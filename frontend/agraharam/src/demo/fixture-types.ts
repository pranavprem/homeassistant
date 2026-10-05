/**
 * Demo fixture contract (§10.2). Each section package owns exactly one fixture file and adds entities,
 * scenario variants and device behaviors only through its SectionFixture; it never edits configs.ts,
 * scenarios.ts, simulate.ts, demo-host.ts or fake-hass.ts. All data is fictional and every ID is `*.demo_*`.
 */
import type { CardConfigInput, DemoScenarioId, EntityId } from '../config/schema.ts';
import type { CalendarEventLike, ForecastItem, ForecastType } from '../ha/host.ts';
import type { HassEntityLike, RegistryEntryLike } from '../ha/types.ts';

/** Every time in a fixture is relative to `now`, so `npm run dev` on any day shows "next 8 hours", today/tomorrow
 *  groups, sunset and "Done 7:40 PM" correctly, and e2e (pinned clock) sees the same layout. */
export interface FixtureClock {
  readonly now: Date;
  at(offsetMin: number): string; // ISO string, now + offset
  dayAt(dayOffset: number, hour: number, minute: number): string; // local wall time on today + dayOffset
}

const MS_PER_MINUTE = 60_000;

export function fixtureClock(nowMs: number): FixtureClock {
  return Object.freeze({
    now: new Date(nowMs),
    at(offsetMin: number): string {
      return new Date(nowMs + offsetMin * MS_PER_MINUTE).toISOString();
    },
    dayAt(dayOffset: number, hour: number, minute: number): string {
      // Local calendar arithmetic, so a DST change between today and the target day keeps the wall time.
      const day = new Date(nowMs);
      day.setDate(day.getDate() + dayOffset);
      day.setHours(hour, minute, 0, 0);
      return day.toISOString();
    },
  });
}

export interface SectionFixture {
  config(s: DemoScenarioId): Partial<CardConfigInput>; // this section's binding keys only (no times)
  states(s: DemoScenarioId, clock: FixtureClock): readonly HassEntityLike[];
  registry?(s: DemoScenarioId): readonly RegistryEntryLike[];
  behaviors?(s: DemoScenarioId): readonly DemoBehavior[];
  forecasts?(s: DemoScenarioId, clock: FixtureClock): Partial<Record<ForecastType, readonly ForecastItem[] | 'error'>>;
  calendarEvents?(s: DemoScenarioId, clock: FixtureClock): Readonly<Record<string, readonly CalendarEventLike[]>>;
}
export interface DemoBehavior {
  readonly entity: EntityId;
  readonly onInvoke?: 'apply' | 'reject-validation' | 'reject-unauthorized' | 'never-confirm' | 'connection-lost';
  /** unauthorized = 401 (session-level, §4.4); forbidden = 403 (this tile only); unavailable = 503. */
  readonly snapshot?: 'ok' | 'unauthorized' | 'forbidden' | 'unavailable';
}
/** Host-level scenario facts, kept in scenarios.ts. */
export interface ScenarioSpec {
  readonly id: DemoScenarioId;
  readonly connection: 'connected' | 'drop-after-first-ingest';
  readonly haState: 'RUNNING' | 'STARTING';
  readonly haVersion: string; // diagnostics; fictional-safe, e.g. '2026.9.2'
  readonly user: { readonly is_admin: boolean }; // 'restricted': false
  /** 'domain.service' strings removed from hass.services ('starting': one, to show service-missing). */
  readonly missingServices: readonly string[];
  readonly holdFirstIngest: boolean; // 'loading'
  readonly defaultInvoke?: DemoBehavior['onInvoke']; // 'restricted': reject-unauthorized
  readonly defaultSnapshot?: DemoBehavior['snapshot']; // 'restricted': unauthorized
}
export interface AssembledScenario {
  readonly spec: ScenarioSpec;
  readonly input: CardConfigInput;
  readonly states: readonly HassEntityLike[];
  readonly registry: readonly RegistryEntryLike[];
  readonly behaviors: ReadonlyMap<EntityId, DemoBehavior>;
  readonly forecasts: Partial<Record<ForecastType, readonly ForecastItem[] | 'error'>>;
  readonly calendarEvents: Readonly<Record<string, readonly CalendarEventLike[]>>;
}

/** Minutes between a fixture state's last change and `now` unless a fixture says otherwise. */
const DEFAULT_CHANGED_MIN_AGO = 30;

/**
 * Builds one fixture state object. Shared by the section fixtures so every state has the full HassEntityLike
 * shape with clock-relative timestamps.
 */
export function demoEntity(
  clock: FixtureClock,
  entityId: string,
  state: string,
  attributes: Readonly<Record<string, unknown>> = {},
  changedMinAgo: number = DEFAULT_CHANGED_MIN_AGO,
): HassEntityLike {
  const changed = clock.at(-changedMinAgo);
  return Object.freeze({
    entity_id: entityId,
    state,
    attributes: Object.freeze({ ...attributes }),
    last_changed: changed,
    last_updated: changed,
    context: Object.freeze({ id: `demo-context-${entityId}`, parent_id: null, user_id: null }),
  });
}
