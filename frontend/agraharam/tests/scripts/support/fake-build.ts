/**
 * A fake `vite build` output in a temp package directory, and a release made from it by the real postbuild, so the
 * postbuild and install suites exercise exactly the files a real build installs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { postbuild } from '../../../scripts/postbuild.mjs';

export const FAKE_FONTS = Object.freeze({
  serif: 'fonts/newsreader-latin-opsz-normal-Ab12Cd.woff2',
  sans: 'fonts/hanken-grotesk-latin-wght-normal-Ef34Gh.woff2',
});
export const CLEAN_BUNDLE = 'const ns="http://www.w3.org/2000/svg";export{ns};\n';
export const FAKE_BUILD_INFO = Object.freeze({
  gitSha: '0123456789ab',
  gitDirty: false,
  commitTime: '2026-09-30T17:51:00-07:00',
});

export function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** What `vite build` leaves in dist/agraharam/<version>/, plus both font packages' licenses in node_modules. */
export function layOutViteOutput(packageDir: string, version: string, bundle: string = CLEAN_BUNDLE): string {
  const bundleDir = join(packageDir, 'dist/agraharam', version);
  writeFile(join(bundleDir, 'agraharam.js'), bundle);
  writeFile(join(bundleDir, 'agraharam.js.map'), '{"version":3}');
  writeFile(join(bundleDir, FAKE_FONTS.serif), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]));
  writeFile(join(bundleDir, FAKE_FONTS.sans), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x02]));
  writeFile(join(bundleDir, 'LICENSES/THIRD_PARTY_LICENSES.md'), '# Third-party licenses\n');
  writeFile(join(packageDir, 'node_modules/@fontsource-variable/newsreader/LICENSE'), 'SIL OFL 1.1 (Newsreader)\n');
  writeFile(join(packageDir, 'node_modules/@fontsource-variable/hanken-grotesk/LICENSE'), 'SIL OFL 1.1 (Hanken)\n');
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
