/**
 * The install documents are executable claims, so they are tested: the resource URL tracks the package version,
 * both example dashboards validate, and the operator console snippets in install/README.md run against a fake
 * `hass.callWS`: the HACS preflight only reads and stops on the HACS 2.0.5 prefix clash or a `/local` resource; the
 * §13.5 snippets throw before any write on an empty CONFIG or a HACS resource, never overwrite a dashboard or add a
 * second resource, and print undo commands that work exactly as printed. The HACS steps of §17.6 are checked too.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/validate.ts';
import { parseYamlSubset, YamlSubsetError } from './support/yaml-subset.ts';

const readInstall = (name: string) => readFileSync(new URL(`../../install/${name}`, import.meta.url), 'utf8');
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
const RESOURCE_URL = `/local/agraharam/${PACKAGE_VERSION}/agraharam.js`;

// Plain JSON shapes read from YAML; the assertions index into them freely.
type Json = Record<string, any>;

function singleCard(dashboard: Json): Json {
  expect(dashboard.views).toHaveLength(1);
  expect(dashboard.views[0]).toMatchObject({ path: 'home', type: 'panel' });
  expect(dashboard.views[0].cards).toHaveLength(1);
  return dashboard.views[0].cards[0];
}

describe('install/resource.yaml', () => {
  it('declares exactly one module resource at the current version', () => {
    expect(parseYamlSubset(readInstall('resource.yaml'))).toEqual({ url: RESOURCE_URL, type: 'module' });
  });
});

describe('install/dashboard.demo.yaml', () => {
  it('is a panel view at path home whose one card is the demo', () => {
    const card = singleCard(parseYamlSubset(readInstall('dashboard.demo.yaml')) as Json);
    expect(card).toEqual({ type: 'custom:agraharam-dashboard', demo: true });
    const result = validateConfig(card);
    expect(result.ok && result.config.demo && result.warnings.length === 0).toBe(true);
  });
});

describe('install/dashboard.example.yaml', () => {
  const card = singleCard(parseYamlSubset(readInstall('dashboard.example.yaml')) as Json);

  it('validates with no issues or warnings and keeps controls off', () => {
    const result = validateConfig(card);
    if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.code}`).join('\n'));
    expect(result.warnings).toEqual([]);
    expect(card.controls).toBe(false);
    expect(card.demo).toBe(false);
  });

  it('shows the full schema with fictional IDs only', () => {
    for (const key of ['people', 'weather', 'climate', 'air', 'rooms', 'vacuums', 'cameras', 'garage', 'vehicle']) {
      expect(card, key).toHaveProperty(key);
    }
    const ids = JSON.stringify(card).match(/"[a-z_]+\.[a-z0-9_]+"/g) ?? [];
    for (const id of ids) expect(id === '"sun.sun"' || /\.demo_/.test(id), id).toBe(true);
  });

  it('binds each security role to its own script, and the garage to cover.demo_garage', () => {
    const scripts = Object.values(card.security.actions as Record<string, string>);
    expect(new Set(scripts).size).toBe(scripts.length);
    expect(card.security.actions.disarm_hold).toBe('script.demo_disarm_hold');
    expect(card.garage.cover).toBe('cover.demo_garage');
  });

  it('shows live: false on an indoor camera, with its comment (§13.3)', () => {
    const nursery = (card.cameras as Json[]).find((camera) => camera.entity === 'camera.demo_nursery');
    expect(nursery?.live).toBe(false);
    expect(readInstall('dashboard.example.yaml')).toMatch(/# live: false removes live view from this dashboard/);
  });

  it('quotes privacy_on_value, because YAML 1.1 reads a bare on as true', () => {
    expect(card.cameras[0].privacy_on_value).toBe('on');
    expect(() => parseYamlSubset('privacy_on_value: on\n')).toThrow(YamlSubsetError);
  });
});

describe('install/README.md operator steps', () => {
  const readme = readInstall('README.md');

  it('checks the installed HA version against the §4.3 host contract before controls are enabled', () => {
    const verification = readme.slice(readme.indexOf('## 6. Read-only verification'), readme.indexOf('### Readback'));
    expect(verification).toContain('Read "Home\n   Assistant version"');
    expect(verification).toContain('2026.9.x and 2026.10.x');
    expect(verification).toContain('§4.3');
    expect(verification.indexOf('§4.3')).toBeLessThan(verification.indexOf('set `controls: true`'));
  });

  it("has the operator check each camera's live flag during the read-only verification", () => {
    const verification = readme.slice(readme.indexOf('## 6. Read-only verification'), readme.indexOf('### Readback'));
    expect(verification).toContain("Check each camera's `live` flag");
    expect(verification.indexOf('`live` flag')).toBeLessThan(verification.indexOf('set `controls: true`'));
    expect(readme).toContain('| `camera_live`');
  });

  it('documents --allow-missing-private, the install.sh flag for a machine without the private files', () => {
    expect(readme).toContain('`--allow-missing-private`');
    expect(readInstall('install.sh')).toMatch(/^ {4}--allow-missing-private\) allow_missing_private=true/m);
  });
});

describe('install/README.md HACS channel (§17.6)', () => {
  const readme = readInstall('README.md');
  const hacs = readme.slice(
    readme.indexOf('## HACS channel (primary)'),
    readme.indexOf('## /local channel (fallback)'),
  );

  it('makes HACS the primary channel and the channels mutually exclusive', () => {
    expect(readme).toContain('**mutually exclusive**');
    expect(readme.indexOf('## HACS channel (primary)')).toBeLessThan(readme.indexOf('## 1. Build and verify'));
  });

  it('lists the GitHub settings checklist', () => {
    for (const item of [
      'requires the `agraharam-ci` status check',
      'Immutable releases on',
      'A tag ruleset on the release tags, pattern `v[0-9]*.[0-9]*.[0-9]*`, that blocks update and delete',
      'default workflow permissions read-only',
      'require approval for workflow runs from outside',
      'write-scoped tokens',
    ]) {
      expect(hacs, item).toContain(item);
    }
  });

  it('runs the first release check and the read-only preflight before adding the repository, then §13.5', () => {
    const order = [
      '**The first release exists.**',
      '**Read-only preflight.**',
      'but not with `/hacsfiles/homeassistant/`',
      'Custom repositories',
      'type **Dashboard**',
      '**Create the dashboard and verify it read-only**',
    ].map((text) => hacs.indexOf(text));
    for (const position of order) expect(position).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('updates through Settings → Updates, rolls back with HACS Redownload, and switches channels safely', () => {
    expect(hacs).toContain('Settings → Updates → Agraharam → Update');
    expect(hacs).toContain('HACS → Agraharam → ⋮ → Redownload → pick the previous version');
    expect(hacs).toContain('remove the repository in HACS first');
    expect(hacs).toContain('delete the `/local/agraharam/` resource first');
  });
});

/** The fenced js block between the README's start and end markers for `name`. */
function snippet(name: string): string {
  const readme = readInstall('README.md');
  const start = readme.indexOf(`<!-- agraharam:${name}:start -->`);
  const end = readme.indexOf(`<!-- agraharam:${name}:end -->`);
  expect(start, `${name} start marker`).toBeGreaterThan(-1);
  const block = /```js\n([\s\S]*?)\n```/.exec(readme.slice(start, end));
  if (!block?.[1]) throw new Error(`no js block inside the ${name} markers`);
  return block[1];
}

type Handler = (message: Json) => unknown;
interface FakeHass {
  readonly calls: Json[];
  callWS(message: Json): Promise<unknown>;
}

function fakeHass(handlers: Readonly<Record<string, Handler>>): FakeHass {
  const calls: Json[] = [];
  return {
    calls,
    async callWS(message: Json) {
      calls.push(message);
      const handler = handlers[message.type as string];
      if (!handler) throw new Error(`unexpected call ${String(message.type)}`);
      return handler(message);
    },
  };
}

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...params: string[]) => AsyncFn;

/** Runs a console snippet as the operator would, with `document` and `console` replaced by fakes. */
async function runSnippet(code: string, hass: FakeHass) {
  const logs: string[] = [];
  const errors: string[] = [];
  const fakeConsole = {
    log: (...parts: unknown[]) => logs.push(parts.map(String).join(' ')),
    error: (...parts: unknown[]) => errors.push(parts.map(String).join(' ')),
  };
  const fakeDocument = { querySelector: (selector: string) => (selector === 'home-assistant' ? { hass } : null) };
  let thrown: unknown;
  try {
    await new AsyncFunction('document', 'console', code)(fakeDocument, fakeConsole);
  } catch (error) {
    thrown = error;
  }
  return { logs, errors, thrown };
}

/** Runs one printed undo command exactly as printed. */
async function runPrinted(command: string, hass: FakeHass): Promise<void> {
  await new AsyncFunction('hass', command)(hass);
}

const CONFIG = { title: 'Agraharam', views: [{ title: 'Home', path: 'home', type: 'panel', cards: [{ demo: true }] }] };

function withConfig(code: string, config: unknown): string {
  const replaced = code.replace('const CONFIG = null;', `const CONFIG = ${JSON.stringify(config)};`);
  expect(replaced).not.toBe(code);
  return replaced;
}

const OTHER_RESOURCE = { id: 'res-other', url: '/hacsfiles/demo-card/demo-card.js', type: 'module' };
const OLD_AGRAHARAM = { id: 'res-old', url: '/local/agraharam/0.0.1/agraharam.js', type: 'module' };
const HACS_AGRAHARAM = { id: 'res-hacs', url: '/hacsfiles/homeassistant/agraharam.js?hacstag=12345', type: 'module' };
/** Another repository whose name starts with the same word: HACS 2.0.5 would treat it as Agraharam's resource. */
const PREFIX_CLASH = { id: 'res-clash', url: '/hacsfiles/homeassistant-demo-card/card.js', type: 'module' };

function installHandlers(overrides: Partial<Record<string, Handler>> = {}): Record<string, Handler> {
  return {
    'lovelace/resources': () => [OTHER_RESOURCE],
    'lovelace/dashboards/list': () => [{ id: 'other', url_path: 'dashboard-other' }],
    'lovelace/resources/create': () => ({ id: 'res-new', url: RESOURCE_URL }),
    'lovelace/resources/update': (message) => ({ id: message.resource_id, url: message.url }),
    'lovelace/resources/delete': () => null,
    'lovelace/dashboards/create': () => ({ id: 'agraharam_next', url_path: 'agraharam-next' }),
    'lovelace/dashboards/delete': () => null,
    'lovelace/config/save': () => null,
    ...overrides,
  } as Record<string, Handler>;
}

function printedCommands(errors: readonly string[]): string[] {
  return errors.flatMap((text) => text.split('\n')).filter((line) => line.startsWith('await hass.callWS('));
}

describe('README HACS preflight snippet (§17.6)', () => {
  const code = snippet('hacs-preflight-snippet');

  it.each([
    ['only unrelated resources', [OTHER_RESOURCE]],
    ['HACS already registered Agraharam', [OTHER_RESOURCE, HACS_AGRAHARAM]],
    ['no resources', []],
  ])('passes with %s, reading only', async (_label, resources) => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => resources }));
    const { thrown, logs } = await runSnippet(code, hass);
    expect(thrown).toBeUndefined();
    expect(logs).toEqual(['Preflight passed: no resource conflicts with the HACS channel.']);
    expect(hass.calls).toEqual([{ type: 'lovelace/resources' }]);
  });

  it('stops on a resource that starts with /hacsfiles/homeassistant but not /hacsfiles/homeassistant/', async () => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => [OTHER_RESOURCE, PREFIX_CLASH] }));
    const { thrown } = await runSnippet(code, hass);
    expect(String(thrown)).toContain('Stop: 1 resource(s) start with /hacsfiles/homeassistant but not');
    expect(String(thrown)).not.toContain(PREFIX_CLASH.url);
    expect(hass.calls).toEqual([{ type: 'lovelace/resources' }]);
  });

  it('stops when the /local channel is in use (channels are exclusive)', async () => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => [OLD_AGRAHARAM] }));
    const { thrown } = await runSnippet(code, hass);
    expect(String(thrown)).toContain('Follow "Switching channels" first');
    expect(hass.calls).toEqual([{ type: 'lovelace/resources' }]);
  });
});

describe('README first-install snippet (§13.5)', () => {
  const code = snippet('first-install-snippet');

  it.each([
    ['a HACS resource', [HACS_AGRAHARAM]],
    ['a resource sharing the HACS prefix without its slash', [PREFIX_CLASH]],
    ['a HACS resource beside a /local one', [OLD_AGRAHARAM, HACS_AGRAHARAM]],
  ])('counts both channel prefixes: stops after one read on %s', async (_label, resources) => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => resources }));
    const { thrown } = await runSnippet(withConfig(code, CONFIG), hass);
    expect(String(thrown)).toContain('HACS manages Agraharam');
    expect(hass.calls.map((call) => call.type)).toEqual(['lovelace/resources']);
  });

  it('uses the current package version', () => {
    expect(code).toContain(`const VERSION = '${PACKAGE_VERSION}';`);
  });

  it.each([
    ['null', null],
    ['an object without views', {}],
    ['empty views', { views: [] }],
  ])('throws on CONFIG = %s before any call', async (_label, config) => {
    const hass = fakeHass(installHandlers());
    const source = config === null ? code : withConfig(code, config);
    const { thrown } = await runSnippet(source, hass);
    expect(String(thrown)).toContain('CONFIG is empty');
    expect(hass.calls).toEqual([]);
  });

  it('stops on two Agraharam resources after one read', async () => {
    const second = { id: 'res-2', url: '/local/agraharam/0.0.2/agraharam.js' };
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => [OLD_AGRAHARAM, second] }));
    const { thrown } = await runSnippet(withConfig(code, CONFIG), hass);
    expect(String(thrown)).toContain('Found 2 Agraharam resources');
    expect(hass.calls.map((call) => call.type)).toEqual(['lovelace/resources']);
  });

  it('never overwrites an existing agraharam-next dashboard: reads only', async () => {
    const hass = fakeHass(
      installHandlers({ 'lovelace/dashboards/list': () => [{ id: 'agraharam_next', url_path: 'agraharam-next' }] }),
    );
    const { thrown } = await runSnippet(withConfig(code, CONFIG), hass);
    expect(String(thrown)).toContain('already exists');
    expect(hass.calls.map((call) => call.type)).toEqual(['lovelace/resources', 'lovelace/dashboards/list']);
  });

  it('first install: creates one resource, the dashboard, then saves the config', async () => {
    const hass = fakeHass(installHandlers());
    const { thrown, logs } = await runSnippet(withConfig(code, CONFIG), hass);
    expect(thrown).toBeUndefined();
    expect(hass.calls).toEqual([
      { type: 'lovelace/resources' },
      { type: 'lovelace/dashboards/list' },
      { type: 'lovelace/resources/create', res_type: 'module', url: RESOURCE_URL },
      {
        type: 'lovelace/dashboards/create',
        url_path: 'agraharam-next',
        title: 'Agraharam',
        icon: 'mdi:home-heart',
        show_in_sidebar: true,
        require_admin: false,
        mode: 'storage',
      },
      { type: 'lovelace/config/save', url_path: 'agraharam-next', config: CONFIG },
    ]);
    expect(logs).toEqual(['resource id (save privately): res-new', 'dashboard id (save privately): agraharam_next']);
  });

  it('upgrade case: updates the single existing resource instead of adding one', async () => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => [OTHER_RESOURCE, OLD_AGRAHARAM] }));
    await runSnippet(withConfig(code, CONFIG), hass);
    expect(hass.calls[2]).toEqual({ type: 'lovelace/resources/update', resource_id: 'res-old', url: RESOURCE_URL });
    expect(hass.calls.some((call) => call.type === 'lovelace/resources/create')).toBe(false);
  });

  it('dashboard creation fails: prints the exact resource undo, which deletes only that resource', async () => {
    const failure = new Error('dashboard rejected');
    const hass = fakeHass(
      installHandlers({
        'lovelace/dashboards/create': () => {
          throw failure;
        },
      }),
    );
    const { thrown, errors } = await runSnippet(withConfig(code, CONFIG), hass);
    expect(thrown).toBe(failure);
    const commands = printedCommands(errors);
    expect(commands).toEqual(["await hass.callWS({ type: 'lovelace/resources/delete', resource_id: 'res-new' })"]);
    const undo = fakeHass(installHandlers());
    await runPrinted(commands[0] as string, undo);
    expect(undo.calls).toEqual([{ type: 'lovelace/resources/delete', resource_id: 'res-new' }]);
  });

  it('after an update, the printed undo points the resource back at the old URL', async () => {
    const hass = fakeHass(
      installHandlers({
        'lovelace/resources': () => [OLD_AGRAHARAM],
        'lovelace/dashboards/create': () => {
          throw new Error('dashboard rejected');
        },
      }),
    );
    const { errors } = await runSnippet(withConfig(code, CONFIG), hass);
    const undo = fakeHass(installHandlers());
    for (const command of printedCommands(errors)) await runPrinted(command, undo);
    expect(undo.calls).toEqual([{ type: 'lovelace/resources/update', resource_id: 'res-old', url: OLD_AGRAHARAM.url }]);
  });

  it('config save fails: prints undo commands for exactly the dashboard and resource it created', async () => {
    const hass = fakeHass(
      installHandlers({
        'lovelace/config/save': () => {
          throw new Error('save rejected');
        },
      }),
    );
    const { thrown, errors } = await runSnippet(withConfig(code, CONFIG), hass);
    expect(String(thrown)).toContain('save rejected');
    const undo = fakeHass(installHandlers());
    for (const command of printedCommands(errors)) await runPrinted(command, undo);
    expect(undo.calls).toEqual([
      { type: 'lovelace/dashboards/delete', dashboard_id: 'agraharam_next' },
      { type: 'lovelace/resources/delete', resource_id: 'res-new' },
    ]);
  });
});

describe('README upgrade snippet', () => {
  const code = snippet('upgrade-snippet');

  it('stops without writing when HACS manages Agraharam', async () => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => [OLD_AGRAHARAM, HACS_AGRAHARAM] }));
    const { thrown } = await runSnippet(code, hass);
    expect(String(thrown)).toContain('Update it in HACS');
    expect(hass.calls.map((call) => call.type)).toEqual(['lovelace/resources']);
  });

  it('uses the current package version', () => {
    expect(code).toContain(`const VERSION = '${PACKAGE_VERSION}';`);
  });

  it.each([
    ['no Agraharam resource', [OTHER_RESOURCE], 'Found 0 Agraharam resources'],
    ['two Agraharam resources', [OLD_AGRAHARAM, { id: 'res-2', url: RESOURCE_URL }], 'Found 2 Agraharam resources'],
    ['a resource already at this version', [{ id: 'res-cur', url: RESOURCE_URL }], 'already points at this version'],
  ])('stops without writing on %s', async (_label, resources, message) => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => resources }));
    const { thrown } = await runSnippet(code, hass);
    expect(String(thrown)).toContain(message);
    expect(hass.calls.map((call) => call.type)).toEqual(['lovelace/resources']);
  });

  it('updates the single resource and prints an undo that restores the old URL', async () => {
    const hass = fakeHass(installHandlers({ 'lovelace/resources': () => [OTHER_RESOURCE, OLD_AGRAHARAM] }));
    const { thrown, logs } = await runSnippet(code, hass);
    expect(thrown).toBeUndefined();
    expect(hass.calls[1]).toEqual({ type: 'lovelace/resources/update', resource_id: 'res-old', url: RESOURCE_URL });
    const undo = fakeHass(installHandlers());
    for (const command of printedCommands(logs)) await runPrinted(command, undo);
    expect(undo.calls).toEqual([{ type: 'lovelace/resources/update', resource_id: 'res-old', url: OLD_AGRAHARAM.url }]);
  });
});
