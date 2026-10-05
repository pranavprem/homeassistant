/**
 * Temporary git repositories for the script suites. Each repo mirrors the real layout (`frontend/agraharam/` plus
 * a gitignored `.dashboard-local/`), so the scripts under test run against it exactly as they run here. Paths are
 * physical (`realpathSync`) because macOS temp directories sit behind a symbolic link.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of frontend/agraharam in this checkout. */
export const PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/** A process environment without the variables that would point a script or git somewhere else. */
export function isolatedEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'AGR_PRIVATE_DIR' || key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node <script> ...args` with `cwd`, capturing output. */
export function runNodeScript(
  script: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = isolatedEnv(),
): RunResult {
  const result = spawnSync(process.execPath, [join(PACKAGE_DIR, 'scripts', script), ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface TempRepo {
  readonly root: string;
  /** frontend/agraharam inside the temp repo. */
  readonly packageDir: string;
  /** .dashboard-local inside the temp repo. */
  readonly privateDir: string;
  /** Writes a file relative to the repo root, creating parent directories. */
  write(path: string, content: string | Buffer): string;
  git(...args: string[]): string;
  remove(): void;
}

/** The ignore rules that matter here, as in the real repository's .gitignore. */
const GITIGNORE = [
  '.dashboard-local/',
  'frontend/agraharam/node_modules/',
  'frontend/agraharam/dist/',
  'frontend/agraharam/test-results/',
  '',
].join('\n');

export function createTempRepo(prefix: string, options: { gitignore?: string } = {}): TempRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, env: isolatedEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'user.name', 'Agraharam tests');
  git('config', 'commit.gpgsign', 'false');
  const write = (path: string, content: string | Buffer): string => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  write('.gitignore', options.gitignore ?? GITIGNORE);
  write('frontend/agraharam/package.json', JSON.stringify({ name: 'agraharam-dashboard', version: '9.9.9' }));
  return {
    root,
    packageDir: join(root, 'frontend/agraharam'),
    privateDir: join(root, '.dashboard-local'),
    write,
    git,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
