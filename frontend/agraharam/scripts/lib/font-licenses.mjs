/**
 * The two embedded OFL fonts and their legal notices (§17.2). `vite.config.ts` prepends `legalBanner()` to the bundle
 * with Rolldown `output.postBanner` (after minification, so it survives), and postbuild copies each font's full
 * license text next to the bundle, checks that the bundle starts with exactly this banner, and checks that the only
 * embedded data in the bundle is these two font files, byte for byte.
 *
 * The copyright lines are read from each Fontsource package's LICENSE file, never retyped, so a font update that
 * changes its notice changes the banner too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Each embedded font: its display name, the package that ships it, the file `src/styles/fonts.ts` embeds from it
 * (`<licensePackage>/<fontFile>?inline`, asserted by tests/root/fonts.test.ts) and the flat file its full license is
 * copied to.
 */
export const FONT_LICENSES = Object.freeze([
  Object.freeze({
    font: 'Newsreader',
    licensePackage: '@fontsource-variable/newsreader',
    fontFile: 'files/newsreader-latin-opsz-normal.woff2',
    licenseFile: 'OFL-1.1-Newsreader.txt',
  }),
  Object.freeze({
    font: 'Hanken Grotesk',
    licensePackage: '@fontsource-variable/hanken-grotesk',
    fontFile: 'files/hanken-grotesk-latin-wght-normal.woff2',
    licenseFile: 'OFL-1.1-Hanken-Grotesk.txt',
  }),
]);

/** Where the license's own preamble starts; the copyright notices precede it. */
const LICENSE_PREAMBLE = 'This Font Software is licensed under the SIL Open Font License';
/** One notice: "Copyright <years> <holder> (<url>)", as Google Fonts writes them. */
const COPYRIGHT_NOTICE_RE = /Copyright [^()\n]+\([^()\s]+\)/g;
/**
 * A notice goes into a JavaScript comment at the top of the shipped module, so it may hold printable ASCII only and
 * never `*` followed by `/`, which would end the comment and turn the rest of the notice into code.
 */
const SAFE_NOTICE_RE = /^[\x20-\x7e]+$/;
const COMMENT_END = '*/';

/** Thrown when a font package's LICENSE is missing or has no usable copyright notice; the build must stop. */
export class FontLicenseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FontLicenseError';
  }
}

/**
 * @param {string} packageDir absolute path of frontend/agraharam
 * @param {{ licensePackage: string }} font
 * @returns {string} absolute path of the package's LICENSE file
 */
export function fontLicensePath(packageDir, font) {
  return join(packageDir, 'node_modules', font.licensePackage, 'LICENSE');
}

/**
 * @param {string} packageDir absolute path of frontend/agraharam
 * @param {{ licensePackage: string, fontFile: string }} font
 * @returns {string} absolute path of the WOFF2 file the bundle embeds
 */
export function fontFilePath(packageDir, font) {
  return join(packageDir, 'node_modules', font.licensePackage, font.fontFile);
}

/**
 * The distinct copyright notices at the top of an OFL LICENSE file. Fontsource lists one per upstream font file
 * (upright and italic), usually identical, so duplicates collapse to one line.
 * @param {string} licenseText
 * @returns {string[]}
 * @throws {FontLicenseError} when a notice is not plain printable ASCII or could end the banner comment
 */
export function copyrightNotices(licenseText) {
  const preamble = licenseText.indexOf(LICENSE_PREAMBLE);
  const header = preamble === -1 ? licenseText : licenseText.slice(0, preamble);
  const notices = [...new Set(header.match(COPYRIGHT_NOTICE_RE) ?? [])];
  for (const notice of notices) {
    if (!SAFE_NOTICE_RE.test(notice) || notice.includes(COMMENT_END)) {
      throw new FontLicenseError(
        'A font copyright notice holds a character that cannot go into the bundle banner (non-printable or non-ASCII, ' +
          'or a comment end). Check the font package version before shipping it.',
      );
    }
  }
  return notices;
}

/**
 * The self-contained legal comment for the bundle: both fonts' copyright notices, the license name and URL, and
 * where the full texts are. `/*!` marks it as a legal comment for any later tool as well.
 * @param {string} packageDir absolute path of frontend/agraharam
 * @returns {string}
 * @throws {FontLicenseError}
 */
export function legalBanner(packageDir) {
  const notices = FONT_LICENSES.flatMap((font) => {
    let text;
    try {
      text = readFileSync(fontLicensePath(packageDir, font), 'utf8');
    } catch {
      throw new FontLicenseError(`${font.licensePackage}/LICENSE is missing. Run "npm ci" and rebuild.`);
    }
    let found;
    try {
      found = copyrightNotices(text);
    } catch (error) {
      throw new FontLicenseError(`${font.licensePackage}/LICENSE: ${/** @type {Error} */ (error).message}`);
    }
    if (found.length === 0) {
      throw new FontLicenseError(
        `${font.licensePackage}/LICENSE has no "Copyright … (…)" notice before its preamble. Check the package ` +
          'version; the bundle must carry each font copyright notice.',
      );
    }
    return found.map((notice) => ` * ${font.font}: ${notice}`);
  });
  const files = FONT_LICENSES.map((font) => font.licenseFile).join(' and ');
  return [
    '/*! Agraharam dashboard. Embedded fonts:',
    ...notices,
    ' * Both fonts are licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org),',
    ' * with no Reserved Font Name.',
    ` * Full license texts: ${files} beside agraharam.js in every release;`,
    ' * in the repository, frontend/agraharam/dist/agraharam/<version>/ after "npm run build".',
    ' */',
  ].join('\n');
}
