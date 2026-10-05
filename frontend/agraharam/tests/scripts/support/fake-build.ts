/**
 * A fake `vite build` output in a temp package directory, and a release made from it by the real postbuild, so the
 * postbuild and install suites exercise exactly the files a real build ships: the flat §17.2 layout, with the legal
 * banner built from the (fictional) font package licenses and both (fictional) package fonts embedded as base64
 * `data:` URLs, as Vite's `?inline` writes them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FONT_LICENSES, fontFilePath, fontLicensePath, legalBanner } from '../../../scripts/lib/font-licenses.mjs';
import { postbuild } from '../../../scripts/postbuild.mjs';

/** The module body after the banner and the embedded fonts. */
export const CLEAN_BUNDLE = 'const ns="http://www.w3.org/2000/svg";export{ns};\n';
/**
 * Fictional package font files. The serif one starts with `{"`, whose base64 starts with `eyJ`: a forbidden literal
 * that postbuild must ignore inside a verified font payload, and only there.
 */
export const FAKE_FONT_FILES = Object.freeze({
  serif: Buffer.from('{"wOF2 demo serif"}\u0000'),
  sans: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x02]),
});

export const FAKE_BUILD_INFO = Object.freeze({
  gitSha: '0123456789ab',
  gitDirty: false,
  commitTime: '2026-09-30T17:51:00-07:00',
});

/** A base64 `data:` URL as Vite's `?inline` writes it. */
export function dataUrl(bytes: Buffer, mime = 'font/woff2'): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** Shaped like a Fontsource OFL LICENSE: notices for the upright and italic files, then the license itself. */
function fakeOflLicense(project: string): string {
  const notice = `Copyright 2020 The ${project} Project Authors (https://example.invalid/${project.toLowerCase()})`;
  return [
    `${notice} ${project}-Italic[wght].ttf: ${notice}`,
    '',
    'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
    'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007',
    '',
  ].join('\n');
}

export function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Both font packages' licenses and font files in node_modules, as `npm ci` leaves them. */
export function writeFontPackages(packageDir: string): void {
  const fakes: Readonly<Record<string, { project: string; bytes: Buffer }>> = {
    '@fontsource-variable/newsreader': { project: 'Demoserif', bytes: FAKE_FONT_FILES.serif },
    '@fontsource-variable/hanken-grotesk': { project: 'Demosans', bytes: FAKE_FONT_FILES.sans },
  };
  for (const font of FONT_LICENSES) {
    const fake = fakes[font.licensePackage];
    if (fake === undefined) throw new Error(`no fake package for ${font.licensePackage}`);
    writeFile(fontLicensePath(packageDir, font), fakeOflLicense(fake.project));
    writeFile(fontFilePath(packageDir, font), fake.bytes);
  }
}

/** The module's font constants, as the minified fonts.ts leaves them. */
export const EMBEDDED_FONTS = `const s="${dataUrl(FAKE_FONT_FILES.serif)}",h="${dataUrl(FAKE_FONT_FILES.sans)}";\n`;

/**
 * The bundle text Vite would write for `body`: the legal banner (Rolldown postBanner), a newline, the embedded
 * fonts, then the module.
 */
export function bundleText(packageDir: string, body: string = CLEAN_BUNDLE, fonts: string = EMBEDDED_FONTS): string {
  return `${legalBanner(packageDir)}\n${fonts}${body}`;
}

/** What `vite build` leaves in dist/agraharam/<version>/, plus both font packages' licenses in node_modules. */
export function layOutViteOutput(
  packageDir: string,
  version: string,
  body: string = CLEAN_BUNDLE,
  fonts: string = EMBEDDED_FONTS,
): string {
  const bundleDir = join(packageDir, 'dist/agraharam', version);
  writeFontPackages(packageDir);
  writeFile(join(bundleDir, 'agraharam.js'), bundleText(packageDir, body, fonts));
  writeFile(join(bundleDir, 'agraharam.js.map'), '{"version":3}');
  writeFile(
    join(bundleDir, 'THIRD_PARTY_LICENSES.md'),
    [
      '# Licenses',
      '',
      '## @fontsource-variable/hanken-grotesk - 5.3.0 (OFL-1.1)',
      '',
      '## @fontsource-variable/newsreader - 5.3.0 (OFL-1.1)',
      '',
      '## lit - 3.3.3 (BSD-3-Clause)',
      '',
    ].join('\n'),
  );
  return bundleDir;
}

/** A complete release (manifest and SHA256SUMS) built by the real postbuild; returns its directory. */
export function buildFakeRelease(
  packageDir: string,
  version: string,
  options: { gitDirty?: boolean; bundle?: string } = {},
): string {
  layOutViteOutput(packageDir, version, options.bundle);
  return postbuild({
    packageDir,
    version,
    build: { ...FAKE_BUILD_INFO, gitDirty: options.gitDirty ?? false },
    nodeVersion: 'v24.0.0',
    forbidden: null,
  }).bundleDir;
}
