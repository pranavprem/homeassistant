/**
 * Public-repo leak scan (§11.1, §16.10). Builds the forbidden set from every private `.dashboard-local/**\/*.json`
 * file and scans what is about to become public:
 *
 *   default            tracked, untracked-not-ignored and staged files under frontend/agraharam, each staged
 *                      index blob, and dist/agraharam/<version>/
 *   --dist <dir>       only the files of one built directory (install.sh re-scans exactly what it copies)
 *   --range <revs>     every blob under frontend/agraharam in every commit of a `git rev-list` range, for the
 *                      commits about to be pushed
 *
 * Private files are found through AGR_PRIVATE_DIR, else `<worktree root>/.dashboard-local`. A missing private
 * directory exits 2 unless --allow-missing-private is given, so a worktree without the private files can never
 * pass silently. Hits print `path:line:column rule`, never the matched value.
 *
 * Exit codes: 0 clean or skipped, 1 hits or an unreadable private file, 2 usage or a missing private directory.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildForbiddenSet, decodeForScan, formatHit, scanForForbidden } from './lib/public-scan.mjs';
import {
  findRepoRoot,
  isDirectory,
  listTree,
  listWorkingFiles,
  loadExemptions,
  loadPrivateSources,
  PACKAGE_PATH,
  readPackageVersion,
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

/** @typedef {{ label: string, content: Buffer }} ScanTarget */

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
      out('check-public: skipped: no private files (private directory not found; --allow-missing-private).');
      return EXIT_CLEAN;
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
    out('check-public: skipped: no private files.');
    return EXIT_CLEAN;
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
 * Working-tree files, staged blobs that differ from them, and the current build output.
 * @param {string} repoRoot
 * @returns {{ scan: ScanTarget[], irregular: string[] }}
 */
function collectDefaultTargets(repoRoot) {
  /** @type {ScanTarget[]} */
  const scan = [];
  /** @type {Map<string, Buffer>} */
  const working = new Map();
  for (const path of listWorkingFiles(repoRoot)) {
    const content = readFileIfPresent(join(repoRoot, path));
    if (content === undefined) continue; // listed by git but deleted from the working tree
    working.set(path, content);
    scan.push({ label: path, content });
  }
  for (const { path, content } of readStagedBlobs(repoRoot)) {
    if (!working.get(path)?.equals(content)) scan.push({ label: `${path} [index]`, content });
  }
  const packageDir = join(repoRoot, PACKAGE_PATH);
  const version = readPackageVersion(packageDir);
  const distDir = version === undefined ? undefined : join(packageDir, 'dist', 'agraharam', version);
  if (distDir !== undefined && isDirectory(distDir)) {
    const dist = readDirectory(distDir, `${PACKAGE_PATH}/dist/agraharam/${version}`);
    scan.push(...dist.scan);
    return { scan, irregular: dist.irregular };
  }
  return { scan, irregular: [] };
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
