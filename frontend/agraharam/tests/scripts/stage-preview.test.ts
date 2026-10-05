import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stagePreview } from '../../scripts/stage-preview.mjs';

const VERSION = '9.9.17';
/** The flat §17.2 release directory, fonts embedded in the module. */
const BUILT_FILES: Readonly<Record<string, Buffer>> = {
  'agraharam.js': Buffer.from('/*! notice */\nexport const demo = 1;\n'),
  'manifest.json': Buffer.from('{"version":"9.9.17"}\n'),
  'OFL-1.1-Newsreader.txt': Buffer.from('SIL Open Font License\n'),
  SHA256SUMS: Buffer.from('0000  agraharam.js\n'),
  'THIRD_PARTY_LICENSES.md': Buffer.from('# Licenses\n'),
};

let packageDir: string;

function writeFile(path: string, content: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeBuild(version = VERSION): void {
  for (const [file, content] of Object.entries(BUILT_FILES)) {
    writeFile(join(packageDir, 'dist/agraharam', version, file), content);
  }
}

beforeEach(() => {
  packageDir = mkdtempSync(join(tmpdir(), 'agr-stage-preview-'));
});

afterEach(() => {
  rmSync(packageDir, { recursive: true, force: true });
});

describe('stagePreview', () => {
  it('copies the build byte for byte to the /local/agraharam/<version>/ preview path of the given version', () => {
    writeBuild();
    const { target } = stagePreview(packageDir, VERSION);
    expect(target).toBe(join(packageDir, 'dist/preview/local/agraharam', VERSION));
    expect(readdirSync(target).sort()).toEqual(Object.keys(BUILT_FILES).sort());
    for (const [file, content] of Object.entries(BUILT_FILES)) {
      expect(readFileSync(join(target, file)).equals(content), file).toBe(true);
    }
  });

  it('removes files left in the preview by an earlier build', () => {
    writeBuild();
    const stale = join(packageDir, 'dist/preview/local/agraharam', VERSION, 'fonts/old-face.woff2');
    writeFile(stale, 'stale');
    stagePreview(packageDir, VERSION);
    expect(existsSync(stale)).toBe(false);
  });

  it('refuses a build output that is not flat (§17.2)', () => {
    writeBuild();
    writeFile(join(packageDir, 'dist/agraharam', VERSION, 'fonts/face.woff2'), 'x');
    expect(() => stagePreview(packageDir, VERSION)).toThrow(/must be flat files only; found fonts/);
  });

  it('fails with an actionable message when that version has not been built', () => {
    writeBuild('9.9.9');
    expect(() => stagePreview(packageDir, VERSION)).toThrow(/agraharam\.js is missing\. Run "npm run build" first\./);
  });
});
