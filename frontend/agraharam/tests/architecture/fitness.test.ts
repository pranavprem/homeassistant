/**
 * Architecture fitness rules (§12.1 row 11 and the rules other rows assign here). Each rule scans source text, so a
 * regression fails the suite before it can reach a browser. Comments are stripped first: rules are about code.
 * Banned service strings are assembled at runtime so this file itself passes the public-literal check (§11.1).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

interface SourceFile {
  readonly path: string; // relative to the package root, with forward slashes
  readonly code: string; // comments removed
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Removes block comments and whole-line // comments; trailing comments must not contain banned words either. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FILES: readonly SourceFile[] = walk(SRC).map((full) => ({
  path: relative(ROOT, full).split('\\').join('/'),
  code: stripComments(readFileSync(full, 'utf8')),
}));

function filesMatching(pattern: RegExp, files: readonly SourceFile[] = FILES): string[] {
  return files.filter((file) => pattern.test(file.code)).map((file) => file.path);
}

const outsideDev = FILES.filter((file) => !file.path.startsWith('src/dev/'));
const components = FILES.filter((file) => file.path.startsWith('src/components/'));
/** The view layer: section elements and their pure view models. */
const layered = FILES.filter((file) => file.path.startsWith('src/components/') || file.path.startsWith('src/model/'));
const adapter = FILES.filter((file) => file.path.startsWith('src/ha/'));
const domain = FILES.filter((file) => file.path.startsWith('src/domain/'));

/**
 * Every relative module specifier of a file, resolved to a path relative to src/: static imports (type-only and
 * bare side-effect imports included), re-exports and dynamic import() calls.
 */
function importsOf(file: SourceFile): string[] {
  return [...file.code.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)'(\.[^']+)'/g)].map((match) =>
    relative(SRC, resolve(dirname(join(ROOT, file.path)), match[1] ?? ''))
      .split('\\')
      .join('/'),
  );
}

describe('fitness: injection and HA surfaces (§12.1 rows 6, 11)', () => {
  it('has no raw HTML sinks, eval or Function in src', () => {
    expect(filesMatching(/unsafeHTML|unsafeSVG|innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/)).toEqual(
      [],
    );
  });

  it('never dispatches hass-more-info, hass-action or ll-custom (HA raw controls stay unreachable)', () => {
    expect(filesMatching(/new (?:Custom)?Event\(\s*['"](?:hass-more-info|hass-action|ll-custom)['"]/)).toEqual([]);
  });

  it('touches the console only in util/log.ts', () => {
    expect(filesMatching(/\bconsole\./).filter((path) => path !== 'src/util/log.ts')).toEqual([]);
  });

  it('calls hass.callService only in hass-host.ts', () => {
    expect(filesMatching(/\.callService\(/, outsideDev)).toEqual(['src/ha/hass-host.ts']);
  });

  it('subscribes only in ha/hass/forecast.ts, and only to weather/subscribe_forecast', () => {
    const subscribers = filesMatching(/\.subscribeMessage\(/, outsideDev);
    expect(subscribers.filter((path) => path !== 'src/ha/hass/forecast.ts')).toEqual([]);
    for (const path of subscribers) {
      expect(FILES.find((file) => file.path === path)?.code).toContain("'weather/subscribe_forecast'");
    }
  });

  it('uses callApi only in ha/hass/calendar.ts and fetchWithAuth only in ha/hass/camera.ts', () => {
    expect(filesMatching(/\.callApi\(/, outsideDev).filter((path) => path !== 'src/ha/hass/calendar.ts')).toEqual([]);
    expect(filesMatching(/\.fetchWithAuth\(/, outsideDev).filter((path) => path !== 'src/ha/hass/camera.ts')).toEqual(
      [],
    );
  });

  it('never uses callWS, sendMessage or sendMessagePromise outside the dev fakes', () => {
    expect(filesMatching(/\bcallWS\b|\bsendMessage(?:Promise)?\b/, outsideDev)).toEqual([]);
  });

  it("never queries document.querySelector('home-assistant'), dev included", () => {
    expect(filesMatching(/querySelector\(\s*['"]home-assistant['"]/)).toEqual([]);
  });

  it('registers connection event listeners only in ha/resync.ts', () => {
    expect(
      filesMatching(/\b(?:conn|connection)\??\.addEventListener\(/).filter((path) => path !== 'src/ha/resync.ts'),
    ).toEqual([]);
  });

  it('reads only user.is_admin and themes.darkMode from hass in the root card (§4.4)', () => {
    const root = FILES.find((file) => file.path === 'src/agraharam-dashboard.ts')?.code ?? '';
    const reads = [...root.matchAll(/(?:\bhass|#hass)\s*\??\.\s*(\w+)(?:\s*\??\.\s*(\w+))?/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(['user.is_admin', 'themes.darkMode']));
  });

  it('lets only agr-confirm-dialog mint confirmation tokens, and only the gateway redeem them (§4.7 step 11)', () => {
    const tokens = 'src/ha/actions/confirmation.ts';
    // Any mention counts (import, alias or call), so an aliased import cannot hide a second minter.
    expect(filesMatching(/\bmintConfirmationToken\b/).filter((path) => path !== tokens)).toEqual([
      'src/components/primitives/agr-confirm-dialog.ts',
    ]);
    expect(filesMatching(/\bredeemConfirmationToken\b/).filter((path) => path !== tokens)).toEqual([
      'src/ha/actions/gateway.ts',
    ]);
  });

  it('has no plain confirmed flag in src: a confirmation is a token', () => {
    expect(filesMatching(/\bconfirmed\s*:\s*true\b/)).toEqual([]);
  });

  it('contains no raw alarm, helper-write or automation service strings', () => {
    const banned = [
      ['alarm', 'arm'].join('_'),
      ['alarm', 'disarm'].join('_'),
      ['select', 'option'].join('_'),
      ['input_boolean', 'turn'].join('.'),
      'automation' + '.',
    ];
    for (const word of banned) expect(filesMatching(new RegExp(word.replace('.', '\\.'))), word).toEqual([]);
  });
});

/**
 * The adapter boundary (§2.1, §4.4): components and models reach Home Assistant only through these src/ha modules.
 * Anything else under src/ha is the adapter's own business; a new entry needs a reason here.
 */
const HA_MODULES_FOR_VIEWS: Readonly<Record<string, string>> = Object.freeze({
  'actions/types': 'the action contract: requests, keys, statuses, Availability',
  'actions/action-controller': 'every section turns gestures into tickets and drafts through it',
  'actions/confirmation': 'agr-confirm-dialog mints tokens (pinned to that one file above)',
  'actions/messages': 'refusal copy the gateway and the selectors must word the same way',
  'actions/catalog': 'the Home selector reads which covers room controls never move (§4.7 step 5a)',
  'entity-controller': 'sections subscribe to the store through it',
  'entity-store': 'the read-only StoreView type only',
  host: 'reader, formatter, phases and the other read contracts',
  normalize: 'entity statuses and null-safe displays',
  features: 'capability facts shared with the gateway',
  types: 'HassEntityLike only (attributes the selectors read)',
  format: 'calendar-day helpers in the formatter zone',
  derive: 'derived vacuum batteries, shared with diagnostics',
  'status-board': 'the StatusBoard type diagnostics reads',
  'camera-gate': 'the pure privacy and availability gate and its CameraGate verdict',
  'snapshot-controller': 'camera stills',
  'forecast-controller': 'the weather forecast',
  'calendar-controller': 'calendar events',
  'live-view-controller': 'the camera live-view lifecycle',
});

/**
 * The mirror rule: the adapter reaches the view layer only through these modules, each type-only. Pure rules both
 * sides need live in src/domain instead.
 */
const VIEW_MODULES_FOR_HA: Readonly<Record<string, string>> = Object.freeze({
  'components/services':
    'the DashboardServices type: ActionController and LiveViewController are reactive controllers a section hands it',
});

describe('fitness: adapter boundary (§2.1, §4.4)', () => {
  it('finds bare side-effect imports and dynamic import() calls as well as from-clauses', () => {
    const sample: SourceFile = {
      path: 'src/components/x/sample.ts',
      code: "import './a.ts';\nconst b = await import('../b.ts');\nimport type { C } from '../../c.ts';",
    };
    expect(importsOf(sample)).toEqual(['components/x/a.ts', 'components/b.ts', 'c.ts']);
  });

  it('imports from src/ha only the modules on the allowlist', () => {
    const imported = layered.flatMap((file) =>
      importsOf(file)
        .filter((target) => target.startsWith('ha/'))
        .map((target) => ({ file: file.path, module: target.slice('ha/'.length).replace(/\.ts$/, '') })),
    );
    expect(imported.length, 'the scan found no src/ha imports at all').toBeGreaterThan(0);
    const offenders = imported.filter(({ module }) => !Object.hasOwn(HA_MODULES_FOR_VIEWS, module));
    expect(offenders.map(({ file, module }) => `${file} → ha/${module}`)).toEqual([]);
  });

  it('takes only the StoreView type from the entity store, and HassEntityLike from the host types', () => {
    const narrow = /import type \{\s*(\w+)\s*\} from '(?:\.\.\/)+ha\/(entity-store|types)\.ts'/;
    const offenders = layered.flatMap((file) =>
      [...file.code.matchAll(/^import[^;]*?from '(?:\.\.\/)+ha\/(?:entity-store|types)\.ts';/gm)]
        .filter((match) => {
          const named = narrow.exec(match[0]);
          return (
            named === null || (named[2] === 'entity-store' ? named[1] !== 'StoreView' : named[1] !== 'HassEntityLike')
          );
        })
        .map((match) => `${file.path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never names HassLike, EntityStore, ServicePort or a hass object, and never imports demo or dev code', () => {
    expect(filesMatching(/\bHassLike\b|\bEntityStore\b|\bServicePort\b|\.hass\b(?!-)/, layered)).toEqual([]);
    const reachesDemoOrDev = layered.filter((file) =>
      importsOf(file).some((target) => target.startsWith('demo/') || target.startsWith('dev/')),
    );
    expect(reachesDemoOrDev.map((file) => file.path)).toEqual([]);
  });

  it('src/ha imports nothing from src/model or src/components except the type-only allowlist', () => {
    const offenders = adapter.flatMap((file) =>
      importsOf(file)
        .filter((target) => target.startsWith('model/') || target.startsWith('components/'))
        .map((target) => target.replace(/\.ts$/, ''))
        .filter((module) => !Object.hasOwn(VIEW_MODULES_FOR_HA, module))
        .map((module) => `${file.path} → ${module}`),
    );
    expect(adapter.length, 'the scan found no src/ha files').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    const valueImports = adapter.flatMap((file) =>
      [...file.code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)]
        .filter((match) => /\/(?:model|components)\//.test(match[1] ?? ''))
        .map((match) => `${file.path}: ${match[0]}`),
    );
    expect(valueImports, 'allowlisted view modules are imported as types only').toEqual([]);
  });

  it('src/domain imports nothing from src/model or src/components', () => {
    expect(domain.length, 'the scan found no src/domain files').toBeGreaterThan(0);
    const offenders = domain.flatMap((file) =>
      importsOf(file)
        .filter((target) => target.startsWith('model/') || target.startsWith('components/'))
        .map((target) => `${file.path} → ${target}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('fitness: browser floor and privacy (§1.2 item 11, §12.1 row 11)', () => {
  it('uses no regex lookbehind (a parse error for the whole bundle before Safari 16.4)', () => {
    expect(filesMatching(/\(\?<[=!]/)).toEqual([]);
  });

  it('uses no ES2023 array-copy methods', () => {
    expect(filesMatching(/\.(?:toSorted|toReversed|toSpliced|with)\(/)).toEqual([]);
  });

  it('uses no browser storage anywhere in src, dev shell included (URL query state only)', () => {
    expect(filesMatching(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\.|document\.cookie/)).toEqual([]);
  });

  it('keeps Lit css templates free of nesting, :has(), color-mix(), light-dark() and subgrid', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of file.code.matchAll(/css`([\s\S]*?)`/g)) {
        const css = match[1] ?? '';
        if (/&|:has\(|color-mix\(|light-dark\(|subgrid/.test(css)) offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writes size queries with only (width < N) and (width >= N), as PANEL_CQ documents (§6.1)', () => {
    const query = /@(?:container|media)[^{]*?\(\s*(?:width|height|inline-size|block-size)\s*(?:<=|>(?!=))/;
    expect(filesMatching(/@container[^{]*\(\s*width\s*</).length, 'the scan found no range queries').toBeGreaterThan(0);
    expect(filesMatching(query)).toEqual([]);
  });

  it('never uses plain olive or brass as a text color (they fail 4.5:1)', () => {
    expect(filesMatching(/(?:^|[^\w-])color:\s*var\(--agr-(?:olive|brass)\)/m)).toEqual([]);
  });

  it('names no Lucide aliases in the icon registry', () => {
    expect(filesMatching(/circle-help/).filter((path) => path === 'src/icons/icons.ts')).toEqual([]);
  });
});

describe('fitness: choice controls (§7.2)', () => {
  it('never uses radios, radiogroups, listboxes or selects in components', () => {
    expect(filesMatching(/type=["']radio["']|role=["'](?:radio|radiogroup|listbox)["']|<select/, components)).toEqual(
      [],
    );
  });
});

describe('fitness: error containment (§4.9)', () => {
  /** The statement starting at `start`: up to the first `;` outside brackets. */
  function statementAt(code: string, start: number): string {
    let depth = 0;
    for (let index = start; index < code.length; index += 1) {
      const char = code[index];
      if (char === '(' || char === '{' || char === '[') depth += 1;
      else if (char === ')' || char === '}' || char === ']') depth -= 1;
      else if (char === ';' && depth <= 0) return code.slice(start, index);
    }
    return code.slice(start);
  }

  it('never discards a promise with void unless the statement ends in .catch()', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of file.code.matchAll(/\bvoid\s+(?=[\w.$#])/g)) {
        const statement = statementAt(file.code, match.index ?? 0);
        if (/\(/.test(statement) && !/\.catch\(/.test(statement)) offenders.push(`${file.path}: ${statement.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('fitness: dev/harness import boundary (§10.3)', () => {
  const ALLOWED = [
    /^src\/dev\/(?:ha-shell|fake-hass|main-harness)\.ts$/,
    /^src\/demo\/(?:fixture-types|scenarios|configs|simulate)\.ts$/,
    /^src\/demo\/fixtures\/[\w-]+\.ts$/,
    /^src\/config\/[\w-]+\.ts$/,
    /^src\/ha\/features\.ts$/, // pure constants used by fixtures
    /^src\/timing\.ts$/, // timing the shell shares with the card and e2e, import-free
  ];

  /** Value imports only: `import type` is erased and cannot pull element source into the harness. */
  function valueImports(path: string): string[] {
    const code = FILES.find((file) => file.path === path)?.code ?? '';
    const specifiers = [
      ...[...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]),
      ...[...code.matchAll(/^import\s+'([^']+)'/gm)].map((match) => match[1]),
    ];
    return specifiers
      .filter((specifier): specifier is string => specifier !== undefined && specifier.startsWith('.'))
      .map((specifier) =>
        relative(ROOT, resolve(dirname(join(ROOT, path)), specifier))
          .split('\\')
          .join('/'),
      );
  }

  function closure(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...valueImports(next));
    }
    return seen;
  }

  it.each(['src/dev/main-harness.ts', 'src/dev/ha-shell.ts', 'src/dev/fake-hass.ts'])(
    '%s reaches no element source, demo host or demo stream',
    (entry) => {
      const reached = [...closure(entry)];
      expect(reached.filter((path) => !ALLOWED.some((allowed) => allowed.test(path)))).toEqual([]);
    },
  );

  it('main-dev.ts is the only dev file that imports element source', () => {
    const devFiles = FILES.filter((file) => file.path.startsWith('src/dev/')).map((file) => file.path);
    const importingElements = devFiles.filter((path) =>
      valueImports(path).some((target) => /^src\/(?:agraharam|components\/)/.test(target)),
    );
    expect(importingElements).toEqual(['src/dev/main-dev.ts']);
  });
});
