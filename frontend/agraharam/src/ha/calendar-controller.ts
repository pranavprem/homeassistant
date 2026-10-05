/**
 * Calendar refresh lifecycle (§9.5). Active only when calendars are configured. It reads on connect, then every 15
 * minutes while the phase is `connected` and the document is visible, and once when the phase returns to
 * `connected` after a reconnect (after the resync barrier clears, never during it). The window is now → end of
 * tomorrow in the formatter's time zone. Each refresh has its own AbortController and supersedes the previous one.
 * A failed calendar keeps its previous events, marked stale by the selector. Teardown aborts the read, clears the
 * timer and removes the visibility listener. Reads only: no service calls.
 *
 * A permission denial (401 or 403) pauses every calendar read until a reconnect (a new socket generation) or a
 * 'user' meta change, as for cameras (§4.4, §9.3): each counted 401 moves this client toward HA's http.ban, so
 * neither the 15 minute timer nor a re-attach retries it.
 *
 * A layout change re-creates the Upcoming section (§5.1), and with it this controller. The latest read is kept per
 * runtime reader and socket generation, so a re-created controller shows the same events at once (no loading
 * skeleton on a rotation or sidebar toggle), reads again only when the 15 minutes are up, and inherits a denial
 * instead of spending another counted 401. Nothing is kept across a reconnect, a runtime or a calendar list change.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { EntityId } from '../config/schema.ts';
import { log } from '../util/log.ts';
import { isDocumentVisible } from '../util/time.ts';
import type { StoreView } from './entity-store.ts';
import { isHostError } from './errors.ts';
import { dayStart } from './format.ts';
import type { CalendarEventLike, Formatter, HostReader, Unsubscribe } from './host.ts';
import type { StatusBoard } from './status-board.ts';

export const CALENDAR_REFRESH_MS = 15 * 60_000;

export interface CalendarEntry {
  readonly calendar: EntityId;
  readonly event: CalendarEventLike;
}

export interface CalendarSnapshot {
  /** idle: nothing read yet; loading: the first read is in flight; error: the latest refresh had a failure. */
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  /** Every calendar's latest successfully read events, in configuration order. */
  readonly entries: readonly CalendarEntry[];
  /** Calendars whose latest read failed; their previous events stay in `entries`. */
  readonly failed: number;
}

/** What the calendar needs from DashboardServices (kept narrow: src/ha never imports components). */
export interface CalendarSource {
  readonly reader: HostReader;
  readonly status: StatusBoard;
  readonly calendars: readonly EntityId[];
}

/** now → the end of tomorrow, in the formatter's time zone (the same days the Upcoming selector groups by). */
export function calendarWindow(
  nowMs: number,
  formatter: Pick<Formatter, 'dayKey'>,
): { readonly start: Date; readonly end: Date } {
  const start = new Date(nowMs);
  return { start, end: dayStart(formatter, start, 2) };
}

interface KeptCalendar {
  readonly signature: string;
  readonly generation: number;
  readonly refreshedAt: number;
  readonly events: ReadonlyMap<EntityId, readonly CalendarEventLike[]>;
  readonly phase: 'ready' | 'error';
  readonly failed: number;
  readonly denied: boolean;
}

/** The latest read per runtime reader; collected with the reader. */
const KEPT_CALENDARS = new WeakMap<HostReader, KeptCalendar>();

const IDLE_SNAPSHOT: CalendarSnapshot = Object.freeze({ phase: 'idle', entries: Object.freeze([]), failed: 0 });
const WATCHED_META = Object.freeze(['connection', 'user'] as const);

type ReadResult = {
  readonly id: EntityId;
  readonly events?: readonly CalendarEventLike[];
  /** The read was refused for permission (401 or 403). */
  readonly denied?: boolean;
};

export class CalendarController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #source: () => CalendarSource | undefined;
  readonly #now: () => number;
  #attached = false;
  #reader: HostReader | undefined;
  #signature = '';
  #watch: { readonly store: StoreView; readonly unsubscribe: Unsubscribe } | undefined;
  /** The phase was `connected` at the last reconcile; a false → true edge triggers one refresh. */
  #live = false;
  #abort: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastRefreshAt: number | undefined;
  #phase: CalendarSnapshot['phase'] = 'idle';
  #failed = 0;
  /** Set by a 401 or 403; lifted by a new socket generation or a 'user' meta change (see the header). */
  #denied: { readonly generation: number } | undefined;
  /** The socket generation of a kept read this controller started from; consumed by the first live reconcile. */
  #keptGeneration: number | undefined;
  readonly #events = new Map<EntityId, readonly CalendarEventLike[]>();
  #snapshot: CalendarSnapshot = IDLE_SNAPSHOT;
  readonly #onVisibilityChange = (): void => this.#guard(() => this.#visibilityChanged());

  constructor(host: ReactiveControllerHost, source: () => CalendarSource | undefined, now: () => number = Date.now) {
    this.#host = host;
    this.#source = source;
    this.#now = now;
    host.addController(this);
  }

  snapshot(): CalendarSnapshot {
    return this.#snapshot;
  }

  hostConnected(): void {
    this.#guard(() => {
      this.#attached = true;
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
      // A re-attached element does not re-render by itself, so a changed snapshot asks for one.
      if (this.#reconcile()) this.#host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.#guard(() => {
      this.#attached = false;
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
      this.#unwatch();
      this.#pause();
      this.#live = false;
      this.#publish();
    });
  }

  /** Runs before every render, so a new runtime or calendar list is picked up at once. */
  hostUpdate(): void {
    if (this.#attached) this.#guard(() => this.#reconcile());
  }

  /** Controller callbacks never throw (§4.9 rule 2). */
  #guard(run: () => void): void {
    try {
      run();
    } catch {
      log.error('calendar-controller-failed');
    }
  }

  /** Returns true when the snapshot changed. */
  #reconcile(): boolean {
    const source = this.#source();
    this.#adopt(source);
    this.#watchStore(source);
    if (source === undefined || !this.#isActive(source)) {
      if (this.#live) this.#pause();
      this.#live = false;
      return this.#publish();
    }
    if (!this.#live) {
      this.#live = true;
      if (this.#resumesKeptRead(source)) this.#ensureTimer();
      else this.#refresh(source);
    } else {
      this.#ensureTimer();
    }
    return this.#publish();
  }

  #isActive(source: CalendarSource): boolean {
    return (
      this.#attached &&
      source.calendars.length > 0 &&
      source.reader.connection().phase === 'connected' &&
      !this.#isDenied(source)
    );
  }

  /** A denial from an earlier socket no longer applies: the reconnect is the one new attempt it allows. */
  #isDenied(source: CalendarSource): boolean {
    if (this.#denied !== undefined && this.#denied.generation !== source.reader.connectionGeneration()) {
      this.#denied = undefined;
    }
    return this.#denied !== undefined;
  }

  /**
   * A new runtime or calendar list starts from scratch: earlier events belong to another source. A read kept for
   * the same reader, list and socket (by a controller a layout change replaced) is taken over instead.
   */
  #adopt(source: CalendarSource | undefined): void {
    const signature = source?.calendars.join('\n') ?? '';
    if (source?.reader === this.#reader && signature === this.#signature) return;
    this.#pause();
    this.#live = false;
    this.#reader = source?.reader;
    this.#signature = signature;
    this.#events.clear();
    this.#lastRefreshAt = undefined;
    this.#phase = 'idle';
    this.#failed = 0;
    this.#denied = undefined;
    this.#keptGeneration = undefined;
    if (source !== undefined) this.#takeOverKeptRead(source.reader, signature);
  }

  #takeOverKeptRead(reader: HostReader, signature: string): void {
    const kept = KEPT_CALENDARS.get(reader);
    if (kept === undefined || kept.signature !== signature || kept.generation !== reader.connectionGeneration()) return;
    for (const [id, events] of kept.events) this.#events.set(id, events);
    this.#lastRefreshAt = kept.refreshedAt;
    this.#phase = kept.phase;
    this.#failed = kept.failed;
    if (kept.denied) this.#denied = { generation: kept.generation };
    this.#keptGeneration = kept.generation;
  }

  /** True once, when the kept read is from this socket and not yet due: the timer covers the rest of its 15 min. */
  #resumesKeptRead(source: CalendarSource): boolean {
    const kept = this.#keptGeneration;
    this.#keptGeneration = undefined;
    const lastRefreshAt = this.#lastRefreshAt;
    return (
      kept === source.reader.connectionGeneration() &&
      lastRefreshAt !== undefined &&
      this.#now() - lastRefreshAt < CALENDAR_REFRESH_MS
    );
  }

  #keepRead(generation: number): void {
    const reader = this.#reader;
    const phase = this.#phase;
    if (reader === undefined || this.#lastRefreshAt === undefined || phase === 'idle' || phase === 'loading') return;
    KEPT_CALENDARS.set(reader, {
      signature: this.#signature,
      generation,
      refreshedAt: this.#lastRefreshAt,
      events: new Map(this.#events),
      phase,
      failed: this.#failed,
      denied: this.#denied?.generation === generation,
    });
  }

  #refresh(source: CalendarSource): void {
    this.#pause();
    const abort = new AbortController();
    this.#abort = abort;
    const nowMs = this.#now();
    const generation = source.reader.connectionGeneration();
    const range = calendarWindow(nowMs, source.reader.formatter());
    if (this.#phase === 'idle') this.#phase = 'loading'; // later refreshes keep showing the current events
    const reads = source.calendars.map((id) => readCalendar(source.reader, id, range, abort.signal));
    Promise.all(reads)
      .then((results) => this.#guard(() => this.#apply(abort, nowMs, generation, results)))
      .catch(() => log.error('calendar-refresh-failed'));
  }

  #apply(abort: AbortController, refreshedAt: number, generation: number, results: readonly ReadResult[]): void {
    if (this.#abort !== abort) return; // superseded, paused or torn down: discard
    this.#abort = undefined;
    this.#lastRefreshAt = refreshedAt;
    let failed = 0;
    for (const { id, events } of results) {
      if (events === undefined) failed += 1;
      else this.#events.set(id, events);
    }
    this.#failed = failed;
    this.#phase = failed > 0 ? 'error' : 'ready';
    if (results.some((result) => result.denied === true)) {
      this.#denied = { generation };
      this.#live = false; // no timer; a reconnect or a user change starts the next read
    }
    this.#keepRead(generation);
    this.#ensureTimer();
    if (this.#publish()) this.#host.requestUpdate();
  }

  /** Aborts the read in flight and clears the timer. */
  #pause(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#phase === 'loading') this.#phase = 'idle';
  }

  /** Schedules the next refresh CALENDAR_REFRESH_MS after the last one, only while live and visible. */
  #ensureTimer(): void {
    if (this.#timer !== undefined || this.#abort !== undefined || !this.#live || !isDocumentVisible()) return;
    const nowMs = this.#now();
    const dueIn = Math.max(0, (this.#lastRefreshAt ?? nowMs) + CALENDAR_REFRESH_MS - nowMs);
    this.#timer = setTimeout(() => this.#guard(() => this.#onTimer()), dueIn);
  }

  #onTimer(): void {
    this.#timer = undefined;
    const source = this.#source();
    if (source === undefined || !this.#isActive(source) || !isDocumentVisible()) return;
    this.#refresh(source);
    if (this.#publish()) this.#host.requestUpdate();
  }

  /** Hidden: no timer runs. Visible again: refresh at once if one is overdue, else re-arm the timer. */
  #visibilityChanged(): void {
    if (!isDocumentVisible()) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      return;
    }
    const source = this.#source();
    if (source === undefined || !this.#live || this.#abort !== undefined || !this.#isActive(source)) return;
    const overdue = this.#lastRefreshAt === undefined || this.#now() - this.#lastRefreshAt >= CALENDAR_REFRESH_MS;
    if (overdue) this.#refresh(source);
    else this.#ensureTimer();
    if (this.#publish()) this.#host.requestUpdate();
  }

  /** The controller watches the connection phase itself, independent of its host section's meta kinds. */
  #watchStore(source: CalendarSource | undefined): void {
    const store =
      this.#attached && source !== undefined && source.calendars.length > 0 ? source.reader.store : undefined;
    if (this.#watch?.store === store) return;
    this.#unwatch();
    if (store === undefined) return;
    const unsubscribe = store.subscribe([], WATCHED_META, (change) =>
      this.#guard(() => {
        if (change.meta.has('user')) {
          // Another user may read the calendars, so neither this controller nor a later one stays denied.
          this.#denied = undefined;
          if (this.#reader !== undefined) KEPT_CALENDARS.delete(this.#reader);
        }
        if (this.#reconcile()) this.#host.requestUpdate();
      }),
    );
    this.#watch = { store, unsubscribe };
  }

  #unwatch(): void {
    this.#watch?.unsubscribe();
    this.#watch = undefined;
  }

  #publish(): boolean {
    const previous = this.#snapshot;
    const entries = this.#entries(previous.entries);
    const changed = previous.phase !== this.#phase || previous.failed !== this.#failed || previous.entries !== entries;
    if (changed) this.#snapshot = Object.freeze({ phase: this.#phase, entries, failed: this.#failed });
    this.#source()?.status.set('calendar', this.#statusLine());
    return changed;
  }

  /** The previous array when nothing changed, so an unchanged snapshot keeps its identity. */
  #entries(previous: readonly CalendarEntry[]): readonly CalendarEntry[] {
    const ids = this.#signature === '' ? [] : (this.#signature.split('\n') as EntityId[]);
    const next = ids.flatMap((calendar) => (this.#events.get(calendar) ?? []).map((event) => ({ calendar, event })));
    const same = next.length === previous.length && next.every((entry, index) => sameEntry(entry, previous[index]));
    return same ? previous : Object.freeze(next);
  }

  /** Short code-like text for diagnostics: never an entity ID or URL. */
  #statusLine(): string {
    const source = this.#source();
    if (source === undefined || source.calendars.length === 0) return 'not configured';
    if (!this.#attached) return 'idle';
    const phase = source.reader.connection().phase;
    if (phase !== 'connected') return `paused ${phase}`;
    if (this.#denied !== undefined) return 'denied';
    return this.#failed > 0 ? `error ${this.#failed} of ${source.calendars.length}` : this.#phase;
  }
}

/** One calendar's read; never rejects. A failure is logged by code only (never a message or URL). */
function readCalendar(
  reader: HostReader,
  id: EntityId,
  range: { readonly start: Date; readonly end: Date },
  signal: AbortSignal,
): Promise<ReadResult> {
  const onFailure = (error: unknown): ReadResult => {
    if (!signal.aborted) log.warn('calendar-read-error', isHostError(error) ? error.code : 'unknown');
    return { id, denied: !signal.aborted && isHostError(error) && error.code === 'permission-denied' };
  };
  try {
    return reader.fetchCalendarEvents(id, range, signal).then((events) => ({ id, events }), onFailure);
  } catch (error) {
    return Promise.resolve(onFailure(error));
  }
}

function sameEntry(a: CalendarEntry, b: CalendarEntry | undefined): boolean {
  return b !== undefined && a.calendar === b.calendar && a.event === b.event;
}
