/**
 * selectToday (§4.8, §9.2): hourly, daily-fallback and no-forecast VMs; high/low only from daily or twice_daily
 * (with the Tomorrow label); sunset and sunrise; units from attributes; honest absent states (never 0).
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { WEATHER_FEATURE } from '../../src/ha/features.ts';
import type { ForecastSnapshot } from '../../src/ha/forecast-controller.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { ForecastItem, Formatter } from '../../src/ha/host.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { FORECAST_NOTES, selectToday } from '../../src/model/today.ts';
import type { TodayVM } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const WEATHER = 'weather.demo_home';
const SUN = 'sun.demo_sun';
const FULL = WEATHER_FEATURE.FORECAST_DAILY | WEATHER_FEATURE.FORECAST_HOURLY;
const NOW = new Date(2026, 8, 30, 17, 51, 0);
const HOUR_MS = 3_600_000;

const formatter: Formatter = createFormatter({
  temperatureUnit: '°F',
  locale: { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'local' },
});

function at(hoursFromHourStart: number): string {
  const start = new Date(NOW);
  start.setMinutes(0, 0, 0);
  return new Date(start.getTime() + hoursFromHourStart * HOUR_MS).toISOString();
}

function onDay(dayOffset: number, hour = 12): string {
  const day = new Date(NOW);
  day.setDate(day.getDate() + dayOffset);
  day.setHours(hour, 0, 0, 0);
  return day.toISOString();
}

function weather(attributes: Readonly<Record<string, unknown>> = {}, state = 'partlycloudy'): HassEntityLike {
  return testEntity(WEATHER, state, {
    friendly_name: 'Home',
    temperature: 69,
    apparent_temperature: 68,
    humidity: 52,
    wind_speed: 5,
    temperature_unit: '°F',
    wind_speed_unit: 'mph',
    supported_features: FULL,
    ...attributes,
  });
}

function sun(state = 'above_horizon', settingInMin = 46): HassEntityLike {
  return testEntity(SUN, state, {
    next_setting: new Date(NOW.getTime() + settingInMin * 60_000).toISOString(),
    next_rising: onDay(1, 7),
  });
}

const HOURLY: readonly ForecastItem[] = Array.from({ length: 12 }, (_, hour) => ({
  datetime: at(hour),
  condition: 'partlycloudy',
  temperature: 68.6 - hour,
  precipitation_probability: hour === 2 ? 40 : 0,
}));

const DAILY: readonly ForecastItem[] = Array.from({ length: 7 }, (_, day) => ({
  datetime: onDay(day),
  condition: day === 1 ? 'rainy' : 'sunny',
  temperature: 71 + day,
  templow: 58 + day,
}));

interface Options {
  readonly states?: readonly HassEntityLike[];
  readonly forecast?: ForecastSnapshot;
  readonly store?: FakeStoreOptions;
  readonly config?: ResolvedConfig;
  readonly formatter?: Formatter;
}

function select(options: Options = {}): TodayVM {
  const store = fakeStore(options.states ?? [weather(), sun()], options.store);
  const reader = { ...fakeReader(store), formatter: () => options.formatter ?? formatter };
  return selectToday({
    config: options.config ?? configFrom({ weather: WEATHER, sun: SUN }),
    store,
    reader,
    gateway: new FakeGateway(),
    now: NOW,
    forecast: options.forecast ?? {},
  });
}

const LIVE_DAILY = { kind: 'live', items: DAILY } as const;
const liveBoth: ForecastSnapshot = {
  hourly: { kind: 'live', items: HOURLY },
  daily: LIVE_DAILY,
};

describe('selectToday: current conditions', () => {
  it('reads the hero, condition, metrics and sunset from the entities', () => {
    const vm = select({ forecast: liveBoth });
    expect(vm.status).toBe('available');
    expect(vm.name).toBe('Home');
    expect(vm.temperature).toEqual({ kind: 'value', text: '69', stale: false });
    expect(vm.unit).toBe('°F');
    expect(vm.condition).toEqual({ key: 'partlycloudy', label: 'Partly cloudy', icon: 'cloud-sun' });
    expect(vm.metrics.map((m) => [m.key, m.label, m.value.kind === 'value' ? m.value.text : m.value.label])).toEqual([
      ['feels', 'Feels like', '68°'],
      ['wind', 'Wind', '5 mph'],
      ['humidity', 'Humidity', '52%'],
    ]);
    expect(vm.sun).toEqual({ kind: 'sunset', time: formatter.time(new Date(NOW.getTime() + 46 * 60_000)) });
  });

  it('takes units from the entity attributes, never a hardcoded °F, and keeps the hero precision', () => {
    const vm = select({
      states: [weather({ temperature: 21.5, temperature_unit: '°C', wind_speed: 12.4, wind_speed_unit: 'km/h' })],
    });
    expect(vm.temperature).toEqual({ kind: 'value', text: '21.5', stale: false });
    expect(vm.unit).toBe('°C');
    expect(vm.metrics.find((m) => m.key === 'wind')?.value).toEqual({ kind: 'value', text: '12.4 km/h', stale: false });
  });

  it('falls back to the HA unit system when the entity has no temperature_unit', () => {
    const celsius = createFormatter({ temperatureUnit: '°C' });
    expect(select({ states: [weather({ temperature_unit: undefined })], formatter: celsius }).unit).toBe('°C');
  });

  it('shows null numbers as absent "No data", never 0', () => {
    const vm = select({ states: [weather({ temperature: null, humidity: 'unknown', wind_speed: Number.NaN })] });
    expect(vm.temperature).toEqual({ kind: 'absent', reason: 'no-data', label: 'No data' });
    for (const metric of vm.metrics.filter((m) => m.key !== 'feels')) {
      expect(metric.value).toEqual({ kind: 'absent', reason: 'no-data', label: 'No data' });
    }
    expect(JSON.stringify(vm)).not.toMatch(/"text":"0/);
  });

  it('omits a metric the integration never reports', () => {
    const vm = select({ states: [weather({ apparent_temperature: undefined, humidity: undefined })] });
    const without = testEntity(WEATHER, 'sunny', { temperature: 70, supported_features: FULL });
    expect(select({ states: [without] }).metrics).toEqual([]);
    expect(vm.metrics.map((m) => m.key)).toContain('wind');
  });

  it('uses HA translations for the condition when the frontend provides them', () => {
    const translated = createFormatter({ temperatureUnit: '°F', formatEntityState: () => 'Teilweise bewölkt' });
    expect(select({ formatter: translated }).condition.label).toBe('Teilweise bewölkt');
  });

  it('shows the night glyph after sunset', () => {
    expect(select({ states: [weather(), sun('above_horizon', 46)] }).condition.icon).toBe('cloud-sun');
    const night = testEntity(SUN, 'below_horizon', {
      next_rising: onDay(1, 7),
      next_setting: onDay(1, 19),
    });
    expect(select({ states: [weather(), night] }).condition.icon).toBe('cloud-moon');
  });

  it('keeps the last known values stale while disconnected', () => {
    const vm = select({ forecast: liveBoth, store: { connected: false } });
    expect(vm.status).toBe('disconnected');
    expect(vm.temperature).toEqual({ kind: 'value', text: '69', stale: true });
    expect(vm.forecast).toEqual({ kind: 'unavailable', reason: 'disconnected', note: FORECAST_NOTES.disconnected });
    expect(vm.high).toBeUndefined();
  });

  it('treats resyncing exactly like disconnected', () => {
    const vm = select({ forecast: liveBoth, store: { connected: false, resyncing: true } });
    expect(vm.forecast.kind).toBe('unavailable');
    expect(vm.temperature).toMatchObject({ stale: true });
  });

  it('distinguishes unavailable, missing, unknown and loading', () => {
    const unavailable = select({ states: [testEntity(WEATHER, 'unavailable')] });
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.temperature).toEqual({ kind: 'absent', reason: 'unavailable', label: 'Unavailable' });
    expect(unavailable.metrics).toEqual([]);
    expect(unavailable.forecast).toEqual({ kind: 'unavailable', reason: 'entity', note: FORECAST_NOTES.unavailable });

    const missing = select({ states: [] });
    expect(missing.status).toBe('missing-binding');
    expect(missing.temperature).toMatchObject({ label: 'Not found' });
    expect(missing.forecast).toMatchObject({ reason: 'entity', note: FORECAST_NOTES.missing });

    const unknown = select({ states: [weather({}, 'unknown')] });
    expect(unknown.status).toBe('unknown');
    expect(unknown.condition.icon).toBe('circle-question-mark');

    const loading = select({ store: { ready: false } });
    expect(loading.status).toBe('loading');
    expect(loading.forecast).toEqual({ kind: 'loading' });
  });

  it('says so when no weather entity is configured', () => {
    const vm = select({ config: configFrom({}) });
    expect(vm.status).toBe('missing-binding');
    expect(vm.forecast).toEqual({ kind: 'unavailable', reason: 'entity', note: FORECAST_NOTES.notConfigured });
  });
});

describe('selectToday: sun', () => {
  it('shows the next sunrise while the sun is below the horizon', () => {
    const night = testEntity(SUN, 'below_horizon', { next_rising: onDay(1, 7), next_setting: onDay(1, 19) });
    expect(select({ states: [weather(), night] }).sun).toEqual({
      kind: 'sunrise',
      time: formatter.time(new Date(onDay(1, 7))),
    });
  });

  it('omits a next event that is already past, a missing time, or no sun binding', () => {
    expect(select({ states: [weather(), sun('above_horizon', -5)] }).sun).toBeUndefined();
    expect(select({ states: [weather(), testEntity(SUN, 'above_horizon')] }).sun).toBeUndefined();
    expect(select({ config: configFrom({ weather: WEATHER }) }).sun).toBeUndefined();
    expect(select({ states: [weather(), testEntity(SUN, 'unavailable')] }).sun).toBeUndefined();
  });
});

describe('selectToday: high and low (§9.2)', () => {
  it('come from the first daily item', () => {
    const vm = select({ forecast: liveBoth });
    expect(vm.high).toEqual({ kind: 'value', text: '71°', stale: false });
    expect(vm.low).toEqual({ kind: 'value', text: '58°', stale: false });
    expect(vm.highLowDay).toBe('today');
  });

  it('are never inferred from hourly data', () => {
    const hourlyOnly = weather({ supported_features: WEATHER_FEATURE.FORECAST_HOURLY });
    const vm = select({ states: [hourlyOnly, sun()], forecast: { hourly: { kind: 'live', items: HOURLY } } });
    expect(vm.high).toBeUndefined();
    expect(vm.low).toBeUndefined();
    expect(vm.forecast.kind).toBe('hourly');
  });

  it('are absent while the daily forecast is loading, failed or unsupported', () => {
    for (const daily of [
      { kind: 'subscribing' },
      { kind: 'error', reason: 'other' },
      { kind: 'unsupported' },
    ] as const) {
      const vm = select({ forecast: { hourly: { kind: 'live', items: HOURLY }, daily } });
      expect(vm.high).toBeUndefined();
    }
  });

  it('read "Tomorrow" when the first daily item is not local today', () => {
    const fromTomorrow = DAILY.slice(1);
    const vm = select({ forecast: { daily: { kind: 'live', items: fromTomorrow } } });
    expect(vm.highLowDay).toBe('tomorrow');
    expect(vm.high).toMatchObject({ text: '72°' });
  });

  it('skip a day that has ended, so "Tomorrow" never labels a past day', () => {
    // An integration dating its daily items at midnight UTC, read the next morning in a western zone, still lists
    // yesterday first.
    const withYesterday = [{ datetime: onDay(-1), temperature: 60, templow: 50 }, ...DAILY];
    const vm = select({ forecast: { daily: { kind: 'live', items: withYesterday } } });
    expect(vm.highLowDay).toBe('today');
    expect(vm.high).toMatchObject({ text: '71°' });
    expect(vm.low).toMatchObject({ text: '58°' });
  });

  it('twice_daily: the first daytime half gives the high and the following night half the low', () => {
    const twice = weather({
      supported_features: WEATHER_FEATURE.FORECAST_HOURLY | WEATHER_FEATURE.FORECAST_TWICE_DAILY,
    });
    const items: ForecastItem[] = [
      { datetime: onDay(0, 18), temperature: 55, is_daytime: false },
      { datetime: onDay(1, 6), temperature: 74, is_daytime: true },
      { datetime: onDay(1, 18), temperature: 57, is_daytime: false },
    ];
    const vm = select({ states: [twice, sun()], forecast: { twice_daily: { kind: 'live', items } } });
    expect(vm.high).toMatchObject({ text: '74°' });
    expect(vm.low).toMatchObject({ text: '57°' });
    expect(vm.highLowDay).toBe('tomorrow');
  });

  it('omit a missing low rather than showing "No data"', () => {
    const vm = select({
      forecast: { daily: { kind: 'live', items: [{ datetime: onDay(0), temperature: 70, templow: null }] } },
    });
    expect(vm.high).toMatchObject({ text: '70°' });
    expect(vm.low).toBeUndefined();
  });
});

describe('selectToday: forecast strip (§9.2 VM mapping)', () => {
  it('hourly: the next 8 hours from the current one, "Now" first, integer temperatures, formatter.hour labels', () => {
    const vm = select({ forecast: liveBoth });
    if (vm.forecast.kind !== 'hourly') throw new Error(`expected hourly, got ${vm.forecast.kind}`);
    const items = vm.forecast.items;
    expect(items).toHaveLength(8);
    expect(items.map((item) => item.label)).toEqual([
      'Now',
      ...[1, 2, 3, 4, 5, 6, 7].map((hour) => formatter.hour(new Date(at(hour)))),
    ]);
    expect(items[0]?.temperature).toEqual({ kind: 'value', text: '69°', stale: false });
    expect(items[1]?.temperature).toEqual({ kind: 'value', text: '68°', stale: false });
    expect(items[2]?.precipitation).toBe('40%');
    expect(items[0]?.precipitation).toBeUndefined();
    expect(items[0]?.conditionLabel).toBe('Partly cloudy');
  });

  it('hourly glyphs switch to night after the sun sets', () => {
    const vm = select({ forecast: liveBoth });
    if (vm.forecast.kind !== 'hourly') throw new Error('expected hourly');
    expect(vm.forecast.items[0]?.icon).toBe('cloud-sun'); // 5 PM, before the 6:37 PM sunset
    expect(vm.forecast.items[2]?.icon).toBe('cloud-moon'); // 7 PM
  });

  it('drops hours that have passed', () => {
    const later = { hourly: { kind: 'live', items: HOURLY.slice(0) }, daily: LIVE_DAILY } as const;
    const store = { states: [weather(), sun()] };
    const vm = selectToday({
      config: configFrom({ weather: WEATHER, sun: SUN }),
      store: fakeStore(store.states),
      reader: { ...fakeReader(fakeStore(store.states)), formatter: () => formatter },
      gateway: new FakeGateway(),
      now: new Date(NOW.getTime() + 6 * HOUR_MS),
      forecast: later,
    });
    if (vm.forecast.kind !== 'hourly') throw new Error('expected hourly');
    expect(vm.forecast.items).toHaveLength(6);
    expect(vm.forecast.items[0]?.label).toBe('Now');
  });

  it('daily-only: a labelled 5-day fallback, never an invented hourly strip', () => {
    const dailyOnly = weather({ supported_features: WEATHER_FEATURE.FORECAST_DAILY });
    const vm = select({ states: [dailyOnly, sun()], forecast: { daily: { kind: 'live', items: DAILY } } });
    expect(vm.forecast.kind).toBe('daily-fallback');
    if (vm.forecast.kind !== 'daily-fallback') return;
    expect(vm.forecast.note).toBe(FORECAST_NOTES.dailyOnly);
    expect(vm.forecast.items).toHaveLength(5);
    expect(vm.forecast.items[0]?.label).toBe('Today');
    expect(vm.forecast.items[1]?.label).toBe(formatter.date(new Date(onDay(1)), 'weekday-short').split(',')[0]);
    expect(vm.forecast.items[1]?.icon).toBe('cloud-rain');
    expect(vm.forecast.items[0]?.low).toEqual({ kind: 'value', text: '58°', stale: false });
  });

  it('hourly not served by HA but daily live: the fallback; hourly failed: says it could not load', () => {
    const unsupported = select({ forecast: { hourly: { kind: 'unsupported' }, daily: LIVE_DAILY } });
    expect(unsupported.forecast).toMatchObject({ kind: 'daily-fallback', note: FORECAST_NOTES.dailyOnly });
    const failed = select({ forecast: { hourly: { kind: 'error', reason: 'other' }, daily: LIVE_DAILY } });
    expect(failed.forecast).toMatchObject({ kind: 'daily-fallback', note: FORECAST_NOTES.hourlyFailed });
  });

  it('waits for the hourly subscription instead of flashing the daily fallback', () => {
    expect(select({ forecast: { hourly: { kind: 'subscribing' }, daily: LIVE_DAILY } }).forecast).toEqual({
      kind: 'loading',
    });
    expect(select({ forecast: {} }).forecast).toEqual({ kind: 'loading' });
  });

  it('no forecast bits: unavailable, saying the source has no forecast', () => {
    const none = weather({ supported_features: 0 });
    expect(select({ states: [none] }).forecast).toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
      note: FORECAST_NOTES.none,
    });
  });

  it('every type unsupported by HA: unavailable unsupported', () => {
    const vm = select({ forecast: { hourly: { kind: 'unsupported' }, daily: { kind: 'unsupported' } } });
    expect(vm.forecast).toMatchObject({ kind: 'unavailable', reason: 'unsupported' });
  });

  it('errors: unavailable with the error copy, current conditions stay live', () => {
    const vm = select({
      forecast: { hourly: { kind: 'error', reason: 'other' }, daily: { kind: 'error', reason: 'entity' } },
    });
    expect(vm.forecast).toEqual({ kind: 'unavailable', reason: 'error', note: FORECAST_NOTES.error });
    expect(vm.temperature.kind).toBe('value');
  });

  it('live hourly data whose every hour has passed is called out of date, not unsupported', () => {
    const past = HOURLY.map((item, index) => ({ ...item, datetime: at(-12 + index - 1) }));
    const withDaily = select({ forecast: { hourly: { kind: 'live', items: past }, daily: LIVE_DAILY } });
    expect(withDaily.forecast).toMatchObject({ kind: 'daily-fallback', note: FORECAST_NOTES.hourlyStale });
    const hourlyOnly = weather({ supported_features: WEATHER_FEATURE.FORECAST_HOURLY });
    const alone = select({ states: [hourlyOnly, sun()], forecast: { hourly: { kind: 'live', items: past } } });
    expect(alone.forecast).toEqual({ kind: 'unavailable', reason: 'error', note: FORECAST_NOTES.stale });
  });

  it('live but empty everywhere: says no data was sent', () => {
    const vm = select({ forecast: { hourly: { kind: 'live', items: [] }, daily: { kind: 'live', items: [] } } });
    expect(vm.forecast).toEqual({ kind: 'unavailable', reason: 'error', note: FORECAST_NOTES.empty });
  });

  it('a forecast item without a temperature shows "No data", never 0', () => {
    const items = [{ datetime: at(0), condition: 'sunny', temperature: null }];
    const vm = select({ forecast: { hourly: { kind: 'live', items }, daily: LIVE_DAILY } });
    if (vm.forecast.kind !== 'hourly') throw new Error('expected hourly');
    expect(vm.forecast.items[0]?.temperature).toEqual({ kind: 'absent', reason: 'no-data', label: 'No data' });
  });
});
