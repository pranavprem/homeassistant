/**
 * Minute-aligned and fixed-interval tickers and visibility helpers (§9.1). The root drives the store's 'clock' meta
 * from the minute ticker, so the greeting, "next 8 hours" and today/tomorrow grouping stay current without any entity
 * change; the sky clock (components/sky/sky-clock.ts) uses the interval ticker for its freshness gates.
 */
import { log } from './log.ts';

const MS_PER_MINUTE = 60_000;

export type StopTicker = () => void;

/** Milliseconds until the next wall-clock minute boundary (a full minute when exactly on one). */
export function msUntilNextMinute(nowMs: number): number {
  return MS_PER_MINUTE - (nowMs % MS_PER_MINUTE);
}

export function isDocumentVisible(): boolean {
  return document.visibilityState !== 'hidden';
}

/**
 * Calls `onTick` at every minute boundary, and once whenever the document becomes visible again: timers are
 * throttled or frozen while a tablet sleeps, so the ticker realigns instead of trusting its schedule.
 */
export function startMinuteTicker(onTick: () => void, now: () => number = Date.now): StopTicker {
  return startRealigningTicker(onTick, () => msUntilNextMinute(now()), 'minute-tick-failed');
}

/**
 * Calls `onTick` every `intervalMs`, and once whenever the document becomes visible again (restarting the interval
 * from there), with the minute ticker's realignment: a gate that a tick must clear (the sky's live → stale step) is
 * then re-evaluated within `intervalMs` of the tablet waking, whatever the throttled timers did meanwhile.
 */
export function startIntervalTicker(onTick: () => void, intervalMs: number): StopTicker {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`startIntervalTicker needs a positive interval in ms, got ${intervalMs}`);
  }
  return startRealigningTicker(onTick, () => intervalMs, 'interval-tick-failed');
}

/**
 * The shared schedule: one timeout at a time, re-armed before each tick so a throwing `onTick` (logged by
 * `failureCode`) never stops it, and re-armed with an immediate tick when the document becomes visible.
 */
function startRealigningTicker(onTick: () => void, nextDelayMs: () => number, failureCode: string): StopTicker {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function tick(): void {
    try {
      onTick();
    } catch {
      log.error(failureCode);
    }
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      schedule();
      tick();
    }, nextDelayMs());
  }

  function onVisibilityChange(): void {
    if (!isDocumentVisible()) return;
    schedule();
    tick();
  }

  schedule();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
