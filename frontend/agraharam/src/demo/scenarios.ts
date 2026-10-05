/**
 * Scenario specs and generic assembly (§10.2). Host-level facts live here; everything a section shows comes
 * from its own fixture, merged generically, so this file is never edited per section.
 *
 * Dev-boundary note (§10.3): FakeHass imports this file, so it imports only fixtures, types and src/config.
 */
import type { DemoScenarioId, EntityId } from '../config/schema.ts';
import type { CalendarEventLike } from '../ha/host.ts';
import type { HassEntityLike, RegistryEntryLike } from '../ha/types.ts';
import { demoCardInput } from './configs.ts';
import type { AssembledScenario, DemoBehavior, FixtureClock, ScenarioSpec } from './fixture-types.ts';
import { SECTION_FIXTURES } from './fixtures/index.ts';

/** Fictional-safe version string shown in diagnostics. */
const DEMO_HA_VERSION = '2026.9.2';

const BASE_SPEC = {
  connection: 'connected',
  haState: 'RUNNING',
  haVersion: DEMO_HA_VERSION,
  user: { is_admin: true },
  missingServices: [],
  holdFirstIngest: false,
} as const satisfies Omit<ScenarioSpec, 'id'>;

export const SCENARIO_SPECS: Readonly<Record<DemoScenarioId, ScenarioSpec>> = Object.freeze({
  normal: { ...BASE_SPEC, id: 'normal' },
  degraded: { ...BASE_SPEC, id: 'degraded' },
  offline: { ...BASE_SPEC, id: 'offline', connection: 'drop-after-first-ingest' },
  empty: { ...BASE_SPEC, id: 'empty' },
  alert: { ...BASE_SPEC, id: 'alert' },
  loading: { ...BASE_SPEC, id: 'loading', holdFirstIngest: true },
  restricted: {
    ...BASE_SPEC,
    id: 'restricted',
    user: { is_admin: false },
    defaultInvoke: 'reject-unauthorized',
    defaultSnapshot: 'unauthorized',
  },
  // One service is missing while HA starts, so the preview shows the service-missing reason somewhere.
  starting: { ...BASE_SPEC, id: 'starting', haState: 'STARTING', missingServices: ['vacuum.start'] },
  dense: { ...BASE_SPEC, id: 'dense' },
});

export const DEMO_SCENARIO_IDS: readonly DemoScenarioId[] = Object.freeze(
  Object.keys(SCENARIO_SPECS) as DemoScenarioId[],
);

type ForecastFixtures = AssembledScenario['forecasts'];

/** Merges the nine section fixtures; a duplicate entity, behavior, forecast type or calendar is a fixture bug. */
export function assembleScenario(id: DemoScenarioId, clock: FixtureClock): AssembledScenario {
  const fixtures = Object.entries(SECTION_FIXTURES);
  const states = uniqueBy(
    fixtures.flatMap(([owner, fixture]) => fixture.states(id, clock).map((item) => ({ owner, item }))),
    (state: HassEntityLike) => state.entity_id,
    'entity',
  );
  const registry = uniqueBy(
    fixtures.flatMap(([owner, fixture]) => (fixture.registry?.(id) ?? []).map((item) => ({ owner, item }))),
    (entry: RegistryEntryLike) => entry.entity_id,
    'registry entry',
  );
  const behaviors = uniqueBy(
    fixtures.flatMap(([owner, fixture]) => (fixture.behaviors?.(id) ?? []).map((item) => ({ owner, item }))),
    (behavior: DemoBehavior) => behavior.entity,
    'behavior',
  );
  const forecasts: ForecastFixtures = mergeRecords(
    fixtures.map(([owner, fixture]) => ({ owner, record: fixture.forecasts?.(id, clock) ?? {} })),
    'forecast type',
  );
  // mergeRecords skips undefined values, so every key it returns holds an event list.
  const calendarEvents: AssembledScenario['calendarEvents'] = mergeRecords(
    fixtures.map(([owner, fixture]) => ({ owner, record: fixture.calendarEvents?.(id, clock) ?? {} })),
    'calendar',
  ) as Readonly<Record<string, readonly CalendarEventLike[]>>;
  return Object.freeze({
    spec: SCENARIO_SPECS[id],
    input: demoCardInput(id),
    states: Object.freeze(states),
    registry: Object.freeze(registry),
    behaviors: new Map(behaviors.map((behavior) => [behavior.entity, behavior] as [EntityId, DemoBehavior])),
    forecasts: Object.freeze(forecasts),
    calendarEvents: Object.freeze(calendarEvents),
  });
}

function uniqueBy<T>(items: readonly { owner: string; item: T }[], keyOf: (item: T) => string, what: string): T[] {
  const owners = new Map<string, string>();
  return items.map(({ owner, item }) => {
    const key = keyOf(item);
    const earlier = owners.get(key);
    if (earlier !== undefined) throw new Error(`Demo fixtures ${earlier} and ${owner} both define ${what} "${key}".`);
    owners.set(key, owner);
    return item;
  });
}

function mergeRecords<K extends string, V>(
  sources: readonly { owner: string; record: Partial<Record<K, V>> }[],
  what: string,
): Partial<Record<K, V>> {
  const merged: Partial<Record<K, V>> = {};
  const owners = new Map<string, string>();
  for (const { owner, record } of sources) {
    for (const [key, value] of Object.entries(record) as [K, V | undefined][]) {
      if (value === undefined) continue;
      const earlier = owners.get(key);
      if (earlier !== undefined) throw new Error(`Demo fixtures ${earlier} and ${owner} both define ${what} "${key}".`);
      owners.set(key, owner);
      merged[key] = value;
    }
  }
  return merged;
}
