import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDocumentVisible, msUntilNextMinute, startIntervalTicker, startMinuteTicker } from '../../src/util/time.ts';
import { setVisibility } from '../helpers/observers.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('minute ticker (§9.1)', () => {
  it('computes the time to the next minute boundary', () => {
    expect(msUntilNextMinute(Date.UTC(2026, 8, 30, 0, 51, 30))).toBe(30_000);
    expect(msUntilNextMinute(Date.UTC(2026, 8, 30, 0, 51, 0))).toBe(60_000);
  });

  it('ticks on minute boundaries and once when the page becomes visible again, until stopped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 30, 0, 51, 45));
    const tick = vi.fn();
    const stop = startMinuteTicker(tick);
    vi.advanceTimersByTime(15_000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    setVisibility('hidden');
    expect(tick).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(180_000);
    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a throwing tick by code and keeps ticking', () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = startMinuteTicker(() => {
      throw new Error('tick bug');
    });
    vi.advanceTimersByTime(120_000);
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'minute-tick-failed');
    stop();
  });

  it('reads document visibility', () => {
    setVisibility('hidden');
    expect(isDocumentVisible()).toBe(false);
    setVisibility('visible');
    expect(isDocumentVisible()).toBe(true);
  });
});

describe('interval ticker (AIRSPACE.md §5)', () => {
  it('ticks every interval, and once at once when the page becomes visible, restarting the interval there', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startIntervalTicker(tick, 10_000);
    vi.advanceTimersByTime(9_999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4_000);
    setVisibility('hidden');
    expect(tick).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(2);
    // The interval restarts from the visibility tick, so the next tick is a full interval after it.
    vi.advanceTimersByTime(9_999);
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a throwing tick by its own code and keeps ticking', () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const stop = startIntervalTicker(() => {
      calls += 1;
      throw new Error('tick bug');
    }, 10_000);
    vi.advanceTimersByTime(30_000);
    expect(calls).toBe(3);
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'interval-tick-failed');
    stop();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an interval of %s ms', (interval) => {
    expect(() => startIntervalTicker(() => undefined, interval)).toThrow(RangeError);
  });
});
