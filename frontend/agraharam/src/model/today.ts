/**
 * Today selector (§4.8, §9.2): current conditions from the weather entity, high/low from the daily (or twice-daily)
 * forecast only, sunset or sunrise from the sun entity, and the forecast strip. Pure: everything it reads comes in
 * through the input, including the forecast controller's snapshot.
 *
 * Honesty rules: values are never invented. No hourly data means a labelled daily fallback, never an hourly strip
 * interpolated from daily items; high/low never comes from hourly data; units come from the entity's attributes.
 */
import {
  forecastPlan,
  type ForecastPlan,
  type ForecastSnapshot,
  type ForecastTypeState,
} from '../ha/forecast-controller.ts';
import { sameDay } from '../ha/format.ts';
import type { ForecastItem, Formatter } from '../ha/host.ts';
import { normalizeEntity, numericDisplay, parseNumericValue, type NormalizedEntity } from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { absentDisplay, friendlyName, valueDisplay, type Display } from './display.ts';
import { conditionIcon, conditionPresentation, NO_CONDITION } from './weather-conditions.ts';
import type { ForecastItemVM, ForecastVM, IconName, MetricVM, SelectorInput, TodayVM } from './types.ts';

interface TodayInput extends SelectorInput {
  readonly forecast: ForecastSnapshot;
}

/** §4.8: the hourly strip shows the next 8 hours; the daily fallback 5 days. Narrow panels hide some by CSS. */
const HOURLY_ITEMS = 8;
/** The label of the hourly cell that contains the current time; the strip emphasises it. */
export const NOW_LABEL = 'Now';
const DAILY_ITEMS = 5;
/** Below this the chance of precipitation is not worth announcing in a forecast cell. */
const PRECIPITATION_ANNOUNCE_PCT = 10;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const FALLBACK_NAME = 'Weather';
const TEMPERATURE_DIGITS = 1;
const WIND_DIGITS = 1;

export const FORECAST_NOTES = Object.freeze({
  dailyOnly: "Hourly forecast isn't provided by this weather source.",
  hourlyFailed: "Hourly forecast couldn't be loaded.",
  hourlyStale: 'The hourly forecast is out of date.',
  stale: 'The forecast is out of date. Current conditions are still live.',
  none: "This weather source doesn't provide a forecast.",
  error: "Forecast couldn't be loaded. Current conditions are still live.",
  empty: 'The weather source sent no forecast data. Current conditions are still live.',
  // The panel's "Offline" pill and the banner say why; the strip says what happens next (§16.13).
  disconnected: 'Forecast resumes when Home Assistant reconnects.',
  unavailable: 'No forecast while the weather source is unavailable.',
  missing: "No forecast: the weather source wasn't found.",
  notConfigured: 'No weather source is configured for this dashboard.',
});

const IDLE: ForecastTypeState = Object.freeze({ kind: 'idle' });
const SOURCE_ABSENT_ICON: IconName = 'cloud';

export function selectToday(input: TodayInput): TodayVM {
  const { config, store } = input;
  const formatter = input.reader.formatter();
  if (config.weather === undefined) return notConfigured();
  const weather = normalizeEntity(store, config.weather);
  const entity = weather.status === 'available' || weather.status === 'disconnected' ? weather.entity : undefined;
  const night = nightTester(input);
  const highLow = selectHighLow(input, weather, formatter);
  return {
    status: weather.status,
    name: friendlyName(store, config.weather, undefined, FALLBACK_NAME),
    temperature: numericDisplay(
      weather,
      (e) => e.attributes['temperature'],
      (v) => formatNumber(formatter, v),
    ),
    ...withUnit(entity, formatter),
    condition: selectCondition(weather, entity, formatter, night?.(input.now.getTime()) ?? false),
    ...highLow,
    metrics: entity === undefined ? [] : selectMetrics(weather, entity, formatter),
    ...withSun(input, formatter),
    forecast: selectForecast(input, weather, formatter, night),
  };
}

function notConfigured(): TodayVM {
  return {
    status: 'missing-binding',
    name: FALLBACK_NAME,
    temperature: absentDisplay('missing-binding'),
    condition: { key: 'none', label: NO_CONDITION.label, icon: NO_CONDITION.icon },
    metrics: [],
    forecast: { kind: 'unavailable', reason: 'entity', note: FORECAST_NOTES.notConfigured },
  };
}

function formatNumber(formatter: Formatter, value: number, digits = TEMPERATURE_DIGITS): string {
  return formatter.number(value, { maximumFractionDigits: digits });
}

/** §4.6: weather values use the entity's own `*_unit` attributes; the HA unit system is only the fallback. */
function withUnit(entity: HassEntityLike | undefined, formatter: Formatter): { unit?: string } {
  const unit = stringAttribute(entity, 'temperature_unit') ?? formatter.temperatureUnit;
  return unit === '' ? {} : { unit };
}

function selectCondition(
  weather: NormalizedEntity,
  entity: HassEntityLike | undefined,
  formatter: Formatter,
  night: boolean,
): TodayVM['condition'] {
  if (entity === undefined) {
    // "?" only when HA reports an unknown state; an unavailable or missing source shows a quiet cloud.
    const icon = weather.status === 'unknown' ? NO_CONDITION.icon : SOURCE_ABSENT_ICON;
    return { key: weather.status, label: NO_CONDITION.label, icon };
  }
  const key = entity.state;
  // HA's translated state when the frontend provides one; the fallback formatter returns the raw state.
  const translated = formatter.entityState(entity);
  const label = translated !== '' && translated !== key ? translated : conditionPresentation(key).label;
  return { key, label, icon: conditionIcon(key, night) };
}

function selectMetrics(weather: NormalizedEntity, entity: HassEntityLike, formatter: Formatter): MetricVM[] {
  const metrics: MetricVM[] = [];
  // A metric the integration never reports is omitted; one it reports as null reads "No data", never 0.
  if (Object.hasOwn(entity.attributes, 'apparent_temperature')) {
    metrics.push({
      key: 'feels',
      label: 'Feels like',
      value: numericDisplay(
        weather,
        (e) => e.attributes['apparent_temperature'],
        (v) => formatter.temperature(v, undefined),
      ),
    });
  }
  if (Object.hasOwn(entity.attributes, 'wind_speed')) {
    const unit = stringAttribute(entity, 'wind_speed_unit');
    metrics.push({
      key: 'wind',
      label: 'Wind',
      value: numericDisplay(
        weather,
        (e) => e.attributes['wind_speed'],
        (v) => withSpace(formatNumber(formatter, v, WIND_DIGITS), unit),
      ),
    });
  }
  if (Object.hasOwn(entity.attributes, 'humidity')) {
    metrics.push({
      key: 'humidity',
      label: 'Humidity',
      value: numericDisplay(
        weather,
        (e) => e.attributes['humidity'],
        (v) => `${formatNumber(formatter, v, 0)}%`,
      ),
    });
  }
  return metrics;
}

function withSpace(value: string, unit: string | undefined): string {
  return unit === undefined || unit === '' ? value : `${value} ${unit}`;
}

// ---------------------------------------------------------------------------------------------------------------
// High and low (§9.2): first daily item, or the first daytime and night halves of twice_daily. Never hourly.

type HighLow = Pick<TodayVM, 'high' | 'low' | 'highLowDay'>;

function selectHighLow(input: TodayInput, weather: NormalizedEntity, formatter: Formatter): HighLow {
  if (weather.status !== 'available' && weather.status !== 'unknown') return {};
  const plan = forecastPlan(weather.entity?.attributes['supported_features']);
  if (plan.daily === undefined) return {};
  const state = input.forecast[plan.daily] ?? IDLE;
  if (state.kind !== 'live') return {};
  const items = fromToday(state.items, input.now, formatter);
  const pair = plan.daily === 'daily' ? firstDailyPair(items) : firstTwiceDailyPair(items);
  if (pair === undefined) return {};
  const high = temperatureDisplay(pair.high, formatter);
  const low = temperatureDisplay(pair.low, formatter);
  if (high === undefined && low === undefined) return {};
  // Items before today are gone, so a different day is always a later one: "Tomorrow" is never a past day.
  const highLowDay = sameDay(formatter, pair.date, input.now) ? 'today' : 'tomorrow';
  return { ...(high !== undefined && { high }), ...(low !== undefined && { low }), highLowDay };
}

interface DayPair {
  readonly date: Date;
  readonly high: number | null | undefined;
  readonly low: number | null | undefined;
}

function firstDailyPair(items: readonly ForecastItem[]): DayPair | undefined {
  const first = items[0];
  return first === undefined
    ? undefined
    : { date: new Date(first.datetime), high: first.temperature, low: first.templow };
}

/** The first daytime half gives the high; the first night half after it (its temperature, else templow) the low. */
function firstTwiceDailyPair(items: readonly ForecastItem[]): DayPair | undefined {
  const dayIndex = items.findIndex((item) => item.is_daytime !== false);
  const day = items[dayIndex];
  if (day === undefined) return undefined;
  const night = items.slice(dayIndex + 1).find((item) => item.is_daytime === false);
  return {
    date: new Date(day.datetime),
    high: day.temperature,
    low: night?.temperature ?? night?.templow ?? day.templow,
  };
}

function temperatureDisplay(value: number | null | undefined, formatter: Formatter): Display | undefined {
  const parsed = parseNumericValue(value);
  return parsed === null ? undefined : valueDisplay(formatter.temperature(parsed, undefined));
}

/**
 * Daily items from today on. An item dated in the past on another local day belongs to a day that has ended, for
 * example an integration dating its items at UTC midnight read in a western time zone the next morning.
 */
function fromToday(items: readonly ForecastItem[], now: Date, formatter: Formatter): readonly ForecastItem[] {
  return items.filter((item) => {
    const at = new Date(item.datetime);
    return at.getTime() >= now.getTime() || sameDay(formatter, at, now);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Sun (§9.2): below the horizon → next sunrise, else next sunset.

function withSun(input: TodayInput, formatter: Formatter): Pick<TodayVM, 'sun'> {
  const sunId = input.config.sun;
  if (sunId === undefined) return {};
  const sun = normalizeEntity(input.store, sunId);
  if (sun.status !== 'available' && sun.status !== 'disconnected') return {};
  const kind = sun.entity?.state === 'below_horizon' ? 'sunrise' : 'sunset';
  const at = dateAttribute(sun.entity, kind === 'sunrise' ? 'next_rising' : 'next_setting');
  // A time already past (a long outage) is no longer "next": omit it rather than show a stale one.
  if (at === undefined || at.getTime() <= input.now.getTime()) return {};
  return { sun: { kind, time: formatter.time(at) } };
}

type NightTest = (ms: number) => boolean;

/** Between sunset and sunrise over the next ~24 hours, from the sun entity's next events; undefined without one. */
function nightTester(input: SelectorInput): NightTest | undefined {
  const sunId = input.config.sun;
  if (sunId === undefined) return undefined;
  const sun = normalizeEntity(input.store, sunId);
  if (sun.status !== 'available' && sun.status !== 'disconnected') return undefined;
  const setting = dateAttribute(sun.entity, 'next_setting')?.getTime();
  const rising = dateAttribute(sun.entity, 'next_rising')?.getTime();
  if (setting === undefined || rising === undefined) return undefined;
  // Sun up: night is [next setting, next rising). Sun down: night until the next rising and again after the next
  // setting (which comes after that rising).
  return setting < rising ? (ms) => ms >= setting && ms < rising : (ms) => ms < rising || ms >= setting;
}

// ---------------------------------------------------------------------------------------------------------------
// Forecast strip (§9.2 VM mapping).

function selectForecast(
  input: TodayInput,
  weather: NormalizedEntity,
  formatter: Formatter,
  night: NightTest | undefined,
): ForecastVM {
  if (weather.status === 'loading') return { kind: 'loading' };
  if (!input.store.isConnected() || weather.status === 'disconnected') {
    return { kind: 'unavailable', reason: 'disconnected', note: FORECAST_NOTES.disconnected };
  }
  if (weather.status === 'unavailable') {
    return { kind: 'unavailable', reason: 'entity', note: FORECAST_NOTES.unavailable };
  }
  if (weather.status !== 'available' && weather.status !== 'unknown') {
    return { kind: 'unavailable', reason: 'entity', note: FORECAST_NOTES.missing };
  }
  const plan = forecastPlan(weather.entity?.attributes['supported_features']);
  return forecastFromStates(input, plan, formatter, night);
}

function forecastFromStates(
  input: TodayInput,
  plan: ForecastPlan,
  formatter: Formatter,
  night: NightTest | undefined,
): ForecastVM {
  if (!plan.hourly && plan.daily === undefined) {
    return { kind: 'unavailable', reason: 'unsupported', note: FORECAST_NOTES.none };
  }
  const hourly = plan.hourly ? (input.forecast.hourly ?? IDLE) : undefined;
  const daily = plan.daily !== undefined ? (input.forecast[plan.daily] ?? IDLE) : undefined;

  // Live hourly data whose every hour has passed (an integration that stopped updating) is stale, not missing.
  let hourlyStale = false;
  if (hourly?.kind === 'live') {
    const items = hourlyItems(hourly.items, input.now, formatter, night);
    if (items.length > 0) return { kind: 'hourly', items };
    hourlyStale = hourly.items.length > 0;
  }
  // Don't flash the daily fallback while the hourly subscription is still on its way.
  if (hourly !== undefined && isPending(hourly)) return { kind: 'loading' };

  if (daily?.kind === 'live' && plan.daily !== undefined) {
    const items =
      plan.daily === 'daily'
        ? dailyItems(daily.items, input.now, formatter)
        : twiceDailyItems(daily.items, input.now, formatter);
    if (items.length > 0) {
      const note =
        hourly?.kind === 'error'
          ? FORECAST_NOTES.hourlyFailed
          : hourlyStale
            ? FORECAST_NOTES.hourlyStale
            : FORECAST_NOTES.dailyOnly;
      return { kind: 'daily-fallback', items, note };
    }
  }
  if (daily !== undefined && isPending(daily)) return { kind: 'loading' };

  if (hourly?.kind === 'error' || daily?.kind === 'error') {
    return { kind: 'unavailable', reason: 'error', note: FORECAST_NOTES.error };
  }
  if (hourly?.kind === 'live' || daily?.kind === 'live') {
    return { kind: 'unavailable', reason: 'error', note: hourlyStale ? FORECAST_NOTES.stale : FORECAST_NOTES.empty };
  }
  return { kind: 'unavailable', reason: 'unsupported', note: FORECAST_NOTES.none };
}

function isPending(state: ForecastTypeState): boolean {
  return state.kind === 'idle' || state.kind === 'subscribing';
}

/** The hour containing `now` and the next ones, labelled "Now", then by `formatter.hour()` ("7 PM", "19"). */
function hourlyItems(
  items: readonly ForecastItem[],
  now: Date,
  formatter: Formatter,
  night: NightTest | undefined,
): ForecastItemVM[] {
  const nowMs = now.getTime();
  return items
    .filter((item) => Date.parse(item.datetime) + MS_PER_HOUR > nowMs)
    .slice(0, HOURLY_ITEMS)
    .map((item) => {
      const at = new Date(item.datetime);
      const label = at.getTime() <= nowMs ? NOW_LABEL : formatter.hour(at);
      const isNightHour = night?.(at.getTime()) ?? item.is_daytime === false;
      return forecastCell(item, label, conditionIcon(item.condition, isNightHour), formatter);
    });
}

/** Today onwards; daily items are labelled by weekday, the first one "Today" when it is today. */
function dailyItems(items: readonly ForecastItem[], now: Date, formatter: Formatter): ForecastItemVM[] {
  return upcomingDays(items, now)
    .slice(0, DAILY_ITEMS)
    .map((item) => dayCell(item, now, formatter));
}

/** Daytime halves as days; each low is the following night half's temperature (or its templow). */
function twiceDailyItems(items: readonly ForecastItem[], now: Date, formatter: Formatter): ForecastItemVM[] {
  const upcoming = upcomingDays(items, now);
  const cells: ForecastItemVM[] = [];
  upcoming.forEach((item, index) => {
    if (item.is_daytime === false || cells.length >= DAILY_ITEMS) return;
    const next = upcoming[index + 1];
    const nightHalf = next?.is_daytime === false ? next : undefined;
    const templow = nightHalf?.temperature ?? nightHalf?.templow ?? item.templow;
    cells.push(dayCell(templow === undefined ? item : { ...item, templow }, now, formatter));
  });
  return cells;
}

/** Day cells always use the daytime glyph: a day's condition describes the day, not the hour it is read at. */
function dayCell(item: ForecastItem, now: Date, formatter: Formatter): ForecastItemVM {
  const cell = forecastCell(
    item,
    dayLabel(formatter, new Date(item.datetime), now),
    conditionIcon(item.condition, false),
    formatter,
  );
  const low = roundedTemperature(item.templow, formatter);
  return low === undefined ? cell : { ...cell, low };
}

/** Drops days that ended before today (an item dated more than a day ago). */
function upcomingDays(items: readonly ForecastItem[], now: Date): readonly ForecastItem[] {
  const earliest = now.getTime() - MS_PER_DAY;
  return items.filter((item) => Date.parse(item.datetime) > earliest);
}

function forecastCell(
  item: ForecastItem,
  label: string,
  icon: ForecastItemVM['icon'],
  formatter: Formatter,
): ForecastItemVM {
  const probability = parseNumericValue(item.precipitation_probability);
  return {
    key: item.datetime,
    label,
    icon,
    conditionLabel: conditionPresentation(item.condition).label,
    temperature: roundedTemperature(item.temperature, formatter) ?? absentDisplay('no-data'),
    ...(probability !== null &&
      probability >= PRECIPITATION_ANNOUNCE_PCT && {
        precipitation: `${formatter.number(Math.round(probability))}%`,
      }),
  };
}

/** §4.8: strip temperatures are integers ("21.5°" does not fit a 40 px cell); the hero keeps the precision. */
function roundedTemperature(value: number | null | undefined, formatter: Formatter): Display | undefined {
  const parsed = parseNumericValue(value);
  return parsed === null ? undefined : valueDisplay(formatter.temperature(Math.round(parsed), undefined));
}

/**
 * "Today", else the short weekday ("Thu"). The Formatter has no weekday-only style, so the weekday is what remains
 * of the 'weekday-short' date once its 'month-day' part is removed ("Thu, Oct 1" − "Oct 1"); a locale where that
 * does not work keeps the full short date.
 */
function dayLabel(formatter: Formatter, at: Date, now: Date): string {
  if (sameDay(formatter, at, now)) return 'Today';
  const full = formatter.date(at, 'weekday-short');
  const monthDay = formatter.date(at, 'month-day');
  if (!full.includes(monthDay)) return full;
  const weekday = full.replace(monthDay, '').replace(/^[\s,.]+|[\s,]+$/g, '');
  return weekday === '' ? full : weekday;
}

function stringAttribute(entity: HassEntityLike | undefined, attribute: string): string | undefined {
  const value = entity?.attributes[attribute];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function dateAttribute(entity: HassEntityLike | undefined, attribute: string): Date | undefined {
  const value = stringAttribute(entity, attribute);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}
