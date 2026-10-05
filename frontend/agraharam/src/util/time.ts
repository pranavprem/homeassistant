/**
 * Minute-aligned ticker and visibility helpers (§9.1). The root drives the store's 'clock' meta from this, so the
 * greeting, "next 8 hours" and today/tomorrow grouping stay current without any entity change.
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
  let timer: ReturnType<typeof setTimeout> | undefined;

  function tick(): void {
    try {
      onTick();
    } catch {
      log.error('minute-tick-failed');
    }
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      schedule();
      tick();
    }, msUntilNextMinute(now()));
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
