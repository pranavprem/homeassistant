/**
 * check-public end to end (§11.1, §12.1, §16.10): the script runs with its cwd in a temp git repo that mirrors the
 * real layout, with fictional private files. Every planted ID uses a `demo_` object ID, except the single-word
 * case, which is built at runtime so this file's own source passes the public-literal check.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedEnv, runNodeScript, type RunResult, type TempRepo } from './support/temp-repo.ts';

const SCRIPT = 'check-public.mjs';
const PKG = 'frontend/agraharam';
/** A real-looking ID with a single-word object: matched only in full form, never as a bare word. */
const SINGLE_WORD_OBJECT = ['pan', 'try'].join('');
const SINGLE_WORD_ID = ['switch', SINGLE_WORD_OBJECT].join('.');
const DENYLIST_PHRASE = 'Quillfeather Lane';
/** Built at runtime, so this file's own source passes the public-literal check. */
const REAL_LOOKING_LIGHT = ['light', 'kitchen'].join('.');

const CANDIDATES = {
  schema_version: 1,
  groups: {
    people: [{ entity_id: 'person.demo_quinn', known_in_saved_inventory: true }],
    perimeter_read_only: [{ entity_id: 'binary_sensor.demo_side_gate', known_in_saved_inventory: true }],
  },
  camera_candidates: [
    {
      entity_id: 'camera.demo_attic',
      role: 'attic',
      privacy_entity: 'switch.demo_attic_privacy',
      privacy_enabled_value: 'on',
    },
  ],
  guarded_actions: [
    {
      label: 'Hold Away',
      entity_id: 'script.demo_hold_away_guarded',
      invocation: { domain: 'script', service: 'turn_on', data: { entity_id: 'script.demo_hold_away_invoked' } },
    },
  ],
  known_ambiguities: ['The sensor.demo_hidden_relay entry may be stale; confirm it live.'],
};

/** Shaped like the much larger saved HA context file: entities, a keyed registry and service strings. */
const CONTEXT = {
  entities: [
    { entity_id: 'light.demo_context_only_lamp', label: 'Context lamp' },
    { entity_id: 'sun.sun', label: 'Sun' },
    { entity_id: SINGLE_WORD_ID, label: 'Pantry switch' },
  ],
  registry: { 'sensor.demo_keyed_entity': { platform: 'demo' } },
  services: ['light.turn_off'],
};

function writePrivateFiles(repo: TempRepo, dir = repo.privateDir): void {
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, 'bindings.candidates.json'), JSON.stringify(CANDIDATES, null, 2));
  writeFileSync(join(dir, 'backups', 'ha-context.saved.json'), JSON.stringify(CONTEXT));
  writeFileSync(join(dir, 'public-denylist.txt'), `# household words\n${DENYLIST_PHRASE}\n\n`);
}

/** 1-based line and column of the first occurrence of `needle`. */
function positionOf(content: string, needle: string, from = 0): string {
  const index = content.indexOf(needle, from);
  if (index === -1) throw new Error('needle not found in test content');
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  return `${line}:${index - before.lastIndexOf('\n')}`;
}

function hitLines(result: RunResult): string[] {
  return result.stdout.split('\n').filter((line) => /:\d+:\d+ /.test(line));
}

describe('check-public: one repo with every kind of planted value', () => {
  let repo: TempRepo;
  let result: RunResult;
  const files: Record<string, string> = {
    'src/tracked.ts': "export const PERSON = 'person.demo_quinn';\n",
    'tests/untracked.test.ts':
      "// Only the context file knows this one.\nconst LAMP = 'light.demo_context_only_lamp';\n",
    'src/keyed.ts': "const KEYED = 'sensor.demo_keyed_entity';\n",
    'src/nested.ts': "const PRIVACY = 'switch.demo_attic_privacy';\nconst INVOKED = 'script.demo_hold_away_invoked';\n",
    'docs/prose.md': 'A note about sensor.demo_hidden_relay.\n',
    'src/bare.ts': "const GATE = 'demo_side_gate';\nconst SHOUTED = DEMO_SIDE_GATE;\n",
    'src/single-word.ts': `const WORD = '${SINGLE_WORD_OBJECT}';\n`,
    'src/single-word-full.ts': `const FULL = '${SINGLE_WORD_ID}';\n`,
    'src/services.ts': "call('light.turn_off');\nconst TURN_OFF = 'turn_off';\n",
    'src/exempt.ts': "const SUN = 'sun.sun';\n",
    'docs/denylist.md': 'Walk down quillfeather\nlane at dusk.\n',
  };

  beforeAll(() => {
    repo = createTempRepo('agr-check-public-');
    writePrivateFiles(repo);
    for (const [path, content] of Object.entries(files)) repo.write(`${PKG}/${path}`, content);
    repo.write(`${PKG}/node_modules/some-package/index.js`, "module.exports = 'person.demo_quinn';\n");
    repo.write(`${PKG}/dist/agraharam/9.9.9/agraharam.js`, 'const c="camera.demo_attic";\n');
    // A release build stamps its own patch (AGR_PATCH), so its directory differs from package.json's version.
    repo.write(`${PKG}/dist/agraharam/9.9.17/agraharam.js`, 'const d="camera.demo_attic";\n');
    repo.git('add', `${PKG}/src/tracked.ts`, `${PKG}/package.json`, '.gitignore');
    repo.git('commit', '-q', '-m', 'tracked');
    // Staged, then fixed only in the working tree: the index blob still holds the ID.
    repo.write(`${PKG}/src/staged.ts`, "const STAGED = 'person.demo_quinn';\n");
    repo.git('add', `${PKG}/src/staged.ts`);
    repo.write(`${PKG}/src/staged.ts`, "const STAGED = 'person.demo_fictional_fixed';\n");
    result = runNodeScript(SCRIPT, [], repo.root);
  });

  afterAll(() => repo.remove());

  const expectHit = (path: string, needle: string, rule: string) => {
    const content = files[path] as string;
    expect(hitLines(result)).toContain(`${PKG}/${path}:${positionOf(content, needle)} ${rule}`);
  };

  it('exits 1 and reports the forbidden-set size as counts', () => {
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/forbidden set from 3 private file\(s\): \d+ entity IDs, \d+ object IDs, 1 denylist/);
  });

  it('fails an ID planted in a tracked file', () => expectHit('src/tracked.ts', 'person.', 'entity-id'));

  it('fails an ID found only in the context-shaped file, planted in an untracked, unstaged file', () =>
    expectHit('tests/untracked.test.ts', 'light.', 'entity-id'));

  it('collects an entity ID used as an object key in a private file', () =>
    expectHit('src/keyed.ts', 'sensor.', 'entity-id'));

  it('collects nested privacy_entity and invocation.data.entity_id IDs', () => {
    expectHit('src/nested.ts', 'switch.', 'entity-id');
    expectHit('src/nested.ts', 'script.', 'entity-id');
  });

  it('collects an ID embedded in known_ambiguities prose', () => expectHit('docs/prose.md', 'sensor.', 'entity-id'));

  it('fails a bare compound object ID without its domain, case-insensitively', () => {
    expectHit('src/bare.ts', 'demo_side_gate', 'object-id');
    expectHit('src/bare.ts', 'DEMO_SIDE_GATE', 'object-id');
  });

  it('passes a single-word object ID on its own but fails it in full form', () => {
    expect(hitLines(result).some((line) => line.includes('/src/single-word.ts:'))).toBe(false);
    expectHit('src/single-word-full.ts', 'switch.', 'entity-id');
  });

  it('drops service-registry strings: neither light.turn_off nor bare turn_off is forbidden', () => {
    expect(hitLines(result).some((line) => line.includes('/src/services.ts:'))).toBe(false);
  });

  it('passes an exempted generic ID', () => {
    expect(hitLines(result).some((line) => line.includes('/src/exempt.ts:'))).toBe(false);
  });

  it('fails a denylist literal, case-insensitively and across a line break', () =>
    expectHit('docs/denylist.md', 'quillfeather', 'denylist'));

  it('scans the staged index blob even after the working tree was fixed', () => {
    expect(hitLines(result)).toContain(`${PKG}/src/staged.ts [index]:1:17 entity-id`);
    expect(hitLines(result).some((line) => line.startsWith(`${PKG}/src/staged.ts:`))).toBe(false);
  });

  it('does not scan gitignored files such as node_modules', () => {
    expect(result.stdout).not.toContain('node_modules');
  });

  it('scans every built dist directory, including a patched release build', () => {
    expect(hitLines(result)).toContain(`${PKG}/dist/agraharam/9.9.9/agraharam.js:1:10 entity-id`);
    expect(hitLines(result)).toContain(`${PKG}/dist/agraharam/9.9.17/agraharam.js:1:10 entity-id`);
  });

  it('prints path:line:column and the rule, never the matched value', () => {
    const output = result.stdout + result.stderr;
    // The summary names the *.demo_* convention; no planted value (demo_ plus a name) may appear.
    expect(output).not.toMatch(/demo_[a-z0-9]/i);
    expect(output).not.toContain(SINGLE_WORD_OBJECT);
    expect(output.toLowerCase()).not.toContain('quillfeather');
    for (const line of hitLines(result)) expect(line).toMatch(/^\S.*:\d+:\d+ (entity-id|object-id|denylist)$/);
  });
});

describe('check-public: private directory discovery (§16.10)', () => {
  it('exits 2 when the private directory is missing, naming AGR_PRIVATE_DIR and the escape hatch', () => {
    const repo = createTempRepo('agr-check-public-missing-');
    try {
      const result = runNodeScript(SCRIPT, [], repo.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('AGR_PRIVATE_DIR');
      expect(result.stderr).toContain('--allow-missing-private');
    } finally {
      repo.remove();
    }
  });

  it('runs the public-literal check under --allow-missing-private, and passes a clean tree', () => {
    const repo = createTempRepo('agr-check-public-allow-');
    try {
      repo.write(`${PKG}/src/clean.ts`, "export const LAMP = 'light.demo_lamp';\n");
      const result = runNodeScript(SCRIPT, ['--allow-missing-private'], repo.root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('running the public-literal check');
      expect(result.stdout).toMatch(/clean: public-literal check of [1-9]\d* file\(s\)/);
    } finally {
      repo.remove();
    }
  });

  it('runs the public-literal check when the private directory holds no private files', () => {
    const repo = createTempRepo('agr-check-public-empty-');
    try {
      mkdirSync(repo.privateDir);
      repo.write('.dashboard-local/notes.md', 'not json');
      repo.write(`${PKG}/src/real.ts`, `export const LAMP = '${REAL_LOOKING_LIGHT}';\n`);
      const result = runNodeScript(SCRIPT, [], repo.root);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('(the private directory holds none): running the public-literal check');
      expect(hitLines(result)).toEqual([`${PKG}/src/real.ts:1:22 public-literal`]);
    } finally {
      repo.remove();
    }
  });

  it('reads the private files from AGR_PRIVATE_DIR when set', () => {
    const repo = createTempRepo('agr-check-public-env-');
    const elsewhere = createTempRepo('agr-check-public-env-private-');
    try {
      writePrivateFiles(repo, elsewhere.root);
      repo.write(`${PKG}/src/tracked.ts`, "export const PERSON = 'person.demo_quinn';\n");
      const result = runNodeScript(SCRIPT, [], repo.root, isolatedEnv({ AGR_PRIVATE_DIR: elsewhere.root }));
      expect(result.status).toBe(1);
      expect(hitLines(result)).toEqual([`${PKG}/src/tracked.ts:1:24 entity-id`]);
    } finally {
      repo.remove();
      elsewhere.remove();
    }
  });

  it('warns about each symbolic link that could hide private values, and never follows it', () => {
    const repo = createTempRepo('agr-check-public-link-');
    const elsewhere = createTempRepo('agr-check-public-link-target-');
    try {
      writePrivateFiles(repo);
      const target = elsewhere.write('context.json', JSON.stringify({ entities: ['light.demo_linked_only'] }));
      symlinkSync(target, join(repo.privateDir, 'linked-context.json'));
      symlinkSync(join(elsewhere.root, 'frontend'), join(repo.privateDir, 'linked-dir'));
      rmSync(join(repo.privateDir, 'public-denylist.txt'));
      symlinkSync(
        elsewhere.write('denylist.txt', `${DENYLIST_PHRASE}\n`),
        join(repo.privateDir, 'public-denylist.txt'),
      );
      repo.write(`${PKG}/src/linked.ts`, "const LAMP = 'light.demo_linked_only';\n");

      const result = runNodeScript(SCRIPT, [], repo.root);
      const warnings = result.stderr.split('\n').filter((line) => line.includes('warning:'));
      expect(warnings.map((line) => line.split(' ')[2])).toEqual([
        '.dashboard-local/linked-context.json',
        '.dashboard-local/linked-dir',
        '.dashboard-local/public-denylist.txt',
      ]);
      for (const line of warnings) expect(line).toContain('is a symbolic link and was not scanned');
      expect(result.status, 'the linked values were not collected').toBe(0);
      expect(result.stdout).toContain('0 denylist literals');
      expect(result.stdout + result.stderr).not.toContain('demo_linked_only');
    } finally {
      repo.remove();
      elsewhere.remove();
    }
  });

  it('exits 1 on an unparsable private file without printing its content', () => {
    const repo = createTempRepo('agr-check-public-broken-');
    try {
      writePrivateFiles(repo);
      repo.write('.dashboard-local/broken.json', '{"entity_id": "person.demo_secret_value",');
      const result = runNodeScript(SCRIPT, [], repo.root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cannot parse private file broken.json');
      expect(result.stdout + result.stderr).not.toContain('demo_secret_value');
    } finally {
      repo.remove();
    }
  });
});

describe('check-public: the public-literal check without private files (§17.7, CI)', () => {
  const allow = ['--allow-missing-private'];

  it('fails a non-fictional ID in any scoped file, untracked or staged, without printing it', () => {
    const repo = createTempRepo('agr-check-public-literals-');
    try {
      repo.write(`${PKG}/src/untracked.ts`, `const A = '${REAL_LOOKING_LIGHT}';\n`);
      repo.write(`${PKG}/tests/staged.test.ts`, `const B = '${REAL_LOOKING_LIGHT}';\n`);
      repo.git('add', `${PKG}/tests/staged.test.ts`);
      repo.write(`${PKG}/tests/staged.test.ts`, "const B = 'light.demo_fixed';\n");
      repo.write(`${PKG}/docs/notes.md`, `Out of scope: ${REAL_LOOKING_LIGHT}.\n`);
      repo.write(`${PKG}/scripts/tool.mjs`, `const C = '${REAL_LOOKING_LIGHT}';\n`);
      const result = runNodeScript(SCRIPT, allow, repo.root);
      expect(result.status).toBe(1);
      expect(hitLines(result)).toEqual([
        `${PKG}/src/untracked.ts:1:12 public-literal`,
        `${PKG}/tests/staged.test.ts [index]:1:12 public-literal`,
      ]);
      expect(result.stdout + result.stderr).not.toContain(REAL_LOOKING_LIGHT);
    } finally {
      repo.remove();
    }
  });

  it('--range checks every scoped blob in the commits, including one removed again', () => {
    const repo = createTempRepo('agr-check-public-literal-range-');
    try {
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'base');
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.write(`${PKG}/e2e/added.spec.ts`, `const A = '${REAL_LOOKING_LIGHT}';\n`);
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'add');
      repo.write(`${PKG}/e2e/added.spec.ts`, "const A = 'light.demo_lamp';\n");
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'fix');
      const clean = runNodeScript(SCRIPT, allow, repo.root);
      expect(clean.status, 'the working tree is clean').toBe(0);
      const result = runNodeScript(SCRIPT, [...allow, '--range', `${base}..HEAD`], repo.root);
      expect(result.status).toBe(1);
      expect(hitLines(result)).toHaveLength(1);
      expect(hitLines(result)[0]).toMatch(
        new RegExp(`^${PKG}/e2e/added\\.spec\\.ts@[0-9a-f]{12}:1:12 public-literal$`),
      );
    } finally {
      repo.remove();
    }
  });

  it('--dist reports skipped: postbuild already ran the check over the bundle it built', () => {
    const repo = createTempRepo('agr-check-public-literal-dist-');
    try {
      repo.write('release/agraharam.js', `const A = '${REAL_LOOKING_LIGHT}';\n`);
      const result = runNodeScript(SCRIPT, [...allow, '--dist', 'release'], repo.root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('check-public: skipped: no private files');
    } finally {
      repo.remove();
    }
  });
});

describe('check-public: --range and --dist modes', () => {
  it('--range scans every blob in the pushed commits, including one removed again', () => {
    const repo = createTempRepo('agr-check-public-range-');
    try {
      writePrivateFiles(repo);
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'base');
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.write(`${PKG}/src/leak.ts`, "const LEAK = 'person.demo_quinn';\n");
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'leak');
      const leakCommit = repo.git('rev-parse', '--short=12', 'HEAD').trim();
      repo.write(`${PKG}/src/leak.ts`, "const LEAK = 'person.demo_fictional_fixed';\n");
      repo.git('commit', '-q', '-am', 'fix');

      expect(runNodeScript(SCRIPT, [], repo.root).status).toBe(0);
      const ranged = runNodeScript(SCRIPT, ['--range', `${base}..HEAD`], repo.root);
      expect(ranged.status).toBe(1);
      expect(hitLines(ranged)).toEqual([`${PKG}/src/leak.ts@${leakCommit}:1:15 entity-id`]);
    } finally {
      repo.remove();
    }
  });

  it('--dist scans only the given directory', () => {
    const repo = createTempRepo('agr-check-public-dist-');
    try {
      writePrivateFiles(repo);
      repo.write(`${PKG}/src/tracked.ts`, "export const PERSON = 'person.demo_quinn';\n");
      repo.write('release/agraharam.js', 'x="camera.demo_attic";\n');
      repo.write(
        'release/fonts/a.woff2',
        Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, ...Buffer.from('camera.demo_attic')]),
      );
      const result = runNodeScript(SCRIPT, ['--dist', 'release'], repo.root);
      expect(result.status).toBe(1);
      expect(hitLines(result)).toEqual(['release/agraharam.js:1:4 entity-id', 'release/fonts/a.woff2:1:6 entity-id']);
    } finally {
      repo.remove();
    }
  });

  it.each([
    ['an unknown flag', ['--everything']],
    ['--dist together with --range', ['--dist', 'x', '--range', 'HEAD~1..HEAD']],
    ['a --range that looks like an option', ['--range=--output=/tmp/x']],
  ])('exits 2 on %s', (_label, args) => {
    const repo = createTempRepo('agr-check-public-usage-');
    try {
      writePrivateFiles(repo);
      expect(runNodeScript(SCRIPT, args, repo.root).status).toBe(2);
    } finally {
      repo.remove();
    }
  });
});
