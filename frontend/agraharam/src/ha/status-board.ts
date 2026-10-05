/**
 * StatusBoard (§5.1): one short status line per source, written by controllers and read by the diagnostics
 * drawer only, so diagnostics never reaches into section internals.
 */
import { log } from '../util/log.ts';
import type { Unsubscribe } from './host.ts';

type StatusSource = 'forecast' | 'calendar' | 'live-view' | 'bundle';
export interface StatusBoard {
  set(source: StatusSource, line: string): void; // short code-like text, never a URL or entity ID
  get(source: StatusSource): string | undefined;
  subscribe(listener: () => void): Unsubscribe;
}

/** One board per runtime (HostRuntime.status). Listeners run only when a line actually changes. */
export function createStatusBoard(): StatusBoard {
  const lines = new Map<StatusSource, string>();
  const listeners = new Set<() => void>();

  function notify(): void {
    // Snapshot first: a listener may unsubscribe itself (or another listener) while being notified.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log.error('status-listener-failed');
      }
    }
  }

  return Object.freeze({
    set(source: StatusSource, line: string): void {
      if (lines.get(source) === line) return;
      lines.set(source, line);
      notify();
    },
    get(source: StatusSource): string | undefined {
      return lines.get(source);
    },
    subscribe(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
