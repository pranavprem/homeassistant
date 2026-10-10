/**
 * Workflow fitness (§17.5, §17.8): .github/workflows/agraharam.yml parsed with `yaml` and held to the approved rules.
 * Each rule is a security or liveness property of the release path; a change that breaks one must change the design
 * first.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { WORKFLOW_FILE } from './support/paths.ts';

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly 'working-directory'?: string;
}

interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly 'runs-on'?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps: readonly Step[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly concurrency: Readonly<Record<string, unknown>>;
  readonly env?: unknown;
  readonly jobs: Readonly<Record<string, Job>>;
}

/** §17.5: the only actions, each at the approved commit with its version comment. */
const PINNED_ACTIONS: Readonly<Record<string, { sha: string; version: string }>> = {
  'actions/checkout': { sha: '3d3c42e5aac5ba805825da76410c181273ba90b1', version: 'v7.0.1' },
  'actions/setup-node': { sha: '820762786026740c76f36085b0efc47a31fe5020', version: 'v7.0.0' },
  'actions/upload-artifact': { sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', version: 'v7.0.1' },
  'actions/download-artifact': { sha: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c', version: 'v8.0.1' },
};
const JOB_IDS = ['changes', 'verify', 'e2e', 'gate', 'release-build', 'release-publish'];
const RELEASE_IF =
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.changes.outputs.bundle == 'true'";

const source = readFileSync(WORKFLOW_FILE, 'utf8');
const workflow = parse(source) as Workflow;
const jobs = Object.entries(workflow.jobs);
const steps = jobs.flatMap(([id, job]) => job.steps.map((step) => ({ job: id, step })));
const job = (id: string): Job => {
  const found = workflow.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
};
const needsOf = (id: string): string[] => {
  const needs = job(id).needs ?? [];
  return typeof needs === 'string' ? [needs] : [...needs];
};
const actionOf = (step: Step) => step.uses?.slice(0, step.uses.indexOf('@'));

describe('workflow: triggers, permissions and concurrency', () => {
  it('runs on pull requests to main, pushes to main and manual dispatch, never pull_request_target', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(workflow.on['pull_request']).toEqual({ branches: ['main'] });
    expect(workflow.on['push']).toEqual({ branches: ['main'] });
    expect(source).not.toMatch(/^\s*pull_request_target\s*:/m);
  });

  it('grants contents: read at the top level and sets no workflow-wide env', () => {
    expect(workflow.permissions).toStrictEqual({ contents: 'read' });
    expect(workflow.env).toBeUndefined();
  });

  it('cancels superseded pull-request runs only; runs on main are never queued or replaced', () => {
    expect(workflow.concurrency).toStrictEqual({
      group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}",
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
  });

  it('has exactly the six jobs, each on ubuntu-24.04 with its own permissions', () => {
    expect(Object.keys(workflow.jobs)).toEqual(JOB_IDS);
    for (const [id, definition] of jobs) {
      expect(definition['runs-on'], id).toBe('ubuntu-24.04');
      expect(definition.permissions, id).toBeDefined();
    }
  });

  it('grants contents: write to release-publish only, and nothing else to it', () => {
    for (const [id, definition] of jobs) {
      const writes = Object.entries(definition.permissions ?? {}).filter(([, level]) => level !== 'read');
      if (id === 'release-publish') expect(definition.permissions).toStrictEqual({ contents: 'write' });
      else expect(writes, id).toEqual([]);
    }
    expect(job('gate').permissions).toStrictEqual({});
  });
});

describe('workflow: actions and scripts', () => {
  it('pins every action to a full commit SHA from the approved list, with its version comment', () => {
    const usesLines = source.split('\n').filter((line) => /^\s*(?:-\s+)?uses:/.test(line));
    expect(usesLines.length).toBe(steps.filter(({ step }) => step.uses !== undefined).length);
    for (const line of usesLines) {
      const match = /uses: ([\w-]+\/[\w-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(line);
      expect(match, line).not.toBeNull();
      const [, action, sha, version] = match as RegExpExecArray;
      expect(PINNED_ACTIONS[action as string], line).toEqual({ sha, version });
    }
  });

  it('drops the token from every checkout', () => {
    const checkouts = steps.filter(({ step }) => actionOf(step) === 'actions/checkout');
    expect(checkouts.length).toBeGreaterThan(0);
    for (const { job: id, step } of checkouts) expect(step.with?.['persist-credentials'], id).toBe(false);
  });

  it('never puts a ${{ }} expression inside a run script', () => {
    const runs = steps.filter(({ step }) => step.run !== undefined);
    expect(runs.length).toBeGreaterThan(10);
    for (const { job: id, step } of runs) expect(step.run, `${id}: ${step.name ?? step.run}`).not.toContain('${{');
  });

  it('installs with npm ci --ignore-scripts only, and sets Node from .nvmrc without a cache', () => {
    for (const { job: id, step } of steps) {
      if (step.run?.includes('npm ci')) expect(step.run.trim(), id).toBe('npm ci --ignore-scripts');
      if (step.run !== undefined) expect(step.run, id).not.toMatch(/\bnpm (?:install|i)\b/);
      if (actionOf(step) === 'actions/setup-node') {
        expect(step.with, id).toStrictEqual({
          'node-version-file': 'frontend/agraharam/.nvmrc',
          'package-manager-cache': false,
        });
      }
    }
  });
});

describe('workflow: the gate', () => {
  const gate = job('gate');

  it('is the agraharam-ci check, always runs, and needs changes, verify and e2e', () => {
    expect(gate.name).toBe('agraharam-ci');
    expect(gate.if).toBe('always()');
    expect(needsOf('gate')).toEqual(['changes', 'verify', 'e2e']);
  });

  it('checks needs.changes.result and requires success/success or skipped/skipped', () => {
    const [step] = gate.steps;
    expect(gate.steps).toHaveLength(1);
    expect(step?.env).toStrictEqual({
      CHANGES_RESULT: '${{ needs.changes.result }}',
      DASHBOARD: '${{ needs.changes.outputs.dashboard }}',
      BUNDLE: '${{ needs.changes.outputs.bundle }}',
      VERIFY_RESULT: '${{ needs.verify.result }}',
      E2E_RESULT: '${{ needs.e2e.result }}',
    });
    expect(step?.run).toContain('if [[ $CHANGES_RESULT != success ]]; then');
    expect(step?.run).toContain('if [[ $BUNDLE == true && $DASHBOARD != true ]]; then');
    expect(step?.run).toContain('true/success/success)');
    expect(step?.run).toContain('false/skipped/skipped)');
    expect(step?.run).toMatch(/\*\)\n\s+echo '::error::[^\n]+\n\s+exit 1/);
  });
});

describe('workflow: CI jobs', () => {
  it('runs changes as the full-history script and exposes only its two outputs', () => {
    const changes = job('changes');
    expect(changes.steps[0]?.with).toStrictEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    expect(changes.outputs).toStrictEqual({
      dashboard: '${{ steps.diff.outputs.dashboard }}',
      bundle: '${{ steps.diff.outputs.bundle }}',
    });
    expect(changes.steps[1]?.run).toBe('bash frontend/agraharam/scripts/ci/changes.sh');
  });

  it('verifies, then runs e2e and the WebKit layout and a11y run, only when the dashboard changed', () => {
    expect(job('verify').if).toBe("needs.changes.outputs.dashboard == 'true'");
    expect(job('e2e').if).toBe("needs.changes.outputs.dashboard == 'true'");
    expect(needsOf('e2e')).toEqual(['changes', 'verify']);
    const verifyRuns = job('verify').steps.flatMap((step) => step.run ?? []);
    expect(verifyRuns.slice(0, 6)).toEqual([
      'npm ci --ignore-scripts',
      'npm run format:check',
      'npm run typecheck',
      'npm test',
      "python3 -B -m unittest discover -s collector -p 'test_*.py'",
      'npm run build',
    ]);
    expect(verifyRuns).toHaveLength(7);
    const e2eRuns = job('e2e').steps.flatMap((step) => step.run ?? []);
    expect(e2eRuns).toEqual([
      'npm ci --ignore-scripts',
      'npx playwright install --with-deps chromium webkit',
      'npm run test:e2e',
      'AGR_E2E_BROWSERS=all npx playwright test e2e/layout.spec.ts e2e/a11y.spec.ts --project=webkit',
    ]);
    const report = job('e2e').steps.find((step) => actionOf(step) === 'actions/upload-artifact');
    expect(report?.if).toBe('failure()');
    expect(report?.with?.['retention-days']).toBe(7);
  });
});

describe('workflow: the public-literal check in CI (§17.7)', () => {
  const verify = job('verify');
  const step = verify.steps.at(-1);

  it('checks out the full history so it can read every commit under test', () => {
    expect(verify.steps[0]?.with).toStrictEqual({ 'fetch-depth': 0, 'persist-credentials': false });
  });

  it('runs the literal check on the working tree, then on the commits since the PR base or the push before', () => {
    expect(step?.name).toMatch(/^Public-literal check of the working tree and of every commit under test/);
    expect(step?.env).toStrictEqual({
      EVENT_NAME: '${{ github.event_name }}',
      PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      PUSH_BEFORE: '${{ github.event.before }}',
    });
    const run = step?.run ?? '';
    expect(run).toContain('npm run check:public -- --allow-missing-private\n');
    expect(run).toContain('pull_request) base=$PR_BASE_SHA ;;');
    expect(run).toContain('push) base=$PUSH_BEFORE ;;');
    expect(run).toContain('npm run check:public -- --allow-missing-private --range "$base..$GITHUB_SHA"');
  });

  it('skips only the range part, safely, for an all-zero, malformed or missing base', () => {
    const run = step?.run ?? '';
    expect(run).toContain('[[ $base =~ ^[0-9a-f]{40}$ && $base != 0000000000000000000000000000000000000000 ]]');
    expect(run).toContain('git cat-file -e "$base^{commit}"');
    expect(run.indexOf('--allow-missing-private\n')).toBeLessThan(run.indexOf('case $EVENT_NAME'));
  });
});

describe('workflow: release jobs', () => {
  it('need the gate and run only for pushes to main that change the bundle', () => {
    expect(needsOf('release-build')).toEqual(['changes', 'gate']);
    expect(needsOf('release-publish')).toEqual(['changes', 'gate', 'release-build']);
    expect(job('release-build').if).toBe(RELEASE_IF);
    expect(job('release-publish').if).toBe(RELEASE_IF);
  });

  it('every needs.<job> a job reads in an if or env is in its own needs list', () => {
    for (const [id, definition] of jobs) {
      const expressions = [
        definition.if ?? '',
        ...Object.values(definition.env ?? {}),
        ...definition.steps.flatMap((step) => [step.if ?? '', ...Object.values(step.env ?? {})]),
      ];
      const referenced = expressions.flatMap((text) => [...text.matchAll(/needs\.([\w-]+)/g)].map((m) => m[1]));
      for (const name of referenced) expect(needsOf(id), `${id} reads needs.${name}`).toContain(name);
    }
  });

  it('release-build builds the run-number version with a read-only token and uploads the staged files for 1 day', () => {
    const build = job('release-build');
    expect(build.permissions).toStrictEqual({ contents: 'read' });
    const runs = build.steps.flatMap((step) => step.run ?? []);
    expect(runs).toEqual([
      'npm ci --ignore-scripts',
      'AGR_PATCH=$GITHUB_RUN_NUMBER npm run build',
      'node scripts/ci/stage-release.mjs dist/release',
    ]);
    const upload = build.steps.at(-1);
    expect(actionOf(upload as Step)).toBe('actions/upload-artifact');
    expect(upload?.with).toStrictEqual({
      name: 'agraharam-release',
      path: 'frontend/agraharam/dist/release/',
      'retention-days': 1,
      'if-no-files-found': 'error',
    });
  });

  describe('release-publish', () => {
    const publish = job('release-publish');
    const runs = publish.steps.flatMap((step) => step.run ?? []);
    const script = runs.join('\n');

    it('is serialized in the agraharam-release group and never cancelled', () => {
      expect(publish.concurrency).toStrictEqual({ group: 'agraharam-release', 'cancel-in-progress': false });
    });

    it('runs no package code: no checkout, setup-node, npm, npx or node', () => {
      const actions = publish.steps.flatMap((step) => actionOf(step) ?? []);
      expect(actions).toEqual(['actions/download-artifact']);
      for (const run of runs) expect(run).not.toMatch(/\b(?:npm|npx|node)\b/);
    });

    it('considers strict SemVer release tags only, so a stray v tag cannot block or skip releases', () => {
      const guard = publish.steps.find((step) => step.id === 'guard');
      expect(guard?.run).toContain('select(test("^v(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)$"))');
    });

    it('treats a run as superseded only by a published release that carries agraharam.js', () => {
      const guard = publish.steps.find((step) => step.id === 'guard')?.run ?? '';
      // GitHub answers 404 for a draft, so a failed lookup must become {} and fail the check with a clear error.
      expect(guard).toContain(`gh api "repos/$GH_REPO/releases/tags/$tag" 2>/dev/null || echo '{}'`);
      expect(guard).toContain(
        '(.draft == false) and (.prerelease == false) and any(.assets[]?; .name == "agraharam.js")',
      );
      expect(guard.indexOf('releases/tags/$tag')).toBeLessThan(guard.indexOf("echo 'publish=false'"));
    });

    it('refuses to publish a release without agraharam.js among its assets', () => {
      const create = publish.steps.find((step) => step.run?.includes('gh release create "$TAG"'))?.run ?? '';
      expect(create).toContain("[[ $has_bundle == true ]] || { echo '::error::SHA256SUMS does not list agraharam.js.'");
    });

    it('downloads the artifact with its digest checked, then verifies SHA256SUMS', () => {
      expect(publish.steps[0]?.with).toStrictEqual({
        name: 'agraharam-release',
        path: 'release',
        'digest-mismatch': 'error',
      });
      expect(publish.steps[1]?.run).toContain('sha256sum --check --strict SHA256SUMS');
    });

    it('takes the token and repository from step env only', () => {
      expect(publish.env).toBeUndefined();
      for (const step of publish.steps) {
        if (step.run?.includes('gh ')) {
          expect(step.env?.['GH_TOKEN'], step.name).toBe('${{ github.token }}');
          expect(step.env?.['GH_REPO'], step.name).toBe('${{ github.repository }}');
        }
      }
    });

    it('runs the guards and the publish in the approved order', () => {
      const markers = [
        'sha256sum --check --strict SHA256SUMS',
        "jq -er '.version' manifest.json",
        '!= "$GITHUB_RUN_NUMBER"',
        'git/matching-refs/tags/v',
        'highest=$(sort -V',
        'releases/tags/$tag',
        'publish=false',
        'compare/$GITHUB_SHA...main',
        'notes.md',
        'select(.draft and .tag_name == $tag)',
        'gh release create "$TAG" --target "$GITHUB_SHA"',
        'first(inputs[] | select((.draft | not) and (.prerelease | not)))',
      ];
      const positions = markers.map((marker) => script.indexOf(marker));
      for (const [index, position] of positions.entries()) expect(position, markers[index]).toBeGreaterThan(-1);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('gates every step after the guard on its publish output, so a superseded run exits 0', () => {
      const guardIndex = publish.steps.findIndex((step) => step.id === 'guard');
      expect(guardIndex).toBeGreaterThan(0);
      for (const step of publish.steps.slice(guardIndex + 1)) {
        expect(step.if, step.name).toBe("steps.guard.outputs.publish == 'true'");
      }
    });

    it('attaches only the SHA256SUMS-listed files and SHA256SUMS, never the notes', () => {
      const create = publish.steps.find((step) => step.run?.includes('gh release create "$TAG"'));
      expect(create?.['working-directory']).toBe('release');
      expect(create?.run).toContain('done <SHA256SUMS');
      expect(create?.run).toMatch(/--notes-file "\$RUNNER_TEMP\/notes\.md" \\\n\s+-- "\$\{assets\[@\]\}" SHA256SUMS$/m);
      const notes = publish.steps.find((step) => step.run?.includes('>"$RUNNER_TEMP/notes.md"'));
      expect(notes?.['working-directory']).toBeUndefined();
    });

    it('writes release notes from a fixed template without commit subjects', () => {
      expect(script).not.toMatch(/git log|head_commit|\.commits|\.message/);
    });
  });
});
