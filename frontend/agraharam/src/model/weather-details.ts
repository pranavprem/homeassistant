/**
 * Weather details (AIRSPACE.md §8): the weather entity's extended current conditions and the next sunrise and sunset,
 * for the read-only weather drawer and the Sky drawer's Conditions strip. Pure; it reads through normalizeEntity and
 * the readable-entity helpers, so an offline entity shows its last known values with the stale cue and an
 * unavailable or missing one shows its state and no values.
 *
 * Honesty rules as in Today: a metric the integration never reports is omitted, one it reports as null (or out of
 * range) reads "No data", never 0; units come from the entity's own `*_unit` attributes, a missing unit leaves the
 * bare number. The entity's friendly_name is never shown: it is often a place name.
 */
import type { Formatter } from '../ha/host.ts';
import {
  normalizeEntity,
  noValueFor,
  numericDisplay,
  parseNumericValue,
  readableEntity,
  type Display,
  type EntityStatus,
  type NormalizedEntity,
} from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { absentDisplay, valueDisplay } from './display.ts';
import { dateAttribute, formatNumber, nightTester, selectCondition, stringAttribute, withUnit } from './today.ts';
import type { IconName, SelectorInput } from './types.ts';
import { NO_CONDITION } from './weather-conditions.ts';

type WeatherDetailKey =
  | 'feels'
  | 'dew-point'
  | 'humidity'
  | 'cloud-cover'
  | 'uv'
  | 'wind'
  | 'gust'
  | 'wind-direction'
  | 'visibility'
  | 'pressure';

export interface WeatherDetailVM {
  readonly key: WeatherDetailKey;
  readonly label: string;
  readonly value: Display;
  /** The UV index's WHO category ("Moderate"), shown beside the number. */
  readonly detail?: string;
}

export interface SunEventVM {
  readonly kind: 'sunrise' | 'sunset';
  readonly label: 'Sunrise' | 'Sunset';
  readonly time: string;
  readonly at: number; // epoch ms, for ordering
}

export interface WeatherDetailsVM {
  /** The weather entity's normalized status; 'missing-binding' when no weather entity is configured. */
  readonly status: EntityStatus;
  /** True while the values are the last known ones (Home Assistant offline or resyncing). */
  readonly stale: boolean;
  readonly condition: { readonly key: string; readonly label: string; readonly icon: IconName };
  readonly temperature: Display;
  readonly unit?: string;
  readonly metrics: readonly WeatherDetailVM[];
  /** Next sunrise and next sunset, soonest first; empty without a readable sun entity. */
  readonly sun: readonly SunEventVM[];
}

/** A 16-wind compass point: the abbreviation shown and the words read aloud. */
interface CompassPoint {
  readonly abbr: string; // "NW"
  readonly name: string; // "north-west"
}

/** Ranges a reading must fall in to be shown; outside them it reads "No data" (AIRSPACE.md §8). */
const RANGES = Object.freeze({
  percent: { min: 0, max: 100 },
  uv: { min: 0, max: 20 },
  nonNegative: { min: 0, max: Number.POSITIVE_INFINITY },
  any: { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY },
} as const);
type Range = (typeof RANGES)[keyof typeof RANGES];

const WIND_DIGITS = 1;
/** inHg readings carry two decimals (30.02); hPa and mbar values simply have none to show. */
const PRESSURE_DIGITS = 2;
const PERCENT = '%';
const DEGREES_PER_POINT = 22.5;
const FULL_TURN_DEG = 360;
const CONDITIONS_KEYS: ReadonlySet<WeatherDetailKey> = new Set(['cloud-cover', 'visibility', 'wind']);

/** WHO UV index categories by their upper bound (the index is rounded first, as forecasts report it). */
const UV_CATEGORIES: readonly { readonly upTo: number; readonly label: string }[] = Object.freeze([
  { upTo: 2, label: 'Low' },
  { upTo: 5, label: 'Moderate' },
  { upTo: 7, label: 'High' },
  { upTo: 10, label: 'Very high' },
]);
const UV_EXTREME = 'Extreme';

const COMPASS_POINTS: readonly CompassPoint[] = Object.freeze(
  [
    ['N', 'north'],
    ['NNE', 'north-north-east'],
    ['NE', 'north-east'],
    ['ENE', 'east-north-east'],
    ['E', 'east'],
    ['ESE', 'east-south-east'],
    ['SE', 'south-east'],
    ['SSE', 'south-south-east'],
    ['S', 'south'],
    ['SSW', 'south-south-west'],
    ['SW', 'south-west'],
    ['WSW', 'west-south-west'],
    ['W', 'west'],
    ['WNW', 'west-north-west'],
    ['NW', 'north-west'],
    ['NNW', 'north-north-west'],
  ].map(([abbr, name]) => Object.freeze({ abbr: abbr ?? '', name: name ?? '' })),
);

/** One metric's definition: the attribute it reads, its range and how its value is worded. */
interface MetricSpec {
  readonly key: WeatherDetailKey;
  readonly label: string;
  readonly attribute: string;
  readonly range: Range;
  readonly format: (value: number, entity: HassEntityLike, formatter: Formatter) => string;
  readonly detail?: (value: number) => string;
}

const METRICS: readonly MetricSpec[] = Object.freeze([
  {
    key: 'feels',
    label: 'Feels like',
    attribute: 'apparent_temperature',
    range: RANGES.any,
    format: (value, _entity, formatter) => formatter.temperature(value, undefined),
  },
  {
    key: 'dew-point',
    label: 'Dew point',
    attribute: 'dew_point',
    range: RANGES.any,
    format: (value, _entity, formatter) => formatter.temperature(value, undefined),
  },
  {
    key: 'humidity',
    label: 'Humidity',
    attribute: 'humidity',
    range: RANGES.percent,
    format: (value, _entity, formatter) => formatter.withUnit(formatNumber(formatter, value, 0), PERCENT),
  },
  {
    key: 'cloud-cover',
    label: 'Cloud cover',
    attribute: 'cloud_coverage',
    range: RANGES.percent,
    format: (value, _entity, formatter) => formatter.withUnit(formatNumber(formatter, value, 0), PERCENT),
  },
  {
    key: 'uv',
    label: 'UV index',
    attribute: 'uv_index',
    range: RANGES.uv,
    format: (value, _entity, formatter) => formatNumber(formatter, value),
    detail: (value) => uvCategory(value),
  },
  {
    key: 'wind',
    label: 'Wind',
    attribute: 'wind_speed',
    range: RANGES.nonNegative,
    format: (value, entity, formatter) =>
      unitText(formatter, formatNumber(formatter, value, WIND_DIGITS), entity, 'wind_speed_unit'),
  },
  {
    key: 'gust',
    label: 'Gusts',
    attribute: 'wind_gust_speed',
    range: RANGES.nonNegative,
    format: (value, entity, formatter) =>
      unitText(formatter, formatNumber(formatter, value, WIND_DIGITS), entity, 'wind_speed_unit'),
  },
  {
    key: 'visibility',
    label: 'Visibility',
    attribute: 'visibility',
    range: RANGES.nonNegative,
    format: (value, entity, formatter) =>
      unitText(formatter, formatNumber(formatter, value), entity, 'visibility_unit'),
  },
  {
    key: 'pressure',
    label: 'Pressure',
    attribute: 'pressure',
    range: RANGES.nonNegative,
    format: (value, entity, formatter) =>
      unitText(formatter, formatNumber(formatter, value, PRESSURE_DIGITS), entity, 'pressure_unit'),
  },
]);
const SUN_EVENTS: readonly (readonly [SunEventVM['kind'], SunEventVM['label'], string])[] = Object.freeze([
  ['sunrise', 'Sunrise', 'next_rising'],
  ['sunset', 'Sunset', 'next_setting'],
]);
/** Wind direction sits after the gusts in the list. */
const WIND_DIRECTION_AFTER: WeatherDetailKey = 'gust';
const WIND_DIRECTION_LABEL = 'Wind direction';

export function selectWeatherDetails(input: SelectorInput): WeatherDetailsVM {
  const formatter = input.reader.formatter();
  const weatherId = input.config.weather;
  if (weatherId === undefined) return notConfigured();
  const weather = normalizeEntity(input.store, weatherId);
  const entity = readableEntity(weather);
  const night = nightTester(input);
  return {
    status: weather.status,
    stale: weather.stale,
    condition: selectCondition(weather, entity, formatter, night?.(input.now.getTime()) ?? false),
    temperature: numericDisplay(
      weather,
      (e) => e.attributes['temperature'],
      (v) => formatNumber(formatter, v),
    ),
    ...withUnit(entity, formatter),
    metrics: entity === undefined ? [] : selectMetrics(weather, entity, formatter),
    sun: selectSunEvents(input, formatter),
  };
}

/** The Sky drawer's Conditions strip (AIRSPACE.md §6): cloud cover, visibility and wind with its direction. */
export function selectSkyConditions(input: SelectorInput): readonly WeatherDetailVM[] {
  const weatherId = input.config.weather;
  if (weatherId === undefined) return [];
  const weather = normalizeEntity(input.store, weatherId);
  const entity = readableEntity(weather);
  if (entity === undefined) return [];
  const metrics = selectMetrics(weather, entity, input.reader.formatter());
  const direction = metrics.find((metric) => metric.key === 'wind-direction')?.value;
  return metrics
    .filter((metric) => CONDITIONS_KEYS.has(metric.key))
    .map((metric) =>
      metric.key === 'wind' && metric.value.kind === 'value' && direction?.kind === 'value'
        ? { ...metric, value: valueDisplay(`${metric.value.text} ${direction.text}`, metric.value.stale) }
        : metric,
    );
}

/** WHO UV index categories: Low 0–2, Moderate 3–5, High 6–7, Very high 8–10, Extreme 11+. */
function uvCategory(uv: number): string {
  const rounded = Math.round(uv);
  return UV_CATEGORIES.find((category) => rounded <= category.upTo)?.label ?? UV_EXTREME;
}

/** The 16-wind compass point of a bearing in degrees (any finite value; wrapped into [0, 360)). */
export function compassPoint(deg: number): CompassPoint {
  const wrapped = ((deg % FULL_TURN_DEG) + FULL_TURN_DEG) % FULL_TURN_DEG;
  const index = Math.round(wrapped / DEGREES_PER_POINT) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index] ?? (COMPASS_POINTS[0] as CompassPoint);
}

function notConfigured(): WeatherDetailsVM {
  return {
    status: 'missing-binding',
    stale: false,
    condition: { key: 'none', label: NO_CONDITION.label, icon: NO_CONDITION.icon },
    temperature: absentDisplay('missing-binding'),
    metrics: [],
    sun: [],
  };
}

/** Each metric the entity reports (Object.hasOwn), in METRICS order, with wind direction after the gusts. */
function selectMetrics(weather: NormalizedEntity, entity: HassEntityLike, formatter: Formatter): WeatherDetailVM[] {
  const metrics: WeatherDetailVM[] = [];
  for (const spec of METRICS) {
    if (Object.hasOwn(entity.attributes, spec.attribute)) metrics.push(metricVM(weather, entity, formatter, spec));
    if (spec.key === WIND_DIRECTION_AFTER) {
      const direction = windDirection(weather, entity);
      if (direction !== undefined) metrics.push(direction);
    }
  }
  return metrics;
}

function metricVM(
  weather: NormalizedEntity,
  entity: HassEntityLike,
  formatter: Formatter,
  spec: MetricSpec,
): WeatherDetailVM {
  const value = numericDisplay(
    weather,
    (e) => inRange(e.attributes[spec.attribute], spec.range),
    (v) => spec.format(v, entity, formatter),
  );
  const reading = inRange(entity.attributes[spec.attribute], spec.range);
  const detail = value.kind === 'value' && reading !== undefined ? spec.detail?.(reading) : undefined;
  return { key: spec.key, label: spec.label, value, ...(detail !== undefined && { detail }) };
}

/** The reading when it is a number (or plain numeric string) within `range`, else undefined ("No data"). */
function inRange(value: unknown, range: Range): number | undefined {
  const parsed = parseNumericValue(value);
  return parsed !== null && parsed >= range.min && parsed <= range.max ? parsed : undefined;
}

/**
 * `wind_bearing` as a compass point: a number becomes the 16-wind point; a string is kept only when it already is
 * one ("NW"), so free text from an integration never reaches the drawer. Omitted when the attribute is absent.
 */
function windDirection(weather: NormalizedEntity, entity: HassEntityLike): WeatherDetailVM | undefined {
  if (!Object.hasOwn(entity.attributes, 'wind_bearing')) return undefined;
  const raw = entity.attributes['wind_bearing'];
  const degrees = parseNumericValue(raw);
  const point =
    degrees !== null
      ? compassPoint(degrees).abbr
      : typeof raw === 'string'
        ? COMPASS_POINTS.find((candidate) => candidate.abbr === raw.trim().toUpperCase())?.abbr
        : undefined;
  const value = point === undefined ? noValueFor(weather) : valueDisplay(point, weather.stale);
  return { key: 'wind-direction', label: WIND_DIRECTION_LABEL, value };
}

/** `text` with the entity's own unit attribute in HA's spacing; without a unit, the bare number. */
function unitText(formatter: Formatter, text: string, entity: HassEntityLike, unitAttribute: string): string {
  const unit = stringAttribute(entity, unitAttribute);
  return unit === undefined ? text : formatter.withUnit(text, unit);
}

/** The next sunrise and next sunset from a readable sun entity, soonest first; a time already past is omitted. */
function selectSunEvents(input: SelectorInput, formatter: Formatter): readonly SunEventVM[] {
  const sunId = input.config.sun;
  if (sunId === undefined) return [];
  const sun = readableEntity(normalizeEntity(input.store, sunId));
  if (sun === undefined) return [];
  const nowMs = input.now.getTime();
  const events: SunEventVM[] = [];
  for (const [kind, label, attribute] of SUN_EVENTS) {
    const at = dateAttribute(sun, attribute);
    if (at !== undefined && at.getTime() > nowMs) {
      events.push({ kind, label, time: formatter.time(at), at: at.getTime() });
    }
  }
  return events.sort((a, b) => a.at - b.at);
}
