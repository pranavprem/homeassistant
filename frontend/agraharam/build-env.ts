/**
 * Build identity, read once per process and shared by the Vite, Vitest and harness configs (and later by
 * postbuild for the install manifest). Git is invoked without a shell; any failure degrades to 'unknown'
 * so a build from an exported tarball still works.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import packageJson from './package.json' with { type: 'json' };

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));
const UNKNOWN = 'unknown';

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

export const APP_VERSION: string = packageJson.version;
export const GIT_SHA: string = readGit(['rev-parse', '--short=12', 'HEAD']) ?? UNKNOWN;
export const COMMIT_TIME: string = readGit(['log', '-1', '--format=%cI']) ?? UNKNOWN;
/** True when this package directory has uncommitted or untracked changes; unknown git state counts as dirty. */
export const GIT_DIRTY: boolean = (readGit(['status', '--porcelain', '--', '.']) ?? UNKNOWN) !== '';
