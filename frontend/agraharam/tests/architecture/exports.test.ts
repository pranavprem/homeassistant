/**
 * Unused-export guard (part of `npm run verify` through `npm test`): every name a production module exports (src/
 * and the build plugin) must be imported by some other PRODUCTION file (src, scripts or a root config file). Tests
 * do not count as users, so an export kept alive only by its tests fails here: it is dead code, or a genuine test
 * seam that TEST_SEAMS lists with its reason. Parsed with the TypeScript compiler API, so aliases, type-only
 * imports, re-exports and destructured dynamic imports all count.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
/** Production code: its imports count as uses. */
const PRODUCTION_DIRS = ['src', 'scripts'];
const PRODUCTION_ROOT_FILES = [
  'build-env.ts',
  'vite.config.ts',
  'vite.harness.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'vite-lit-css.ts',
];
/** Test code: scanned only to keep the test-seam allowlist honest. */
const TEST_DIRS = ['tests', 'e2e'];
/** Modules whose exports are checked: everything under src, plus the build plugin. */
const CHECKED_ROOT_FILES = ['vite-lit-css.ts'];
/**
 * The scan must see at least this many exports, so a broken walk or parser can never pass vacuously. The real count
 * is several hundred; the floor only needs to be well above zero.
 */
const MIN_EXPORTS_SCANNED = 300;

/**
 * Exports used only by tests, each a deliberate seam with its reason. Anything else used only by tests is dead
 * production code: delete it instead of listing it here.
 */
const TEST_SEAMS: Readonly<Record<string, string>> = Object.freeze({
  // Timing and limits the tests must advance by or measure against, rather than repeat as magic numbers.
  'src/agraharam-dashboard.ts: ORPHAN_DISPOSE_MS': 'tests advance the orphan timer by exactly this',
  'src/ha/actions/gateway.ts: RECENT_LIMIT': 'the ring-buffer bound the recent() tests fill past',
  'src/ha/actions/error-map.ts: HA_MESSAGE_MAX_CHARS': 'the cap the HA-message truncation tests measure',
  'src/ha/calendar-controller.ts: CALENDAR_REFRESH_MS': 'tests advance the calendar refresh timer by it',
  'src/ha/hass/calendar.ts: MAX_SUMMARY_CHARS': 'the cap the event-summary tests measure',
  'src/ha/hass/camera.ts: LIVE_HELPERS_TIMEOUT_MS': 'tests advance the live-helpers timeout by it',
  'src/ha/resync.ts: RESYNC_GRACE_MS': 'tests advance the resync grace by it (§16.15)',
  'src/components/sky/sky-clock.ts: SKY_TICK_MS':
    'tests advance the sky clock by it (the AIRSPACE.md §5 liveness bounds)',
  'src/model/home/vacuums.ts: VACUUM_ERROR_MAX_CHARS': 'the cap the vacuum error-text tests measure',
  'src/model/security.ts: HEALTH_TEXT_MAX_CHARS': 'the cap the health-text tests measure',
  'src/styles/breakpoints.ts: BREAKPOINTS': 'the layout tests probe each side of every breakpoint',
  'src/styles/breakpoints.ts: HYSTERESIS_PX': 'the layout tests probe each side of the hysteresis band',
  'src/styles/layout.ts: MAX_ABSORBED_SLACK_PX': 'the slack-cap tests measure against it (§16.14)',
  'src/styles/layout.ts: ALIGN_SNAP_PX': 'the slack-cap tests measure against it (§16.14)',
  // Copy the tests compare against, so a wording change is made once.
  'src/ha/actions/messages.ts: NOT_APPLICABLE_COPY': 'every not-applicable reason is checked against its copy',
  'src/ha/actions/messages.ts: SECURITY_TICKET_COPY': "the security controller's timeout line the drawer tests show",
  'src/ha/actions/messages.ts: GARAGE_TICKET_COPY': "the garage's timeout and reversal lines the panel tests show",
  'src/ha/hass/camera.ts: CONTAINED_EVENTS': 'the events the live-card containment tests fire',
  'src/ha/hass/camera.ts: LETTERBOX_COLOR': "the live card's letterbox the camera tests check",
  'src/model/garage.ts: DOOR_MOVING_REASON': 'the moving-door reason the garage tests check',
  'src/model/home/vacuums.ts: VACUUM_STARTING_REASON': 'the starting reason the vacuum tests check',
  'src/model/upcoming.ts: UPCOMING_NOTES': 'the empty and paused notes the upcoming tests check',
  // Pure steps of a larger pipeline, tested directly with inputs the pipeline cannot easily reach.
  'src/components/comfort/agr-comfort-tile.ts: climateIcon': 'the HVAC-mode glyph mapping, every mode at once',
  'src/components/shared/agr-fan-controls.ts: fanSpeedRequest': 'the slider value to request mapping, every step',
  'src/demo/configs.ts: mergeConfigFragments': 'the scenario config merge, with fragments no scenario uses',
  'src/demo/scenarios.ts: SCENARIO_SPECS': 'scenario specs read directly (connection script, behaviors)',
  'src/demo/simulate.ts: demoContextId': 'the context id a simulated change carries, which the simulate tests match',
  'src/demo/simulate.ts: SIMULATED_SERVICES': 'compared with the catalog, so the demo simulates every action',
  'src/demo/simulate.ts: simulateServiceCall': 'the demo device reaction to one call, without a host',
  'src/demo/simulate.ts: SIMULATED_REJECTIONS': 'the scripted rejections each scenario behavior is checked against',
  'src/ha/actions/error-map.ts: isPortNotSent': 'the port-refusal predicate, with hostile shapes',
  'src/ha/actions/error-map.ts: sanitizeHaMessage': 'HA message sanitizing, with hostile text',
  'src/ha/actions/error-map.ts: withoutEntityIds': 'entity-ID stripping, with every ID shape (§16.15)',
  'src/ha/actions/inflight.ts: createInflightRegistry': 'a private registry per test instead of the page singleton',
  'src/ha/calendar-controller.ts: calendarWindow': 'the fetch window across zones and day boundaries (§9.5)',
  'src/ha/camera-gate.ts: cameraGate': 'the pure gate on raw inputs, every privacy state (§9.3)',
  'src/ha/camera-gate.ts: privacyOffValue': 'the exact privacy-off value for each on value',
  'src/ha/format.ts: formatDuration': 'duration text, case by case',
  'src/ha/hass/calendar.ts: calendarPath': 'the calendar REST path and its range query',
  'src/ha/hass/calendar.ts: parseCalendarEvents': 'event parsing, with malformed payloads',
  'src/ha/hass/forecast.ts: parseForecastPayload': 'forecast parsing, with malformed payloads',
  'src/ha/snapshot-controller.ts: snapshotSize': 'the requested snapshot size for each box and ratio',
  'src/ha/snapshot-controller.ts: backoffDelay': 'the retry backoff schedule',
  'src/model/comfort.ts: comfortSummary': "Climate's header pill for each device mix",
  'src/model/comfort.ts: selectClimateTile': 'one climate tile without the panel budget',
  'src/model/comfort.ts: selectBedTile': 'one bed tile without the panel budget',
  'src/model/header.ts: greetingFor': 'the greeting at every hour boundary',
  'src/model/header.ts: initialsFor': 'presence initials for unusual names',
  'src/model/media.ts: activePlayer': 'which player leads, for every playback mix',
  'src/model/media.ts: selectMediaPlayer': 'one player view without the panel',
  'src/styles/layout.ts: NARROW_ORDER': 'the reference narrow order the column tests compare with',
  'src/styles/layout.ts: WIDE_COLUMNS': 'the reference wide columns the budget tests sum',
  'src/styles/layout.ts: slackAllowances': 'the slack cap on measured columns, without a DOM',
  'src/util/time.ts: msUntilNextMinute': 'the minute ticker alignment at every second',
  // Sky (AIRSPACE.md §10, ARCHITECTURE.md §19): fixture builders for every sky state, and the pure parser and
  // geometry steps.
  'src/demo/fixtures/sky.ts: skyEntity':
    'the sky sensor in each fixture state; only the sky scenario uses normal (AIRSPACE.md §10)',
  'src/demo/fixtures/sky.ts: skyAttributes': 'fixture payloads the parser and selector tests modify field by field',
  'src/demo/fixtures/sky.ts: SKY_FIXTURE_KINDS': 'every fixture state, for the fictional-pattern and no-NaN tests',
  'src/demo/fixtures/sky.ts: SkyFixtureKind': 'the builder kind the sky component tests take as a parameter',
  'src/demo/fixtures/sky.ts: DEMO_SKY_AIRSPACE': 'the fictional sensor ID the sky component tests bind',
  'src/model/airspace.ts: parseAirspace':
    'the pure clock-independent parser, tested field by field with hostile payloads',
  'src/model/radar.ts: radarPoint': 'radar geometry at the cardinal bearings and the clamp',
  // Types the tests annotate their fixtures with.
  'src/config/validate.ts: ValidationResult': 'the result type the validation tests narrow',
  'src/dev/fake-hass.ts: FakeHassObject': 'the fake hass type the acceptance tests transform',
  'src/domain/steps.ts: StepGrid': 'the grid type the step tests build',
  'src/ha/camera-gate.ts: CameraGateInput': 'the raw gate input the gate tests build',
  'src/ha/entity-store.ts: StoreSnapshot': 'the snapshot type the store tests ingest',
  'src/styles/layout.ts: MeasuredColumn': 'the measurement type the slack tests build',
  // The build plugin's pure transform.
  'vite-lit-css.ts: minifyCssTemplates': 'the build transform, tested without running Vite',
  'vite-lit-css.ts: minifyCssText': 'one static run of CSS text, the unit the edge-case tests pin',
});

const CODE_FILE = /\.(?:ts|mjs)$/;
/** Every name of a module counts as used: `import * as x`, `export * from` or an unresolved dynamic import. */
const ALL = '*';

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) return walk(full);
    return CODE_FILE.test(full) && !full.endsWith('.d.ts') ? [full] : [];
  });
}

const PRODUCTION_FILES = [
  ...PRODUCTION_DIRS.flatMap((dir) => walk(join(ROOT, dir))),
  ...PRODUCTION_ROOT_FILES.map((file) => join(ROOT, file)),
];
const TEST_FILES = TEST_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
const CHECKED_FILES = [...walk(join(ROOT, 'src')), ...CHECKED_ROOT_FILES.map((file) => join(ROOT, file))];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Element classes a module names in its own `declare global { interface HTMLElementTagNameMap { … } }`: the class
 * is the public type behind its tag (what `document.createElement('agr-…')` returns), so it counts as used.
 */
function tagMapClasses(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isModuleDeclaration(statement) || statement.name.getText() !== 'global') continue;
    const body = statement.body;
    if (body === undefined || !ts.isModuleBlock(body)) continue;
    for (const declaration of body.statements) {
      if (!ts.isInterfaceDeclaration(declaration) || declaration.name.text !== 'HTMLElementTagNameMap') continue;
      for (const member of declaration.members) {
        if (ts.isPropertySignature(member) && member.type !== undefined && ts.isTypeReferenceNode(member.type)) {
          names.add(member.type.typeName.getText());
        }
      }
    }
  }
  return names;
}

/** The names a module exports itself (declarations and `export { … }` lists, re-exports included). */
function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    } else if (hasExportModifier(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        names.push(statement.name.text);
      }
    }
  }
  return names;
}

function resolveSpecifier(from: string, specifier: string): string | undefined {
  return specifier.startsWith('.') ? resolve(dirname(from), specifier) : undefined;
}

/** What a dynamic `import('…')` uses: the destructured names, `x.name` reads of its binding, or everything. */
function dynamicImportNames(call: ts.CallExpression, text: string): string[] {
  const awaited = ts.isAwaitExpression(call.parent) ? call.parent : call;
  const declaration = awaited.parent;
  if (!ts.isVariableDeclaration(declaration)) return [ALL];
  if (ts.isObjectBindingPattern(declaration.name)) {
    return declaration.name.elements.map((element) => (element.propertyName ?? element.name).getText());
  }
  if (!ts.isIdentifier(declaration.name)) return [ALL];
  const binding = declaration.name.text;
  return [...text.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'g'))].map((match) => match[1] ?? ALL);
}

/** Module path → names the given files use from it. */
function usedNames(files: readonly string[]): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  const record = (target: string | undefined, names: readonly string[]): void => {
    if (target === undefined) return;
    const set = used.get(target) ?? new Set<string>();
    for (const name of names) set.add(name);
    used.set(target, set);
  };
  for (const file of files) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        const names =
          bindings === undefined
            ? []
            : ts.isNamespaceImport(bindings)
              ? [ALL]
              : bindings.elements.map((element) => (element.propertyName ?? element.name).getText());
        record(resolveSpecifier(file, node.moduleSpecifier.text), names);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.exportClause;
        const names =
          clause === undefined || !ts.isNamedExports(clause)
            ? [ALL]
            : clause.elements.map((element) => (element.propertyName ?? element.name).getText());
        record(resolveSpecifier(file, node.moduleSpecifier.text), names);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        record(resolveSpecifier(file, node.arguments[0].text), dynamicImportNames(node, source.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return used;
}

/** "path: name" for every export of the checked modules, with the names production and tests use. */
function exportReport(): { readonly scanned: number; readonly unused: string[]; readonly testOnly: string[] } {
  const production = usedNames(PRODUCTION_FILES);
  const tests = usedNames(TEST_FILES);
  let scanned = 0;
  const unused: string[] = [];
  const testOnly: string[] = [];
  for (const file of CHECKED_FILES) {
    const source = parse(file);
    const inProduction = production.get(file) ?? new Set<string>();
    const inTests = tests.get(file) ?? new Set<string>();
    const elements = tagMapClasses(source);
    for (const name of exportedNames(source)) {
      scanned += 1;
      if (inProduction.has(ALL) || inProduction.has(name) || elements.has(name)) continue;
      const label = `${relative(ROOT, file).split('\\').join('/')}: ${name}`;
      if (inTests.has(ALL) || inTests.has(name)) testOnly.push(label);
      else unused.push(label);
    }
  }
  return { scanned, unused, testOnly };
}

describe('fitness: exports', () => {
  const report = exportReport();

  it('scans enough exports that it cannot pass vacuously', () => {
    expect(report.scanned).toBeGreaterThanOrEqual(MIN_EXPORTS_SCANNED);
  });

  it('exports from production modules only what another production file imports', () => {
    expect(report.unused, 'exported but never imported: drop the export or the symbol').toEqual([]);
  });

  it('keeps an export alive for tests only when TEST_SEAMS lists it with a reason', () => {
    const unlisted = report.testOnly.filter((label) => !Object.hasOwn(TEST_SEAMS, label));
    expect(unlisted, 'used only by tests: delete it, or list it in TEST_SEAMS with its reason').toEqual([]);
  });

  it('lists no stale test seams', () => {
    const stale = Object.keys(TEST_SEAMS).filter((label) => !report.testOnly.includes(label));
    expect(stale, 'TEST_SEAMS entries that production now uses, or that no longer exist').toEqual([]);
  });
});
