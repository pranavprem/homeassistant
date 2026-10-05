/**
 * Weather forecast lifecycle (§9.2). One subscription per needed forecast type, started only while the element is
 * connected, the phase is `connected` (never while resyncing: a restart waits for the post-reconnect snapshot) and
 * the weather entity is present, not unavailable and advertises the type. Any of those turning false stops the
 * subscription (one unsubscribe, through the seam's generation rule) and marks the type idle; it restarts as a new
 * subscription when they turn true again. There are no timers and no automatic retries, except ONE new attempt
 * after `invalid_entity_id` when HA becomes RUNNING and one per registry change (an entity that is still loading).
 *
 * A layout change re-creates the Today section (§5.1), and with it this controller. So the strip does not flash its
 * loading skeleton on every rotation or sidebar toggle, the last live forecast of each type is kept per runtime
 * reader and socket generation: a new subscription on the same reader and socket starts from it instead of from
 * "subscribing", and HA's first payload replaces it moments later. Nothing is kept across a reconnect or runtime.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { EntityId } from '../config/schema.ts';
import { log } from '../util/log.ts';
import type { StoreView } from './entity-store.ts';
import { hasFeatures, WEATHER_FEATURE } from './features.ts';
import type {
  ForecastItem,
  ForecastPayload,
  ForecastType,
  HostChange,
  HostError,
  HostReader,
  Unsubscribe,
} from './host.ts';
import { normalizeEntity } from './normalize.ts';
import type { StatusBoard } from './status-board.ts';
import type { ConfigLike } from './types.ts';

export type ForecastTypeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'subscribing' }
  | { readonly kind: 'live'; readonly items: readonly ForecastItem[] }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly reason: 'entity' | 'other'; readonly haCode?: string };

/** Per forecast type; a type that is absent is idle. */
export type ForecastSnapshot = Readonly<Partial<Record<ForecastType, ForecastTypeState>>>;

/** What the forecast needs from DashboardServices (kept narrow: src/ha never imports components). */
export interface ForecastSource {
  readonly reader: HostReader;
  readonly status: StatusBoard;
  readonly weather?: EntityId;
}

/** Which types to subscribe to: hourly if advertised; daily if advertised, else twice_daily (§9.2). */
export interface ForecastPlan {
  readonly hourly: boolean;
  readonly daily?: 'daily' | 'twice_daily';
}

export function forecastPlan(supportedFeatures: unknown): ForecastPlan {
  const hourly = hasFeatures(supportedFeatures, [WEATHER_FEATURE.FORECAST_HOURLY]);
  if (hasFeatures(supportedFeatures, [WEATHER_FEATURE.FORECAST_DAILY])) return { hourly, daily: 'daily' };
  if (hasFeatures(supportedFeatures, [WEATHER_FEATURE.FORECAST_TWICE_DAILY])) return { hourly, daily: 'twice_daily' };
  return { hourly };
}

function plannedTypes(plan: ForecastPlan): ForecastType[] {
  return [...(plan.hourly ? (['hourly'] as const) : []), ...(plan.daily !== undefined ? [plan.daily] : [])];
}

/** HA's error code for a weather entity it doesn't know (yet): likely still loading while HA starts. */
const INVALID_ENTITY_ID = 'invalid_entity_id';
const SUBSCRIBING: ForecastTypeState = Object.freeze({ kind: 'subscribing' });
const UNSUPPORTED: ForecastTypeState = Object.freeze({ kind: 'unsupported' });
const EMPTY_SNAPSHOT: ForecastSnapshot = Object.freeze({});
const WATCHED_META = Object.freeze(['connection', 'registry'] as const);

interface KeptForecast {
  readonly generation: number;
  readonly state: Extract<ForecastTypeState, { kind: 'live' }>;
}

/** The last live forecast per runtime reader, keyed `${weather}|${type}`; collected with the reader. */
const KEPT_FORECASTS = new WeakMap<HostReader, Map<string, KeptForecast>>();

function keptKey(weather: EntityId, type: ForecastType): string {
  return `${weather}|${type}`;
}

/** The kept live forecast for this reader, weather and type, only while its socket is still the current one. */
function keptForecast(reader: HostReader, weather: EntityId, type: ForecastType): ForecastTypeState | undefined {
  const kept = KEPT_FORECASTS.get(reader)?.get(keptKey(weather, type));
  return kept !== undefined && kept.generation === reader.connectionGeneration() ? kept.state : undefined;
}

function keepForecast(reader: HostReader, weather: EntityId, type: ForecastType, state: ForecastTypeState): void {
  if (state.kind !== 'live') return;
  let kept = KEPT_FORECASTS.get(reader);
  if (kept === undefined) {
    kept = new Map();
    KEPT_FORECASTS.set(reader, kept);
  }
  kept.set(keptKey(weather, type), { generation: reader.connectionGeneration(), state });
}

interface Slot {
  readonly reader: HostReader;
  readonly weather: EntityId;
  /** The controller's own request counter, distinct from the socket generation: events after a stop are ignored. */
  readonly request: number;
  unsubscribe: Unsubscribe | undefined;
  state: ForecastTypeState;
}

interface StoreWatch {
  readonly store: StoreView;
  readonly weather: EntityId | undefined;
  readonly unsubscribe: Unsubscribe;
}

export class ForecastController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #source: () => ForecastSource | undefined;
  readonly #slots = new Map<ForecastType, Slot>();
  #snapshot: ForecastSnapshot = EMPTY_SNAPSHOT;
  #attached = false;
  #watch: StoreWatch | undefined;
  #requests = 0;
  #lastHaState: ConfigLike['state'];
  #registryChanged = false;
  /**
   * A retry signal (HA became RUNNING, or a registry change) waits here until an error('entity') slot uses it, so an
   * invalid_entity_id that arrives AFTER HA became RUNNING (the subscribe was still in flight) still gets its one new
   * attempt instead of the signal having been spent on a slot that had not failed yet.
   */
  #retryPending = false;

  constructor(host: ReactiveControllerHost, source: () => ForecastSource | undefined) {
    this.#host = host;
    this.#source = source;
    host.addController(this);
  }

  /** The current per-type states, for the Today selector. A new object only when something changed. */
  snapshot(): ForecastSnapshot {
    return this.#snapshot;
  }

  /** A re-attached element does not re-render by itself, so a changed snapshot asks for one. */
  hostConnected(): void {
    this.#guard(() => {
      this.#attached = true;
      if (this.#reconcile()) this.#host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.#guard(() => {
      this.#attached = false;
      this.#unwatch();
      for (const type of [...this.#slots.keys()]) this.#stop(type);
      this.#publish();
    });
  }

  /** Runs before every render, so a new runtime (store, reader) or weather binding is picked up at once. */
  hostUpdate(): void {
    if (this.#attached) this.#guard(() => this.#reconcile());
  }

  /** Controller callbacks never throw (§4.9 rule 2). */
  #guard(run: () => void): void {
    try {
      run();
    } catch {
      log.error('forecast-controller-failed');
    }
  }

  /** Returns true when the snapshot changed. */
  #reconcile(): boolean {
    const source = this.#source();
    this.#watchStore(source);
    const desired = this.#desiredTypes(source);
    this.#latchRetrySignal(source);
    let retried = false;
    for (const [type, slot] of [...this.#slots]) {
      const current = desired.has(type) && slot.reader === source?.reader && slot.weather === source.weather;
      const retryEntity =
        this.#retryPending && current && slot.state.kind === 'error' && slot.state.reason === 'entity';
      retried ||= retryEntity;
      if (!current || retryEntity) this.#stop(type);
    }
    // One signal is one new attempt (for every type that failed on the entity), never a standing retry.
    if (retried) this.#retryPending = false;
    if (source?.weather !== undefined) {
      for (const type of desired) if (!this.#slots.has(type)) this.#start(type, source.reader, source.weather);
    }
    return this.#publish();
  }

  /** The types whose start conditions hold right now (§9.2). */
  #desiredTypes(source: ForecastSource | undefined): ReadonlySet<ForecastType> {
    if (!this.#attached || source?.weather === undefined) return new Set();
    if (source.reader.connection().phase !== 'connected') return new Set();
    const weather = normalizeEntity(source.reader.store, source.weather);
    if (weather.status !== 'available' && weather.status !== 'unknown') return new Set();
    return new Set(plannedTypes(forecastPlan(weather.entity?.attributes['supported_features'])));
  }

  /** Latches a retry once per HA-became-RUNNING transition and once per registry change; a slot consumes it. */
  #latchRetrySignal(source: ForecastSource | undefined): void {
    const haState = source?.reader.store.haState();
    const becameRunning = this.#lastHaState !== undefined && this.#lastHaState !== 'RUNNING' && haState === 'RUNNING';
    this.#lastHaState = haState;
    if (becameRunning || this.#registryChanged) this.#retryPending = true;
    this.#registryChanged = false;
  }

  #start(type: ForecastType, reader: HostReader, weather: EntityId): void {
    this.#requests += 1;
    const request = this.#requests;
    const state = keptForecast(reader, weather, type) ?? SUBSCRIBING;
    const slot: Slot = { reader, weather, request, unsubscribe: undefined, state };
    this.#slots.set(type, slot);
    slot.unsubscribe = reader.subscribeForecast(weather, type, {
      next: (payload) => this.#onPayload(type, request, payload),
      error: (error) => this.#onError(type, request, error),
    });
  }

  #stop(type: ForecastType): void {
    const slot = this.#slots.get(type);
    if (slot === undefined) return;
    this.#slots.delete(type);
    const unsubscribe = slot.unsubscribe;
    slot.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch {
      log.error('forecast-stop-failed');
    }
  }

  #onPayload(type: ForecastType, request: number, payload: ForecastPayload): void {
    this.#settle(type, request, { kind: 'live', items: payload.forecast ?? [] });
  }

  #onError(type: ForecastType, request: number, error: HostError): void {
    if (error.haCode === INVALID_ENTITY_ID) {
      this.#settle(type, request, { kind: 'error', reason: 'entity', haCode: INVALID_ENTITY_ID });
    } else if (error.code === 'unsupported') {
      this.#settle(type, request, UNSUPPORTED);
    } else {
      this.#settle(type, request, { kind: 'error', reason: 'other', haCode: error.haCode ?? error.code });
    }
  }

  /** Late results (after a stop or a restart) belong to a request that is no longer current and are ignored. */
  #settle(type: ForecastType, request: number, state: ForecastTypeState): void {
    this.#guard(() => {
      const slot = this.#slots.get(type);
      if (slot === undefined || slot.request !== request) return;
      slot.state = state;
      keepForecast(slot.reader, slot.weather, type, state);
      if (this.#publish()) this.#host.requestUpdate();
    });
  }

  /** The controller watches the weather entity, the connection phase and the registry itself, so it never depends
   *  on which meta kinds its host section happens to subscribe to. */
  #watchStore(source: ForecastSource | undefined): void {
    const store = this.#attached ? source?.reader.store : undefined;
    const weather = source?.weather;
    if (this.#watch?.store === store && this.#watch?.weather === weather) return;
    this.#unwatch();
    if (store === undefined) return;
    const ids = weather === undefined ? [] : [weather];
    const unsubscribe = store.subscribe(ids, WATCHED_META, (change) => this.#onStoreChange(change));
    this.#watch = { store, weather, unsubscribe };
  }

  #unwatch(): void {
    this.#watch?.unsubscribe();
    this.#watch = undefined;
  }

  #onStoreChange(change: HostChange): void {
    this.#guard(() => {
      if (change.meta.has('registry')) this.#registryChanged = true;
      if (this.#reconcile()) this.#host.requestUpdate();
    });
  }

  /** Rebuilds the snapshot only when a type's state object changed, and writes the diagnostics line (§5.1). */
  #publish(): boolean {
    const next: Partial<Record<ForecastType, ForecastTypeState>> = {};
    for (const [type, slot] of this.#slots) next[type] = slot.state;
    const changed = !sameSnapshot(this.#snapshot, next);
    if (changed) this.#snapshot = Object.freeze(next);
    this.#source()?.status.set('forecast', this.#statusLine());
    return changed;
  }

  /** Short code-like text for diagnostics: never an entity ID or URL. */
  #statusLine(): string {
    const source = this.#source();
    if (source?.weather === undefined) return 'not configured';
    if (!this.#attached) return 'idle';
    const phase = source.reader.connection().phase;
    if (phase !== 'connected') return `paused ${phase}`;
    const weather = normalizeEntity(source.reader.store, source.weather);
    if (weather.status !== 'available' && weather.status !== 'unknown') return `weather ${weather.status}`;
    if (this.#slots.size === 0) return 'no forecast types';
    return [...this.#slots].map(([type, slot]) => `${type} ${stateCode(slot.state)}`).join(', ');
  }
}

function stateCode(state: ForecastTypeState): string {
  switch (state.kind) {
    case 'error':
      return `error ${state.haCode ?? state.reason}`;
    case 'live':
      return 'live';
    default:
      return state.kind;
  }
}

function sameSnapshot(previous: ForecastSnapshot, next: ForecastSnapshot): boolean {
  const previousTypes = Object.keys(previous) as ForecastType[];
  const nextTypes = Object.keys(next) as ForecastType[];
  return previousTypes.length === nextTypes.length && nextTypes.every((type) => previous[type] === next[type]);
}
