/**
 * The positive public-literal check (§11.1, §12.1): every entity-ID-shaped literal in src/demo, src/dev, tests,
 * e2e and install must be fictional (`demo_`), a reviewed exemption, or a §7.1 catalog `domain.service`. It needs
 * no private files, so it protects a machine without `.dashboard-local/` too.
 *
 * Non-demo IDs in the unit cases are built at runtime by concatenation, so this file's own source passes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildForbiddenSet,
  checkPublicLiterals,
  FILE_EXTENSIONS,
  isPublicLiteralScope,
  KNOWN_ENTITY_DOMAINS,
  literalRegions,
  type FileHit,
} from '../../scripts/lib/public-scan.mjs';
import { findRepoRoot, listWorkingFiles, loadExemptions, PACKAGE_PATH } from '../../scripts/lib/repo-files.mjs';
import { DOMAINS_BY_ROLE } from '../../src/config/schema.ts';
import { ACTION_CATALOG } from '../../src/ha/actions/catalog.ts';
import { PACKAGE_DIR } from './support/temp-repo.ts';

const exemptions = loadExemptions();
/** §7.1 catalog identifiers a public file may name: `domain.service` pairs and action kinds. */
/** Every `domain.service` the catalog can call (for example `cover.open_cover`). */
const ACTION_KINDS = Object.keys(ACTION_CATALOG) as (keyof typeof ACTION_CATALOG)[];
const CATALOG_SERVICES = ACTION_KINDS.map((kind) => `${ACTION_CATALOG[kind].domain}.${ACTION_CATALOG[kind].service}`);
const CATALOG_LITERALS = [...new Set(CATALOG_SERVICES), ...ACTION_KINDS];
const join2 = (...parts: string[]) => parts.join('.');
const REAL_LOOKING_LIGHT = join2('light', 'kitchen');

function check(path: string, text: string): FileHit[] {
  return checkPublicLiterals({ files: [{ path, text }], exemptions, catalogLiterals: CATALOG_LITERALS });
}

function format(hit: FileHit): string {
  return `${hit.path}:${hit.line}:${hit.column} ${hit.rule}`;
}

describe('public literals on the real tree', () => {
  it('finds no non-fictional entity ID in src/demo, src/dev, tests, e2e or install', () => {
    const repoRoot = findRepoRoot(PACKAGE_DIR);
    const files = listWorkingFiles(repoRoot)
      .map((path) => path.slice(PACKAGE_PATH.length + 1))
      .filter(isPublicLiteralScope)
      .flatMap((path) => {
        try {
          return [{ path, text: readFileSync(join(PACKAGE_DIR, path), 'utf8') }];
        } catch {
          return []; // listed by git but deleted in the working tree
        }
      });
    expect(files.length).toBeGreaterThan(0);
    const hits = checkPublicLiterals({ files, exemptions, catalogLiterals: CATALOG_LITERALS });
    expect(hits.map(format), 'replace each with a *.demo_* ID, or add a reviewed generic value to exemptions').toEqual(
      [],
    );
  });
});

describe('checkPublicLiterals', () => {
  it('fails a non-demo light ID with path:line:column and the public-literal rule', () => {
    const hits = check('tests/x.test.ts', `const a = 1;\nconst LIGHT = '${REAL_LOOKING_LIGHT}';\n`);
    expect(hits.map(format)).toEqual(['tests/x.test.ts:2:16 public-literal']);
  });

  it.each([
    ['a demo ID', "const LIGHT = 'light.demo_kitchen';"],
    ['an exempted generic ID', "const SUN = 'sun.sun';"],
    ['a catalog domain.service', "expect(call).toBe('light.turn_on');"],
    ['a catalog action kind', "request({ kind: 'light.set_brightness' });"],
    ['a bare demo object in an invalid-ID table', "['light.demo', 'light.demo.kitchen', 'light.demo-x', 'light.a.b']"],
    ['a file name with an entity-domain stem', "import '../../src/ha/hass/camera.ts';"],
    ['code that is not a literal', `if (${join2('event', 'target')} === ${join2('button', 'label')}) x = 1;`],
  ])('passes %s', (_label, source) => {
    expect(check('tests/x.test.ts', source)).toEqual([]);
  });

  it('checks comments and template text, but not template expressions', () => {
    const source = [
      `// see ${REAL_LOOKING_LIGHT}`,
      'const t = `${' + join2('event', 'target') + '} ok`;',
      `const u = \`text ${REAL_LOOKING_LIGHT}\`;`,
    ].join('\n');
    expect(check('tests/x.test.ts', source).map(format)).toEqual([
      'tests/x.test.ts:1:8 public-literal',
      'tests/x.test.ts:3:17 public-literal',
    ]);
  });

  it('treats every token of YAML, JSON and Markdown files as a literal', () => {
    expect(check('install/x.yaml', `weather: ${join2('weather', 'home')}\n`).map(format)).toEqual([
      'install/x.yaml:1:10 public-literal',
    ]);
    expect(check('tests/fixtures/x.json', `{"a": "${join2('switch', 'porch')}"}`)).toHaveLength(1);
    expect(check('install/README.md', 'Run script.turn_on, never automation.demo_x directly.')).toEqual([]);
  });

  it('ignores a regular expression literal that looks like an ID', () => {
    expect(check('tests/x.test.ts', `const re = /light\\.kitchen/;`)).toEqual([]);
  });

  it('fails a non-demo lock ID (lock is a core entity platform)', () => {
    const lockId = join2('lock', 'front_door');
    expect(check('src/demo/fixtures/x.ts', `const LOCK = '${lockId}';`).map(format)).toEqual([
      'src/demo/fixtures/x.ts:1:15 public-literal',
    ]);
  });
});

describe('checkPublicLiterals: CSS selector arguments', () => {
  const closeButton = join2('button', 'close');
  const confirmButton = join2('button', 'confirm');

  it.each([
    ['querySelector', `root.querySelector('${closeButton}')`],
    ['querySelector with type arguments', `root.querySelector<HTMLButtonElement>('${closeButton}')`],
    ['querySelectorAll in a template', `root.querySelectorAll(\`section ${confirmButton}\`)`],
    ['closest and matches', `el.closest('${closeButton}'); el.matches("${confirmButton}");`],
    ['a Playwright locator', `page.locator('${closeButton}')`],
    ['the second argument of deepQueryAll', `deepQueryAll<HTMLButtonElement>(document.body, '${confirmButton}')`],
  ])('reads a selector passed to %s as CSS, not as an entity ID', (_label, source) => {
    expect(check('tests/x.test.ts', source)).toEqual([]);
  });

  it('still checks attribute values inside a selector', () => {
    const source = `root.querySelector('${closeButton}[data-entity="${REAL_LOOKING_LIGHT}"]')`;
    expect(check('tests/x.test.ts', source).map(format)).toEqual(['tests/x.test.ts:1:47 public-literal']);
  });

  it('still checks the same text outside a selector call, and in a nested non-selector call', () => {
    expect(check('tests/x.test.ts', `label('${closeButton}')`)).toHaveLength(1);
    expect(check('tests/x.test.ts', `root.querySelector(pick('${closeButton}'))`)).toHaveLength(1);
    expect(check('tests/x.test.ts', `const s = '${closeButton}'; root.querySelector(s);`)).toHaveLength(1);
  });
});

describe('literalRegions', () => {
  it('returns string contents and comments, skipping code and regex literals', () => {
    const source = "a.b('x.y') /* c.d */ // e.f\nconst r = /g.h/; `i ${j.k} l`";
    const texts = literalRegions(source).map(([start, end]) => source.slice(start, end));
    expect(texts).toEqual(['x.y', ' c.d ', ' e.f', 'i ', ' l']);
  });

  it('flags direct string arguments of selector calls, including template text after an expression', () => {
    const source = "q.querySelector('a.b', f('c.d'), `e ${g} h`); f('i.j')";
    const regions = literalRegions(source).map(([start, end, isSelector]) => [source.slice(start, end), isSelector]);
    expect(regions).toEqual([
      ['a.b', true],
      ['c.d', false],
      ['e ', true],
      [' h', true],
      ['i.j', false],
    ]);
  });
});

describe('exemptions and the shared domain list', () => {
  it('service_names covers every §7.1 catalog service, so no catalog service is ever forbidden', () => {
    for (const call of CATALOG_SERVICES) {
      expect(exemptions.serviceNames.has(call.slice(call.indexOf('.') + 1)), call).toBe(true);
    }
  });

  it('every catalog service and every exempted entity ID has a known entity domain', () => {
    for (const id of [...CATALOG_SERVICES, ...exemptions.entityIds]) {
      expect(KNOWN_ENTITY_DOMAINS.has(id.slice(0, id.indexOf('.'))), id).toBe(true);
    }
  });

  it('the shared domain list includes every DOMAINS_BY_ROLE domain and the helper domains', () => {
    const roleDomains = Object.values(DOMAINS_BY_ROLE).flat();
    for (const domain of [...roleDomains, 'input_number', 'input_datetime', 'counter', 'timer', 'group', 'schedule']) {
      expect(KNOWN_ENTITY_DOMAINS.has(domain), domain).toBe(true);
    }
  });

  it('the shared domain list includes every domain §11.1 rule 2 names explicitly', () => {
    const RULE_2_DOMAINS = [
      'sensor',
      'switch',
      'automation',
      'device_tracker',
      'todo',
      'button',
      'number',
      'lock',
      'scene',
      'zone',
      'update',
    ];
    for (const domain of RULE_2_DOMAINS) expect(KNOWN_ENTITY_DOMAINS.has(domain), domain).toBe(true);
  });

  it('the shared domain list includes every core entity platform (homeassistant.const.Platform)', () => {
    const CORE_PLATFORMS = [
      'ai_task',
      'air_quality',
      'alarm_control_panel',
      'assist_satellite',
      'binary_sensor',
      'button',
      'calendar',
      'camera',
      'climate',
      'conversation',
      'cover',
      'date',
      'datetime',
      'device_tracker',
      'event',
      'fan',
      'geo_location',
      'humidifier',
      'image',
      'image_processing',
      'lawn_mower',
      'light',
      'lock',
      'media_player',
      'notify',
      'number',
      'remote',
      'scene',
      'select',
      'sensor',
      'siren',
      'stt',
      'switch',
      'text',
      'time',
      'todo',
      'tts',
      'update',
      'vacuum',
      'valve',
      'wake_word',
      'water_heater',
      'weather',
    ];
    for (const domain of CORE_PLATFORMS) expect(KNOWN_ENTITY_DOMAINS.has(domain), domain).toBe(true);
  });

  it('rule 2 collects a lock ID embedded in private prose', () => {
    const forbidden = buildForbiddenSet(
      { documents: [{ known_ambiguities: ['The lock.demo_side_gate entry may be stale; confirm it live.'] }] },
      exemptions,
    );
    expect(forbidden.entityIds.has('lock.demo_side_gate')).toBe(true);
    expect(forbidden.objectIds.has('demo_side_gate')).toBe(true);
  });

  it('no file extension is also an entity domain', () => {
    for (const extension of FILE_EXTENSIONS) expect(KNOWN_ENTITY_DOMAINS.has(extension), extension).toBe(false);
  });

  it('exempts no demo IDs (they never need it) and no object IDs yet without review', () => {
    for (const id of exemptions.entityIds) expect(id).not.toMatch(/\.demo_/);
    expect([...exemptions.objectIds]).toEqual([]);
  });
});
