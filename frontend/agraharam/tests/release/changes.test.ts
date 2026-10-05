/**
 * The workflow's `changes` job (§17.5), scripts/ci/changes.sh, run with bash against temp git repositories shaped
 * like this one. It must answer only literal true/false, diff pushes against the newest release tag, and answer
 * true for both outputs whenever it cannot be sure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedEnv } from '../scripts/support/temp-repo.ts';
import { PACKAGE_DIR } from './support/paths.ts';

const SCRIPT = join(PACKAGE_DIR, 'scripts/ci/changes.sh');
const ZERO_SHA = '0'.repeat(40);

let root: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, env: isolatedEnv(), encoding: 'utf8' }).trim();
}

/** Writes the files and commits them; returns the new commit. */
function commit(files: Readonly<Record<string, string>>, message = 'change'): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

interface Outcome {
  readonly status: number | null;
  readonly outputs: string;
  readonly log: string;
}

function runChanges(env: Readonly<Record<string, string>>, cwd = root): Outcome {
  const outputFile = join(dirname(root), `output-${Date.now()}-${Math.random()}`);
  writeFileSync(outputFile, '');
  const result = spawnSync('bash', [SCRIPT], {
    cwd,
    env: isolatedEnv({ GITHUB_OUTPUT: outputFile, ...env }),
    encoding: 'utf8',
  });
  return { status: result.status, outputs: readFileSync(outputFile, 'utf8'), log: result.stdout + result.stderr };
}

function push(before: string, sha = git('rev-parse', 'HEAD')): Outcome {
  return runChanges({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, PUSH_BEFORE: before });
}

const answer = (dashboard: boolean, bundle: boolean) => `dashboard=${dashboard}\nbundle=${bundle}\n`;

beforeEach(() => {
  root = join(realpathSync(mkdtempSync(join(tmpdir(), 'agr-changes-'))), 'repo');
  mkdirSync(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'user.name', 'Agraharam tests');
  git('config', 'commit.gpgsign', 'false');
  // Spelled as git documents it; the all-lowercase key would read as an entity ID to the public-literal check.
  git('config', 'tag.gpgSign', 'false');
  commit({ 'README.md': 'stack\n', 'frontend/agraharam/src/a.ts': 'export {};\n' }, 'initial');
});

afterEach(() => {
  rmSync(dirname(root), { recursive: true, force: true });
});

describe('changes.sh: outputs', () => {
  it('writes exactly two literal lines and exits 0', () => {
    git('tag', 'v0.1.1');
    commit({ 'frontend/agraharam/src/b.ts': 'export {};\n' });
    const outcome = push(ZERO_SHA);
    expect(outcome.status, outcome.log).toBe(0);
    expect(outcome.outputs).toBe(answer(true, true));
    expect(outcome.outputs).toMatch(/^dashboard=(true|false)\nbundle=(true|false)\n$/);
  });

  it('never prints a changed file name, which a pull request controls', () => {
    const base = git('rev-parse', 'HEAD');
    commit({ 'frontend/agraharam/src/planted-name-xyz.ts': 'export {};\n', 'docs/odd\nname.md': 'x\n' });
    const outcome = runChanges({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: git('rev-parse', 'HEAD'),
      PR_BASE_SHA: base,
    });
    expect(outcome.outputs).toBe(answer(true, true));
    expect(outcome.log).not.toContain('planted-name-xyz');
    expect(outcome.log).not.toContain('odd');
  });
});

describe('changes.sh: path classification (one pull request per path)', () => {
  it.each([
    ['frontend/agraharam/src/x.ts', true, true],
    ['frontend/agraharam/package.json', true, true],
    ['frontend/agraharam/package-lock.json', true, true],
    ['frontend/agraharam/vite.config.ts', true, true],
    ['frontend/agraharam/vite-lit-css.ts', true, true],
    ['frontend/agraharam/build-env.ts', true, true],
    ['frontend/agraharam/scripts/postbuild.mjs', true, true],
    ['frontend/agraharam/scripts/public-exemptions.json', true, true],
    ['frontend/agraharam/.nvmrc', true, true],
    ['frontend/agraharam/new-top-level-file.txt', true, true],
    ['hacs.json', true, true],
    ['frontend/agraharam/docs/ARCHITECTURE.md', true, false],
    ['frontend/agraharam/README.md', true, false],
    ['frontend/agraharam/src/notes.md', true, true],
    ['frontend/agraharam/scripts/notes.md', true, true],
    ['frontend/agraharam/other/notes.md', true, true],
    ['frontend/agraharam/CHANGELOG.md', true, false],
    ['frontend/agraharam/tests/x.test.ts', true, false],
    ['frontend/agraharam/e2e/x.spec.ts', true, false],
    ['frontend/agraharam/install/install.sh', true, false],
    ['frontend/agraharam/playwright.config.ts', true, false],
    ['frontend/agraharam/vitest.config.ts', true, false],
    ['frontend/agraharam/vite.harness.config.ts', true, false],
    ['frontend/agraharam/harness.html', true, false],
    ['frontend/agraharam/index.html', true, false],
    ['.github/workflows/agraharam.yml', true, false],
    ['docker-compose.yaml', false, false],
    ['automations/x.yaml', false, false],
    ['frontend/other/x.ts', false, false],
    ['.github/workflows/other.yml', false, false],
  ])('%s → dashboard %s, bundle %s', (path, dashboard, bundle) => {
    const base = git('rev-parse', 'HEAD');
    commit({ [path]: `changed ${path}\n` });
    const outcome = runChanges({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: git('rev-parse', 'HEAD'),
      PR_BASE_SHA: base,
    });
    expect(outcome.outputs, outcome.log).toBe(answer(dashboard, bundle));
  });

  it('counts a file moved out of the bundle by its old path too', () => {
    commit({ 'frontend/agraharam/src/move-me.ts': 'export {};\n' });
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(root, 'frontend/agraharam/docs'));
    git('mv', 'frontend/agraharam/src/move-me.ts', 'frontend/agraharam/docs/move-me.ts');
    git('commit', '-q', '-m', 'move');
    const outcome = runChanges({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: git('rev-parse', 'HEAD'),
      PR_BASE_SHA: base,
    });
    expect(outcome.outputs).toBe(answer(true, true));
  });
});

describe('changes.sh: push base', () => {
  it('diffs against the newest release tag, by version rather than by name, when it is an ancestor', () => {
    commit({ 'frontend/agraharam/src/b.ts': 'export {};\n' });
    git('tag', 'v0.1.9');
    commit({ 'frontend/agraharam/docs/notes.md': 'x\n' });
    git('tag', 'v0.1.10');
    const before = commit({ 'frontend/agraharam/src/c.ts': 'export {};\n' });
    commit({ 'README.md': 'stack only\n' });
    // Since v0.1.10: one bundle change, then a stack-only push. The bundle change was never released, so the
    // stack-only push still releases it; `before` alone would have said "nothing changed".
    expect(push(before).outputs).toBe(answer(true, true));
  });

  it.each([['vacuum-schedule'], ['v1'], ['v0.2'], ['v0.1.10-rc.1'], ['v01.0.0']])(
    'ignores a stray tag %j that sort -V would rank above every release',
    (stray) => {
      git('tag', 'v0.1.4');
      commit({ 'frontend/agraharam/src/b.ts': 'export {};\n' });
      git('tag', stray);
      const before = commit({ 'frontend/agraharam/docs/d.md': 'x\n' });
      commit({ 'README.md': 'stack only\n' });
      // Since v0.1.4 the bundle changed; a base taken from the stray tag would have hidden that change.
      const outcome = push(before);
      expect(outcome.outputs).toBe(answer(true, true));
      expect(outcome.log).toContain('release tag v0.1.4');
    },
  );

  it('answers true for both when only stray v tags exist', () => {
    git('tag', 'vacuum-x');
    const before = commit({ 'README.md': 'stack only\n' });
    const outcome = push(before);
    expect(outcome.outputs).toBe(answer(true, true));
    expect(outcome.log).toContain('no release tag yet');
  });

  it('reports nothing to do when only stack files changed since the newest release', () => {
    git('tag', 'v0.1.4');
    const before = commit({ 'docker-compose.yaml': 'x\n' });
    commit({ 'automations/y.yaml': 'y\n' });
    expect(push(before).outputs).toBe(answer(false, false));
  });

  it('falls back to before when the newest tag is not an ancestor of the pushed commit', () => {
    git('checkout', '-q', '-b', 'elsewhere');
    commit({ 'frontend/agraharam/src/elsewhere.ts': 'export {};\n' });
    git('tag', 'v0.9.1');
    git('checkout', '-q', 'main');
    const before = commit({ 'frontend/agraharam/src/b.ts': 'export {};\n' });
    commit({ 'frontend/agraharam/docs/d.md': 'x\n' });
    const outcome = push(before);
    expect(outcome.outputs).toBe(answer(true, false));
    expect(outcome.log).toContain("push's before");
  });
});

describe('changes.sh: fails toward testing', () => {
  it.each([['workflow_dispatch'], ['schedule'], ['']])('answers true for both on event %j', (event) => {
    const outcome = runChanges({ GITHUB_EVENT_NAME: event, GITHUB_SHA: git('rev-parse', 'HEAD') });
    expect(outcome.status).toBe(0);
    expect(outcome.outputs).toBe(answer(true, true));
  });

  it('answers true for both on a push when no v* tag exists yet (the first release)', () => {
    const before = git('rev-parse', 'HEAD');
    commit({ 'README.md': 'stack only\n' });
    expect(push(before).outputs).toBe(answer(true, true));
  });

  it.each([
    ['an all-zero before', ZERO_SHA],
    ['an empty before', ''],
    ['a malformed before', 'HEAD~1'],
    ['an unreachable before (force-pushed away)', 'f'.repeat(40)],
  ])('answers true for both on %s when the tag cannot be used', (_label, before) => {
    git('checkout', '-q', '-b', 'elsewhere');
    commit({ 'x.txt': 'x\n' });
    git('tag', 'v0.9.1');
    git('checkout', '-q', 'main');
    commit({ 'README.md': 'stack only\n' });
    expect(push(before).outputs).toBe(answer(true, true));
  });

  it('answers true for both on a pull request without a usable base', () => {
    const head = git('rev-parse', 'HEAD');
    for (const base of ['', ZERO_SHA, 'e'.repeat(40)]) {
      expect(runChanges({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: head, PR_BASE_SHA: base }).outputs).toBe(
        answer(true, true),
      );
    }
  });

  it('answers true for both in a shallow clone', () => {
    git('tag', 'v0.1.1');
    commit({ 'README.md': 'stack only\n' });
    const shallow = join(dirname(root), 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, shallow], { env: isolatedEnv() });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: shallow, encoding: 'utf8' }).trim();
    const outcome = runChanges({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: head, PUSH_BEFORE: ZERO_SHA }, shallow);
    expect(outcome.outputs).toBe(answer(true, true));
    expect(outcome.log).toContain('shallow history');
  });

  it('answers true for both outside a git repository', () => {
    const outside = join(dirname(root), 'not-a-repo');
    mkdirSync(outside);
    const outcome = runChanges(
      { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40), PUSH_BEFORE: ZERO_SHA },
      outside,
    );
    expect(outcome.status).toBe(0);
    expect(outcome.outputs).toBe(answer(true, true));
  });

  it('answers true for both when GITHUB_SHA is not a commit hash', () => {
    expect(runChanges({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'main', PUSH_BEFORE: ZERO_SHA }).outputs).toBe(
      answer(true, true),
    );
  });
});
