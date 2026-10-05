import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_LICENSES } from '../../scripts/lib/font-licenses.mjs';

const SERIF_FILE = '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2';
const SANS_FILE = '@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2';
const packageBytes = (file: string) => readFileSync(createRequire(import.meta.url).resolve(file));

class FakeFontFace {
  static instances: FakeFontFace[] = [];
  readonly family: string;
  readonly source: unknown;
  readonly descriptors: FontFaceDescriptors;
  constructor(family: string, source: unknown, descriptors: FontFaceDescriptors) {
    this.family = family;
    this.source = source;
    this.descriptors = descriptors;
    FakeFontFace.instances.push(this);
  }
  load(): Promise<this> {
    return this.family === 'Agraharam Sans' ? Promise.reject(new Error('parse')) : Promise.resolve(this);
  }
}

function stubDocumentFonts(): unknown[] {
  const added: unknown[] = [];
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: unknown) => added.push(face) },
  });
  return added;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock(`${SERIF_FILE}?inline`);
  vi.resetModules();
  FakeFontFace.instances = [];
});

describe('ensureFonts (§11.4, §17.2, D3)', () => {
  it('registers both embedded faces once, from the exact package font bytes', async () => {
    const added = stubDocumentFonts();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ensureFonts } = await import('../../src/styles/fonts.ts');
    ensureFonts();
    ensureFonts();
    await Promise.resolve();
    await Promise.resolve();
    expect(added).toHaveLength(2);
    expect(
      FakeFontFace.instances.map((face) => [face.family, face.descriptors.weight, face.descriptors.display]),
    ).toEqual([
      ['Agraharam Serif', '200 800', 'swap'],
      ['Agraharam Sans', '100 900', 'swap'],
    ]);
    const [serif, sans] = FakeFontFace.instances.map((face) => face.source);
    expect(serif).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(serif as ArrayBuffer).equals(packageBytes(SERIF_FILE))).toBe(true);
    expect(Buffer.from(sans as ArrayBuffer).equals(packageBytes(SANS_FILE))).toBe(true);
    expect(warn).toHaveBeenCalledWith('[agraharam]', 'font-load-failed');
  });

  it('skips a face whose embedded data is not a base64 data URL and keeps the other', async () => {
    vi.doMock(`${SERIF_FILE}?inline`, () => ({ default: 'fonts/newsreader.woff2' }));
    const added = stubDocumentFonts();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ensureFonts } = await import('../../src/styles/fonts.ts');
    ensureFonts();
    expect(added).toHaveLength(1);
    expect(FakeFontFace.instances.map((face) => face.family)).toEqual(['Agraharam Sans']);
    expect(warn).toHaveBeenCalledWith('[agraharam]', 'font-load-failed');
  });

  it('contains a payload that is not valid base64: logs, keeps the other face, never throws', async () => {
    vi.doMock(`${SERIF_FILE}?inline`, () => ({ default: 'data:font/woff2;base64,@@not base64@@' }));
    const added = stubDocumentFonts();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ensureFonts } = await import('../../src/styles/fonts.ts');
    expect(() => ensureFonts()).not.toThrow();
    expect(FakeFontFace.instances.map((face) => face.family)).toEqual(['Agraharam Sans']);
    expect(added).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[agraharam]', 'font-load-failed');
  });

  it('contains a FontFace constructor that throws', async () => {
    vi.stubGlobal(
      'FontFace',
      class {
        constructor() {
          throw new TypeError('unsupported source');
        }
      },
    );
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: () => undefined } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ensureFonts } = await import('../../src/styles/fonts.ts');
    expect(() => ensureFonts()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('embeds exactly the font files postbuild verifies (scripts/lib/font-licenses.mjs)', () => {
    const source = readFileSync(join(process.cwd(), 'src/styles/fonts.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)\?inline'/g)].map((match) => match[1]);
    expect(imports).toEqual(FONT_LICENSES.map((font) => `${font.licensePackage}/${font.fontFile}`));
    expect(imports).toEqual([SERIF_FILE, SANS_FILE]);
  });

  it('does nothing where the FontFace API is missing', async () => {
    vi.stubGlobal('FontFace', undefined);
    const { ensureFonts } = await import('../../src/styles/fonts.ts');
    expect(() => ensureFonts()).not.toThrow();
  });
});
