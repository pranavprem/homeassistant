/**
 * The weather fixture's scenario variants (§10.2): every designed Today fallback has a scenario, all data is
 * fictional and clock-relative.
 */
import { describe, expect, it } from 'vitest';
import type { DemoScenarioId } from '../../src/config/schema.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { todayFixture } from '../../src/demo/fixtures/today.ts';
import { WEATHER_FEATURE } from '../../src/ha/features.ts';
import { forecastPlan } from '../../src/ha/forecast-controller.ts';

const NOW = new Date(2026, 8, 30, 17, 51, 0).getTime();
const clock = fixtureClock(NOW);

function weather(scenario: DemoScenarioId) {
  return todayFixture.states(scenario, clock).find((state) => state.entity_id.startsWith('weather.'));
}

describe('today fixture', () => {
  it('normal: daily + hourly, with the first hourly item in the current hour ("Now")', () => {
    expect(forecastPlan(weather('normal')?.attributes['supported_features'])).toEqual({ hourly: true, daily: 'daily' });
    const hourly = todayFixture.forecasts?.('normal', clock).hourly;
    if (!Array.isArray(hourly)) throw new Error('expected hourly items');
    const first = Date.parse(hourly[0]?.datetime ?? '');
    expect(first).toBeLessThanOrEqual(NOW);
    expect(first + 3_600_000).toBeGreaterThan(NOW);
    expect(hourly.length).toBeGreaterThanOrEqual(8);
  });

  it('degraded: daily only (the labelled fallback)', () => {
    expect(weather('degraded')?.attributes['supported_features']).toBe(WEATHER_FEATURE.FORECAST_DAILY);
    expect(Object.keys(todayFixture.forecasts?.('degraded', clock) ?? {})).toEqual(['daily']);
  });

  it('empty: weather only, with no forecast feature bits and no forecasts', () => {
    expect(todayFixture.config('empty')).toEqual({ weather: 'weather.demo_home' });
    expect(todayFixture.states('empty', clock).map((state) => state.entity_id)).toEqual(['weather.demo_home']);
    expect(weather('empty')?.attributes['supported_features']).toBe(0);
    expect(todayFixture.forecasts?.('empty', clock)).toEqual({});
  });

  it('restricted: the weather entity itself is unavailable', () => {
    expect(weather('restricted')?.state).toBe('unavailable');
  });

  it('starting: every forecast subscription fails', () => {
    expect(todayFixture.forecasts?.('starting', clock)).toEqual({ hourly: 'error', daily: 'error' });
  });

  it('dense: hourly + twice_daily, with a fractional hero temperature', () => {
    expect(forecastPlan(weather('dense')?.attributes['supported_features'])).toEqual({
      hourly: true,
      daily: 'twice_daily',
    });
    const twice = todayFixture.forecasts?.('dense', clock).twice_daily;
    if (!Array.isArray(twice)) throw new Error('expected twice_daily items');
    expect(twice.some((item) => item.is_daytime === false)).toBe(true);
    expect(weather('dense')?.attributes['temperature']).toBe(70.5);
  });

  it('places the sunset relative to the clock and uses only fictional IDs', () => {
    const sun = todayFixture.states('normal', clock).find((state) => state.entity_id.startsWith('sun.'));
    expect(Date.parse(String(sun?.attributes['next_setting'])) - NOW).toBe(46 * 60_000);
    for (const scenario of ['normal', 'degraded', 'empty', 'dense'] as const) {
      for (const state of todayFixture.states(scenario, clock)) expect(state.entity_id.split('.')[1]).toMatch(/^demo_/);
    }
  });
});
