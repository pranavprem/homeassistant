import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESYNC_GRACE_MS, resyncTrackerFor, type ResyncEvent, type StatesMap } from '../../src/ha/resync.ts';
import type { ConnectionLike } from '../../src/ha/types.ts';
import { testEntity } from '../helpers/fake-store.ts';

type Event = 'ready' | 'disconnected';

/** A hajs-like connection whose events and socket getter the test drives. */
function fakeConnection(options: { events?: boolean; connected?: boolean } = {}) {
  const listeners = new Map<Event, Set<() => void>>();
  let connected = options.connected ?? true;
  const addEventListener = vi.fn((type: Event, callback: () => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(callback);
    listeners.set(type, set);
  });
  const removeEventListener = vi.fn((type: Event, callback: () => void) => {
    listeners.get(type)?.delete(callback);
  });
  const conn: ConnectionLike = {
    get connected() {
      return connected;
    },
    subscribeMessage: () => Promise.reject(new Error('unused')),
    ...(options.events !== false && { addEventListener, removeEventListener }),
  };
  return {
    conn,
    addEventListener,
    removeEventListener,
    fire(type: Event) {
      connected = type === 'ready';
      for (const listener of listeners.get(type) ?? []) listener();
    },
    /** The socket getter alone (a hidden-tab suspend HA has not reported yet). */
    setGetter(value: boolean) {
      connected = value;
    },
  };
}

function states(label: string): StatesMap {
  return { 'light.demo_a': testEntity('light.demo_a', label) };
}

/** Records tracker events. */
function eventsOf(tracker: ReturnType<typeof resyncTrackerFor>): ResyncEvent[] {
  const events: ResyncEvent[] = [];
  tracker.subscribe((event) => events.push(event));
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ResyncTracker arming and holding (§4.4, §16.10, §16.15)', () => {
  it('a brand-new tracker on a live connection is not armed', () => {
    const { conn } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('on'), true);
    expect(tracker.armed()).toBe(false);
    expect(tracker.base()).toBeUndefined();
  });

  it('registers each connection listener once, however many hosts ask for the tracker', () => {
    const { conn, addEventListener } = fakeConnection();
    const first = resyncTrackerFor(conn);
    expect(resyncTrackerFor(conn)).toBe(first);
    expect(addEventListener.mock.calls.map(([type]) => type)).toEqual(['ready', 'disconnected']);
  });

  it('arms on ready with the last observed map as base, and holds through the connected push', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const before = states('off');
    tracker.observe(before, true);
    fire('disconnected');
    tracker.observe(before, false);
    fire('ready');
    expect(tracker.armed()).toBe(true);
    expect(tracker.base()).toBe(before);
    tracker.observe(before, true); // HA pushes connected: true with the SAME states reference
    expect(tracker.armed()).toBe(true);
    const snapshot = states('off');
    tracker.observe(snapshot, true);
    expect(tracker.armed()).toBe(false);
  });

  it('keeps holding for registry, config-only and identity-only updates (same states reference)', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const before = states('on');
    tracker.observe(before, true);
    fire('disconnected');
    tracker.observe(before, false);
    fire('ready');
    for (let update = 0; update < 5; update += 1) tracker.observe(before, true);
    vi.advanceTimersByTime(RESYNC_GRACE_MS * 10);
    expect(tracker.armed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never takes the first post-ready map as the base: with nothing observed since the disconnect it is ambiguous', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const preOutage = states('a');
    tracker.observe(preOutage, true);
    fire('disconnected');
    fire('ready'); // the card was detached across the outage
    const first = states('b'); // the snapshot, or a pre-snapshot map no host saw: no way to tell
    tracker.observe(first, true);
    expect(tracker.armed()).toBe(true);
    expect(tracker.base()).toBe(preOutage);
    tracker.observe(states('b'), true);
    expect(tracker.armed()).toBe(false);
    expect(tracker.base()).toBe(preOutage);
  });

  it('arms on an observed connected false → true transition when the connection has no event API', () => {
    const { conn } = fakeConnection({ events: false });
    const tracker = resyncTrackerFor(conn);
    const before = states('on');
    tracker.observe(before, true);
    tracker.observe(before, false);
    tracker.observe(before, true);
    expect(tracker.armed()).toBe(true);
    expect(tracker.base()).toBe(before);
    tracker.observe(states('on'), true);
    expect(tracker.armed()).toBe(false);
  });

  it('re-arms for a second outage that happens while still armed', () => {
    const { conn } = fakeConnection({ events: false });
    const tracker = resyncTrackerFor(conn);
    const before = states('on');
    tracker.observe(before, true);
    tracker.observe(before, false);
    tracker.observe(before, true);
    tracker.observe(before, false);
    tracker.observe(before, true);
    expect(tracker.armed()).toBe(true);
    expect(tracker.base()).toBe(before);
  });

  it('never clears while disconnected', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    tracker.observe(states('a'), false);
    fire('ready');
    fire('disconnected');
    tracker.observe(states('b'), false);
    expect(tracker.armed()).toBe(true);
  });

  it('records the base for a tracker created while the socket is down', () => {
    const { conn, fire } = fakeConnection({ connected: false });
    const tracker = resyncTrackerFor(conn);
    const stale = states('a');
    tracker.observe(stale, false);
    fire('ready');
    expect(tracker.base()).toBe(stale);
    tracker.observe(stale, true);
    expect(tracker.armed()).toBe(true);
  });

  it('keeps the freshness base after clearing, until the next arm', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const before = states('a');
    tracker.observe(before, true);
    fire('disconnected');
    tracker.observe(before, false);
    fire('ready');
    const snapshot = states('a');
    tracker.observe(snapshot, true);
    expect(tracker.armed()).toBe(false);
    expect(tracker.base()).toBe(before);
    fire('disconnected');
    tracker.observe(snapshot, false);
    fire('ready');
    expect(tracker.base()).toBe(snapshot);
  });
});

describe('ResyncTracker clearing (§16.15)', () => {
  it('the known pre-snapshot map observed after ready clears exactly at the next map, with no grace timer', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const preOutage = states('a');
    tracker.observe(preOutage, true);
    fire('disconnected'); // not observed while down: the host was detached
    fire('ready');
    tracker.observe(preOutage, true);
    vi.advanceTimersByTime(RESYNC_GRACE_MS * 5);
    expect(tracker.armed()).toBe(true);
    tracker.observe(states('a'), true);
    expect(tracker.armed()).toBe(false);
  });

  it('a map observed during the outage is final, so the first different map after ready clears at once', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const outage = states('a');
    tracker.observe(states('a'), true);
    fire('disconnected');
    tracker.observe(outage, false);
    fire('ready');
    tracker.observe(states('a'), true); // connected: true and the snapshot in one push
    expect(tracker.armed()).toBe(false);
  });

  it('an ambiguous first map clears when the grace elapses with no further map, and announces it', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    const events = eventsOf(tracker);
    tracker.observe(states('a'), true);
    vi.advanceTimersByTime(RESYNC_GRACE_MS - 1);
    expect(tracker.armed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.armed()).toBe(false);
    expect(events).toEqual(['cleared']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an ambiguous first map followed by another before the grace clears at the second and stops the grace', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    const events = eventsOf(tracker);
    const first = states('a');
    tracker.observe(first, true);
    tracker.observe(first, true); // an identity-only update keeps waiting
    expect(tracker.armed()).toBe(true);
    tracker.observe(states('a'), true);
    expect(tracker.armed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RESYNC_GRACE_MS);
    expect(events).toEqual(['cleared']);
  });

  it('a disconnect stops a running grace, and re-arming starts over', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    tracker.observe(states('b'), true);
    fire('disconnected');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RESYNC_GRACE_MS);
    expect(tracker.armed()).toBe(true);
    fire('ready');
    expect(vi.getTimerCount()).toBe(0);
    expect(tracker.armed()).toBe(true);
  });

  it('a re-arm stops the previous grace and starts over from the map last observed', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    const ambiguous = states('b');
    tracker.observe(ambiguous, true);
    expect(vi.getTimerCount()).toBe(1);
    fire('ready'); // a second 'ready' without a disconnect in between
    expect(vi.getTimerCount()).toBe(0);
    expect(tracker.base()).toBe(ambiguous);
    vi.advanceTimersByTime(RESYNC_GRACE_MS);
    expect(tracker.armed()).toBe(true);
  });

  it('the grace never clears while the live socket getter reads false', () => {
    vi.useFakeTimers();
    const { conn, fire, setGetter } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    tracker.observe(states('b'), true);
    setGetter(false);
    vi.advanceTimersByTime(RESYNC_GRACE_MS);
    expect(tracker.armed()).toBe(true);
  });

  it('a tracker that never observed anything has no freshness base and clears an ambiguous map on the grace', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    fire('disconnected');
    fire('ready');
    expect(tracker.base()).toBeUndefined();
    tracker.observe(states('a'), true);
    expect(tracker.armed()).toBe(true);
    vi.advanceTimersByTime(RESYNC_GRACE_MS);
    expect(tracker.armed()).toBe(false);
    expect(tracker.base()).toBeUndefined();
  });
});

describe('ResyncTracker connection identity and events', () => {
  it('a replacement connection starts armed with the previous last observed map as base, and disposes the previous', () => {
    vi.useFakeTimers();
    const old = fakeConnection();
    const oldTracker = resyncTrackerFor(old.conn);
    const seen = states('a');
    oldTracker.observe(seen, true);
    const next = fakeConnection();
    const tracker = resyncTrackerFor(next.conn, oldTracker);
    expect(tracker.armed()).toBe(true);
    expect(tracker.base()).toBe(seen);
    expect(tracker.lastObserved()).toBe(seen);
    expect(tracker.generation()).toBeGreaterThan(oldTracker.generation());
    expect(old.removeEventListener.mock.calls.map(([type]) => type)).toEqual(['ready', 'disconnected']);
    const first = states('a');
    tracker.observe(first, true);
    expect(tracker.armed()).toBe(true);
    tracker.observe(states('a'), true);
    expect(tracker.armed()).toBe(false);
  });

  it('a disposed tracker ignores events and observations and keeps no timer', () => {
    vi.useFakeTimers();
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    tracker.observe(states('b'), true);
    const generation = tracker.generation();
    tracker.dispose();
    expect(vi.getTimerCount()).toBe(0);
    fire('disconnected');
    tracker.observe(states('c'), true);
    expect(tracker.generation()).toBe(generation);
    expect(tracker.armed()).toBe(true);
  });

  it('moves the generation on ready, disconnected and an observed drop, never backwards', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const seen = [tracker.generation()];
    tracker.observe(states('a'), true);
    fire('disconnected');
    seen.push(tracker.generation());
    tracker.observe(states('a'), false);
    seen.push(tracker.generation());
    fire('ready');
    seen.push(tracker.generation());
    expect(seen.every((value, index) => index === 0 || value > (seen[index - 1] ?? 0))).toBe(true);
  });

  it('notifies subscribers of disconnected, armed, ready and cleared, and stops after unsubscribe', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    const events: string[] = [];
    const unsubscribe = tracker.subscribe((event) => events.push(event));
    tracker.observe(states('a'), true);
    fire('disconnected');
    fire('ready');
    tracker.observe(states('a'), true);
    tracker.observe(states('b'), true);
    expect(events).toEqual(['disconnected', 'armed', 'ready', 'cleared']);
    unsubscribe();
    fire('disconnected');
    expect(events).toHaveLength(4);
  });

  it('is already armed when it announces ready, so no listener ever sees a live socket with a clear barrier', () => {
    const { conn, fire } = fakeConnection();
    const tracker = resyncTrackerFor(conn);
    tracker.observe(states('a'), true);
    fire('disconnected');
    const armedAtEvent: [string, boolean][] = [];
    tracker.subscribe((event) => armedAtEvent.push([event, tracker.armed()]));
    fire('ready');
    expect(armedAtEvent).toEqual([
      ['armed', true],
      ['ready', true],
    ]);
  });
});
