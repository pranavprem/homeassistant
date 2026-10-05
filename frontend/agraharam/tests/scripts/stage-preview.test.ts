import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stagePreview } from '../../scripts/stage-preview.mjs';

const VERSION = '9.9.9';
const BUILT_FILES: Readonly<Record<string, Buffer>> = {
  'agraharam.js': Buffer.from('export const demo = 1;\n'),
  'fonts/demo-serif.woff2': Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]),
  'LICENSES/THIRD_PARTY_LICENSES.md': Buffer.from('# Licenses\n'),
};

let packageDir: string;

function writeFile(path: string, content: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  packageDir = mkdtempSync(join(tmpdir(), 'agr-stage-preview-'));
  writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: VERSION }));
});

afterEach(() => {
  rmSync(packageDir, { recursive: true, force: true });
});

describe('stagePreview', () => {
  it('copies the build byte for byte to the /local/agraharam/<version>/ preview path', () => {
    for (const [file, content] of Object.entries(BUILT_FILES)) {
      writeFile(join(packageDir, 'dist/agraharam', VERSION, file), content);
    }
    const { target } = stagePreview(packageDir);
    expect(target).toBe(join(packageDir, 'dist/preview/local/agraharam', VERSION));
    for (const [file, content] of Object.entries(BUILT_FILES)) {
      expect(readFileSync(join(target, file)).equals(content), file).toBe(true);
    }
  });

  it('removes files left in the preview by an earlier build', () => {
    writeFile(join(packageDir, 'dist/agraharam', VERSION, 'agraharam.js'), 'export {};\n');
    const stale = join(packageDir, 'dist/preview/local/agraharam', VERSION, 'old-chunk.js');
    writeFile(stale, 'stale');
    stagePreview(packageDir);
    expect(existsSync(stale)).toBe(false);
  });

  it('fails with an actionable message when the bundle has not been built', () => {
    expect(() => stagePreview(packageDir)).toThrow(/agraharam\.js is missing\. Run "npm run build" first\./);
  });
});
