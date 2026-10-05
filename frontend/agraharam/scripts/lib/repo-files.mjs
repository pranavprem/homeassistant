/**
 * File-system and git access for the public-repo checks: repository discovery, the private directory, the
 * exemptions file and the lists of files and blobs to scan. Git always runs through `execFileSync` with an argv
 * array (never a shell) and NUL-separated output, so unusual path names cannot be misread or injected.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExemptions } from './public-scan.mjs';

/** Where the dashboard package lives inside the repository; every git listing is limited to it. */
export const PACKAGE_PATH = 'frontend/agraharam';

/** The gitignored private directory at the worktree root (§11.1, §16.10). */
export const PRIVATE_DIR_NAME = '.dashboard-local';

/** Optional private file of extra forbidden literals, one per line (§11.1 rule 4). */
export const DENYLIST_FILE_NAME = 'public-denylist.txt';

/** The reviewed exemptions, next to the scripts that read them. */
export const EXEMPTIONS_PATH = fileURLToPath(new URL('../public-exemptions.json', import.meta.url));

/** Large enough for every blob of the package in one `git cat-file --batch` read. */
const GIT_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

/** Thrown when a private file exists but cannot be read or parsed; the scan would silently weaken otherwise. */
export class PrivateFileError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PrivateFileError';
  }
}

/** Thrown when git is unavailable, the directory is not a work tree, or a git listing fails. */
export class GitError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Runs git without a shell and returns its raw stdout.
 * @param {string} cwd
 * @param {readonly string[]} args
 * @param {{ input?: Buffer | string }} [options]
 * @returns {Buffer}
 */
export function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      input: options.input,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // The git error text can quote revision arguments or paths; report the subcommand only.
    throw new GitError(`git ${args[0] ?? ''} failed. Check that git is installed and the arguments are valid.`);
  }
}

/** @param {Buffer} output */
function splitNul(output) {
  return output.toString('utf8').split('\0').filter(Boolean);
}

/**
 * @param {string} cwd any directory inside the work tree
 * @returns {string} absolute path of the work tree root
 */
export function findRepoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
}

/**
 * `AGR_PRIVATE_DIR` when set (resolved against `cwd`), otherwise `<worktree root>/.dashboard-local`.
 * @param {{ repoRoot: string, cwd: string, env: Readonly<Record<string, string | undefined>> }} input
 */
export function resolvePrivateDir({ repoRoot, cwd, env }) {
  const override = env.AGR_PRIVATE_DIR;
  return override ? resolve(cwd, override) : join(repoRoot, PRIVATE_DIR_NAME);
}

/**
 * @param {string} path
 * @returns {boolean} true for a directory, or a link to one (the private directory itself may be a link)
 */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `*.json` file under `dir`, recursively, without following symbolic links (a link could point the scan
 * at an unrelated tree, or loop). Links that could hide private JSON (a `*.json` link or a link to a directory)
 * are returned separately so callers can warn: a skipped file must never weaken the scan unnoticed.
 * @param {string} dir
 * @returns {{ files: string[], skippedLinks: string[] }} absolute file paths and `dir`-relative link paths, sorted
 */
export function listPrivateJsonFiles(dir) {
  const root = realpathSync(dir);
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const skippedLinks = [];
  const walk = (/** @type {string} */ current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
      else if (entry.isSymbolicLink() && (entry.name.endsWith('.json') || isDirectory(full))) {
        skippedLinks.push(relative(root, full));
      }
    }
  };
  walk(root);
  return { files: files.sort(), skippedLinks: skippedLinks.sort() };
}

/**
 * The warning a caller prints for each skipped link: the link's path inside the private directory, never content.
 * @param {string} link `dir`-relative path from `loadPrivateSources(...).skippedLinks`
 */
export function skippedLinkWarning(link) {
  return (
    `warning: ${PRIVATE_DIR_NAME}/${link} is a symbolic link and was not scanned (links are never followed). ` +
    `Replace it with the file itself so its values join the forbidden set.`
  );
}

/**
 * Reads and parses every private JSON file plus the optional denylist.
 * @param {string} dir the private directory (must exist)
 * @returns {{ documents: unknown[], denylist: string[], fileCount: number, skippedLinks: string[] }}
 * @throws {PrivateFileError} naming the unreadable file by its path relative to `dir`, never its content
 */
export function loadPrivateSources(dir) {
  const root = realpathSync(dir);
  const { files, skippedLinks } = listPrivateJsonFiles(root);
  const documents = files.map((file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // JSON.parse messages quote a snippet of the input; never print them.
      throw new PrivateFileError(
        `cannot parse private file ${relative(root, file)}. A file the scanner cannot read would weaken the scan; ` +
          'fix or remove it, then re-run.',
      );
    }
  });
  const denylistPath = join(root, DENYLIST_FILE_NAME);
  const denylistStats = lstatOrNull(denylistPath);
  if (denylistStats?.isSymbolicLink()) skippedLinks.push(DENYLIST_FILE_NAME);
  const denylist = denylistStats?.isFile()
    ? readFileSync(denylistPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
    : [];
  return {
    documents,
    denylist,
    fileCount: files.length + (denylist.length > 0 ? 1 : 0),
    skippedLinks: skippedLinks.sort(),
  };
}

/**
 * @param {string} path
 * @returns {import('node:fs').Stats | null} the path's own stats (links not followed), or null when it is absent
 */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * @param {string} [path]
 * @returns {import('./public-scan.mjs').Exemptions}
 */
export function loadExemptions(path = EXEMPTIONS_PATH) {
  return parseExemptions(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Tracked plus untracked-not-ignored files under the package (§11.1). Gitignored paths such as `node_modules/`
 * and `dist/` are excluded by `--exclude-standard`.
 * @param {string} repoRoot
 * @returns {string[]} repo-relative paths, de-duplicated and sorted
 */
export function listWorkingFiles(repoRoot) {
  const tracked = splitNul(git(repoRoot, ['ls-files', '-z', '--', PACKAGE_PATH]));
  const untracked = splitNul(git(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--', PACKAGE_PATH]));
  return [...new Set([...tracked, ...untracked, ...listStagedPaths(repoRoot)])].sort();
}

/**
 * @param {string} repoRoot
 * @returns {string[]} repo-relative paths added, copied, modified or renamed in the index
 */
export function listStagedPaths(repoRoot) {
  return splitNul(git(repoRoot, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--', PACKAGE_PATH]));
}

/**
 * The index blob of every staged path, so content staged and then fixed only in the working tree is still caught.
 * @param {string} repoRoot
 * @returns {{ path: string, content: Buffer }[]}
 */
export function readStagedBlobs(repoRoot) {
  const staged = new Set(listStagedPaths(repoRoot));
  if (staged.size === 0) return [];
  /** @type {Map<string, string>} */
  const pathBySha = new Map();
  for (const entry of splitNul(git(repoRoot, ['ls-files', '-s', '-z', '--', PACKAGE_PATH]))) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = entry.indexOf('\t');
    const [mode, sha] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (staged.has(path) && mode !== '160000' && sha) pathBySha.set(sha, path);
  }
  const blobs = readBlobs(repoRoot, [...pathBySha.keys()]);
  return [...blobs].map(([sha, content]) => ({ path: /** @type {string} */ (pathBySha.get(sha)), content }));
}

/**
 * Every blob under the package in every commit of `range` (`git rev-list` syntax), de-duplicated by content.
 * Scanning each commit's tree, not just the final one, catches a leak added in one commit and removed in a later
 * commit of the same push.
 * @param {string} repoRoot
 * @param {string} range
 * @returns {{ path: string, commit: string, content: Buffer }[]}
 */
export function readRangeBlobs(repoRoot, range) {
  const commits = git(repoRoot, ['rev-list', '--reverse', '--end-of-options', range])
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  /** @type {Map<string, { path: string, commit: string }>} */
  const firstSeen = new Map();
  for (const commit of commits) {
    for (const entry of splitNul(git(repoRoot, ['ls-tree', '-r', '-z', commit, '--', PACKAGE_PATH]))) {
      // "<mode> blob <sha>\t<path>"
      const tab = entry.indexOf('\t');
      const [, type, sha] = entry.slice(0, tab).split(' ');
      if (type === 'blob' && sha && !firstSeen.has(sha)) {
        firstSeen.set(sha, { path: entry.slice(tab + 1), commit: commit.slice(0, 12) });
      }
    }
  }
  const blobs = readBlobs(repoRoot, [...firstSeen.keys()]);
  return [...blobs].map(([sha, content]) => ({
    .../** @type {{ path: string, commit: string }} */ (firstSeen.get(sha)),
    content,
  }));
}

/**
 * Reads blobs in one `git cat-file --batch` process.
 * @param {string} repoRoot
 * @param {readonly string[]} shas
 * @returns {Map<string, Buffer>}
 */
function readBlobs(repoRoot, shas) {
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  if (shas.length === 0) return blobs;
  const output = git(repoRoot, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n` });
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    // "<sha> <type> <size>"
    const [sha, , size] = output.subarray(offset, headerEnd).toString('utf8').split(' ');
    const bytes = Number(size);
    if (!sha || !Number.isInteger(bytes)) throw new GitError('git cat-file returned an unexpected header.');
    blobs.set(sha, output.subarray(headerEnd + 1, headerEnd + 1 + bytes));
    offset = headerEnd + 1 + bytes + 1;
  }
  return blobs;
}

/**
 * Every entry under `dir`, recursively, without following symbolic links.
 * @param {string} dir
 * @returns {{ files: string[], others: string[] }} paths relative to `dir` with forward slashes; `others` are
 *   symbolic links and special files, which never belong in a build
 */
export function listTree(dir) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const others = [];
  const walk = (/** @type {string} */ current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(rel);
      else others.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(), others: others.sort() };
}
