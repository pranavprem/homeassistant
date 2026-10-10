/**
 * selectWeatherDetails and selectSkyConditions (AIRSPACE.md §6, §8): each metric only when the entity reports it,
 * null and out-of-range values as "No data" (never 0), units from the entity's own attributes, UV categories, wind
 * direction, next sunrise and sunset, the offline cue, unavailable and missing states, and no friendly_name.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { displayText } from '../../src/model/display.ts';
import { selectSkyConditions, selectWeatherDetails } from '../../src/model/weather-details.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const WEATHER = 'weather.demo_home';
const SUN = 'sun.demo_sun';
const NOW = new Date('2026-10-09T18:00:00.000Z');
const HOUR_MS = 3_600_000;
const formatter = createFormatter({
  temperatureUnit: '°F',
  locale: { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'server' },
  serverTimeZone: 'UTC',
});
const CONFIG = configFrom({ weather: WEATHER, sun: SUN });

const FULL_ATTRIBUTES = {
  friendly_name: 'Fictional Town Weather',
  temperature: 68.4,
  temperature_unit: '°F',
  apparent_temperature: 66,
  dew_point: 51.2,
  humidity: 61,
  cloud_coverage: 40,
  uv_index: 3.4,
  wind_speed: 9.4,
  wind_gust_speed: 18,
  wind_speed_unit: 'mph',
  wind_bearing: 315,
  visibility: 10,
  visibility_unit: 'mi',
  pressure: 30.02,
  pressure_unit: 'inHg',
};

function sunEntity(risingInHours: number, settingInHours: number): HassEntityLike {
  return testEntity(SUN, 'above_horizon', {
    next_rising: new Date(NOW.getTime() + risingInHours * HOUR_MS).toISOString(),
    next_setting: new Date(NOW.getTime() + settingInHours * HOUR_MS).toISOString(),
  });
}

function details(
  weather: HassEntityLike | undefined,
  options: { store?: FakeStoreOptions; sun?: HassEntityLike; config?: ResolvedConfig } = {},
) {
  const states = [weather, options.sun ?? sunEntity(13, 1)].filter((state): state is HassEntityLike => !!state);
  const store = fakeStore(states, options.store);
  const input = {
    config: options.config ?? CONFIG,
    store,
    reader: { ...fakeReader(store), formatter: () => formatter },
    gateway: new FakeGateway(),
    now: NOW,
  };
  return { vm: selectWeatherDetails(input), conditions: selectSkyConditions(input) };
}

function metricTexts(weather: HassEntityLike, options?: Parameters<typeof details>[1]): Record<string, string> {
  return Object.fromEntries(
    details(weather, options).vm.metrics.map((metric) => [metric.key, displayText(metric.value)]),
  );
}

describe('selectWeatherDetails (AIRSPACE.md §8)', () => {
  it('lists every reported metric in order, with units from the entity', () => {
    const { vm } = details(testEntity(WEATHER, 'partlycloudy', FULL_ATTRIBUTES));
    expect(vm.metrics.map((metric) => [metric.label, displayText(metric.value)])).toEqual([
      ['Feels like', '66°'],
      ['Dew point', '51.2°'],
      ['Humidity', '61%'],
      ['Cloud cover', '40%'],
      ['UV index', '3.4'],
      ['Wind', '9.4 mph'],
      ['Gusts', '18 mph'],
      ['Wind direction', 'NW'],
      ['Visibility', '10 mi'],
      ['Pressure', '30.02 inHg'],
    ]);
    expect(vm.metrics.find((metric) => metric.key === 'uv')?.detail).toBe('Moderate');
    expect(vm).toMatchObject({ status: 'available', stale: false, unit: '°F' });
    expect(displayText(vm.temperature)).toBe('68.4');
    expect(vm.condition.key).toBe('partlycloudy');
  });

  it('omits metrics the integration never reports', () => {
    const { vm } = details(testEntity(WEATHER, 'sunny', { temperature: 70, humidity: 40 }));
    expect(vm.metrics.map((metric) => metric.key)).toEqual(['humidity']);
  });

  it('shows null and out-of-range values as "No data", never 0', () => {
    const texts = metricTexts(
      testEntity(WEATHER, 'sunny', {
        humidity: null,
        cloud_coverage: 101,
        uv_index: 21,
        wind_speed: -1,
        pressure: 'high',
        visibility: Number.POSITIVE_INFINITY,
        dew_point: null,
        wind_bearing: 'somewhere',
      }),
    );
    expect(texts).toEqual({
      'dew-point': 'No data',
      humidity: 'No data',
      'cloud-cover': 'No data',
      uv: 'No data',
      wind: 'No data',
      'wind-direction': 'No data',
      visibility: 'No data',
      pressure: 'No data',
    });
    const uv = details(testEntity(WEATHER, 'sunny', { uv_index: 21 })).vm.metrics[0];
    expect(Object.hasOwn(uv as object, 'detail')).toBe(false);
  });

  it('keeps the range edges and leaves a bare number without a unit', () => {
    expect(
      metricTexts(
        testEntity(WEATHER, 'sunny', { humidity: 0, cloud_coverage: 100, uv_index: 20, visibility: 0, wind_speed: 0 }),
      ),
    ).toEqual({ humidity: '0%', 'cloud-cover': '100%', uv: '20', wind: '0', visibility: '0' });
  });

  it('reads a compass-point wind bearing only when it is one', () => {
    const direction = (wind_bearing: unknown) =>
      metricTexts(testEntity(WEATHER, 'sunny', { wind_bearing }))['wind-direction'];
    expect(direction(90)).toBe('E');
    expect(direction('nw')).toBe('NW');
    expect(direction('NNE')).toBe('NNE');
    expect(direction('Northwest')).toBe('No data');
    expect(direction('<b>N</b>')).toBe('No data');
  });

  it.each([
    [0, 'Low'],
    [2.4, 'Low'],
    [2.5, 'Moderate'],
    [5, 'Moderate'],
    [6, 'High'],
    [7, 'High'],
    [8, 'Very high'],
    [10, 'Very high'],
    [11, 'Extreme'],
    [20, 'Extreme'],
  ])('puts UV index %s in the WHO category %s', (uv, category) => {
    const metric = details(testEntity(WEATHER, 'sunny', { uv_index: uv })).vm.metrics[0];
    expect(metric?.detail).toBe(category);
  });

  it('lists the next sunrise and sunset, soonest first, and drops a time already past', () => {
    const weather = testEntity(WEATHER, 'sunny', FULL_ATTRIBUTES);
    expect(details(weather, { sun: sunEntity(13, 1) }).vm.sun.map((event) => [event.label, event.time])).toEqual([
      ['Sunset', '7:00 PM'],
      ['Sunrise', '7:00 AM'],
    ]);
    expect(details(weather, { sun: sunEntity(13, -1) }).vm.sun.map((event) => event.kind)).toEqual(['sunrise']);
    expect(details(weather, { sun: testEntity(SUN, 'above_horizon', { next_rising: 'soon' }) }).vm.sun).toEqual([]);
    expect(details(weather, { config: configFrom({ weather: WEATHER }) }).vm.sun).toEqual([]);
  });

  it('marks last-known values while offline', () => {
    const { vm } = details(testEntity(WEATHER, 'sunny', FULL_ATTRIBUTES), { store: { connected: false } });
    expect(vm).toMatchObject({ status: 'disconnected', stale: true });
    expect(vm.metrics.every((metric) => metric.value.kind === 'value' && metric.value.stale)).toBe(true);
  });

  it('shows the state and no values when the source is unavailable, missing or not configured', () => {
    const unavailable = details(testEntity(WEATHER, 'unavailable', FULL_ATTRIBUTES)).vm;
    expect(unavailable).toMatchObject({ status: 'unavailable', metrics: [] });
    expect(displayText(unavailable.temperature)).toBe('Unavailable');
    expect(details(undefined).vm).toMatchObject({ status: 'missing-binding', metrics: [] });
    const none = details(undefined, { config: configFrom({}) }).vm;
    expect(none).toMatchObject({ status: 'missing-binding', metrics: [], sun: [] });
  });

  it("never carries the weather entity's friendly_name", () => {
    const { vm, conditions } = details(testEntity(WEATHER, 'sunny', FULL_ATTRIBUTES));
    expect(JSON.stringify({ vm, conditions })).not.toContain('Fictional Town');
  });
});

describe('selectSkyConditions (AIRSPACE.md §6)', () => {
  it('gives cloud cover, visibility and wind with its direction', () => {
    const { conditions } = details(testEntity(WEATHER, 'sunny', FULL_ATTRIBUTES));
    expect(conditions.map((metric) => [metric.label, displayText(metric.value)])).toEqual([
      ['Cloud cover', '40%'],
      ['Wind', '9.4 mph NW'],
      ['Visibility', '10 mi'],
    ]);
  });

  it('is empty without a readable weather source', () => {
    expect(details(testEntity(WEATHER, 'unavailable', FULL_ATTRIBUTES)).conditions).toEqual([]);
    expect(details(undefined, { config: configFrom({}) }).conditions).toEqual([]);
  });
});
