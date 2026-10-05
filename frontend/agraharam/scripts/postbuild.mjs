/**
 * Postbuild (§11.5, §17.2). Turns Vite's output in dist/agraharam/<version>/ into the flat release directory that
 * both channels install (HACS release assets and install.sh), in order:
 *
 *   1. move source maps to dist/sourcemaps/<version>/ (never shipped: /local and /hacsfiles are unauthenticated);
 *   2. copy the two OFL font licenses next to the bundle and require THIRD_PARTY_LICENSES.md, listing both fonts;
 *   3. allowlist: exactly agraharam.js and the three license files, flat, nothing else;
 *   4. scan agraharam.js: the legal banner leads it, the privacy and browser-floor rules, and the positive
 *      public-literal check over its string literals (§17.7); plus the private forbidden set over every file when
 *      the private directory exists;
 *   5. write manifest.json, then SHA256SUMS;
 *   6. log one size line for agraharam.js (raw and gzip bytes against the §17.2 target), warning above it.
 *
 * Any failure exits non-zero and prints `path:line:column rule` lines, never the matched value.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, BUNDLE_SIZE_TARGET_BYTES, COMMIT_TIME, GIT_DIRTY, GIT_SHA } from '../build-env.ts';
import { CATALOG_LITERALS } from './lib/catalog-literals.mjs';
import { FONT_LICENSES, fontFilePath, fontLicensePath, legalBanner } from './lib/font-licenses.mjs';
import {
  buildForbiddenSet,
  checkPublicLiterals,
  decodeForScan,
  formatHit,
  lineLocator,
  scanForForbidden,
} from './lib/public-scan.mjs';
import {
  findRepoRoot,
  GitError,
  isDirectory,
  listTree,
  loadExemptions,
  loadPrivateSources,
  resolvePrivateDir,
  skippedLinkWarning,
} from './lib/repo-files.mjs';

export const BUNDLE_ENTRY = 'agraharam.js';
export const MANIFEST_FILE = 'manifest.json';
export const CHECKSUMS_FILE = 'SHA256SUMS';
export const THIRD_PARTY_LICENSES = 'THIRD_PARTY_LICENSES.md';
/**
 * The release version shape, identical to install.sh's VERSION_RE. The version names dist/sourcemaps/<version>/,
 * which postbuild deletes recursively, so a malformed value must never reach a path.
 */
export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

/**
 * Exactly the files that must exist, flat, before the manifest and checksums are written (§17.2 step 3). The fonts
 * are inside agraharam.js; their full license texts ship beside it.
 */
export const BUILT_FILES = Object.freeze(
  [BUNDLE_ENTRY, THIRD_PARTY_LICENSES, ...FONT_LICENSES.map((font) => font.licenseFile)].sort(),
);
/** The finished release directory: the built files plus the manifest and checksums, exactly (§17.2). */
export const RELEASE_FILES = Object.freeze([...BUILT_FILES, MANIFEST_FILE, CHECKSUMS_FILE].sort());

/**
 * Bundle scan rules (§11.5 step 4). Lookbehind is a parse-time SyntaxError for the whole module before Safari
 * 16.4; the ES2023 array-copy methods are missing in Chrome 108 and Firefox 110; raw decorators throw everywhere.
 */
const BUNDLE_PATTERNS = Object.freeze([
  { rule: 'source-map-url', pattern: /sourceMappingURL/g },
  { rule: 'raw-decorator', pattern: /^\s*@[A-Za-z_$][\w$]*\(/gm },
  { rule: 'regex-lookbehind', pattern: /\(\?<[=!]/g },
  { rule: 'es2023-array-copy', pattern: /\.(?:toSorted|toReversed|toSpliced)\(/g },
]);
/**
 * Embedded data (§17.2). The bundle may embed exactly the two package font files and nothing else: every base64
 * `data:` URL must be a `data:font/woff2;base64,` string whose decoded bytes equal one of them, and no other
 * MIME-typed `data:` URL (base64 or not, such as a `data:text/javascript,…` import) may appear. Only those verified
 * payloads are blanked for the text rules, which a three-letter rule such as `eyJ` would otherwise hit in random
 * base64 by chance.
 */
const BASE64_DATA_URL_RE = /data:[^,"'`]*;base64,/g;
const MIME_DATA_URL_RE = /data:[a-z]+\/[\w.+-]+/gi;
const FONT_DATA_URL_HEADER = 'data:font/woff2;base64,';
const BASE64_RUN_RE = /[A-Za-z0-9+/]*={0,2}/y;
/** A verified payload must end its string literal. */
const STRING_QUOTES = new Set(['"', "'", '`']);
/** The only URL prefix allowed in the bundle after its legal banner: the SVG namespace. */
const ALLOWED_URL_PREFIX = 'http://www.w3.org/';
/** Credentials, private paths and dev-only names that must never reach /local or /hacsfiles. */
const FORBIDDEN_LITERALS = Object.freeze([
  'authSig',
  'access_token=',
  'Bearer ',
  'eyJ',
  '10.0.0.',
  '.dashboard-local',
  'dev-ha-shell',
  'FakeHass',
  '__agrCalls',
]);

/** @typedef {{ readonly path: string, readonly line: number, readonly column: number, readonly rule: string }} Issue */
/** @typedef {{ readonly path: string, readonly bytes: number, readonly sha256: string }} ManifestFile */

/** Thrown when any postbuild step fails; `issues` hold positions and rules only. */
export class PostbuildError extends Error {
  /**
   * @param {string} message
   * @param {readonly Issue[]} [issues]
   */
  constructor(message, issues = []) {
    super(message);
    this.name = 'PostbuildError';
    this.issues = issues;
  }
}

/**
 * Scans the bundle text for the §11.5 step 4 patterns. When `banner` is given, the bundle must start with exactly it
 * (rule `legal-banner`), and the URLs of its font notices are allowed there and nowhere else. `fonts` are the only
 * files the bundle may embed (rule `embedded-data`); without them, any embedded data fails.
 * @param {string} bundleText
 * @param {{ banner?: string, fonts?: readonly Buffer[] }} [expected]
 * @returns {{ line: number, column: number, rule: string }[]}
 */
export function scanBundleText(bundleText, { banner, fonts = [] } = {}) {
  const locate = lineLocator(bundleText);
  const embedded = verifyEmbeddedFonts(bundleText, fonts);
  const text = embedded.maskedText;
  /** @type {{ line: number, column: number, rule: string }[]} */
  const hits = embedded.offsets.map((offset) => ({ ...locate(offset), rule: 'embedded-data' }));
  const bannerEnd = banner !== undefined && text.startsWith(banner) ? banner.length : 0;
  if (banner !== undefined && bannerEnd === 0) hits.push({ line: 1, column: 1, rule: 'legal-banner' });
  for (const { rule, pattern } of BUNDLE_PATTERNS) {
    for (const match of text.matchAll(pattern)) hits.push({ ...locate(match.index ?? 0), rule });
  }
  for (const match of text.matchAll(/https?:\/\//g)) {
    const index = match.index ?? 0;
    if (index >= bannerEnd && !text.startsWith(ALLOWED_URL_PREFIX, index)) {
      hits.push({ ...locate(index), rule: 'external-url' });
    }
  }
  for (const literal of FORBIDDEN_LITERALS) {
    for (let index = text.indexOf(literal); index !== -1; index = text.indexOf(literal, index + 1)) {
      hits.push({ ...locate(index), rule: 'forbidden-literal' });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Checks every embedded `data:` URL against the expected font files, each of which must appear exactly once, and
 * blanks only the verified payloads with spaces of the same length, so hit positions still match the file.
 * @param {string} text
 * @param {readonly Buffer[]} fonts
 * @returns {{ maskedText: string, offsets: number[] }} the masked text and the offsets of every rejected data URL
 */
function verifyEmbeddedFonts(text, fonts) {
  const expected = fonts.map(sha256);
  const headers = [...text.matchAll(BASE64_DATA_URL_RE)];
  /** @type {number[]} */
  const offsets = [];
  /** @type {[number, number][]} */
  const verified = [];
  for (const header of headers) {
    const start = (header.index ?? 0) + header[0].length;
    BASE64_RUN_RE.lastIndex = start;
    const end = start + (BASE64_RUN_RE.exec(text)?.[0].length ?? 0);
    const font = expected.indexOf(sha256(Buffer.from(text.slice(start, end), 'base64')));
    if (header[0] !== FONT_DATA_URL_HEADER || !STRING_QUOTES.has(text[end] ?? '') || font === -1) {
      offsets.push(header.index ?? 0);
      continue;
    }
    expected.splice(font, 1); // each font once
    verified.push([start, end]);
  }
  if (headers.length !== fonts.length) offsets.push(headers[fonts.length]?.index ?? 0);
  const base64Headers = new Set(headers.map((header) => header.index));
  for (const match of text.matchAll(MIME_DATA_URL_RE)) {
    if (!base64Headers.has(match.index)) offsets.push(match.index ?? 0);
  }
  let maskedText = text;
  for (const [start, end] of verified) {
    maskedText = maskedText.slice(0, start) + ' '.repeat(end - start) + maskedText.slice(end);
  }
  return { maskedText, offsets: [...new Set(offsets)] };
}

/** @param {Uint8Array} bytes */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Runs every postbuild step on dist/agraharam/<version>/.
 * @param {{ packageDir: string, version: string,
 *           build: { gitSha: string, gitDirty: boolean, commitTime: string }, nodeVersion: string,
 *           forbidden: import('./lib/public-scan.mjs').ForbiddenSet | null,
 *           log?: (line: string) => void }} input
 * @returns {{ bundleDir: string, files: ManifestFile[] }}
 * @throws {PostbuildError}
 */
export function postbuild({ packageDir, version, build, nodeVersion, forbidden, log = () => {} }) {
  if (!VERSION_PATTERN.test(version)) {
    throw new PostbuildError(
      'The build version must look like X.Y.Z (optionally -prerelease). Fix package.json or AGR_PATCH and rebuild; ' +
        'nothing was changed.',
    );
  }
  const bundleDir = join(packageDir, 'dist', 'agraharam', version);
  if (!existsSync(join(bundleDir, BUNDLE_ENTRY))) {
    throw new PostbuildError(`dist/agraharam/${version}/${BUNDLE_ENTRY} is missing. Run "vite build" first.`);
  }
  // Earlier postbuild outputs are regenerated below; removing them keeps a re-run idempotent.
  rmSync(join(bundleDir, MANIFEST_FILE), { force: true });
  rmSync(join(bundleDir, CHECKSUMS_FILE), { force: true });

  const movedMaps = moveSourceMaps(bundleDir, join(packageDir, 'dist', 'sourcemaps', version));
  log(`postbuild: moved ${movedMaps} source map(s) to dist/sourcemaps/${version}/`);
  copyFontLicenses(packageDir, bundleDir);
  const files = assertAllowlist(bundleDir);
  scanBundle(packageDir, bundleDir, files, forbidden);

  const manifestFiles = files.map((path) => describeFile(bundleDir, path));
  const manifest = {
    name: 'agraharam-dashboard',
    version,
    git_sha: build.gitSha,
    git_dirty: build.gitDirty,
    commit_time: build.commitTime,
    node: nodeVersion,
    entry: BUNDLE_ENTRY,
    files: manifestFiles,
  };
  writeFileSync(join(bundleDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const summed = [...manifestFiles, describeFile(bundleDir, MANIFEST_FILE)].sort(byPath);
  writeFileSync(join(bundleDir, CHECKSUMS_FILE), summed.map((file) => `${file.sha256}  ${file.path}\n`).join(''));

  log(sizeLine(readFileSync(join(bundleDir, BUNDLE_ENTRY))));
  return { bundleDir, files: manifestFiles };
}

/**
 * The build log's size line (§11.5, §17.2): raw and gzip bytes of the bundle and the raw target
 * (`BUNDLE_SIZE_TARGET_BYTES` in build-env.ts), as a warning above it. HA shows "custom element doesn't exist" until
 * a slow module loads, and 720 KiB still loads well under HA's 2 s define window on a LAN or the tunnel, so the
 * target warns and never fails. The exact figures of a build also live in its manifest.json.
 * @param {Buffer} bundle
 * @returns {string}
 */
export function sizeLine(bundle) {
  const sizes = `${BUNDLE_ENTRY} ${bundle.length} B raw, ${gzipSync(bundle).length} B gzip`;
  return bundle.length > BUNDLE_SIZE_TARGET_BYTES
    ? `postbuild: warning: ${sizes}, above the ${BUNDLE_SIZE_TARGET_BYTES} B target.`
    : `postbuild: ${sizes} (target ${BUNDLE_SIZE_TARGET_BYTES} B raw).`;
}

/**
 * @param {string} bundleDir
 * @param {string} sourcemapDir replaced on every run so stale maps never linger
 * @returns {number} maps moved
 */
function moveSourceMaps(bundleDir, sourcemapDir) {
  rmSync(sourcemapDir, { recursive: true, force: true });
  const maps = listTree(bundleDir).files.filter((path) => path.endsWith('.map'));
  for (const path of maps) {
    const target = join(sourcemapDir, path);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(bundleDir, path), target);
  }
  return maps.length;
}

/**
 * Copies each font's OFL text next to the bundle and checks Vite's third-party notice file names both font packages
 * (§17.8: the fonts are inside agraharam.js now, so this file is their only package-level notice).
 * @param {string} packageDir
 * @param {string} bundleDir
 */
function copyFontLicenses(packageDir, bundleDir) {
  const noticesPath = join(bundleDir, THIRD_PARTY_LICENSES);
  if (!existsSync(noticesPath)) {
    throw new PostbuildError(`${THIRD_PARTY_LICENSES} is missing. Check build.license in vite.config.ts.`);
  }
  const notices = readFileSync(noticesPath, 'utf8');
  for (const font of FONT_LICENSES) {
    const source = fontLicensePath(packageDir, font);
    if (!existsSync(source)) {
      throw new PostbuildError(`${font.licensePackage}/LICENSE is missing. Run "npm ci" and rebuild.`);
    }
    if (!notices.includes(`## ${font.licensePackage} `)) {
      throw new PostbuildError(
        `${THIRD_PARTY_LICENSES} does not list ${font.licensePackage}. Check that src/styles/fonts.ts still imports ` +
          'it and that build.license is set in vite.config.ts.',
      );
    }
    copyFileSync(source, join(bundleDir, font.licenseFile));
  }
}

/**
 * @param {string} bundleDir
 * @returns {string[]} the bundle's files, sorted
 */
function assertAllowlist(bundleDir) {
  const { files, others } = listTree(bundleDir);
  /** @type {Issue[]} */
  const issues = [
    ...others.map((path) => ({ path, line: 1, column: 1, rule: 'not-a-regular-file' })),
    ...files
      .filter((path) => !BUILT_FILES.includes(path))
      .map((path) => ({ path, line: 1, column: 1, rule: 'not-allowlisted' })),
    ...BUILT_FILES.filter((path) => !files.includes(path)).map((path) => ({
      path,
      line: 1,
      column: 1,
      rule: 'missing',
    })),
  ];
  if (issues.length > 0) throw new PostbuildError('The bundle does not match the §17.2 file allowlist.', issues);
  return files;
}

/**
 * @param {string} packageDir
 * @param {string} bundleDir
 * @param {readonly string[]} files
 * @param {import('./lib/public-scan.mjs').ForbiddenSet | null} forbidden
 */
function scanBundle(packageDir, bundleDir, files, forbidden) {
  /** @type {Issue[]} */
  const issues = [];
  const entryText = readFileSync(join(bundleDir, BUNDLE_ENTRY), 'utf8');
  const fonts = readEmbeddableFonts(packageDir);
  for (const hit of scanBundleText(entryText, { banner: legalBanner(packageDir), fonts })) {
    issues.push({ path: BUNDLE_ENTRY, ...hit });
  }
  // §17.7: CI cannot run the private scan, so every entity-ID-shaped string in the shipped module must be fictional,
  // a reviewed exemption or a catalog identifier, whatever source file it came from.
  issues.push(
    ...checkPublicLiterals({
      files: [{ path: BUNDLE_ENTRY, text: entryText }],
      exemptions: loadExemptions(),
      catalogLiterals: CATALOG_LITERALS,
    }),
  );
  if (forbidden) {
    for (const path of files) {
      for (const hit of scanForForbidden(decodeForScan(readFileSync(join(bundleDir, path))), forbidden)) {
        issues.push({ path, ...hit });
      }
    }
    // The embedded fonts were separate files scanned as latin1 before §17.2; the bundle holds exactly these bytes.
    fonts.forEach((bytes, index) => {
      for (const hit of scanForForbidden(decodeForScan(bytes), forbidden)) {
        issues.push({ path: `${BUNDLE_ENTRY} [embedded font ${index + 1}]`, ...hit });
      }
    });
  }
  if (issues.length > 0) throw new PostbuildError('The bundle failed the privacy and safety scan.', issues);
}

/**
 * The package font files the bundle must embed, byte for byte (§17.2).
 * @param {string} packageDir
 * @returns {Buffer[]}
 */
function readEmbeddableFonts(packageDir) {
  return FONT_LICENSES.map((font) => {
    const path = fontFilePath(packageDir, font);
    if (!existsSync(path)) {
      throw new PostbuildError(`${font.licensePackage}/${font.fontFile} is missing. Run "npm ci" and rebuild.`);
    }
    return readFileSync(path);
  });
}

/**
 * @param {string} bundleDir
 * @param {string} path
 * @returns {ManifestFile}
 */
function describeFile(bundleDir, path) {
  const content = readFileSync(join(bundleDir, path));
  return { path, bytes: content.length, sha256: sha256(content) };
}

/**
 * Byte-order comparison, so the manifest and checksums are identical on every machine and locale.
 * @param {{ path: string }} a
 * @param {{ path: string }} b
 */
function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Builds the forbidden set when private files are available. The build never fails for their absence:
 * `npm run check:public` (in verify and the commit procedure) is the strict gate for that.
 * @param {{ packageDir: string, env: Readonly<Record<string, string | undefined>>, log: (line: string) => void }} input
 * @returns {import('./lib/public-scan.mjs').ForbiddenSet | null}
 */
export function loadForbiddenSetForBuild({ packageDir, env, log }) {
  let repoRoot;
  try {
    repoRoot = findRepoRoot(packageDir);
  } catch (error) {
    if (!(error instanceof GitError) || !env.AGR_PRIVATE_DIR) {
      log('postbuild: private-value scan skipped: not in a git work tree and AGR_PRIVATE_DIR is unset.');
      return null;
    }
    repoRoot = packageDir;
  }
  const privateDir = resolvePrivateDir({ repoRoot, cwd: packageDir, env });
  if (!isDirectory(privateDir)) {
    log('postbuild: private-value scan skipped: no private directory (check:public enforces it).');
    return null;
  }
  const sources = loadPrivateSources(privateDir);
  for (const link of sources.skippedLinks) log(`postbuild: ${skippedLinkWarning(link)}`);
  if (sources.documents.length === 0 && sources.denylist.length === 0) {
    log('postbuild: private-value scan skipped: no private files.');
    return null;
  }
  return buildForbiddenSet(sources, loadExemptions());
}

if (import.meta.main) {
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const log = (/** @type {string} */ line) => console.log(line);
  try {
    const forbidden = loadForbiddenSetForBuild({ packageDir, env: process.env, log });
    const { files } = postbuild({
      packageDir,
      version: APP_VERSION,
      build: { gitSha: GIT_SHA, gitDirty: GIT_DIRTY, commitTime: COMMIT_TIME },
      nodeVersion: process.version,
      forbidden,
      log,
    });
    for (const file of files) log(`postbuild: ${String(file.bytes).padStart(9)} B  ${file.path}`);
    log(`postbuild: wrote dist/agraharam/${APP_VERSION}/${MANIFEST_FILE} and ${CHECKSUMS_FILE}.`);
  } catch (error) {
    if (error instanceof PostbuildError) {
      console.error(`postbuild: ${error.message}`);
      for (const issue of error.issues) console.error(formatHit(issue.path, issue));
    } else {
      console.error(`postbuild: ${error instanceof Error ? error.message : 'unexpected failure'}`);
    }
    process.exitCode = 1;
  }
}
