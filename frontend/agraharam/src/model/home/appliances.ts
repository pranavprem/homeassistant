/**
 * Home appliances (§4.8, §6.2.1): status text, remaining time or finish time, and which ones are active, idle or
 * not reporting, for the overview's cut (active first, idle ones collapsed into one count).
 */
import type { EntityId, ResolvedConfig } from '../../config/schema.ts';
import {
  absentFor,
  noValueFor,
  normalizeEntity,
  numericDisplay,
  parseNumericValue,
  readableEntity,
  textDisplay,
  type NormalizedEntity,
} from '../../ha/normalize.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { CONTENT_BUDGET } from '../budget.ts';
import { valueDisplay, type Display } from '../display.ts';
import type { ApplianceVM, IconName, SelectorInput } from '../types.ts';

/**
 * Appliance status values that mean "not running". Status sensors are free text from many integrations, so this is
 * matched case-insensitively with spaces and hyphens folded to underscores; anything else counts as active.
 */
const IDLE_APPLIANCE_STATES: ReadonlySet<string> = new Set([
  'off',
  'power_off',
  'idle',
  'standby',
  'ready',
  'initial',
  'end',
  'done',
  'finished',
  'complete',
  'completed',
  'inactive',
  'stopped',
  'sleep',
  'none',
]);
/** Units HA uses for duration sensors, in milliseconds; a numeric value without a unit is minutes (§4.8). */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});
const DEFAULT_DURATION_UNIT = 'min';

export function buildAppliance(input: SelectorInput, appliance: ResolvedConfig['appliances'][number]): ApplianceVM {
  const normalized = normalizeEntity(input.store, appliance.status);
  const formatter = input.reader.formatter();
  // Last known values count while disconnected, so a dropped connection does not reshuffle the overview.
  const entity = readableEntity(normalized);
  const remaining = appliance.remaining === undefined ? undefined : remainingDisplay(input, appliance.remaining);
  return {
    key: appliance.status,
    name: appliance.name,
    status: normalized.status,
    statusText: textDisplay(normalized, (current) => formatter.entityState(current)),
    ...(remaining !== undefined && { remaining }),
    active: entity !== undefined && !isIdleApplianceState(entity.state),
  };
}

/**
 * The appliance's glyph, read from the household's own name for it (the configuration has no kind field): an oven
 * must not show a washing machine. Dishwasher is tested before washer because it contains "wash"; any other
 * appliance gets the neutral plug.
 */
const APPLIANCE_ICON_RULES: readonly (readonly [RegExp, IconName])[] = Object.freeze([
  [/dish/i, 'utensils'],
  [/dryer|drying/i, 'shirt'],
  [/wash|laundry/i, 'washing-machine'],
  [/microwave/i, 'microwave'],
  [/oven|stove|range|cooktop|hob|cooker/i, 'cooking-pot'],
  [/fridge|refrigerator|freezer/i, 'refrigerator'],
]);

export function applianceIcon(name: string): IconName {
  return APPLIANCE_ICON_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? 'plug';
}

function isIdleApplianceState(state: string): boolean {
  return IDLE_APPLIANCE_STATES.has(
    state
      .trim()
      .toLowerCase()
      .split(/[\s-]+/)
      .join('_'),
  );
}

/** Idle means a readable status that says "not running"; loading, unknown and unavailable are neither. */
function isIdleAppliance(appliance: ApplianceVM): boolean {
  return !appliance.active && (appliance.status === 'available' || appliance.status === 'disconnected');
}

/**
 * Remaining time (§4.8): a timestamp renders "Done 7:40 PM" (nothing once it has passed, re-evaluated on the
 * 'clock' tick), a duration or plain number of minutes renders "35 min left", anything else uses HA's own
 * formatting. A null or unknown value is absent, never "0 min".
 */
function remainingDisplay(input: SelectorInput, id: EntityId): Display | undefined {
  const normalized = normalizeEntity(input.store, id);
  const entity = readableEntity(normalized);
  if (entity === undefined) return absentFor(normalized.status);
  const formatter = input.reader.formatter();
  if (entity.attributes['device_class'] === 'timestamp') return finishTime(input, normalized, entity);
  const unitMs = durationUnitMs(entity.attributes['unit_of_measurement']);
  if (unitMs !== undefined && parseNumericValue(entity.state) !== null) {
    return numericDisplay(
      normalized,
      (current) => current.state,
      (value) => `${formatter.duration(value * unitMs)} left`,
    );
  }
  if (entity.attributes['device_class'] === 'duration') {
    return noValueFor(normalized);
  }
  return textDisplay(normalized, (current) => formatter.entityState(current));
}

/** Milliseconds per unit for duration units; a value without a unit is minutes; any other unit is not a time. */
function durationUnitMs(unit: unknown): number | undefined {
  if (unit === undefined || unit === null || unit === '') return DURATION_UNIT_MS[DEFAULT_DURATION_UNIT];
  return typeof unit === 'string' ? DURATION_UNIT_MS[unit] : undefined;
}

function finishTime(input: SelectorInput, normalized: NormalizedEntity, entity: HassEntityLike): Display | undefined {
  const finishMs = Date.parse(entity.state);
  if (!Number.isFinite(finishMs)) return noValueFor(normalized);
  if (finishMs <= input.now.getTime()) return undefined;
  const formatter = input.reader.formatter();
  const finish = new Date(finishMs);
  const time = formatter.time(finish);
  const day = formatter.date(finish, 'month-day');
  let text = `Done ${time}`;
  if (day === formatter.date(addDays(input.now, 1), 'month-day')) text = `Done ${time} tomorrow`;
  else if (day !== formatter.date(input.now, 'month-day')) text = `Done ${day}, ${time}`;
  return valueDisplay(text, normalized.stale);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Active appliances first, then ones that are not reporting or still loading (an existing device must stay visibly
 * unavailable, and loading rows keep the layout stable), up to the budget, shown in configuration order. Idle
 * appliances collapse into one count.
 */
export function cutAppliances(appliances: readonly ApplianceVM[]): {
  shown: ApplianceVM[];
  idle: number;
  overflow: number;
} {
  const active = appliances.filter((appliance) => appliance.active);
  const attention = appliances.filter((appliance) => !appliance.active && !isIdleAppliance(appliance));
  const candidates = [...active, ...attention];
  const shownKeys = new Set(candidates.slice(0, CONTENT_BUDGET.activeAppliances).map((appliance) => appliance.key));
  return {
    shown: appliances.filter((appliance) => shownKeys.has(appliance.key)),
    idle: appliances.filter(isIdleAppliance).length,
    overflow: Math.max(0, candidates.length - CONTENT_BUDGET.activeAppliances),
  };
}
