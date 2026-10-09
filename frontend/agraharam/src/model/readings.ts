/**
 * House readings (§18): the configured collections as read-only rows with an honest condition each, the counts the
 * House panel and the readings drawer summarise, and their wording. Pure and read-only by construction: nothing here
 * can act, and nothing here feeds House health's headline, device counts or problem list.
 *
 * Attention rules are strict. `below` means strictly below and `above` strictly above, compared on the raw numeric
 * state in the entity's own unit; `equals` matches the raw state exactly. A rule-bearing row whose reading is missing,
 * unknown, unavailable or (under a range rule) not a number counts as unavailable, never as within limits.
 */
import { domainOf } from '../config/entity-id.ts';
import type { Collection, CollectionRow, EntityId, ResolvedConfig } from '../config/schema.ts';
import type { Formatter } from '../ha/host.ts';
import { absentFor, normalizeEntity, parseNumericValue, type Display } from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { friendlyName } from './display.ts';
import type { HealthFactVM } from './health.ts';
import { capText, readAttribute, readingValue, type ReadingValueContext } from './reading-value.ts';
import type { IconName, SelectorInput } from './types.ts';

type ReadingCondition = 'attention' | 'ok' | 'info' | 'unavailable' | 'loading' | 'stale';

export interface ReadingVM {
  readonly key: string; // `${group}:${row}`
  readonly name: string;
  readonly value: Display;
  readonly condition: ReadingCondition;
  /** "Below 15%", "Can't compare with the limit", … */
  readonly detail?: string;
}

interface ReadingCounts {
  readonly total: number;
  /** Rows whose rule was evaluated on a current reading and passed. */
  readonly checked: number;
  readonly attention: number;
  readonly unavailable: number;
  readonly loading: number;
}

export interface ReadingGroupVM {
  readonly index: number;
  readonly name: string;
  readonly icon?: IconName;
  readonly rows: readonly ReadingVM[];
  readonly counts: ReadingCounts;
}

export interface ReadingsVM {
  /** 'paused' while Home Assistant is disconnected or resyncing: values are the last known, and nothing is counted. */
  readonly state: 'loading' | 'live' | 'paused';
  readonly resyncing: boolean;
  readonly groups: readonly ReadingGroupVM[];
  readonly counts: ReadingCounts;
}

const NAME_MAX_CHARS = 60;
const FALLBACK_NAME = 'Reading';
const MS_PER_MINUTE = 60_000;
const NOT_COMPARABLE = "Can't compare with the limit";
const NO_READING = 'No reading';
const NO_CURRENT_READING = 'No current reading';
const UNKNOWN_LABELS = Object.freeze({ event: 'No events yet', emptyText: 'Empty' });
const SENTENCES = Object.freeze({
  paused: 'Paused while Home Assistant is disconnected. Values shown are the last known.',
  resyncing: 'Waiting for current states from Home Assistant.',
  loading: 'Loading readings.',
});
const GROUP_META = Object.freeze({ paused: 'Paused', loading: 'Loading', allWithin: 'All within limits' });

/** Every collection entity, de-duplicated, in configuration order: what the readings subscribe to. */
export function collectionEntityIds(config: ResolvedConfig): EntityId[] {
  return [...new Set(config.collections.flatMap((group) => group.rows.map((row) => row.entity)))];
}

function selectReadings(input: SelectorInput): ReadingsVM {
  const { store } = input;
  const state = !store.isReady() ? 'loading' : store.isConnected() ? 'live' : 'paused';
  const groups = input.config.collections.map((group, index) => buildGroup(input, group, index));
  return {
    state,
    resyncing: store.isResyncing(),
    groups,
    counts: sumCounts(groups.map((group) => group.counts)),
  };
}

/**
 * A memoised selectReadings for one element (§18): up to 384 rows are evaluated again only when something they read
 * changed: the configuration, the formatter, the connection, HA's state, the minute (relative day words), the
 * registry (display precision) or a collection entity's object. Any other entity's change, or a hass push that
 * changed nothing, returns the previous view model.
 */
export function createReadingsSelector(): (input: SelectorInput) => ReadingsVM {
  let lastKey: readonly unknown[] | undefined;
  let last: ReadingsVM | undefined;
  return (input) => {
    const key = readingsKey(input);
    if (last !== undefined && lastKey !== undefined && sameKey(lastKey, key)) return last;
    lastKey = key;
    last = selectReadings(input);
    return last;
  };
}

function readingsKey(input: SelectorInput): readonly unknown[] {
  const { config, store, reader } = input;
  return [
    config,
    reader.formatter(),
    store.isReady(),
    store.isConnected(),
    store.isResyncing(),
    store.haState(),
    Math.floor(input.now.getTime() / MS_PER_MINUTE),
    reader.registryLoaded(),
    ...collectionEntityIds(config).flatMap((id) => [store.get(id), store.freshSinceResync(id), reader.registry(id)]),
  ];
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

function buildGroup(input: SelectorInput, group: Collection, index: number): ReadingGroupVM {
  const rows = group.rows.map((row, position) => buildRow(input, row, `${index}:${position}`, position));
  // A plain assignment: a collection icon missing from the curated set is a compile error here.
  const icon: IconName | undefined = group.icon;
  return { index, name: group.name, ...(icon !== undefined && { icon }), rows, counts: countRows(rows) };
}

function buildRow(input: SelectorInput, row: CollectionRow, key: string, position: number): ReadingVM {
  const { store } = input;
  const normalized = normalizeEntity(store, row.entity);
  const base = { key, name: rowName(input, row, position) };
  if (!store.isReady()) return { ...base, value: absentFor('loading'), condition: 'loading' };
  if (!store.isConnected()) {
    // Paused: the last known value, muted, or "Offline" when there is none; nothing is counted.
    const entity = normalized.entity;
    const value = entity === undefined ? absentFor('disconnected') : staleValue(input, row.entity, entity);
    return { ...base, value, condition: 'stale' };
  }
  const entity = normalized.entity;
  switch (normalized.status) {
    case 'available':
      return entity === undefined ? unavailableRow(base, absentFor('no-data')) : evaluateRow(input, row, base, entity);
    case 'unknown':
      return row.attention === undefined
        ? { ...base, value: unknownValue(entity), condition: 'info' }
        : unavailableRow(base, absentFor('unknown'));
    case 'loading':
      return { ...base, value: absentFor('loading'), condition: 'loading' };
    case 'disconnected':
      // The store is live but the reconnect snapshot did not replace this entity: HA no longer reports it.
      return unavailableRow(base, { kind: 'absent', reason: 'disconnected', label: NO_CURRENT_READING });
    default:
      return unavailableRow(base, absentFor(normalized.status));
  }
}

function unavailableRow(base: Pick<ReadingVM, 'key' | 'name'>, value: Display, detail?: string): ReadingVM {
  return { ...base, value, condition: 'unavailable', ...(detail !== undefined && { detail }) };
}

function evaluateRow(
  input: SelectorInput,
  row: CollectionRow,
  base: Pick<ReadingVM, 'key' | 'name'>,
  entity: HassEntityLike,
): ReadingVM {
  const formatted = readingValue(entity, valueContext(input, row.entity));
  const value: Display = formatted.valid
    ? { kind: 'value', text: formatted.text, stale: false }
    : { kind: 'absent', reason: 'no-data', label: NO_READING };
  const rule = row.attention;
  if (rule === undefined) return { ...base, value, condition: formatted.valid ? 'info' : 'unavailable' };
  if (!formatted.valid) return unavailableRow(base, value);
  if (rule.kind === 'equals') {
    return { ...base, value, condition: rule.values.includes(entity.state) ? 'attention' : 'ok' };
  }
  const reading = parseNumericValue(entity.state);
  if (reading === null) return unavailableRow(base, value, NOT_COMPARABLE);
  const formatter = input.reader.formatter();
  const unit = readAttribute(entity, 'unit_of_measurement');
  // "Below 15%", "Above 41 °F": the limit in the reading's own unit, spaced as HA spaces it.
  const bound = (limit: number): string => {
    const number = formatter.number(limit);
    return typeof unit === 'string' && unit !== '' ? formatter.withUnit(number, unit) : number;
  };
  if (rule.below !== undefined && reading < rule.below) {
    return { ...base, value, condition: 'attention', detail: `Below ${bound(rule.below)}` };
  }
  if (rule.above !== undefined && reading > rule.above) {
    return { ...base, value, condition: 'attention', detail: `Above ${bound(rule.above)}` };
  }
  return { ...base, value, condition: 'ok' };
}

function staleValue(input: SelectorInput, id: EntityId, entity: HassEntityLike): Display {
  const formatted = readingValue(entity, valueContext(input, id));
  return formatted.valid
    ? { kind: 'value', text: formatted.text, stale: true }
    : { kind: 'absent', reason: 'disconnected', label: NO_READING };
}

/** A rule-less row whose state is unknown: worded for what it is, never counted. */
function unknownValue(entity: HassEntityLike | undefined): Display {
  const unknown = absentFor('unknown');
  if (entity === undefined) return unknown;
  const domain = domainOf(entity.entity_id);
  if (domain === 'event') return { ...unknown, label: UNKNOWN_LABELS.event };
  if (domain === 'input_text' && entity.state === '') return { ...unknown, label: UNKNOWN_LABELS.emptyText };
  return unknown;
}

function valueContext(input: SelectorInput, id: EntityId): ReadingValueContext {
  const precision = input.reader.registry(id)?.display_precision;
  return {
    formatter: input.reader.formatter(),
    now: input.now,
    ...(typeof precision === 'number' &&
      Number.isInteger(precision) &&
      precision >= 0 && { displayPrecision: precision }),
  };
}

/** The configured name, else HA's friendly name (capped), else "Reading <n>". Never the entity ID. */
function rowName(input: SelectorInput, row: CollectionRow, position: number): string {
  return capText(friendlyName(input.store, row.entity, row.name, `${FALLBACK_NAME} ${position + 1}`), NAME_MAX_CHARS);
}

// ---------------------------------------------------------------------------------------------------------------
// Counts and wording

function countRows(rows: readonly ReadingVM[]): ReadingCounts {
  const count = (condition: ReadingCondition): number => rows.filter((row) => row.condition === condition).length;
  return {
    total: rows.length,
    checked: count('ok'),
    attention: count('attention'),
    unavailable: count('unavailable'),
    loading: count('loading'),
  };
}

function sumCounts(counts: readonly ReadingCounts[]): ReadingCounts {
  const sum = (field: keyof ReadingCounts): number => counts.reduce((total, item) => total + item[field], 0);
  return {
    total: sum('total'),
    checked: sum('checked'),
    attention: sum('attention'),
    unavailable: sum('unavailable'),
    loading: sum('loading'),
  };
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * The House panel's readings fact, live only: while paused or loading the panel's own paused line or placeholders
 * speak for it. "Within limits", the only all-clear wording, needs every row live, ruled and passing.
 */
export function readingsFact(vm: ReadingsVM, formatter: Formatter): HealthFactVM | undefined {
  if (vm.state !== 'live') return undefined;
  const { total, checked, attention, unavailable, loading } = vm.counts;
  const n = (value: number): string => formatter.number(value);
  if (attention > 0) {
    const text = plural(attention, 'reading needs attention', 'readings need attention');
    const extra = unavailable > 0 ? `, ${n(unavailable)} unavailable` : '';
    return { key: 'readings', count: n(attention), text: `${text}${extra}`, tone: 'attention', icon: 'circle-alert' };
  }
  if (unavailable > 0) {
    const text = plural(unavailable, 'reading unavailable', 'readings unavailable');
    const extra = loading > 0 ? `, ${n(loading)} still loading` : '';
    return { key: 'readings', count: n(unavailable), text: `${text}${extra}`, tone: 'attention', icon: 'circle-alert' };
  }
  if (loading > 0) {
    const text = plural(loading, 'reading still loading', 'readings still loading');
    return { key: 'readings', count: n(loading), text, tone: 'muted', icon: 'info' };
  }
  if (total > 0 && checked === total) {
    const text = plural(total, 'reading within limits', 'readings within limits');
    return { key: 'readings', count: n(total), text, tone: 'ok', icon: 'circle-check' };
  }
  const extra = checked > 0 ? `, ${n(checked)} within limits` : '';
  return {
    key: 'readings',
    count: n(total),
    text: `${plural(total, 'reading', 'readings')}${extra}`,
    tone: 'neutral',
    icon: 'info',
  };
}

/** The readings drawer's lead line. */
export function readingsSentence(vm: ReadingsVM, formatter: Formatter): string {
  if (vm.state === 'loading') return SENTENCES.loading;
  if (vm.state === 'paused') return vm.resyncing ? SENTENCES.resyncing : SENTENCES.paused;
  const fact = readingsFact(vm, formatter);
  return fact === undefined ? SENTENCES.loading : `${fact.count} ${fact.text}.`;
}

/**
 * A group's short meta line in the drawer. While paused or loading it states only that, so stale values never yield
 * "All within limits" or any count.
 */
export function readingGroupMeta(group: ReadingGroupVM, vm: ReadingsVM, formatter: Formatter): string {
  if (vm.state === 'paused') return GROUP_META.paused;
  if (vm.state === 'loading') return GROUP_META.loading;
  const { total, checked, attention, unavailable, loading } = group.counts;
  const n = (value: number): string => formatter.number(value);
  if (attention > 0) return `${n(attention)} ${plural(attention, 'needs attention', 'need attention')}`;
  if (unavailable > 0) return `${n(unavailable)} unavailable`;
  if (loading > 0) return `${n(loading)} still loading`;
  if (total > 0 && checked === total) return GROUP_META.allWithin;
  return `${n(total)} ${plural(total, 'reading', 'readings')}`;
}

/**
 * Whether a group starts expanded: live groups that need a look (attention or unavailable rows), and a lone group
 * always. While paused or loading the counts are absent, so only a lone group starts open.
 */
export function readingGroupStartsExpanded(group: ReadingGroupVM, vm: ReadingsVM): boolean {
  if (vm.groups.length === 1) return true;
  if (vm.state !== 'live') return false;
  return group.counts.attention > 0 || group.counts.unavailable > 0;
}
