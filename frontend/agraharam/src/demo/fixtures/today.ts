/**
 * Weather and sun fixture (§10.2). Fictional and clock-relative: every time derives from the fixture clock, so
 * "Now", the next hours, sunset and the Today/Tomorrow high-low label are right on any day.
 *
 * Scenario variants: normal (and alert, offline, loading) daily + hourly; degraded daily-only (the labelled
 * fallback); empty no forecast feature bits and no sun; restricted the weather entity unavailable; starting both
 * subscriptions fail (error copy); dense hourly + twice_daily with a fractional temperature (hero precision).
 */
import type { DemoScenarioId } from '../../config/schema.ts';
import { WEATHER_FEATURE } from '../../ha/features.ts';
import type { ForecastItem, ForecastType } from '../../ha/host.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

const WEATHER = 'weather.demo_home';
const SUN = 'sun.demo_sun';
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
/** A day of hours, so a long-running preview still has a full strip hours after the fixture was built. */
const HOURLY_ITEMS = 30;
const DAILY_ITEMS = 7;
/** Sunset 46 minutes after now: 5:51 PM → "Sunset 6:37 PM" at the pinned e2e time. */
const SUNSET_IN_MIN = 46;
const SUNRISE_HOUR = 7;
const SUNRISE_MINUTE = 4;
/** twice_daily halves: daytime 06:00–18:00, night 18:00–06:00. */
const DAY_HALF_START_HOUR = 6;
const NIGHT_HALF_START_HOUR = 18;
const HALF_DAY_MIN = 12 * MINUTES_PER_HOUR;

const FULL_FEATURES = WEATHER_FEATURE.FORECAST_DAILY | WEATHER_FEATURE.FORECAST_HOURLY;
const DENSE_FEATURES = WEATHER_FEATURE.FORECAST_HOURLY | WEATHER_FEATURE.FORECAST_TWICE_DAILY;

const HOURLY_CONDITIONS = [
  'partlycloudy',
  'partlycloudy',
  'partlycloudy',
  'cloudy',
  'partlycloudy',
  'clear-night',
  'clear-night',
  'partlycloudy',
] as const;
const HOURLY_TEMPERATURES = [69, 67, 65, 64, 63, 62, 61, 60, 59, 59, 58, 58] as const;
const DAILY = [
  { condition: 'partlycloudy', high: 71, low: 58, rain: 10 },
  { condition: 'sunny', high: 74, low: 59, rain: 0 },
  { condition: 'cloudy', high: 68, low: 56, rain: 20 },
  { condition: 'rainy', high: 63, low: 54, rain: 60 },
  { condition: 'sunny', high: 70, low: 57, rain: 0 },
] as const;

const SECONDS_PER_MINUTE = 60;

/** Minutes from now back to the start of the current local hour, so the first hourly item is labelled "Now". */
function minutesSinceHourStart(clock: FixtureClock): number {
  const now = clock.now;
  return now.getMinutes() + now.getSeconds() / SECONDS_PER_MINUTE + now.getMilliseconds() / MS_PER_MINUTE;
}

function hourlyForecast(clock: FixtureClock, rainy: boolean): readonly ForecastItem[] {
  const hourStart = -minutesSinceHourStart(clock);
  return Array.from({ length: HOURLY_ITEMS }, (_, hour) => ({
    datetime: clock.at(hourStart + hour * MINUTES_PER_HOUR),
    condition:
      rainy && hour >= 3 && hour < 6
        ? 'rainy'
        : (HOURLY_CONDITIONS[hour % HOURLY_CONDITIONS.length] ?? HOURLY_CONDITIONS[0]),
    temperature: HOURLY_TEMPERATURES[hour % HOURLY_TEMPERATURES.length] ?? HOURLY_TEMPERATURES[0],
    precipitation_probability: rainy && hour >= 3 && hour < 6 ? 70 : 10,
  }));
}

function dailyForecast(clock: FixtureClock): readonly ForecastItem[] {
  return Array.from({ length: DAILY_ITEMS }, (_, day) => {
    const spec = DAILY[day % DAILY.length] ?? DAILY[0];
    return {
      datetime: clock.dayAt(day, 12, 0),
      condition: spec.condition,
      temperature: spec.high,
      templow: spec.low,
      precipitation_probability: spec.rain,
    };
  });
}

/** Daytime and night halves from today on, dropping halves that have already ended. */
function twiceDailyForecast(clock: FixtureClock): readonly ForecastItem[] {
  const nowMs = clock.now.getTime();
  return Array.from({ length: DAILY_ITEMS }, (_, day) => {
    const spec = DAILY[day % DAILY.length] ?? DAILY[0];
    return [
      {
        datetime: clock.dayAt(day, DAY_HALF_START_HOUR, 0),
        condition: spec.condition,
        temperature: spec.high,
        is_daytime: true,
      },
      {
        datetime: clock.dayAt(day, NIGHT_HALF_START_HOUR, 0),
        condition: 'clear-night',
        temperature: spec.low,
        is_daytime: false,
      },
    ];
  })
    .flat()
    .filter((item) => Date.parse(item.datetime) + HALF_DAY_MIN * MS_PER_MINUTE > nowMs)
    .map((item) => ({ ...item, precipitation_probability: 10 }));
}

function weatherState(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike {
  if (scenario === 'restricted') return demoEntity(clock, WEATHER, 'unavailable', { friendly_name: 'Home' });
  return demoEntity(clock, WEATHER, 'partlycloudy', {
    friendly_name: 'Home',
    temperature: scenario === 'dense' ? 70.5 : 69,
    apparent_temperature: 69,
    humidity: 52,
    wind_speed: 5,
    temperature_unit: '°F',
    wind_speed_unit: 'mph',
    supported_features: featuresFor(scenario),
  });
}

function featuresFor(scenario: DemoScenarioId): number {
  switch (scenario) {
    case 'empty':
      return 0; // "This weather source doesn't provide a forecast."
    case 'degraded':
      return WEATHER_FEATURE.FORECAST_DAILY;
    case 'dense':
      return DENSE_FEATURES;
    default:
      return FULL_FEATURES;
  }
}

function sunState(clock: FixtureClock): HassEntityLike {
  return demoEntity(clock, SUN, 'above_horizon', {
    friendly_name: 'Sun',
    next_setting: clock.at(SUNSET_IN_MIN),
    next_rising: clock.dayAt(1, SUNRISE_HOUR, SUNRISE_MINUTE),
  });
}

type ForecastFixture = Partial<Record<ForecastType, readonly ForecastItem[] | 'error'>>;

function forecasts(scenario: DemoScenarioId, clock: FixtureClock): ForecastFixture {
  switch (scenario) {
    case 'empty':
      return {};
    case 'degraded':
      return { daily: dailyForecast(clock) };
    case 'starting':
      return { hourly: 'error', daily: 'error' };
    case 'dense':
      return { hourly: hourlyForecast(clock, true), twice_daily: twiceDailyForecast(clock) };
    default:
      return { hourly: hourlyForecast(clock, false), daily: dailyForecast(clock) };
  }
}

export const todayFixture: SectionFixture = {
  config: (scenario) => (scenario === 'empty' ? { weather: WEATHER } : { weather: WEATHER, sun: SUN }),
  states: (scenario, clock) =>
    scenario === 'empty' ? [weatherState(scenario, clock)] : [weatherState(scenario, clock), sunState(clock)],
  forecasts,
};
