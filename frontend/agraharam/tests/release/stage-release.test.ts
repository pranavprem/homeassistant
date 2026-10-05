/**
 * The release-build check (§17.5), scripts/ci/stage-release.mjs, on releases made by the real postbuild: only the
 * build this run must publish is staged, and exactly the SHA256SUMS-listed files plus SHA256SUMS.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageRelease, StageReleaseError } from '../../scripts/ci/stage-release.mjs';
import { buildFakeRelease, FAKE_BUILD_INFO, writeFile } from '../scripts/support/fake-build.ts';
import { isolatedEnv, PACKAGE_DIR } from '../scripts/support/temp-repo.ts';

const RUN_NUMBER = '42';
const VERSION = '0.3.42';
const COMMIT_SHA = `${FAKE_BUILD_INFO.gitSha}${'c'.repeat(28)}`;
const RELEASE_ASSETS = [
  'OFL-1.1-Hanken-Grotesk.txt',
  'OFL-1.1-Newsreader.txt',
  'THIRD_PARTY_LICENSES.md',
  'agraharam.js',
  'manifest.json',
  'SHA256SUMS',
];

let tmp: string;
let packageDir: string;
let buildDir: string;
let outDir: string;

function stage(overrides: Partial<Parameters<typeof stageRelease>[0]> = {}) {
  return stageRelease({ packageDir, runNumber: RUN_NUMBER, commitSha: COMMIT_SHA, outDir, ...overrides });
}

function editManifest(edit: (manifest: Record<string, unknown>) => void): void {
  const path = join(buildDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agr-stage-release-')));
  packageDir = join(tmp, 'pkg');
  writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'agraharam-dashboard', version: '0.3.0' }));
  buildDir = buildFakeRelease(packageDir, VERSION);
  outDir = join(tmp, 'release');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('stageRelease', () => {
  it('stages exactly the SHA256SUMS-listed files plus SHA256SUMS, byte for byte', () => {
    const { version, files } = stage();
    expect(version).toBe(VERSION);
    expect(files).toEqual(RELEASE_ASSETS);
    expect(readdirSync(outDir).sort()).toEqual([...RELEASE_ASSETS].sort());
    for (const file of files) {
      expect(readFileSync(join(outDir, file)).equals(readFileSync(join(buildDir, file))), file).toBe(true);
    }
  });

  it.each([
    ['a missing run number', { runNumber: '' }, /GITHUB_RUN_NUMBER is not set/],
    ['a malformed run number', { runNumber: '042' }, /cannot form a release version/],
    ['another run number (another version)', { runNumber: '43' }, /0\.3\.43\/manifest\.json is missing/],
    ['a short commit hash', { commitSha: FAKE_BUILD_INFO.gitSha }, /GITHUB_SHA is not a full commit hash/],
    ['another commit', { commitSha: 'd'.repeat(40) }, /git_sha is not a prefix of GITHUB_SHA/],
  ])('refuses %s', (_label, overrides, message) => {
    expect(() => stage(overrides)).toThrow(message);
  });

  it.each([
    ['another version', (m: Record<string, unknown>) => (m['version'] = '0.3.41'), /version is not 0\.3\.42/],
    ['a dirty build', (m: Record<string, unknown>) => (m['git_dirty'] = true), /uncommitted changes/],
    ['an unknown git state', (m: Record<string, unknown>) => (m['git_sha'] = 'unknown'), /not a prefix/],
    ['another entry', (m: Record<string, unknown>) => (m['entry'] = 'other.js'), /entry is not agraharam\.js/],
  ])('refuses a manifest with %s', (_label, edit, message) => {
    editManifest(edit);
    // The manifest is covered by SHA256SUMS, but the manifest checks come first and name the real problem.
    expect(() => stage()).toThrow(message);
  });

  it('refuses a file that does not match SHA256SUMS', () => {
    writeFileSync(join(buildDir, 'agraharam.js'), 'tampered();\n');
    expect(() => stage()).toThrow(/agraharam\.js does not match SHA256SUMS/);
  });

  it('refuses an unlisted file or directory in the build, so nothing rides along', () => {
    writeFileSync(join(buildDir, 'notes.md'), 'extra');
    expect(() => stage()).toThrow(/1 entry\(ies\) that SHA256SUMS omits/);
    rmSync(join(buildDir, 'notes.md'));
    writeFile(join(buildDir, 'fonts/face.woff2'), 'x');
    expect(() => stage()).toThrow(/SHA256SUMS omits/);
  });

  it.each([
    ['a nested path', 'fonts/face.woff2'],
    ['a parent path', '../outside.js'],
    ['a hidden name', '.env'],
    ['an option-like name', '-rf'],
  ])('refuses a SHA256SUMS line with %s', (_label, name) => {
    const sums = readFileSync(join(buildDir, 'SHA256SUMS'), 'utf8');
    writeFileSync(join(buildDir, 'SHA256SUMS'), `${sums}${'0'.repeat(64)}  ${name}\n`);
    expect(() => stage()).toThrow(/is not "<sha256> {2}<flat file name>"/);
  });

  it('refuses a SHA256SUMS that lists an extra file, even one with a correct sum', () => {
    writeFileSync(join(buildDir, 'extra.txt'), 'extra\n');
    const sum = createHash('sha256').update('extra\n').digest('hex');
    writeFileSync(
      join(buildDir, 'SHA256SUMS'),
      `${readFileSync(join(buildDir, 'SHA256SUMS'), 'utf8')}${sum}  extra.txt\n`,
    );
    expect(() => stage()).toThrow(/must list exactly OFL-1\.1-Hanken-Grotesk\.txt, OFL-1\.1-Newsreader\.txt/);
  });

  it("refuses a release missing one of postbuild's files, even when SHA256SUMS omits it too", () => {
    rmSync(join(buildDir, 'OFL-1.1-Newsreader.txt'));
    const sums = readFileSync(join(buildDir, 'SHA256SUMS'), 'utf8').split('\n');
    writeFileSync(join(buildDir, 'SHA256SUMS'), sums.filter((line) => !line.endsWith('Newsreader.txt')).join('\n'));
    expect(() => stage()).toThrow(/must list exactly/);
  });

  it('refuses a listed file that is missing from the build', () => {
    rmSync(join(buildDir, 'THIRD_PARTY_LICENSES.md'));
    expect(() => stage()).toThrow(/THIRD_PARTY_LICENSES\.md is listed in SHA256SUMS but missing/);
  });

  it('never stages into an existing directory', () => {
    writeFile(join(outDir, 'keep.txt'), 'x');
    expect(() => stage()).toThrow(StageReleaseError);
    expect(readdirSync(outDir)).toEqual(['keep.txt']);
  });
});

describe('stage-release.mjs (CLI)', () => {
  it('needs an output directory and reports failures on one line with exit 1', () => {
    const result = spawnSync(process.execPath, [join(PACKAGE_DIR, 'scripts/ci/stage-release.mjs')], {
      cwd: tmp,
      env: isolatedEnv(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('stage-release: usage: node scripts/ci/stage-release.mjs <output directory>');
  });
});
