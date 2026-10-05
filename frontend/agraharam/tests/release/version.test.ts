/**
 * Version stamping (§17.3): AGR_PATCH replaces the patch of package.json's MAJOR.MINOR.0 for release builds. A valid
 * override stamps the bundle (Vite `define`), the dist directory and the manifest; unset or empty uses the package
 * version; anything else fails the build before it starts.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { BuildEnvError, resolveAppVersion } from '../../build-env.ts';
import { isolatedEnv } from '../scripts/support/temp-repo.ts';
import { PACKAGE_DIR } from './support/paths.ts';

const PACKAGE_MAJOR_MINOR = packageJson.version.replace(/\.0$/, '');

/** Imports `module` in a fresh Node process with AGR_PATCH set (or unset) and prints `expression` as JSON. */
function evaluateWith(patch: string | undefined, module: string, expression: string) {
  const env = isolatedEnv();
  delete env['AGR_PATCH'];
  if (patch !== undefined) env['AGR_PATCH'] = patch;
  const script = `const m = await import(${JSON.stringify(module)}); console.log(JSON.stringify(${expression}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_DIR,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    value: result.status === 0 ? (JSON.parse(result.stdout) as unknown) : undefined,
  };
}

describe('resolveAppVersion', () => {
  it.each([
    [undefined, '0.1.0'],
    ['', '0.1.0'],
    ['7', '0.1.7'],
    ['42', '0.1.42'],
    ['1234567', '0.1.1234567'],
  ])('AGR_PATCH %j on 0.1.0 gives %s', (patch, expected) => {
    expect(resolveAppVersion('0.1.0', patch)).toBe(expected);
  });

  it.each([['0'], ['07'], ['-1'], ['1.2'], [' 7'], ['7 '], ['7\n'], ['abc'], ['1e3'], ['+7'], ['٣']])(
    'refuses AGR_PATCH %j',
    (patch) => {
      expect(() => resolveAppVersion('0.1.0', patch)).toThrow(BuildEnvError);
      expect(() => resolveAppVersion('0.1.0', patch)).toThrow(/positive integer without leading zeros/);
    },
  );

  it('refuses an override when package.json does not hold MAJOR.MINOR.0', () => {
    expect(() => resolveAppVersion('0.1.3', '7')).toThrow(/MAJOR\.MINOR\.0, but it is 0\.1\.3/);
    expect(() => resolveAppVersion('0.2.0-rc.1', '7')).toThrow(BuildEnvError);
    expect(resolveAppVersion('0.1.3', undefined)).toBe('0.1.3');
  });

  it.each([['01.2.0'], ['0.01.0'], ['00.1.0']])(
    'refuses an override on %s: a leading zero is not SemVer and would never match a release tag',
    (packageVersion) => {
      expect(() => resolveAppVersion(packageVersion, '7')).toThrow(BuildEnvError);
    },
  );

  it.each([
    ['0.0.0', '0.0.7'],
    ['10.20.0', '10.20.7'],
  ])('accepts %s', (packageVersion, expected) => {
    expect(resolveAppVersion(packageVersion, '7')).toBe(expected);
  });

  it('the package itself holds MAJOR.MINOR.0', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.0$/);
  });
});

describe('AGR_PATCH in the real build configuration', () => {
  it('stamps the bundle define and the dist directory with MAJOR.MINOR.<patch>', () => {
    const result = evaluateWith(
      '7',
      './vite.config.ts',
      '{ define: m.default.define.__APP_VERSION__, outDir: m.default.build.outDir }',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.value).toEqual({
      define: JSON.stringify(`${PACKAGE_MAJOR_MINOR}.7`),
      outDir: `dist/agraharam/${PACKAGE_MAJOR_MINOR}.7`,
    });
  });

  it('serves the harness from the same patched /local path', () => {
    const result = evaluateWith('7', './vite.harness.config.ts', 'm.default.define.__HARNESS_BUNDLE_URL__');
    expect(result.status, result.stderr).toBe(0);
    expect(result.value).toBe(JSON.stringify(`/local/agraharam/${PACKAGE_MAJOR_MINOR}.7/agraharam.js`));
  });

  it.each([[undefined], ['']])('uses the package version when AGR_PATCH is %j', (patch) => {
    const result = evaluateWith(patch, './build-env.ts', 'm.APP_VERSION');
    expect(result.status, result.stderr).toBe(0);
    expect(result.value).toBe(packageJson.version);
  });

  it('fails before building on an invalid AGR_PATCH', () => {
    const result = evaluateWith('07', './build-env.ts', 'm.APP_VERSION');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AGR_PATCH must be a positive integer without leading zeros');
  });
});
