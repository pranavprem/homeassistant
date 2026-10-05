/**
 * Post-reconnect snapshot barrier (§4.4, refined by §16.10 "Resync base" and by §16.15, the review fix for
 * freshness after a reconnect no host observed).
 *
 * Module scope: one tracker per hass.connection object (WeakMap), shared by every HassHost in the page, so a
 * runtime rebuilt during an outage (§9.1 orphan disposal) still knows a snapshot is outstanding. It is the ONLY
 * code that calls connection.addEventListener, once per connection object; its listeners retain only the
 * tracker's own small state (generation, flags, states references), never a HassHost, store or card.
 *
 * Why it exists: on a reconnect hajs fires 'ready' and the frontend pushes `connected: true` at once, but the fresh
 * state snapshot arrives a round trip later and the hajs store is never cleared. Until then hass.states still
 * holds pre-outage objects, so a privacy switch turned on during the outage would read as off.
 *
 * Two references, two jobs. When the barrier arms it takes the last states map any host observed on this
 * connection, which is always a pre-snapshot map:
 * - `freshBase` (exposed as base()) is used ONLY for per-entity freshness: an entity whose object is still the one
 *   in freshBase was never replaced by the snapshot (for example it was deleted during the outage).
 * - `knownStale` (the same map) decides when the barrier clears. Observing it again holds the barrier. The first
 *   different map clears at once when knownStale is known to be the final pre-snapshot map: it was observed after
 *   the socket dropped (nothing can change hass.states until the snapshot), or hass.states was still it after
 *   arming. Otherwise the first different map is ambiguous (the snapshot, or a pre-snapshot change no host saw),
 *   and the barrier clears on the next map after it or when RESYNC_GRACE_MS have passed, whichever comes first.
 *
 * The first post-ready map never becomes a freshness base: it may already be the snapshot, and because hajs keeps
 * the object of every unchanged entity, a snapshot base would leave every unchanged entity "not fresh" forever.
 */
import { log } from '../util/log.ts';
import type { Unsubscribe } from './host.ts';
import type { ConnectionLike, HassEntityLike } from './types.ts';

export type StatesMap = Readonly<Record<string, HassEntityLike>>;
export type ResyncEvent = 'ready' | 'disconnected' | 'armed' | 'cleared';
export interface ResyncTracker {
  generation(): number; // the socket generation exposed by HostReader.connectionGeneration()
  armed(): boolean; // a reconnect was signalled and no fresh snapshot has been observed yet
  /** The pre-snapshot states map the barrier last armed with, for per-entity freshness only; kept until the next
   *  arm (one superseded states map stays in memory, an accepted cost). undefined if it never armed, or if nothing
   *  had been observed on this connection before it armed. */
  base(): StatesMap | undefined;
  /** The most recent states map any host observed on this connection (seeds a replacement connection's tracker). */
  lastObserved(): StatesMap | undefined;
  /** HassHost.update calls this BEFORE ingest, with the same states reference it ingests (never a copy). */
  observe(states: StatesMap, connected: boolean): void;
  subscribe(listener: (e: ResyncEvent) => void): Unsubscribe;
  /** Stops the grace timer and removes the connection listeners; called when a new connection object replaces this
   *  one. A disposed tracker ignores every later event and observation. */
  dispose(): void;
}

/**
 * How long an ambiguous first post-reconnect map holds the barrier when no further map arrives (§16.15). The
 * snapshot normally lands within hundreds of milliseconds over the tunnel; a quiet house may send nothing after
 * it, so without a bound the dashboard could stay "Reconnecting" indefinitely.
 */
export const RESYNC_GRACE_MS = 2_000;

const trackers = new WeakMap<ConnectionLike, ResyncTracker>();

/**
 * Generations come from one page-wide counter, so a tracker for a new connection object can never reuse a value
 * an older tracker already handed out: a subscription made under the old socket can never look current again.
 */
let lastGeneration = 0;
function nextGeneration(): number {
  lastGeneration += 1;
  return lastGeneration;
}

/**
 * The tracker for `conn`, created on first use. `previous` is the tracker of the connection object this one
 * replaces: a new connection identity means a reconnect may be in flight, so the new tracker starts armed with the
 * previous tracker's last observed map as its base, and the previous tracker is disposed.
 */
export function resyncTrackerFor(conn: ConnectionLike, previous?: ResyncTracker): ResyncTracker {
  const existing = trackers.get(conn);
  if (existing !== undefined) return existing;
  const tracker = createTracker(conn, previous === undefined ? undefined : { seed: previous.lastObserved() });
  previous?.dispose();
  trackers.set(conn, tracker);
  return tracker;
}

/**
 * Clearing progress while armed. `idle`: nothing observed since arming, and knownStale may not be the final
 * pre-snapshot map. `held`: knownStale is the final pre-snapshot map (observed during the outage, or observed again
 * after arming), so the next different map is the snapshot. `ambiguous`: the first map observed was a different
 * one; it clears on the next map after it or when the grace ends.
 */
type Clearing =
  { readonly kind: 'idle' } | { readonly kind: 'held' } | { readonly kind: 'ambiguous'; readonly first: StatesMap };

const IDLE: Clearing = Object.freeze({ kind: 'idle' });
const HELD: Clearing = Object.freeze({ kind: 'held' });

interface TrackerState {
  generation: number;
  armed: boolean;
  /** The most recent states map any host observed on this connection. */
  lastObserved: StatesMap | undefined;
  /** A disconnect was seen (event or observed drop) and the barrier has not armed since. */
  outageOpen: boolean;
  /** lastObserved was observed while the outage was open, so it is the final map before the snapshot. */
  lastObservedInOutage: boolean;
  freshBase: StatesMap | undefined;
  knownStale: StatesMap | undefined;
  clearing: Clearing;
  grace: ReturnType<typeof setTimeout> | undefined;
  lastConnected: boolean | undefined;
  disposed: boolean;
}

function createTracker(
  conn: ConnectionLike,
  replaces: { readonly seed: StatesMap | undefined } | undefined,
): ResyncTracker {
  const seed = replaces?.seed;
  const state: TrackerState = {
    generation: nextGeneration(),
    armed: replaces !== undefined,
    lastObserved: seed,
    // Created while the socket is down: every observation until the reconnect is a final pre-snapshot map.
    outageOpen: replaces === undefined && !conn.connected,
    lastObservedInOutage: false,
    freshBase: seed,
    knownStale: seed,
    clearing: IDLE,
    grace: undefined,
    lastConnected: undefined,
    disposed: false,
  };
  const listeners = new Set<(e: ResyncEvent) => void>();

  function emit(event: ResyncEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        log.error('resync-listener-failed');
      }
    }
  }

  function stopGrace(): void {
    clearTimeout(state.grace);
    state.grace = undefined;
  }

  /** Both references are the last observed map, which predates the snapshot (it is requested at 'ready'). */
  function arm(): void {
    stopGrace();
    state.generation = nextGeneration();
    state.armed = true;
    state.freshBase = state.lastObserved;
    state.knownStale = state.lastObserved;
    state.clearing = state.outageOpen && state.lastObservedInOutage ? HELD : IDLE;
    state.outageOpen = false;
    emit('armed');
  }

  function markDisconnected(): void {
    stopGrace();
    state.generation = nextGeneration();
    state.outageOpen = true;
    // A map observed before this drop may not be the final one: a change can still have arrived unobserved.
    state.lastObservedInOutage = false;
    state.clearing = IDLE;
  }

  function clear(): void {
    stopGrace();
    state.armed = false;
    state.clearing = IDLE;
    emit('cleared');
  }

  /** The grace clears an ambiguous barrier only on a live socket; hosts re-ingest on 'cleared'. */
  function onGraceElapsed(): void {
    state.grace = undefined;
    if (state.disposed || !state.armed || state.clearing.kind !== 'ambiguous') return;
    if (state.lastConnected !== true || conn.connected !== true) return;
    clear();
  }

  /** Runs for an observation made while armed and connected (§16.15 clearing rules). */
  function evaluateClearing(states: StatesMap): void {
    if (states === state.knownStale) {
      // Definitely pre-snapshot, and hass.states still being it now means no unobserved change came after it.
      if (state.clearing.kind === 'idle') state.clearing = HELD;
      return;
    }
    const clearing = state.clearing;
    if (clearing.kind === 'held') {
      clear();
    } else if (clearing.kind === 'idle') {
      state.clearing = { kind: 'ambiguous', first: states };
      state.grace = setTimeout(onGraceElapsed, RESYNC_GRACE_MS);
    } else if (states !== clearing.first) {
      clear();
    }
  }

  /**
   * Arm BEFORE announcing 'ready'. HassHost re-ingests its last hass on every tracker event, and a hass retained
   * across the outage can still say `connected: true` (a detached panel never receives the `connected: false`
   * push). Announcing first would publish phase 'connected' with the barrier clear for one synchronous turn, and
   * store subscribers would start forecast, calendar and camera reads on pre-outage states.
   */
  function onReady(): void {
    if (state.disposed) return;
    arm();
    emit('ready');
  }

  function onDisconnected(): void {
    if (state.disposed) return;
    markDisconnected();
    emit('disconnected');
  }

  // Local listener registration only: hajs sends nothing for it. Feature-detected (§15 #23).
  conn.addEventListener?.('ready', onReady);
  conn.addEventListener?.('disconnected', onDisconnected);

  return {
    generation: () => state.generation,
    armed: () => state.armed,
    base: () => state.freshBase,
    lastObserved: () => state.lastObserved,
    observe(states, connected) {
      if (state.disposed) return;
      const wasConnected = state.lastConnected;
      state.lastConnected = connected;
      if (wasConnected === true && !connected) markDisconnected();
      // Without hajs events (or for a second outage while armed) the observed transition is the reconnect signal.
      // It arms with the map observed BEFORE this update; this update is then evaluated like any other.
      if (wasConnected === false && connected && (!state.armed || state.outageOpen)) arm();
      state.lastObserved = states;
      state.lastObservedInOutage = state.outageOpen;
      if (state.armed && connected) evaluateClearing(states);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stopGrace();
      conn.removeEventListener?.('ready', onReady);
      conn.removeEventListener?.('disconnected', onDisconnected);
      listeners.clear();
    },
  };
}
