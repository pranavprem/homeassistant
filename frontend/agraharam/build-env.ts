/**
 * Build identity, read once per process and shared by the Vite, Vitest and harness configs and by postbuild for the
 * install manifest. Git is invoked without a shell; any failure degrades to 'unknown' so a build from an exported
 * tarball still works.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import packageJson from './package.json' with { type: 'json' };

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));
const UNKNOWN = 'unknown';
/** §17.3: a release patch is a positive integer without leading zeros (the workflow's run number). */
const PATCH_OVERRIDE_PATTERN = /^[1-9]\d*$/;
/**
 * §17.3: package.json holds MAJOR.MINOR.0 (SemVer numbers, no leading zeros); the patch belongs to the release
 * workflow.
 */
const OVERRIDABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/;

/**
 * §17.2 raw size target of agraharam.js, 720 KiB (737,280 B), raised from 480 KiB when both fonts moved into the
 * bundle (§11.5). Exceeding it warns, in postbuild's size line and in Vite's chunk report; features are not cut to
 * meet it.
 */
export const BUNDLE_SIZE_TARGET_BYTES = 720 * 1024;

/** Thrown when AGR_PATCH or the package version cannot produce a release version; the build must stop. */
export class BuildEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildEnvError';
  }
}

/**
 * The version a build stamps into the bundle, its dist directory and its manifest (§17.3). Without `patch` (unset or
 * empty) it is the package version. With `patch`, it is MAJOR.MINOR.<patch>; any other value fails the build, so a
 * typo can never publish a surprising version.
 */
export function resolveAppVersion(packageVersion: string, patch: string | undefined): string {
  if (patch === undefined || patch === '') return packageVersion;
  if (!PATCH_OVERRIDE_PATTERN.test(patch)) {
    throw new BuildEnvError(
      'AGR_PATCH must be a positive integer without leading zeros, such as 42. Unset it (or leave it empty) to build ' +
        `the package version ${packageVersion}.`,
    );
  }
  const match = OVERRIDABLE_VERSION_PATTERN.exec(packageVersion);
  if (match === null) {
    throw new BuildEnvError(
      `AGR_PATCH needs the package.json version to be MAJOR.MINOR.0, but it is ${packageVersion}. Set it to ` +
        'MAJOR.MINOR.0: release builds supply the patch.',
    );
  }
  return `${match[1]}.${match[2]}.${patch}`;
}

function readGit(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export const APP_VERSION: string = resolveAppVersion(packageJson.version, process.env['AGR_PATCH']);
export const GIT_SHA: string = readGit(['rev-parse', '--short=12', 'HEAD']) ?? UNKNOWN;
export const COMMIT_TIME: string = readGit(['log', '-1', '--format=%cI']) ?? UNKNOWN;
/** True when this package directory has uncommitted or untracked changes; unknown git state counts as dirty. */
export const GIT_DIRTY: boolean = (readGit(['status', '--porcelain', '--', '.']) ?? UNKNOWN) !== '';
