import { describe, expect, it } from 'vitest';
import { isStepValue, stepValue, temperatureGrid, type StepGrid } from '../../src/domain/steps.ts';

const HALF_DEGREE: StepGrid = { min: 7.2, max: 35, step: 0.5 };
const WHOLE_DEGREE: StepGrid = { min: 60, max: 86, step: 1 };

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('stepValue', () => {
  it('snaps an off-grid base to the grid first (§7.1)', () => {
    expect(stepValue(22.3, 1, HALF_DEGREE)).toBe(22.5);
    expect(stepValue(22.3, -1, HALF_DEGREE)).toBe(22);
  });

  it('moves one full step from an on-grid base', () => {
    expect(stepValue(22.5, 1, HALF_DEGREE)).toBe(23);
    expect(stepValue(22.5, -1, HALF_DEGREE)).toBe(22);
  });

  it('keeps an off-grid min reachable as the clamp result', () => {
    expect(stepValue(8, -1, HALF_DEGREE)).toBe(7.5);
    expect(stepValue(7.5, -1, HALF_DEGREE)).toBe(7.2);
    expect(isStepValue(7.2, HALF_DEGREE)).toBe(true);
  });

  it('clamps at max', () => {
    expect(stepValue(86, 1, WHOLE_DEGREE)).toBe(86);
    expect(stepValue(85.6, 1, WHOLE_DEGREE)).toBe(86);
  });

  it('rounds away floating-point noise to 6 decimals', () => {
    expect(stepValue(0.2, 1, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
  });

  it('rejects a non-positive step and a non-finite base', () => {
    expect(() => stepValue(20, 1, { min: 0, max: 100, step: 0 })).toThrow(RangeError);
    expect(() => stepValue(Number.NaN, 1, WHOLE_DEGREE)).toThrow(RangeError);
  });

  it('only produces values that isStepValue accepts, within [min, max] (property test)', () => {
    const random = seededRandom(20261003);
    const steps = [0.1, 0.5, 1, 2.5, 100 / 3, 0.25];
    for (let run = 0; run < 2_000; run += 1) {
      const step = steps[Math.floor(random() * steps.length)] ?? 1;
      const min = Math.round(random() * 400) / 10 - 10;
      const max = min + Math.round(random() * 600) / 10;
      const grid = { min, max, step };
      const base = min + random() * (max - min);
      for (const direction of [1, -1] as const) {
        const next = stepValue(base, direction, grid);
        expect(next).toBeGreaterThanOrEqual(min);
        expect(next).toBeLessThanOrEqual(max);
        expect(isStepValue(next, grid)).toBe(true);
      }
    }
  });
});

describe('isStepValue', () => {
  it('accepts grid values within tolerance and exactly min or max', () => {
    expect(isStepValue(22.5, HALF_DEGREE)).toBe(true);
    expect(isStepValue(22.5000001, HALF_DEGREE)).toBe(true);
    expect(isStepValue(35, HALF_DEGREE)).toBe(true);
  });

  it('rejects off-grid, out-of-range and non-finite values', () => {
    expect(isStepValue(22.3, HALF_DEGREE)).toBe(false);
    expect(isStepValue(36, HALF_DEGREE)).toBe(false);
    expect(isStepValue(7, HALF_DEGREE)).toBe(false);
    expect(isStepValue(Number.POSITIVE_INFINITY, HALF_DEGREE)).toBe(false);
  });
});

describe('temperatureGrid: the one setpoint grid for the gateway and the Comfort stepper (§7.1)', () => {
  it.each([
    [{ min_temp: 7, max_temp: 35 }, '°C', { min: 7, max: 35, step: 0.5 }],
    [{ min_temp: 45, max_temp: 95 }, '°F', { min: 45, max: 95, step: 1 }],
    [{ min_temp: 7, max_temp: 35, target_temp_step: 0.1 }, '°C', { min: 7, max: 35, step: 0.1 }],
    [{ min_temp: 60, max_temp: 86, target_temp_step: 0 }, '°F', { min: 60, max: 86, step: 1 }],
    [{ min_temp: 60, max_temp: 86, target_temp_step: '1' }, '°F', { min: 60, max: 86, step: 1 }],
    [{ min_temp: 7, max_temp: 35 }, 'K', { min: 7, max: 35, step: 0.5 }],
  ])('builds the grid for %j in %s', (attributes, unit, grid) => {
    expect(temperatureGrid(attributes, unit)).toEqual(grid);
  });

  it.each([
    [{ min_temp: 7 }],
    [{ min_temp: '7', max_temp: 35 }],
    [{ min_temp: Number.NaN, max_temp: 35 }],
    [{ min_temp: 30, max_temp: 10 }],
  ])('fails closed for %j', (attributes) => {
    expect(temperatureGrid(attributes, '°C')).toBeUndefined();
  });
});
