import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDocumentVisible, msUntilNextMinute, startMinuteTicker } from '../../src/util/time.ts';
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
