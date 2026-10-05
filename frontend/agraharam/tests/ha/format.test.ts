import { describe, expect, it, vi } from 'vitest';
import { createFormatter, formatDuration } from '../../src/ha/format.ts';
import type { LocaleLike } from '../../src/ha/types.ts';
import { testEntity } from '../helpers/fake-store.ts';

const EVENING = new Date('2026-09-30T19:05:00Z');

/** ICU versions differ on the space before AM/PM (U+0020 or U+202F); the assertions are about content. */
function spaces(text: string): string {
  return text.replace(/\s/g, ' ');
}

function locale(overrides: Partial<LocaleLike> = {}): LocaleLike {
  return { language: 'en', number_format: 'language', time_format: 'language', time_zone: 'server', ...overrides };
}

describe('createFormatter (§4.4)', () => {
  it('builds one Intl.NumberFormat per distinct options and reuses it on every later call', () => {
    const formatter = createFormatter({ locale: locale(), temperatureUnit: '°F' });
    const constructed = vi.spyOn(Intl, 'NumberFormat');
    try {
      expect([formatter.number(1234), formatter.number(5678)]).toEqual(['1,234', '5,678']);
      expect(formatter.temperature(21.25, undefined)).toBe('21.3°');
      expect(formatter.temperature(19.5, undefined)).toBe('19.5°');
      expect(constructed).toHaveBeenCalledTimes(2);
    } finally {
      constructed.mockRestore();
    }
  });

  it('takes the temperature unit from the HA unit system, never a hardcoded °F', () => {
    expect(createFormatter({ temperatureUnit: '°C' }).temperatureUnit).toBe('°C');
    expect(createFormatter({ temperatureUnit: '°F' }).temperatureUnit).toBe('°F');
  });

  it('formats a compact degree without a unit, and HA spacing with the unit an entity reports', () => {
    const formatter = createFormatter({ locale: locale(), temperatureUnit: '°C' });
    expect(formatter.temperature(69, undefined)).toBe('69°');
    expect(formatter.temperature(21.5, '°C')).toBe('21.5 °C');
    const weather = testEntity('weather.demo_home', 'sunny', { temperature: 71, temperature_unit: '°F' });
    expect(formatter.temperature(71, weather.attributes['temperature_unit'] as string)).toBe('71 °F');
  });

  it('formats forecast hours and clock parts per the 12/24 h profile setting', () => {
    const twelve = createFormatter({
      locale: locale({ time_format: '12' }),
      serverTimeZone: 'UTC',
      temperatureUnit: '°F',
    });
    expect(spaces(twelve.hour(EVENING))).toBe('7 PM');
    expect(twelve.clock(EVENING)).toEqual({ hm: '7:05', period: 'PM' });
    expect(spaces(twelve.time(EVENING))).toBe('7:05 PM');
    const twentyFour = createFormatter({
      locale: locale({ time_format: '24' }),
      serverTimeZone: 'UTC',
      temperatureUnit: '°C',
    });
    expect(twentyFour.hour(EVENING)).toBe('19');
    expect(twentyFour.clock(EVENING)).toEqual({ hm: '19:05' });
  });

  it("follows the profile language for 'language' and the DEVICE locale for 'system', as HA's useAmPm does", () => {
    const usesPeriod = (overrides: Partial<LocaleLike>): boolean =>
      createFormatter({ locale: locale(overrides), serverTimeZone: 'UTC', temperatureUnit: '°C' }).clock(EVENING)
        .period !== undefined;
    expect(usesPeriod({ language: 'en-US', time_format: 'language' })).toBe(true);
    expect(usesPeriod({ language: 'de', time_format: 'language' })).toBe(false);
    // One of these two languages disagrees with the device, so matching both proves the language is ignored.
    const device = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true;
    expect(usesPeriod({ language: 'en-US', time_format: 'system' })).toBe(device);
    expect(usesPeriod({ language: 'de', time_format: 'system' })).toBe(device);
  });

  it('uses the server time zone only when the profile asks for it', () => {
    const server = createFormatter({
      locale: locale({ time_format: '24' }),
      serverTimeZone: 'Asia/Kolkata',
      temperatureUnit: '°C',
    });
    expect(server.time(EVENING)).toBe('00:35');
  });

  it('reads the hour of the day (0–23) in the same zone as the clock, whatever the language or 12/24 h setting', () => {
    const at = (overrides: Partial<LocaleLike>, zone: string) =>
      createFormatter({ locale: locale(overrides), serverTimeZone: zone, temperatureUnit: '°C' }).hourOfDay(EVENING);
    expect(at({ time_format: '12' }, 'UTC')).toBe(19);
    expect(at({ time_format: '24' }, 'Asia/Kolkata')).toBe(0); // 00:35 the next day
    expect(at({ language: 'ar-EG', time_format: '12' }, 'America/Los_Angeles')).toBe(12); // Latin digits parsed
    const local = createFormatter({ locale: locale({ time_zone: 'local' }), temperatureUnit: '°C' });
    expect(local.hourOfDay(EVENING)).toBe(EVENING.getHours());
  });

  it('formats the three date styles', () => {
    const formatter = createFormatter({ locale: locale(), serverTimeZone: 'UTC', temperatureUnit: '°F' });
    expect(formatter.date(EVENING, 'long')).toBe('Wednesday, September 30');
    expect(formatter.date(EVENING, 'weekday-short')).toBe('Wed, Sep 30');
    expect(formatter.date(EVENING, 'month-day')).toBe('Sep 30');
  });

  it('maps HA number formats to the locales HA uses, including no grouping', () => {
    const value = 12345.6;
    expect(
      createFormatter({ locale: locale({ number_format: 'comma_decimal' }), temperatureUnit: '' }).number(value),
    ).toBe('12,345.6');
    expect(
      createFormatter({ locale: locale({ number_format: 'decimal_comma' }), temperatureUnit: '' }).number(value),
    ).toBe('12.345,6');
    expect(createFormatter({ locale: locale({ number_format: 'none' }), temperatureUnit: '' }).number(value)).toBe(
      '12345.6',
    );
  });

  it('prefers hass.formatEntityState and falls back to the state with its unit', () => {
    const sensor = testEntity('sensor.demo_power', '7.2', { unit_of_measurement: 'kW' });
    const fromHass = vi.fn(() => '7.2 kW (HA)');
    expect(createFormatter({ temperatureUnit: '°F', formatEntityState: fromHass }).entityState(sensor)).toBe(
      '7.2 kW (HA)',
    );
    expect(fromHass).toHaveBeenCalledWith(sensor);
    const fallback = createFormatter({ locale: locale(), temperatureUnit: '°F' });
    expect(fallback.entityState(sensor)).toBe('7.2 kW');
    expect(fallback.entityState(testEntity('sensor.demo_battery', '82', { unit_of_measurement: '%' }))).toBe('82%');
    expect(fallback.entityState(testEntity('sensor.demo_status', 'Washing'))).toBe('Washing');
  });

  it('formats attributes through hass when available, else as plain values', () => {
    const fan = testEntity('fan.demo_purifier', 'on', { preset_mode: 'Sleep', percentage: 40 });
    const fallback = createFormatter({ locale: locale(), temperatureUnit: '°F' });
    expect(fallback.attribute(fan, 'preset_mode')).toBe('Sleep');
    expect(fallback.attribute(fan, 'percentage')).toBe('40');
    expect(fallback.attribute(fan, 'missing')).toBe('');
    const viaHass = createFormatter({ temperatureUnit: '°F', formatEntityAttributeValue: () => 'Sleep mode' });
    expect(viaHass.attribute(fan, 'preset_mode')).toBe('Sleep mode');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 min'],
    [-5_000, '0 min'],
    [35 * 60_000, '35 min'],
    [60 * 60_000, '1 h'],
    [70 * 60_000, '1 h 10 min'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
