import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeFontFace {
  static instances: FakeFontFace[] = [];
  readonly family: string;
  readonly source: string;
  readonly descriptors: FontFaceDescriptors;
  constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
    this.family = family;
    this.source = source;
    this.descriptors = descriptors;
    FakeFontFace.instances.push(this);
  }
  load(): Promise<this> {
    return this.family === 'Agraharam Sans' ? Promise.reject(new Error('network')) : Promise.resolve(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeFontFace.instances = [];
});

describe('ensureFonts (§11.4, D3)', () => {
  it('registers both faces once through document.fonts from module-relative asset URLs', async () => {
    const added: unknown[] = [];
    vi.stubGlobal('FontFace', FakeFontFace);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: (face: unknown) => added.push(face) },
    });
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
    expect(FakeFontFace.instances[0]?.source).toMatch(
      /^url\(.*newsreader-latin-opsz-normal.*\.woff2\) format\('woff2'\)$/,
    );
    expect(FakeFontFace.instances[1]?.source).toMatch(/hanken-grotesk-latin-wght-normal.*\.woff2/);
    expect(warn).toHaveBeenCalledWith('[agraharam]', 'font-load-failed');
  });

  it('does nothing where the FontFace API is missing', async () => {
    vi.stubGlobal('FontFace', undefined);
    const { ensureFonts } = await import('../../src/styles/fonts.ts');
    expect(() => ensureFonts()).not.toThrow();
  });
});
