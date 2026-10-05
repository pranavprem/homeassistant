/**
 * Private runtime config generator (§13.4): reads `.dashboard-local/bindings.candidates.json` (required) and
 * `.dashboard-local/agraharam.overrides.json` (optional) at the worktree root, and writes ONLY
 * `.dashboard-local/agraharam-next.dashboard.yaml`, always with `controls: false`.
 *
 * Output guards. The output lands inside the real `.dashboard-local/` by construction: the directory is resolved
 * once to its real path and joined with a constant file name, and no input reaches the path. Checked before
 * writing: the output is not a symbolic link or other non-regular file, and `git check-ignore` confirms it is
 * ignored. The file is written to an exclusive (`wx`, O_EXCL) temporary sibling with mode 0600 and renamed into
 * place, so a crash never leaves half a file and a link planted after the check is replaced, never followed.
 *
 * Live view fails closed: a camera is written with `live: false` (no live view from the dashboard) unless its role,
 * name or entity object ID has an outdoor word, none has an indoor word, and it has no privacy binding. The file's
 * header lists every `live: false` camera with its reason; the operator opts one in through
 * `overrides.camera_live` after checking what it shows.
 *
 * Output on the terminal is counts and validation results only, never entity IDs or names.
 * Exit codes: 0 written, 1 any failure (nothing written).
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CANDIDATES_FILE_NAME,
  generatePrivateConfig,
  OUTPUT_FILE_NAME,
  OVERRIDES_FILE_NAME,
  PrivateConfigError,
} from './lib/private-config.mjs';
import { findRepoRoot, isDirectory, PRIVATE_DIR_NAME } from './lib/repo-files.mjs';

export const EXIT_WRITTEN = 0;
export const EXIT_FAILED = 1;
/** Owner read/write only: the file holds household bindings. */
const OUTPUT_MODE = 0o600;

/** Thrown when an output guard fails; nothing has been written. */
export class OutputGuardError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'OutputGuardError';
  }
}

/**
 * @param {{ cwd: string, now: () => Date, out: (line: string) => void, err: (line: string) => void }} io
 * @returns {number} exit code
 */
export function generate({ cwd, now, out, err }) {
  try {
    const repoRoot = findRepoRoot(cwd);
    const privateDir = join(repoRoot, PRIVATE_DIR_NAME);
    if (!isDirectory(privateDir)) {
      err(`config:private: ${PRIVATE_DIR_NAME}/ not found at the worktree root. Copy the private files there first.`);
      return EXIT_FAILED;
    }
    const realPrivateDir = realpathSync(privateDir);
    const candidatesData = readJson(join(realPrivateDir, CANDIDATES_FILE_NAME), true);
    const overridesData = readJson(join(realPrivateDir, OVERRIDES_FILE_NAME), false);
    const result = generatePrivateConfig({ candidatesData, overridesData, generatedAt: now().toISOString() });
    assertOutputGuards({ repoRoot, outputPath: join(privateDir, OUTPUT_FILE_NAME) });
    writePrivateFile(join(realPrivateDir, OUTPUT_FILE_NAME), result.text);
    out(`config:private: wrote ${PRIVATE_DIR_NAME}/${OUTPUT_FILE_NAME} (mode 0600, controls: false).`);
    for (const line of summarize(result.card, result.notes)) out(`config:private: ${line}`);
    return EXIT_WRITTEN;
  } catch (error) {
    if (error instanceof PrivateConfigError) {
      for (const problem of error.problems) err(`config:private: ${problem}`);
      err('config:private: nothing was written.');
    } else {
      err(`config:private: ${error instanceof Error ? error.message : 'unexpected failure'} Nothing was written.`);
    }
    return EXIT_FAILED;
  }
}

/**
 * @param {string} path
 * @param {boolean} required
 * @returns {unknown} the parsed JSON, or undefined for a missing optional file
 */
function readJson(path, required) {
  const name = `${PRIVATE_DIR_NAME}/${basename(path)}`;
  if (!existsSync(path)) {
    if (required) throw new OutputGuardError(`${name} is required and was not found.`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // JSON.parse messages quote a snippet of the input; never print them.
    throw new OutputGuardError(`${name} is not valid JSON.`);
  }
}

/**
 * @param {{ repoRoot: string, outputPath: string }} input `outputPath` is the worktree path of the output, so
 *   `git check-ignore` judges it by the repository's own ignore rules
 * @throws {OutputGuardError}
 */
export function assertOutputGuards({ repoRoot, outputPath }) {
  let stats;
  try {
    stats = lstatSync(outputPath);
  } catch {
    stats = undefined; // first run: nothing there yet
  }
  if (stats && !stats.isFile()) {
    throw new OutputGuardError(`${PRIVATE_DIR_NAME}/${OUTPUT_FILE_NAME} exists and is not a regular file (a link?).`);
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '--', outputPath], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    throw new OutputGuardError(
      `${PRIVATE_DIR_NAME}/${OUTPUT_FILE_NAME} is not gitignored. Restore the ${PRIVATE_DIR_NAME}/ rule in .gitignore.`,
    );
  }
}

/**
 * Writes through an exclusive 0600 temporary file and an atomic rename.
 * @param {string} target
 * @param {string} text
 */
function writePrivateFile(target, text) {
  const temporary = join(dirname(target), `.${OUTPUT_FILE_NAME}.${process.pid}.tmp`);
  const handle = openSync(temporary, 'wx', OUTPUT_MODE);
  try {
    writeSync(handle, text);
    closeSync(handle);
    chmodSync(temporary, OUTPUT_MODE);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Counts only, for the terminal.
 * @param {Record<string, unknown>} card
 * @param {import('./lib/private-config.mjs').Notes} notes
 * @returns {string[]}
 */
export function summarize(card, notes) {
  const count = (/** @type {string} */ key) => (Array.isArray(card[key]) ? card[key].length : 0);
  const cameras = /** @type {Array<Record<string, unknown>>} */ (card.cameras ?? []);
  const security = /** @type {Record<string, unknown> | undefined} */ (card.security);
  const actions = security?.actions ? Object.keys(/** @type {object} */ (security.actions)).length : 0;
  const perimeter = Array.isArray(security?.perimeter) ? security.perimeter.length : 0;
  return [
    `people ${count('people')}, climate ${count('climate')}, air ${count('air')}, bed ${count('bed_comfort')}, ` +
      `rooms ${count('rooms')}, vacuums ${count('vacuums')}, appliances ${count('appliances')}, ` +
      `media ${count('media')}, calendars ${count('calendars')}.`,
    `cameras ${cameras.length}: ${cameras.filter((camera) => camera.privacy_entity).length} privacy-gated, ` +
      `${cameras.filter((camera) => camera.thumbnails === false).length} with thumbnails off, ` +
      `${cameras.filter((camera) => camera.live === false).length} with live view off.`,
    `security: alarm and 4 helpers bound, ${perimeter} perimeter, ${actions} guarded action(s); ` +
      `studio monitors ${card.studio_monitors_script ? 'bound' : 'not bound'}; ` +
      `garage ${card.garage ? 'bound' : 'not bound'}; vehicle ${card.vehicle ? 'bound' : 'not bound'}.`,
    `header lists: ${notes.verifyBeforeEnabling.length} verify-before-enabling, ${notes.unassigned.length} ` +
      `unassigned, ${notes.notes.length} note(s). Read the file's header before pasting it.`,
  ];
}

if (import.meta.main) {
  process.exitCode = generate({
    cwd: process.cwd(),
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
