/**
 * install.sh (§13.2, §12.1, §17.2) spawned with bash against temp directories: a flat release made by the real
 * postbuild (and the same files as a downloaded release), a fake HA config share, and fictional private files for
 * the privacy re-scan.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFakeRelease } from '../scripts/support/fake-build.ts';
import { isolatedEnv, PACKAGE_DIR } from '../scripts/support/temp-repo.ts';

const INSTALL_SH = join(PACKAGE_DIR, 'install/install.sh');
const VERSION = '9.9.9';
const PLANTED_ID = 'person.demo_install_owner';
/** The flat §17.2 release: also exactly the release assets the workflow attaches. */
const EXPECTED_FILES = [
  'OFL-1.1-Hanken-Grotesk.txt',
  'OFL-1.1-Newsreader.txt',
  'SHA256SUMS',
  'THIRD_PARTY_LICENSES.md',
  'agraharam.js',
  'manifest.json',
];

let tmp: string;
let src: string;
let privateDir: string;
let www: string;
let dest: string;

interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function install(args: readonly string[], env: NodeJS.ProcessEnv = isolatedEnv({ AGR_PRIVATE_DIR: privateDir })) {
  const result = spawnSync('bash', [INSTALL_SH, ...args], { cwd: tmp, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr } satisfies Result;
}

function standardArgs(...extra: string[]): string[] {
  return ['--dest', dest, '--src', src, '--version', VERSION, ...extra];
}

/** Every file and directory under `dir`, relative, sorted (C order). */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)) + (entry.isDirectory() ? '/' : ''))
    .sort();
}

function filesOnly(dir: string): string[] {
  return tree(dir)
    .filter((path) => !path.endsWith('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agr-install-')));
  src = buildFakeRelease(join(tmp, 'pkg'), VERSION);
  privateDir = join(tmp, 'private');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'bindings.candidates.json'), JSON.stringify({ groups: { people: [PLANTED_ID] } }));
  www = join(tmp, 'ha/config/www');
  mkdirSync(www, { recursive: true });
  dest = join(www, 'agraharam');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('install.sh: dry run', () => {
  it('writes nothing and prints the stable plan, including the first-install mkdir line', () => {
    const result = install(standardArgs());
    expect(result.status).toBe(0);
    expect(tree(www)).toEqual([]);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('agraharam install plan (dry run: nothing written)');
    expect(lines[1]).toMatch(
      new RegExp(`^source {7}\\S+/${VERSION} {3}manifest ${VERSION} {2}git 0123456789ab {2}clean$`),
    );
    expect(lines).toContain(`destination  ${dest}/${VERSION}   (absent: ok)`);
    expect(lines).toContain(`destination parent absent: will create ${dest}   (first install only)`);
    expect(lines).toContain('checksums    5 files verified');
    expect(lines).toContain('privacy      re-scanned with check-public --dist');
    const copied = lines.filter((line) => line.startsWith('copy ')).map((line) => line.split(/\s+/)[1]);
    expect(copied).toEqual([
      'agraharam.js',
      'THIRD_PARTY_LICENSES.md',
      'OFL-1.1-Hanken-Grotesk.txt',
      'OFL-1.1-Newsreader.txt',
      'manifest.json',
      'SHA256SUMS',
    ]);
    const bundleBytes = statSync(join(src, 'agraharam.js')).size.toLocaleString('en-US');
    expect(lines.find((line) => line.startsWith('copy         agraharam.js'))).toMatch(
      new RegExp(`\\s${bundleBytes} B {2}sha256 [0-9a-f]{4}…[0-9a-f]{4}$`),
    );
    expect(lines.slice(-4)).toEqual([
      `resource     /local/agraharam/${VERSION}/agraharam.js   (type: module; create or update, see install/README.md)`,
      'dashboard    url_path agraharam-next, view path home   (create once; see install/README.md)',
      'restart      not performed; required only if www did not exist when HA last started',
      'next         re-run with --apply to copy',
    ]);
  });

  it('omits the mkdir line when the agraharam directory already exists', () => {
    mkdirSync(dest);
    const result = install(standardArgs());
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('destination parent absent');
    expect(tree(dest)).toEqual([]);
  });
});

describe('install.sh: --apply', () => {
  it('on a first install creates <dest> with one mkdir and copies exactly the allowlisted files', () => {
    const result = install(standardArgs('--apply'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('agraharam install (apply)');
    expect(result.stdout).toContain(`installed    ${dest}/${VERSION}`);
    expect(readdirSync(www)).toEqual(['agraharam']);
    const installed = join(dest, VERSION);
    expect(filesOnly(installed)).toEqual(EXPECTED_FILES);
    for (const file of EXPECTED_FILES) {
      expect(readFileSync(join(installed, file)).equals(readFileSync(join(src, file))), file).toBe(true);
      expect(statSync(join(installed, file)).mode & 0o777, file).toBe(0o644);
    }
    for (const dir of [dest, installed]) expect(statSync(dir).mode & 0o777, dir).toBe(0o755);
    expect(readdirSync(dest)).toEqual([VERSION]);
    const verify = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: installed, encoding: 'utf8' });
    if (!verify.error) expect(verify.status).toBe(0);
  });

  it('installs a flat release downloaded into a directory named after its version', () => {
    // As `gh release download v9.9.9 --dir 9.9.9` leaves it: exactly the attached assets, nothing else.
    const downloaded = join(tmp, 'downloads', VERSION);
    mkdirSync(downloaded, { recursive: true });
    for (const file of EXPECTED_FILES) copyFileSync(join(src, file), join(downloaded, file));
    const result = install(['--dest', dest, '--src', downloaded, '--version', VERSION, '--apply']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^source {7}\\S+/downloads/${VERSION} {3}manifest ${VERSION} `, 'm'));
    expect(filesOnly(join(dest, VERSION))).toEqual(EXPECTED_FILES);
    for (const file of EXPECTED_FILES) {
      expect(readFileSync(join(dest, VERSION, file)).equals(readFileSync(join(downloaded, file))), file).toBe(true);
    }
  });

  it('installs a second version beside the first without touching it', () => {
    expect(install(standardArgs('--apply')).status).toBe(0);
    const before = readFileSync(join(dest, VERSION, 'agraharam.js'));
    const nextSrc = buildFakeRelease(join(tmp, 'pkg2'), '9.9.10', { bundle: 'export const next = 2;\n' });
    const result = install(['--dest', dest, '--src', nextSrc, '--version', '9.9.10', '--apply']);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(dest).sort()).toEqual(['9.9.10', VERSION]);
    expect(readFileSync(join(dest, VERSION, 'agraharam.js')).equals(before)).toBe(true);
  });
});

describe('install.sh: --apply races and leftovers', () => {
  it('never removes a stale partial directory it did not create (same PID), and installs nothing', () => {
    const stale = `.${VERSION}.partial-`;
    // exec keeps the PID, so install.sh's $$ equals the $$ this wrapper used to plant the stale directory.
    const wrapper = `mkdir -p "$DEST/${stale}$$" && echo stale > "$DEST/${stale}$$/marker" && exec bash "$@"`;
    const result = spawnSync('bash', ['-c', wrapper, 'wrapper', INSTALL_SH, ...standardArgs('--apply')], {
      cwd: tmp,
      env: isolatedEnv({ AGR_PRIVATE_DIR: privateDir, DEST: dest }),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toContain('stale partial directory');
    const entries = readdirSync(dest);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(new RegExp(`^\\.${VERSION.replaceAll('.', '\\.')}\\.partial-\\d+$`));
    expect(readFileSync(join(dest, entries[0] as string, 'marker'), 'utf8')).toBe('stale\n');
  });

  /**
   * A test double for `mv` that plants something at the rename target right before running the real `mv`, which
   * is exactly the gap between install.sh's last existence check and its rename.
   */
  function withRacingMv(plant: string): NodeJS.ProcessEnv {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const realMv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(
      join(bin, 'mv'),
      [
        '#!/bin/sh',
        `case "$1" in --version) exec "${realMv}" "$@" ;; esac`,
        'for target in "$@"; do :; done',
        plant,
        `exec "${realMv}" "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return isolatedEnv({ AGR_PRIVATE_DIR: privateDir, PATH: `${bin}:${process.env.PATH ?? ''}` });
  }

  it('never moves the copy through a symbolic link planted at <dest>/<version> just before the rename', () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    const result = install(standardArgs('--apply'), withRacingMv(`ln -s "${elsewhere}" "$target"`));
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toContain('appeared while installing');
    expect(tree(elsewhere)).toEqual([]);
    expect(readdirSync(dest)).toEqual([VERSION]);
    expect(lstatSync(join(dest, VERSION)).isSymbolicLink()).toBe(true);
  });

  it('leaves a real directory that appears at <dest>/<version> alone and removes only its own copy', () => {
    const plant = 'mkdir "$target" && echo older > "$target/agraharam.js"';
    const result = install(standardArgs('--apply'), withRacingMv(plant));
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toContain('appeared while installing');
    expect(tree(dest)).toEqual([`${VERSION}/`, `${VERSION}/agraharam.js`]);
    expect(readFileSync(join(dest, VERSION, 'agraharam.js'), 'utf8')).toBe('older\n');
  });
});

describe('install.sh: refusals', () => {
  it('refuses an existing version with exit 4 and leaves it untouched', () => {
    mkdirSync(join(dest, VERSION), { recursive: true });
    writeFileSync(join(dest, VERSION, 'agraharam.js'), 'older');
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('Versions are never overwritten');
    expect(tree(dest)).toEqual([`${VERSION}/`, `${VERSION}/agraharam.js`]);
    expect(readFileSync(join(dest, VERSION, 'agraharam.js'), 'utf8')).toBe('older');
  });

  it('refuses a bad checksum with exit 3 and writes nothing', () => {
    writeFileSync(join(src, 'agraharam.js'), 'tampered();\n');
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('SHA256SUMS');
    expect(tree(www)).toEqual([]);
  });

  it.each([
    ['a file outside the allowlist', 'index.html', 'file not on the install allowlist'],
    ['active content beside the bundle', 'notice.svg', 'file not on the install allowlist'],
    ['release notes next to the assets (the workflow never attaches them)', 'notes.md', 'not on the install allowlist'],
    ['a subdirectory, which a flat release never has', 'fonts/face.woff2', 'unexpected directory in the source'],
  ])('refuses %s with exit 3', (_label, file, message) => {
    mkdirSync(dirname(join(src, file)), { recursive: true });
    writeFileSync(join(src, file), 'extra');
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(message);
    expect(tree(www)).toEqual([]);
  });

  it('refuses a release file that SHA256SUMS does not cover', () => {
    const sums = readFileSync(join(src, 'SHA256SUMS'), 'utf8').split('\n');
    writeFileSync(join(src, 'SHA256SUMS'), sums.filter((line) => !line.endsWith('OFL-1.1-Newsreader.txt')).join('\n'));
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('file not covered by SHA256SUMS: OFL-1.1-Newsreader.txt');
    expect(tree(www)).toEqual([]);
  });

  it('refuses a release with a missing file, even when SHA256SUMS omits it too', () => {
    rmSync(join(src, 'OFL-1.1-Hanken-Grotesk.txt'));
    const sums = readFileSync(join(src, 'SHA256SUMS'), 'utf8').split('\n');
    writeFileSync(join(src, 'SHA256SUMS'), sums.filter((line) => !line.endsWith('Hanken-Grotesk.txt')).join('\n'));
    const result = install(standardArgs());
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('missing OFL-1.1-Hanken-Grotesk.txt');
  });

  it('refuses a symbolic link inside the source', () => {
    symlinkSync(join(src, 'agraharam.js'), join(src, 'link.txt'));
    expect(install(standardArgs()).status).toBe(3);
  });

  it.each([
    ['a basename other than agraharam', () => join(www, 'other')],
    ['a parent other than www', () => join(tmp, 'ha/config/web/agraharam')],
    ['a relative path', () => 'ha/config/www/agraharam'],
  ])('refuses a destination with %s (exit 2)', (_label, makeDest) => {
    const result = install(['--dest', makeDest(), '--src', src, '--version', VERSION, '--apply']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('www/agraharam');
    expect(tree(www)).toEqual([]);
  });

  it.each([[[]], [['--dest']], [['--dest', '/x/www/agraharam', '--bogus']]])('exits 2 on bad usage %j', (args) => {
    expect(install(args as string[]).status).toBe(2);
  });

  it('refuses a symlinked --dest and writes nothing through the link', () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, dest);
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('refusing a symlinked destination');
    expect(tree(elsewhere)).toEqual([]);
  });

  it('refuses a symlinked www', () => {
    const realWww = join(tmp, 'real-www');
    mkdirSync(realWww);
    rmSync(www, { recursive: true });
    symlinkSync(realWww, www);
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('refusing a symlinked destination');
    expect(tree(realWww)).toEqual([]);
  });

  it('refuses a destination reached through a symlinked ancestor (physical path differs)', () => {
    symlinkSync(join(tmp, 'ha'), join(tmp, 'ha-link'));
    const linked = join(tmp, 'ha-link/config/www/agraharam');
    const result = install(['--dest', linked, '--src', src, '--version', VERSION, '--apply']);
    expect(result.status).toBe(3);
    expect(tree(www)).toEqual([]);
  });

  it('never creates www: exit 3 with the restart note, and www still absent', () => {
    rmSync(www, { recursive: true });
    const result = install(standardArgs('--apply'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('HA serves /local only if /config/www existed at startup');
    expect(result.stderr).toContain('This script never restarts HA.');
    expect(existsSync(www)).toBe(false);
  });

  it('refuses a dirty build unless --allow-dirty, which warns', () => {
    const dirtySrc = buildFakeRelease(join(tmp, 'dirty'), VERSION, { gitDirty: true });
    const refused = install(['--dest', dest, '--src', dirtySrc, '--version', VERSION]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('uncommitted changes');
    const allowed = install(['--dest', dest, '--src', dirtySrc, '--version', VERSION, '--allow-dirty']);
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain('warning');
    expect(allowed.stdout).toMatch(/git 0123456789ab {2}dirty$/m);
  });

  it('refuses a version that does not match the source directory and manifest', () => {
    const result = install(['--dest', dest, '--src', src, '--version', '1.0.0']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('version mismatch');
  });

  it('fails the privacy re-scan (exit 3) when a private value reached the build', () => {
    const leakySrc = buildFakeRelease(join(tmp, 'leaky'), VERSION, { bundle: `const o="${PLANTED_ID}";\n` });
    const result = install(['--dest', dest, '--src', leakySrc, '--version', VERSION, '--apply']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('privacy re-scan failed');
    expect(result.stdout + result.stderr).not.toContain(PLANTED_ID);
    expect(tree(www)).toEqual([]);
  });

  it('fails the privacy re-scan (exit 3) when no private directory is found, naming the escape hatch', () => {
    const result = install(standardArgs(), isolatedEnv({ AGR_PRIVATE_DIR: join(tmp, 'absent-private') }));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('privacy re-scan failed');
    expect(result.stderr).toContain('--allow-missing-private');
  });

  it('with --allow-missing-private, says in the plan that the re-scan was skipped', () => {
    const env = isolatedEnv({ AGR_PRIVATE_DIR: join(tmp, 'absent-private') });
    const result = install(standardArgs('--allow-missing-private'), env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'privacy      privacy re-scan skipped: no private files (--allow-missing-private given)',
    );
  });

  it('skips the privacy re-scan with a clear line when node is not on PATH', () => {
    const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const nodeOnSystemPath = spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: systemPath } }).status === 0;
    if (nodeOnSystemPath) return; // this machine ships node in a system directory; nothing to simulate
    const result = install(standardArgs(), { ...isolatedEnv(), PATH: systemPath });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('privacy re-scan skipped: node not found');
  });
});
