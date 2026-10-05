/**
 * The release check of the workflow's `release-build` job (§17.5). After `AGR_PATCH=$GITHUB_RUN_NUMBER npm run
 * build`, it proves the build is the one this run must publish, then copies exactly the files SHA256SUMS lists, plus
 * SHA256SUMS, into a new directory that the job uploads as the release artifact:
 *
 *   - manifest.version equals MAJOR.MINOR (package.json) plus the run number;
 *   - manifest.git_dirty is false, and manifest.git_sha is a prefix of the commit the workflow checked out;
 *   - SHA256SUMS lists exactly postbuild's release files (flat, safe names), each file matches its sum, and the build
 *     directory holds nothing else.
 *
 * Usage (from frontend/agraharam): node scripts/ci/stage-release.mjs <output directory>, with GITHUB_RUN_NUMBER and
 * GITHUB_SHA set by Actions. Exits 1 with a message naming the failed check; nothing is staged then.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppVersion } from '../../build-env.ts';
import { BUNDLE_ENTRY, CHECKSUMS_FILE, MANIFEST_FILE, RELEASE_FILES } from '../postbuild.mjs';

/** One SHA256SUMS line with a flat file name that cannot be a path, an option or hidden. */
const SUM_LINE_RE = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHORT_SHA_RE = /^[0-9a-f]{7,64}$/;

/** Thrown when the build is not exactly the release this run may publish. */
export class StageReleaseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'StageReleaseError';
  }
}

/**
 * @param {{ packageDir: string, runNumber: string, commitSha: string, outDir: string }} input
 * @returns {{ version: string, files: string[] }} the release version and the staged file names, SHA256SUMS last
 * @throws {StageReleaseError}
 */
export function stageRelease({ packageDir, runNumber, commitSha, outDir }) {
  const packageVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
  let version;
  try {
    version = resolveAppVersion(packageVersion, runNumber);
  } catch (error) {
    throw new StageReleaseError(
      `the run number cannot form a release version: ${/** @type {Error} */ (error).message}`,
    );
  }
  if (version === packageVersion) throw new StageReleaseError('GITHUB_RUN_NUMBER is not set.');
  if (!COMMIT_SHA_RE.test(commitSha)) throw new StageReleaseError('GITHUB_SHA is not a full commit hash.');

  const buildDir = join(packageDir, 'dist', 'agraharam', version);
  if (!existsSync(join(buildDir, MANIFEST_FILE))) {
    throw new StageReleaseError(
      `dist/agraharam/${version}/${MANIFEST_FILE} is missing: build with AGR_PATCH set to this run number.`,
    );
  }
  assertManifest(JSON.parse(readFileSync(join(buildDir, MANIFEST_FILE), 'utf8')), version, commitSha);
  const listed = verifiedChecksumNames(buildDir);

  if (existsSync(outDir)) throw new StageReleaseError(`${outDir} already exists; stage into a new directory.`);
  mkdirSync(outDir, { recursive: true });
  const files = [...listed, CHECKSUMS_FILE];
  for (const file of files) copyFileSync(join(buildDir, file), join(outDir, file));
  return { version, files };
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} version
 * @param {string} commitSha
 */
function assertManifest(manifest, version, commitSha) {
  if (manifest['version'] !== version) {
    throw new StageReleaseError(`manifest.json version is not ${version}, the version this run must publish.`);
  }
  if (manifest['git_dirty'] !== false) {
    throw new StageReleaseError('manifest.json says the build had uncommitted changes (git_dirty is not false).');
  }
  const gitSha = manifest['git_sha'];
  if (typeof gitSha !== 'string' || !SHORT_SHA_RE.test(gitSha) || !commitSha.startsWith(gitSha)) {
    throw new StageReleaseError('manifest.json git_sha is not a prefix of GITHUB_SHA: the build is of another commit.');
  }
  if (manifest['entry'] !== BUNDLE_ENTRY) throw new StageReleaseError(`manifest.json entry is not ${BUNDLE_ENTRY}.`);
}

/**
 * Verifies SHA256SUMS and returns the names it lists, which must be exactly postbuild's release files without
 * SHA256SUMS itself (§17.2). The directory must hold exactly those files plus SHA256SUMS, so nothing unlisted can
 * ride along into the release and nothing expected can be missing from it.
 * @param {string} buildDir
 * @returns {string[]}
 */
function verifiedChecksumNames(buildDir) {
  const lines = readFileSync(join(buildDir, CHECKSUMS_FILE), 'utf8').split('\n');
  if (lines.pop() !== '') throw new StageReleaseError(`${CHECKSUMS_FILE} must end with a newline.`);
  const entries = lines.map((line, index) => {
    const match = SUM_LINE_RE.exec(line);
    if (match === null) {
      throw new StageReleaseError(`${CHECKSUMS_FILE} line ${index + 1} is not "<sha256>  <flat file name>".`);
    }
    const [, sum, name] = /** @type {[string, string, string]} */ (match);
    return { sum, name };
  });
  const names = entries.map((entry) => entry.name);
  const expected = RELEASE_FILES.filter((file) => file !== CHECKSUMS_FILE);
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
    throw new StageReleaseError(
      `${CHECKSUMS_FILE} must list exactly ${expected.join(', ')}, once each (it lists ${names.length} name(s)).`,
    );
  }
  for (const { sum, name } of entries) {
    if (!existsSync(join(buildDir, name)))
      throw new StageReleaseError(`${name} is listed in ${CHECKSUMS_FILE} but missing.`);
    const actual = createHash('sha256')
      .update(readFileSync(join(buildDir, name)))
      .digest('hex');
    if (actual !== sum) throw new StageReleaseError(`${name} does not match ${CHECKSUMS_FILE}.`);
  }
  const directoryEntries = readdirSync(buildDir, { withFileTypes: true });
  const unlisted = directoryEntries.filter(
    (entry) => !entry.isFile() || (entry.name !== CHECKSUMS_FILE && !names.includes(entry.name)),
  );
  if (unlisted.length > 0) {
    throw new StageReleaseError(
      `the build directory holds ${unlisted.length} entry(ies) that ${CHECKSUMS_FILE} omits.`,
    );
  }
  return names;
}

if (import.meta.main) {
  const packageDir = fileURLToPath(new URL('../..', import.meta.url));
  const outArg = process.argv[2];
  try {
    if (outArg === undefined)
      throw new StageReleaseError('usage: node scripts/ci/stage-release.mjs <output directory>');
    const { version, files } = stageRelease({
      packageDir,
      runNumber: process.env['GITHUB_RUN_NUMBER'] ?? '',
      commitSha: process.env['GITHUB_SHA'] ?? '',
      outDir: resolve(outArg),
    });
    console.log(`stage-release: ${version}: staged ${files.join(', ')}`);
  } catch (error) {
    console.error(`stage-release: ${error instanceof Error ? error.message : 'unexpected failure'}`);
    process.exitCode = 1;
  }
}
