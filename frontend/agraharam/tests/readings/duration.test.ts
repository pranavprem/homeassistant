/**
 * Reading durations (§18, design §7.4 with review S1): numeric states in HA's time units only, compact two-unit text
 * with carries, numbers through the formatter, and never a reinterpretation of text or of an unknown unit.
 */
import { describe, expect, it } from 'vitest';
import { createFormatter } from '../../src/ha/format.ts';
import { durationSeconds, formatReadingDuration } from '../../src/model/duration.ts';

const en = createFormatter({
  locale: { language: 'en', number_format: 'language', time_format: 'language', time_zone: 'server' },
  temperatureUnit: '°F',
});
const de = createFormatter({
  locale: { language: 'de', number_format: 'language', time_format: 'language', time_zone: 'server' },
  temperatureUnit: '°C',
});
const format = (seconds: number) => formatReadingDuration(seconds, en.number);

describe('formatReadingDuration (§7.4)', () => {
  it.each([
    [45, '45 s'],
    [725, '12 min 5 s'],
    [5_100, '1 h 25 min'],
    [3_600, '1 h'],
    [273_600, '3 d 4 h'],
    [3_542_400, '41 d'],
    [60, '1 min'],
    [61, '1 min 1 s'],
    [86_400, '1 d'],
    [90_000, '1 d 1 h'],
  ])('%d s → %s (the design examples)', (seconds, expected) => {
    expect(format(seconds)).toBe(expected);
  });

  it.each([
    // Under an hour the two units are min and s, so 59 min 50 s is shown exactly (the design's "59 min 50 s → 1 h"
    // example contradicts its own algorithm; the algorithm is what is specified and implemented).
    [3_590, '59 min 50 s'],
    [3_599.6, '1 h'], // rounds to 3 600 s, which reads as the hour
    [86_390, '1 d'], // 23 h 59 min 50 s rounds to 24 h 0 min, which carries to the day
    [59.6, '1 min'], // rounds to 60 s, then reads as a minute
    [86_399, '1 d'], // 23 h 59 min 59 s rounds to 24 h, which carries to the day
    [7_169, '1 h 59 min'],
    [7_170, '2 h'],
  ])(
    'rounds to the smaller unit and carries at the boundary: %d s → %s, never "60 min" or "24 h"',
    (seconds, expected) => {
      const text = format(seconds);
      expect(text).toBe(expected);
      expect(text).not.toMatch(/\b60 min\b|\b24 h\b|\b60 s\b/);
    },
  );

  it.each([
    [0, '0 s'],
    [0.4, '0.4 s'],
    [0.45, '0.5 s'],
    [0.999, '1 s'],
  ])('under a second: %d → %s (one decimal at most)', (seconds, expected) => {
    expect(format(seconds)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5])(
    'returns undefined for %d, so the caller falls back to HA formatting',
    (seconds) => {
      expect(format(seconds)).toBeUndefined();
    },
  );

  it('formats numbers through the formatter (grouping and decimal marks follow the locale)', () => {
    expect(format(1e9)).toBe('11,574 d 2 h');
    expect(formatReadingDuration(1e9, de.number)).toBe('11.574 d 2 h');
    expect(formatReadingDuration(0.4, de.number)).toBe('0,4 s');
  });
});

describe('durationSeconds (§7.4, S1)', () => {
  it.each([
    ['5100', 's', 5_100],
    ['1.25', 'h', 4_500],
    ['2', 'd', 172_800],
    ['30', 'min', 1_800],
    ['500', 'ms', 0.5],
    ['0', 's', 0],
    ['-5', 'min', -300],
  ])('reads %s %s as %d seconds', (state, unit, seconds) => {
    expect(durationSeconds(state, unit)).toBeCloseTo(seconds, 9);
  });

  it('accepts both micro signs: core’s Greek mu (U+03BC) and the micro sign (U+00B5)', () => {
    expect(durationSeconds('5', 'μs')).toBeCloseTo(5e-6, 12);
    expect(durationSeconds('5', 'µs')).toBeCloseTo(5e-6, 12);
  });

  it.each([
    ['1:25:00', 'h'],
    ['3 days, 4:05:00', 's'],
    ['07:30:00', 's'],
    ['unknown', 's'],
    ['unavailable', 'min'],
    ['', 's'],
    ['abc', 'h'],
  ])('does not reinterpret the non-numeric state %j', (state, unit) => {
    expect(durationSeconds(state, unit)).toBeUndefined();
  });

  it.each([undefined, null, '', 'hours', 'H', 'sec', 'w', 'mo', 'y', 5, 'µ', 'us'])(
    'does not reinterpret a numeric state with the unit %j',
    (unit) => {
      expect(durationSeconds('5', unit)).toBeUndefined();
    },
  );
});
