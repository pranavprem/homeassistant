/**
 * Public-repo leak scan (§11.1, §16.10). Builds the forbidden set from every private `.dashboard-local/**\/*.json`
 * file and scans what is about to become public:
 *
 *   default            tracked, untracked-not-ignored and staged files under frontend/agraharam, each staged
 *                      index blob, and every built dist/agraharam/<version>/ (an AGR_PATCH build included)
 *   --dist <dir>       only the files of one built directory (install.sh re-scans exactly what it copies)
 *   --range <revs>     every blob under frontend/agraharam in every commit of a `git rev-list` range, for the
 *                      commits about to be pushed
 *
 * Private files are found through AGR_PRIVATE_DIR, else `<worktree root>/.dashboard-local`. A missing private
 * directory exits 2 unless --allow-missing-private is given, so a worktree without the private files can never
 * pass silently. Without private files (allowed missing, or a private directory holding none), there is no forbidden
 * set, so the default and --range modes run the positive public-literal check instead (§11.1, §17.7): every
 * entity-ID-shaped literal in src, tests, e2e and install must be fictional, exempted or a catalog identifier. That
 * is what CI runs. --dist then reports "skipped", because postbuild already ran that check over the bundle it built.
 * Hits print `path:line:column rule`, never the matched value.
 *
 * Exit codes: 0 clean or skipped, 1 hits or an unreadable private file, 2 usage or a missing private directory.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CATALOG_LITERALS } from './lib/catalog-literals.mjs';
import {
  buildForbiddenSet,
  checkPublicLiterals,
  decodeForScan,
  formatHit,
  isPublicLiteralScope,
  scanForForbidden,
} from './lib/public-scan.mjs';
import {
  findRepoRoot,
  isDirectory,
  listTree,
  listWorkingFiles,
  loadExemptions,
  loadPrivateSources,
  PACKAGE_PATH,
  readRangeBlobs,
  readStagedBlobs,
  resolvePrivateDir,
  skippedLinkWarning,
} from './lib/repo-files.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_HITS = 1;
export const EXIT_USAGE = 2;

const USAGE =
  'usage: node scripts/check-public.mjs [--dist <dir> | --range <rev-range>] [--allow-missing-private]\n' +
  '  Private files: AGR_PRIVATE_DIR, else <worktree root>/.dashboard-local.';

/** @typedef {{ label: string, content: Buffer, path?: string }} ScanTarget `path` is repo-relative, when known */

/**
 * @param {{ argv: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>,
 *           out: (line: string) => void, err: (line: string) => void }} io
 * @returns {number} exit code
 */
export function checkPublic({ argv, cwd, env, out, err }) {
  /** @type {{ dist?: string, range?: string, 'allow-missing-private'?: boolean, help?: boolean }} */
  let options;
  try {
    ({ values: options } = parseArgs({
      args: [...argv],
      options: {
        dist: { type: 'string' },
        range: { type: 'string' },
        'allow-missing-private': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    err(USAGE);
    return EXIT_USAGE;
  }
  if (options.help) {
    out(USAGE);
    return EXIT_CLEAN;
  }
  if (options.dist !== undefined && options.range !== undefined) {
    err('check-public: --dist and --range are separate modes; pass one of them.');
    return EXIT_USAGE;
  }
  if (options.range !== undefined && (options.range === '' || options.range.startsWith('-'))) {
    err('check-public: --range expects a revision range such as origin/main..HEAD.');
    return EXIT_USAGE;
  }

  const repoRoot = findRepoRoot(cwd);
  const privateDir = resolvePrivateDir({ repoRoot, cwd, env });
  if (!isDirectory(privateDir)) {
    if (options['allow-missing-private']) {
      return checkLiteralsOnly({
        repoRoot,
        options,
        reason: 'private directory not found; --allow-missing-private',
        out,
        err,
      });
    }
    err(
      `check-public: private directory not found at ${privateDir}. Set AGR_PRIVATE_DIR to the directory that holds ` +
        'the private .dashboard-local files, or pass --allow-missing-private on a machine that has none.',
    );
    return EXIT_USAGE;
  }

  const sources = loadPrivateSources(privateDir);
  for (const link of sources.skippedLinks) err(`check-public: ${skippedLinkWarning(link)}`);
  if (sources.documents.length === 0 && sources.denylist.length === 0) {
    return checkLiteralsOnly({ repoRoot, options, reason: 'the private directory holds none', out, err });
  }
  const forbidden = buildForbiddenSet(sources, loadExemptions());
  out(
    `check-public: forbidden set from ${sources.fileCount} private file(s): ${forbidden.entityIds.size} entity IDs, ` +
      `${forbidden.objectIds.size} object IDs, ${forbidden.denylistSize} denylist literals.`,
  );

  const targets = collectTargets({ repoRoot, cwd, options });
  if (typeof targets === 'string') {
    err(targets);
    return EXIT_USAGE;
  }
  let hitCount = 0;
  for (const { label, content } of targets.scan) {
    for (const hit of scanForForbidden(decodeForScan(content), forbidden)) {
      out(formatHit(label, hit));
      hitCount += 1;
    }
  }
  for (const label of targets.irregular) {
    out(`${label}:1:1 not-a-regular-file`);
    hitCount += 1;
  }
  if (hitCount > 0) {
    err(
      `check-public: ${hitCount} hit(s) in ${targets.scan.length} scanned item(s). Replace real household values ` +
        'with fictional *.demo_* data; values are never printed, open each path:line:column to see them.',
    );
    return EXIT_HITS;
  }
  out(`check-public: clean (${targets.scan.length} item(s) scanned).`);
  return EXIT_CLEAN;
}

/**
 * The check that needs no private files (§17.7): the positive public-literal check over the scoped working-tree
 * files and staged blobs, or over every scoped blob of a commit range.
 * @param {{ repoRoot: string, options: { dist?: string, range?: string }, reason: string,
 *           out: (line: string) => void, err: (line: string) => void }} input
 * @returns {number} exit code
 */
function checkLiteralsOnly({ repoRoot, options, reason, out, err }) {
  if (options.dist !== undefined) {
    out(`check-public: skipped: no private files (${reason}); postbuild ran the public-literal check on the build.`);
    return EXIT_CLEAN;
  }
  out(`check-public: no private files (${reason}): running the public-literal check (§17.7).`);
  const targets =
    options.range === undefined
      ? workingTreeTargets(repoRoot)
      : readRangeBlobs(repoRoot, options.range).map(({ path, commit, content }) => ({
          label: `${path}@${commit}`,
          path,
          content,
        }));
  const scoped = targets.filter(
    (target) => target.path !== undefined && isPublicLiteralScope(target.path.slice(PACKAGE_PATH.length + 1)),
  );
  const exemptions = loadExemptions();
  let hitCount = 0;
  for (const { label, path, content } of scoped) {
    const files = [{ path: /** @type {string} */ (path), text: decodeForScan(content) }];
    for (const hit of checkPublicLiterals({ files, exemptions, catalogLiterals: CATALOG_LITERALS })) {
      out(formatHit(label, hit));
      hitCount += 1;
    }
  }
  if (hitCount > 0) {
    err(
      `check-public: ${hitCount} public-literal hit(s) in ${scoped.length} file(s). Use fictional *.demo_* IDs, or ` +
        'add a reviewed generic value to scripts/public-exemptions.json; values are never printed.',
    );
    return EXIT_HITS;
  }
  out(`check-public: clean: public-literal check of ${scoped.length} file(s).`);
  return EXIT_CLEAN;
}

/**
 * @param {{ repoRoot: string, cwd: string, options: { dist?: string, range?: string } }} input
 * @returns {{ scan: ScanTarget[], irregular: string[] } | string} targets, or a usage error message
 */
function collectTargets({ repoRoot, cwd, options }) {
  if (options.dist !== undefined) {
    const distDir = resolve(cwd, options.dist);
    if (!isDirectory(distDir)) return `check-public: --dist ${options.dist} is not a directory.`;
    return readDirectory(distDir, options.dist.replace(/\/+$/, ''));
  }
  if (options.range !== undefined) {
    return {
      scan: readRangeBlobs(repoRoot, options.range).map(({ path, commit, content }) => ({
        label: `${path}@${commit}`,
        content,
      })),
      irregular: [],
    };
  }
  return collectDefaultTargets(repoRoot);
}

/**
 * Working-tree files, staged blobs that differ from them, and every build output under dist/agraharam/: a release
 * build stamps its own patch (AGR_PATCH, §17.3), so its directory need not match package.json.
 * @param {string} repoRoot
 * @returns {{ scan: ScanTarget[], irregular: string[] }}
 */
function collectDefaultTargets(repoRoot) {
  const scan = workingTreeTargets(repoRoot);
  /** @type {string[]} */
  const irregular = [];
  const distRoot = join(repoRoot, PACKAGE_PATH, 'dist', 'agraharam');
  if (isDirectory(distRoot)) {
    const dist = readDirectory(distRoot, `${PACKAGE_PATH}/dist/agraharam`);
    scan.push(...dist.scan);
    irregular.push(...dist.irregular);
  }
  return { scan, irregular };
}

/**
 * Tracked, untracked-not-ignored and staged files under the package, plus each staged blob that differs from its
 * working-tree file.
 * @param {string} repoRoot
 * @returns {ScanTarget[]}
 */
function workingTreeTargets(repoRoot) {
  /** @type {ScanTarget[]} */
  const scan = [];
  /** @type {Map<string, Buffer>} */
  const working = new Map();
  for (const path of listWorkingFiles(repoRoot)) {
    const content = readFileIfPresent(join(repoRoot, path));
    if (content === undefined) continue; // listed by git but deleted from the working tree
    working.set(path, content);
    scan.push({ label: path, path, content });
  }
  for (const { path, content } of readStagedBlobs(repoRoot)) {
    if (!working.get(path)?.equals(content)) scan.push({ label: `${path} [index]`, path, content });
  }
  return scan;
}

/**
 * @param {string} dir
 * @param {string} labelPrefix
 * @returns {{ scan: ScanTarget[], irregular: string[] }}
 */
function readDirectory(dir, labelPrefix) {
  const { files, others } = listTree(dir);
  return {
    scan: files.map((file) => ({ label: `${labelPrefix}/${file}`, content: readFileSync(join(dir, file)) })),
    irregular: others.map((file) => `${labelPrefix}/${file}`),
  };
}

/**
 * Reads a working-tree file. A symbolic link is followed on purpose: a link planted in the public tree that
 * points at private data is reported rather than skipped.
 * @param {string} path
 * @returns {Buffer | undefined} undefined when the path is missing or is not a file
 */
function readFileIfPresent(path) {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = checkPublic({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } catch (error) {
    // Typed errors from the helpers carry actionable, value-free messages.
    console.error(`check-public: ${error instanceof Error ? error.message : 'unexpected failure'}`);
    process.exitCode = EXIT_HITS;
  }
}
