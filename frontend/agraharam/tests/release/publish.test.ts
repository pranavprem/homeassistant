/**
 * The release-publish scripts (§17.5), run exactly as written in .github/workflows/agraharam.yml with bash, jq and
 * sha256sum, against a fake `gh` (support/fake-gh.mjs) that answers from fixtures. This job publishes what HACS
 * offers to the house, so its guards are tested as behaviour, not only as text: the tag and run-number assertion,
 * the monotonic and superseded cases, the ancestor check, the notes template, draft clean-up, the exact asset list
 * and the post-publish "first release" check.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildFakeRelease, writeFile } from '../scripts/support/fake-build.ts';
import { isolatedEnv } from '../scripts/support/temp-repo.ts';
import { WORKFLOW_FILE } from './support/paths.ts';

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly 'working-directory'?: string;
}

const REPO = 'demo-owner/demo-repo';
const API = `repos/${REPO}`;
const RUN_NUMBER = '42';
const VERSION = '0.3.42';
const TAG = `v${VERSION}`;
const COMMIT = `0123456789ab${'c'.repeat(28)}`;
const FAKE_GH = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
const RELEASES = `api ${API}/releases?per_page=100`;

const workflow = parse(readFileSync(WORKFLOW_FILE, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
const publishSteps = workflow.jobs['release-publish']?.steps ?? [];

let tmp: string;
let workspace: string;

interface StepContext {
  readonly tag?: string;
  readonly previous?: string;
  readonly runNumber?: string;
  readonly routes?: Readonly<Record<string, unknown>>;
}

interface StepResult {
  readonly status: number | null;
  readonly outputs: Readonly<Record<string, string>>;
  readonly log: string;
  readonly ghCalls: readonly string[][];
}

/** The only expressions release-publish may use in a step env, and the value each has in these tests. */
function resolveExpression(value: string, context: StepContext): string {
  const known: Record<string, string | undefined> = {
    '${{ github.token }}': 'fake-token',
    '${{ github.repository }}': REPO,
    '${{ steps.tag.outputs.tag }}': context.tag ?? TAG,
    '${{ steps.guard.outputs.previous }}': context.previous ?? '',
  };
  const resolved = known[value];
  if (resolved === undefined) throw new Error(`unexpected expression in a release-publish env: ${value}`);
  return resolved;
}

function step(nameStart: string): Step {
  const found = publishSteps.find((candidate) => candidate.name?.startsWith(nameStart));
  if (found?.run === undefined) throw new Error(`no release-publish run step named "${nameStart}…"`);
  return found;
}

/** Runs one step's script as Actions would: bash -eo pipefail, its working directory and its env only. */
function runStep(nameStart: string, context: StepContext = {}): StepResult {
  const target = step(nameStart);
  const scratch = mkdtempSync(join(tmp, 'step-'));
  const files = {
    script: join(scratch, 'script.sh'),
    output: join(scratch, 'output'),
    log: join(scratch, 'gh.log'),
    routes: join(scratch, 'routes.json'),
  };
  writeFileSync(files.script, target.run ?? '');
  writeFileSync(files.output, '');
  writeFileSync(files.log, '');
  writeFileSync(files.routes, JSON.stringify(context.routes ?? {}));
  const env = isolatedEnv({
    PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`,
    GITHUB_SHA: COMMIT,
    GITHUB_RUN_NUMBER: context.runNumber ?? RUN_NUMBER,
    GITHUB_SERVER_URL: 'https://github.example',
    GITHUB_OUTPUT: files.output,
    RUNNER_TEMP: join(tmp, 'runner-temp'),
    FAKE_GH_LOG: files.log,
    FAKE_GH_FIXTURE: files.routes,
  });
  for (const name of ['GH_TOKEN', 'GH_REPO', 'GITHUB_TOKEN']) delete env[name];
  for (const [name, value] of Object.entries(target.env ?? {})) env[name] = resolveExpression(value, context);
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', files.script], {
    cwd: join(workspace, target['working-directory'] ?? '.'),
    env,
    encoding: 'utf8',
  });
  const outputs = Object.fromEntries(
    readFileSync(files.output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const ghCalls = readFileSync(files.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { status: result.status, outputs, log: result.stdout + result.stderr, ghCalls };
}

const tagRefs = (...tags: string[]) => tags.map((tag) => ({ ref: `refs/tags/${tag}`, object: { sha: 'x' } }));
const release = (
  tag_name: string,
  extra: { draft?: boolean; prerelease?: boolean; id?: number; assets?: string[] } = {},
) => ({
  id: extra.id ?? 1,
  tag_name,
  draft: extra.draft ?? false,
  prerelease: extra.prerelease ?? false,
  assets: (extra.assets ?? ['agraharam.js', 'SHA256SUMS']).map((name) => ({ name })),
});

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agr-publish-')));
  workspace = join(tmp, 'workspace');
  mkdirSync(join(tmp, 'runner-temp'), { recursive: true });
  writeFile(join(tmp, 'bin', 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`);
  spawnSync('chmod', ['+x', join(tmp, 'bin', 'gh')]);
  writeFile(join(tmp, 'pkg', 'package.json'), JSON.stringify({ version: '0.3.0' }));
  // The artifact as download-artifact leaves it: the staged release directory.
  cpSync(buildFakeRelease(join(tmp, 'pkg'), VERSION), join(workspace, 'release'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('release-publish: checksums and tag', () => {
  it('verifies SHA256SUMS strictly and fails on any changed byte', () => {
    expect(runStep('Verify the checksums').status).toBe(0);
    writeFileSync(join(workspace, 'release', 'agraharam.js'), 'tampered();\n');
    expect(runStep('Verify the checksums').status).not.toBe(0);
  });

  it('derives v<manifest version> when its patch is this run number', () => {
    const result = runStep('Derive the tag');
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ tag: TAG });
  });

  it.each([['41'], ['420'], ['4']])('refuses a manifest version from another run (run number %s)', (runNumber) => {
    const result = runStep('Derive the tag', { runNumber });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.log).toContain('refusing to publish');
  });

  it.each([['0.3.042'], ['0.3.42-rc.1'], ['v0.3.42'], ['0.3']])('refuses a manifest version %j', (version) => {
    const path = join(workspace, 'release', 'manifest.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version }));
    expect(runStep('Derive the tag').status).toBe(1);
  });
});

describe('release-publish: monotonic and tag-absent guard', () => {
  const refsRoute = (...tags: string[]) => ({ [`api ${API}/git/matching-refs/tags/v`]: tagRefs(...tags) });

  it('publishes the first release when no v* tag exists', () => {
    const result = runStep('Refuse unless the tag is new', { routes: refsRoute() });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ publish: 'true', previous: '' });
  });

  it('ignores stray tags that sort -V would rank above every release (strict SemVer only)', () => {
    const result = runStep('Refuse unless the tag is new', {
      routes: {
        [`api ${API}/git/matching-refs/tags/v`]: {
          pages: [tagRefs('v0.3.40', 'vacuum-schedule'), tagRefs('v1', 'v0.4', 'v0.3.41', 'v0.3.99-rc.1', 'v00.9.9')],
        },
      },
    });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ publish: 'true', previous: 'v0.3.41' });
    expect(result.ghCalls).toHaveLength(1);
  });

  it('publishes the first release when only stray v tags exist', () => {
    const result = runStep('Refuse unless the tag is new', { routes: refsRoute('vacuum-x', 'v2') });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ publish: 'true', previous: '' });
  });

  it('publishes a tag higher than every tag, comparing versions rather than strings', () => {
    const result = runStep('Refuse unless the tag is new', {
      tag: 'v0.3.10',
      routes: refsRoute('v0.3.8', 'v0.3.9', 'v0.2.99'),
    });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ publish: 'true', previous: 'v0.3.9' });
  });

  it('exits 0 without publishing when the same tag already releases this commit (a re-run)', () => {
    const result = runStep('Refuse unless the tag is new', {
      routes: {
        ...refsRoute('v0.3.41', TAG),
        [`api ${API}/commits/tags/${TAG}`]: { sha: COMMIT },
        [`api ${API}/compare/${COMMIT}...${COMMIT}`]: { status: 'identical' },
        [`api ${API}/releases/tags/${TAG}`]: release(TAG),
      },
    });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ publish: 'false' });
    expect(result.log).toContain('::notice::');
  });

  it('exits 0 without publishing when a newer tag releases a descendant (superseded)', () => {
    const newer = 'd'.repeat(40);
    const result = runStep('Refuse unless the tag is new', {
      routes: {
        ...refsRoute('v0.3.41', 'v0.3.43'),
        [`api ${API}/commits/tags/v0.3.43`]: { sha: newer },
        [`api ${API}/compare/${COMMIT}...${newer}`]: { status: 'ahead' },
        [`api ${API}/releases/tags/v0.3.43`]: release('v0.3.43'),
      },
    });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ publish: 'false' });
  });

  it.each([
    ['a bare tag without a release', undefined],
    ['a draft release', release('v0.3.43', { draft: true })],
    ['a prerelease', release('v0.3.43', { prerelease: true })],
    ['a release without agraharam.js', release('v0.3.43', { assets: ['SHA256SUMS', 'notes.txt'] })],
  ])('fails red instead of exiting as superseded when the newer tag is %s', (_label, newerRelease) => {
    const newer = 'd'.repeat(40);
    const result = runStep('Refuse unless the tag is new', {
      routes: {
        ...refsRoute('v0.3.41', 'v0.3.43'),
        [`api ${API}/commits/tags/v0.3.43`]: { sha: newer },
        [`api ${API}/compare/${COMMIT}...${newer}`]: { status: 'ahead' },
        ...(newerRelease === undefined ? {} : { [`api ${API}/releases/tags/v0.3.43`]: newerRelease }),
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.outputs).toEqual({});
  });

  it.each([['behind'], ['diverged']])('fails when a higher tag is not a descendant (compare %s)', (status) => {
    const other = 'e'.repeat(40);
    const result = runStep('Refuse unless the tag is new', {
      routes: {
        ...refsRoute('v0.3.100'),
        [`api ${API}/commits/tags/v0.3.100`]: { sha: other },
        [`api ${API}/compare/${COMMIT}...${other}`]: { status },
      },
    });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.log).toContain('bump MINOR');
  });

  it('never asks the API about a tag below this version or a tag that is not vMAJOR.MINOR.PATCH', () => {
    const other = 'e'.repeat(40);
    const result = runStep('Refuse unless the tag is new', {
      routes: {
        ...refsRoute('v0.3.41', TAG, 'v0.3.42/../../x', 'v9'),
        [`api ${API}/commits/tags/${TAG}`]: { sha: other },
        [`api ${API}/compare/${COMMIT}...${other}`]: { status: 'diverged' },
      },
    });
    expect(result.status, result.log).toBe(1);
    const asked = result.ghCalls.filter((call) => call[1]?.includes('/commits/'));
    expect(asked).toEqual([['api', `${API}/commits/tags/${TAG}`]]);
  });
});

describe('release-publish: ancestor check', () => {
  const compareMain = (status: string) => ({ [`api ${API}/compare/${COMMIT}...main`]: { status } });

  it.each([['ahead'], ['identical']])('passes when main is %s of this commit', (status) => {
    expect(runStep('Refuse unless this commit is on main', { routes: compareMain(status) }).status).toBe(0);
  });

  it.each([['behind'], ['diverged']])('fails when main is %s', (status) => {
    const result = runStep('Refuse unless this commit is on main', { routes: compareMain(status) });
    expect(result.status).toBe(1);
    expect(result.log).toContain('not on main');
  });
});

describe('release-publish: notes, drafts, publish and the post-publish check', () => {
  const notesPath = () => join(tmp, 'runner-temp', 'notes.md');

  it('writes the notes from the fixed template: tag, full commit, compare link, and nothing from commits', () => {
    expect(runStep('Write the release notes', { previous: 'v0.3.41' }).status).toBe(0);
    const notes = readFileSync(notesPath(), 'utf8');
    expect(notes).toContain(`Agraharam dashboard ${TAG}, built and tested from commit ${COMMIT}.`);
    expect(notes).toContain(`https://github.example/${REPO}/compare/v0.3.41...${TAG}`);
    expect(notes.split('\n').length).toBeLessThan(10);
  });

  it.each([[''], ['v0.3.41](https://example.invalid)']])('writes no compare link for previous %j', (previous) => {
    expect(runStep('Write the release notes', { previous }).status).toBe(0);
    const notes = readFileSync(notesPath(), 'utf8');
    expect(notes).toContain('First Agraharam release.');
    expect(notes).not.toContain('compare/');
    expect(notes).not.toContain('example.invalid');
  });

  it('deletes only a leftover draft of this exact tag', () => {
    const routes = {
      [RELEASES]: {
        pages: [
          [release(TAG, { draft: true, id: 7 }), release('v0.3.41', { draft: true, id: 8 })],
          [release('v0.3.40', { id: 9 }), release(TAG, { draft: false, id: 10 })],
        ],
      },
      [`api --method DELETE ${API}/releases/7`]: null,
    };
    const result = runStep('Delete a leftover draft', { routes });
    expect(result.status, result.log).toBe(0);
    expect(result.ghCalls.filter((call) => call.includes('DELETE'))).toEqual([
      ['api', '--method', 'DELETE', `${API}/releases/7`],
    ]);
  });

  it('creates the release at this commit with exactly the SHA256SUMS-listed files and SHA256SUMS', () => {
    writeFileSync(notesPath(), 'notes\n');
    const result = runStep('Publish the release');
    expect(result.status, result.log).toBe(0);
    expect(result.ghCalls).toEqual([
      [
        'release',
        'create',
        TAG,
        '--target',
        COMMIT,
        '--title',
        TAG,
        '--notes-file',
        notesPath(),
        '--',
        'OFL-1.1-Hanken-Grotesk.txt',
        'OFL-1.1-Newsreader.txt',
        'THIRD_PARTY_LICENSES.md',
        'agraharam.js',
        'manifest.json',
        'SHA256SUMS',
      ],
    ]);
  });

  it('refuses to publish a release whose SHA256SUMS does not list agraharam.js', () => {
    const sums = join(workspace, 'release', 'SHA256SUMS');
    const lines = readFileSync(sums, 'utf8').split('\n');
    writeFileSync(sums, lines.filter((line) => !line.endsWith('  agraharam.js')).join('\n'));
    const result = runStep('Publish the release');
    expect(result.status).toBe(1);
    expect(result.log).toContain('does not list agraharam.js');
    expect(result.ghCalls).toEqual([]);
  });

  it('refuses to publish when SHA256SUMS names anything but a flat file', () => {
    const sums = join(workspace, 'release', 'SHA256SUMS');
    writeFileSync(sums, `${readFileSync(sums, 'utf8')}${'0'.repeat(64)}  ../notes.md\n`);
    const result = runStep('Publish the release');
    expect(result.status).toBe(1);
    expect(result.ghCalls).toEqual([]);
  });

  it('passes the post-publish check when this tag is the first non-draft, non-prerelease release', () => {
    const routes = {
      [RELEASES]: {
        pages: [
          [release('v0.3.43', { draft: true }), release('v0.4.0', { prerelease: true })],
          [release(TAG), release('v0.3.41')],
        ],
      },
    };
    const result = runStep('Check that HACS will offer', { routes });
    expect(result.status, result.log).toBe(0);
  });

  it.each([
    ['an older release listed first', [release('v0.3.41'), release(TAG)]],
    ['no published release', [release(TAG, { draft: true })]],
  ])('fails the post-publish check with %s', (_label, list) => {
    const result = runStep('Check that HACS will offer', { routes: { [RELEASES]: list } });
    expect(result.status).toBe(1);
    expect(result.log).toContain('HACS would keep offering');
  });

  it('every gh call in release-publish carries the token and repository from its own step env', () => {
    const result = runStep('Check that HACS will offer', { routes: { [RELEASES]: [release(TAG)] } });
    expect(result.status).toBe(0);
    for (const target of publishSteps.filter((candidate) => candidate.run?.includes('gh '))) {
      expect(Object.keys(target.env ?? {}), target.name).toEqual(expect.arrayContaining(['GH_TOKEN', 'GH_REPO']));
    }
  });
});
