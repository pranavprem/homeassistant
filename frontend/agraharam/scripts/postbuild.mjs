/**
 * Postbuild (§11.5). Turns Vite's output in dist/agraharam/<version>/ into the installable bundle, in order:
 *
 *   1. move source maps to dist/sourcemaps/<version>/ (never installed: /local is unauthenticated);
 *   2. copy the two OFL font licenses into LICENSES/ and require THIRD_PARTY_LICENSES.md;
 *   3. allowlist: exactly agraharam.js, the two fonts and the three license files, nothing else;
 *   4. privacy and browser-floor scan of agraharam.js, plus the private forbidden set over every file when the
 *      private directory exists;
 *   5. write manifest.json, then SHA256SUMS;
 *   6. log one size line for agraharam.js (raw and gzip bytes against the §11.5 target), warning above it.
 *
 * Any failure exits non-zero and prints `path:line:column rule` lines, never the matched value.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, COMMIT_TIME, GIT_DIRTY, GIT_SHA } from '../build-env.ts';
import { buildForbiddenSet, decodeForScan, formatHit, lineLocator, scanForForbidden } from './lib/public-scan.mjs';
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
export const THIRD_PARTY_LICENSES = 'LICENSES/THIRD_PARTY_LICENSES.md';
/**
 * §11.5 size target, 480 KiB (491,520 B) raw, raised from 220 KB at integration for the complete card: all nine
 * sections, the action catalog and validation, and the fictional demo fixtures. Each build's own measurement is its
 * size line (raw and gzip) and its manifest (raw bytes per file). Exceeding the target warns: HA shows "custom element
 * doesn't exist" until a slow module loads, and even 480 KiB loads well under HA's 2 s define window on a LAN or the
 * tunnel. Features are not cut to meet it.
 */
export const BUNDLE_SIZE_TARGET_BYTES = 480 * 1024;
/**
 * The release version shape, identical to install.sh's VERSION_RE. The version names dist/sourcemaps/<version>/,
 * which postbuild deletes recursively, so a malformed value must never reach a path.
 */
export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

/** Each bundled font family: the file Vite emits and the OFL text copied from its package. */
export const FONT_FAMILIES = Object.freeze([
  {
    label: 'fonts/newsreader-latin-opsz-normal-<hash>.woff2',
    file: /^fonts\/newsreader-latin-opsz-normal-[\w-]+\.woff2$/,
    licensePackage: '@fontsource-variable/newsreader',
    license: 'LICENSES/OFL-1.1-Newsreader.txt',
  },
  {
    label: 'fonts/hanken-grotesk-latin-wght-normal-<hash>.woff2',
    file: /^fonts\/hanken-grotesk-latin-wght-normal-[\w-]+\.woff2$/,
    licensePackage: '@fontsource-variable/hanken-grotesk',
    license: 'LICENSES/OFL-1.1-Hanken-Grotesk.txt',
  },
]);

/** The only files that may exist before the manifest and checksums are written (§11.5 step 3). */
const ALLOWLIST = [/^agraharam\.js$/, /^fonts\/[^/]+\.woff2$/, /^LICENSES\/[^/]+\.(?:md|txt)$/];

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
/** The only URL prefix allowed in the bundle: the SVG namespace. */
const ALLOWED_URL_PREFIX = 'http://www.w3.org/';
/** Credentials, private paths and dev-only names that must never reach /local. */
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
 * Scans the bundle text for the §11.5 step 4 patterns.
 * @param {string} text
 * @returns {{ line: number, column: number, rule: string }[]}
 */
export function scanBundleText(text) {
  const locate = lineLocator(text);
  /** @type {{ line: number, column: number, rule: string }[]} */
  const hits = [];
  for (const { rule, pattern } of BUNDLE_PATTERNS) {
    for (const match of text.matchAll(pattern)) hits.push({ ...locate(match.index ?? 0), rule });
  }
  for (const match of text.matchAll(/https?:\/\//g)) {
    const index = match.index ?? 0;
    if (!text.startsWith(ALLOWED_URL_PREFIX, index)) hits.push({ ...locate(index), rule: 'external-url' });
  }
  for (const literal of FORBIDDEN_LITERALS) {
    for (let index = text.indexOf(literal); index !== -1; index = text.indexOf(literal, index + 1)) {
      hits.push({ ...locate(index), rule: 'forbidden-literal' });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
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
      'The package.json version must look like X.Y.Z (optionally -prerelease). Fix it and rebuild; nothing was changed.',
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
  scanBundle(bundleDir, files, forbidden);

  const manifestFiles = files.map((path) => describeFile(bundleDir, path));
  const manifest = {
    name: 'agraharam-dashboard',
    version,
    git_sha: build.gitSha,
    git_dirty: build.gitDirty,
    commit_time: build.commitTime,
    node: nodeVersion,
    entry: BUNDLE_ENTRY,
    resource_url: `/local/agraharam/${version}/${BUNDLE_ENTRY}`,
    files: manifestFiles,
  };
  writeFileSync(join(bundleDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const summed = [...manifestFiles, describeFile(bundleDir, MANIFEST_FILE)].sort(byPath);
  writeFileSync(join(bundleDir, CHECKSUMS_FILE), summed.map((file) => `${file.sha256}  ${file.path}\n`).join(''));

  log(sizeLine(readFileSync(join(bundleDir, BUNDLE_ENTRY))));
  return { bundleDir, files: manifestFiles };
}

/**
 * The build log's size line (§11.5): raw and gzip bytes of the bundle and the raw target, as a warning above it.
 * The exact figures of a build also live in its manifest.json.
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
 * @param {string} packageDir
 * @param {string} bundleDir
 */
function copyFontLicenses(packageDir, bundleDir) {
  if (!existsSync(join(bundleDir, THIRD_PARTY_LICENSES))) {
    throw new PostbuildError(`${THIRD_PARTY_LICENSES} is missing. Check build.license in vite.config.ts.`);
  }
  for (const { licensePackage, license } of FONT_FAMILIES) {
    const source = join(packageDir, 'node_modules', licensePackage, 'LICENSE');
    if (!existsSync(source)) {
      throw new PostbuildError(`${licensePackage}/LICENSE is missing. Run "npm ci" and rebuild.`);
    }
    copyFileSync(source, join(bundleDir, license));
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
      .filter((path) => !ALLOWLIST.some((pattern) => pattern.test(path)))
      .map((path) => ({ path, line: 1, column: 1, rule: 'not-allowlisted' })),
  ];
  for (const { label, file, license } of FONT_FAMILIES) {
    if (files.filter((path) => file.test(path)).length !== 1) {
      issues.push({ path: label, line: 1, column: 1, rule: 'expected-exactly-one' });
    }
    if (!files.includes(license)) issues.push({ path: license, line: 1, column: 1, rule: 'missing' });
  }
  const fontCount = files.filter((path) => path.startsWith('fonts/')).length;
  if (fontCount !== FONT_FAMILIES.length) {
    issues.push({ path: 'fonts/', line: 1, column: 1, rule: 'unexpected-font-count' });
  }
  if (issues.length > 0) throw new PostbuildError('The bundle does not match the §11.5 file allowlist.', issues);
  return files;
}

/**
 * @param {string} bundleDir
 * @param {readonly string[]} files
 * @param {import('./lib/public-scan.mjs').ForbiddenSet | null} forbidden
 */
function scanBundle(bundleDir, files, forbidden) {
  /** @type {Issue[]} */
  const issues = [];
  const entryText = readFileSync(join(bundleDir, BUNDLE_ENTRY), 'utf8');
  for (const hit of scanBundleText(entryText)) issues.push({ path: BUNDLE_ENTRY, ...hit });
  if (forbidden) {
    for (const path of files) {
      for (const hit of scanForForbidden(decodeForScan(readFileSync(join(bundleDir, path))), forbidden)) {
        issues.push({ path, ...hit });
      }
    }
  }
  if (issues.length > 0) throw new PostbuildError('The bundle failed the privacy and safety scan.', issues);
}

/**
 * @param {string} bundleDir
 * @param {string} path
 * @returns {ManifestFile}
 */
function describeFile(bundleDir, path) {
  const content = readFileSync(join(bundleDir, path));
  return { path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
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
