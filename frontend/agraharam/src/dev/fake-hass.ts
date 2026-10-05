/**
 * FakeHass (§10.3): a full HassLike over the same assembled scenario and simulator as DemoHost, so `host=fake-hass`
 * exercises the REAL HassHost, resync barrier and gateway with no network. Not in the bundle.
 *
 * - Every method call is recorded in `calls` (the shell exposes it as window.__agrCalls), including the members real
 *   hass has but our types omit (callWS, connection.sendMessage, connection.sendMessagePromise), so indirect use is
 *   caught at runtime.
 * - Entity identity follows hajs: a live change replaces only the changed entity's object
 *   (`{ ...delivered, [id]: changed }`), so every unchanged entity keeps its reference. Per-entity freshness after a
 *   reconnect (§4.4) can only be tested against that.
 * - Reconnect follows HA's real order: the socket getter turns true, 'ready' fires synchronously, hass is pushed
 *   with `connected: true` and the SAME states reference, and only after `snapshotDelayMs` the snapshot arrives:
 *   a new states map in which every entity is a new object, outage changes applied, and entities deleted during the
 *   outage keeping their old objects (hajs never clears its store). Nothing else reaches hass.states between 'ready'
 *   and the snapshot, because hajs's new entity subscription starts with it.
 * - While the socket is down nothing reaches hass.states, and service calls queue and are sent on the next socket,
 *   exactly the hajs gap HassHost's live-socket guard closes.
 *
 * Import boundary (§10.3): only src/demo/{fixture-types,scenarios,simulate}.ts, src/config/* and type-only modules.
 */
import type { DemoScenarioId, EntityId } from '../config/schema.ts';
import { fixtureClock, type AssembledScenario } from '../demo/fixture-types.ts';
import { assembleScenario } from '../demo/scenarios.ts';
import { demoSnapshotSvg, ScenarioDevices, simulatedServiceRegistry, snapshotBehavior } from '../demo/simulate.ts';
import type { ConnectionLike, HassEntityLike, HassLike, LocaleLike, RegistryEntryLike } from '../ha/types.ts';
import { SIMULATED_CALL_LATENCY_MS } from '../timing.ts';

export interface FakeHassCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface FakeHassOptions {
  readonly now?: () => number;
  readonly latencyMs?: readonly [number, number];
  readonly random?: () => number;
  readonly darkMode?: boolean;
}

/** The extra members real hass has; recorded as spies so any indirect use shows up. */
export type FakeHassObject = HassLike & { callWS(message: Readonly<Record<string, unknown>>): Promise<unknown> };

type StatesMap = Readonly<Record<string, HassEntityLike>>;
type ConnectionEvent = 'ready' | 'disconnected';

const READ_LATENCY_MS = 100;
const CAMERA_PROXY_PREFIX = '/api/camera_proxy/';
const CALENDAR_PREFIX = 'calendars/';
const HTTP_STATUS = Object.freeze({ ok: 200, unauthorized: 401, forbidden: 403, notFound: 404, unavailable: 503 });
const LOCALE: LocaleLike = Object.freeze({
  language: 'en',
  number_format: 'language',
  time_format: 'language',
  time_zone: 'local',
});
const UNIT_SYSTEM = Object.freeze({ temperature: '°F', length: 'mi' });
const FORECAST_FAILED = Object.freeze({ code: 'home_assistant_error', message: 'Forecast request failed.' });
const FORECAST_NOT_SUPPORTED = Object.freeze({ code: 'forecast_not_supported', message: 'Not supported.' });

/** hajs-like connection: a live `connected` getter, ready/disconnected events and per-socket command ids. */
class FakeConnection implements ConnectionLike {
  readonly #calls: FakeHassCall[];
  readonly #listeners = new Map<ConnectionEvent, Set<() => void>>();
  readonly #forecasts: AssembledScenario['forecasts'];
  #open = true;
  #socket = 1;
  #commandId = 0;

  constructor(calls: FakeHassCall[], forecasts: AssembledScenario['forecasts']) {
    this.#calls = calls;
    this.#forecasts = forecasts;
  }

  get connected(): boolean {
    return this.#open;
  }

  /** Socket number, incremented on every reconnect. */
  get socket(): number {
    return this.#socket;
  }

  addEventListener(type: ConnectionEvent, callback: () => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: ConnectionEvent, callback: () => void): void {
    this.#listeners.get(type)?.delete(callback);
  }

  /** How many listeners are registered for an event (tests assert the tracker registers once). */
  listenerCount(type: ConnectionEvent): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  subscribeMessage<T>(
    callback: (message: T) => void,
    message: Readonly<Record<string, unknown>>,
    options?: { resubscribe?: boolean },
  ): Promise<() => Promise<void>> {
    this.#calls.push({ method: 'connection.subscribeMessage', args: [{ ...message }, options] });
    const id = this.#nextCommandId();
    const socket = this.#socket;
    if (message['type'] !== 'weather/subscribe_forecast') return Promise.reject(FORECAST_NOT_SUPPORTED);
    const forecast = this.#forecasts[message['forecast_type'] as keyof AssembledScenario['forecasts']];
    if (forecast === undefined) return Promise.reject(FORECAST_NOT_SUPPORTED);
    if (forecast === 'error') return Promise.reject(FORECAST_FAILED);
    setTimeout(() => {
      if (this.#open && socket === this.#socket) callback({ type: message['forecast_type'], forecast } as T);
    }, READ_LATENCY_MS);
    return Promise.resolve(() => {
      // An unsubscribe from an older socket would kill whatever HA resubscribed under the reused id (§9.2).
      this.#calls.push({
        method: 'unsubscribe_events',
        args: [{ subscription: id, socket, stale: socket !== this.#socket }],
      });
      return Promise.resolve();
    });
  }

  sendMessage(message: Readonly<Record<string, unknown>>): void {
    this.#calls.push({ method: 'connection.sendMessage', args: [message] });
  }

  sendMessagePromise(message: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.#calls.push({ method: 'connection.sendMessagePromise', args: [message] });
    return Promise.resolve(null);
  }

  /** Socket closed: the getter turns false and 'disconnected' fires. */
  drop(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#emit('disconnected');
  }

  /** New socket: command ids restart at 1, the getter turns true and 'ready' fires synchronously. */
  reopen(): void {
    if (this.#open) return;
    this.#open = true;
    this.#socket += 1;
    this.#commandId = 0;
    this.#emit('ready');
  }

  #nextCommandId(): number {
    this.#commandId += 1;
    return this.#commandId;
  }

  #emit(type: ConnectionEvent): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
  }
}

export class FakeHass {
  readonly calls: FakeHassCall[] = [];
  readonly scenario: AssembledScenario;
  readonly connection: FakeConnection;
  readonly #devices: ScenarioDevices;
  readonly #listeners = new Set<(hass: FakeHassObject) => void>();
  readonly #registry: Readonly<Record<string, RegistryEntryLike>>;
  readonly #services: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly #user: { readonly id: string; readonly is_admin: boolean };
  readonly #queuedCalls: (() => void)[] = [];
  readonly #deletedDuringOutage = new Set<string>();
  #delivered: StatesMap;
  /** The devices' states map as of the last change, to tell which entity a change replaced. */
  #deviceStates: StatesMap;
  /** Between 'ready' and the snapshot: changes wait for the snapshot, which reads the devices' current states. */
  #awaitingSnapshot = false;
  #connected = true;
  #darkMode: boolean;
  #hass: FakeHassObject;
  #snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(scenario: DemoScenarioId, options: FakeHassOptions = {}) {
    const now = options.now ?? Date.now;
    this.scenario = assembleScenario(scenario, fixtureClock(now()));
    this.connection = new FakeConnection(this.calls, this.scenario.forecasts);
    this.#darkMode = options.darkMode ?? false;
    this.#registry = Object.freeze(Object.fromEntries(this.scenario.registry.map((entry) => [entry.entity_id, entry])));
    this.#services = simulatedServiceRegistry(this.scenario.spec.missingServices);
    this.#user = Object.freeze({ id: 'demo-user', is_admin: this.scenario.spec.user.is_admin });
    this.#devices = new ScenarioDevices({
      states: this.scenario.states,
      behaviors: this.scenario.behaviors,
      ...(this.scenario.spec.defaultInvoke !== undefined && { defaultInvoke: this.scenario.spec.defaultInvoke }),
      latencyMs: options.latencyMs ?? SIMULATED_CALL_LATENCY_MS,
      random: options.random ?? Math.random,
      now,
      onChange: (states) => this.#onDeviceChange(states),
    });
    this.#delivered = this.#devices.states;
    this.#deviceStates = this.#devices.states;
    this.#hass = this.#build();
  }

  /** The current hass object; every push creates a new one, as HA does. */
  get hass(): FakeHassObject {
    return this.#hass;
  }

  /** Receives every new hass object (what HA assigns to card.hass). */
  onPush(listener: (hass: FakeHassObject) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 'offline' starts connected and drops right after the first push (§10.2). */
  applyScenarioConnection(): void {
    if (this.scenario.spec.connection === 'drop-after-first-ingest') this.disconnect();
  }

  setDarkMode(darkMode: boolean): void {
    this.#darkMode = darkMode;
    this.#push();
  }

  /** A live state change (new entity object, new states map), delivered at once while connected. */
  setState(id: string, state: string, attributes: Readonly<Record<string, unknown>> = {}): void {
    const current = this.#devices.states[id];
    if (current === undefined) return;
    this.#devices.put(withState(current, state, attributes));
  }

  /** A new hass identity with nothing changed, like HA's empty `_updateHass({})` after a token refresh. */
  pushIdentityOnly(): void {
    this.#push();
  }

  /** Socket closed: getter false, 'disconnected', then hass with `connected: false` and the same states. */
  disconnect(): void {
    clearTimeout(this.#snapshotTimer);
    this.#awaitingSnapshot = false;
    this.connection.drop();
    this.#connected = false;
    this.#push();
  }

  /** HA's two-step reconnect (§10.3). `snapshotDelayMs` 0 still waits one macrotask. */
  reconnect(options: { readonly snapshotDelayMs: number }): void {
    this.connection.reopen();
    this.#connected = true;
    this.#awaitingSnapshot = true;
    this.#push();
    for (const send of this.#queuedCalls.splice(0)) send();
    this.#snapshotTimer = setTimeout(() => this.#deliverSnapshot(), options.snapshotDelayMs);
  }

  /** A change made while disconnected, delivered only in the reconnect snapshot. */
  queueOutageChange(id: string, state: string, attributes: Readonly<Record<string, unknown>> = {}): void {
    this.setState(id, state, attributes);
  }

  /** An entity deleted during the outage: the snapshot keeps its old object, so it is never fresh. */
  deleteDuringOutage(id: string): void {
    this.#deletedDuringOutage.add(id);
  }

  dispose(): void {
    clearTimeout(this.#snapshotTimer);
    this.#devices.dispose();
    this.#listeners.clear();
  }

  #onDeviceChange(states: StatesMap): void {
    const previous = this.#deviceStates;
    this.#deviceStates = states;
    // Nothing reaches hass.states while the socket is down or before the reconnect snapshot.
    if (!this.connection.connected || this.#awaitingSnapshot) return;
    this.#delivered = withReplacedEntities(this.#delivered, previous, states);
    this.#push();
  }

  #deliverSnapshot(): void {
    if (!this.connection.connected) return;
    this.#awaitingSnapshot = false;
    const fresh: Record<string, HassEntityLike> = {};
    for (const [id, entity] of Object.entries(this.#devices.states)) {
      const old = this.#delivered[id];
      fresh[id] = this.#deletedDuringOutage.has(id) && old !== undefined ? old : Object.freeze({ ...entity });
    }
    this.#deletedDuringOutage.clear();
    this.#delivered = Object.freeze(fresh);
    this.#push();
  }

  #push(): void {
    this.#hass = this.#build();
    for (const listener of [...this.#listeners]) listener(this.#hass);
  }

  #build(): FakeHassObject {
    const spec = this.scenario.spec;
    return Object.freeze({
      states: this.#delivered,
      entities: this.#registry,
      services: this.#services,
      connected: this.#connected,
      connection: this.connection,
      locale: LOCALE,
      config: Object.freeze({
        unit_system: UNIT_SYSTEM,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        state: spec.haState,
        version: spec.haVersion,
      }),
      themes: Object.freeze({ darkMode: this.#darkMode }),
      user: this.#user,
      callService: (
        domain: string,
        service: string,
        data?: Record<string, unknown>,
        target?: { entity_id: string | string[] },
        notifyOnError?: boolean,
        returnResponse?: boolean,
      ) => this.#callService(domain, service, data, target, notifyOnError, returnResponse),
      callApi: <T>(method: 'GET', path: string) => this.#callApi(method, path) as Promise<T>,
      fetchWithAuth: (path: string, init?: RequestInit) => this.#fetchWithAuth(path, init),
      callWS: (message: Readonly<Record<string, unknown>>) => {
        this.calls.push({ method: 'callWS', args: [message] });
        return Promise.resolve(null);
      },
    });
  }

  #callService(
    domain: string,
    service: string,
    data: Record<string, unknown> | undefined,
    target: { entity_id: string | string[] } | undefined,
    notifyOnError: boolean | undefined,
    returnResponse: boolean | undefined,
  ): Promise<{ context: { id: string } }> {
    this.calls.push({
      method: 'callService',
      args: [domain, service, { ...data }, target, notifyOnError, returnResponse],
    });
    const call = {
      domain: domain as Parameters<ScenarioDevices['invoke']>[0]['domain'],
      service,
      data: { ...data },
      target: { entity_id: (target?.entity_id ?? []) as EntityId | readonly EntityId[] },
    };
    const send = (): Promise<{ context: { id: string } }> =>
      this.#devices.invoke(call).then((result) => ({ context: { id: result.contextId } }));
    if (this.connection.connected) return send();
    // hajs queues messages while the socket is down and sends them on the next socket.
    return new Promise((resolve, reject) => {
      this.#queuedCalls.push(() => {
        send().then(resolve, reject);
      });
    });
  }

  #callApi(method: 'GET', path: string): Promise<unknown> {
    this.calls.push({ method: 'callApi', args: [method, path] });
    if (!path.startsWith(CALENDAR_PREFIX)) return Promise.reject({ code: 'not_found', message: 'Not found.' });
    const url = new URL(path, 'http://fake-hass.invalid/');
    const id = decodeURIComponent(url.pathname.slice(`/${CALENDAR_PREFIX}`.length));
    const start = Date.parse(url.searchParams.get('start') ?? '');
    const end = Date.parse(url.searchParams.get('end') ?? '');
    const events = (this.scenario.calendarEvents[id] ?? [])
      .filter((event) => Date.parse(event.end) > start && Date.parse(event.start) < end)
      .map((event) => ({
        uid: event.key,
        summary: event.summary,
        start: event.allDay ? { date: event.start.slice(0, 10) } : { dateTime: event.start },
        end: event.allDay ? { date: event.end.slice(0, 10) } : { dateTime: event.end },
      }));
    return delay(READ_LATENCY_MS).then(() => events);
  }

  #fetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ method: 'fetchWithAuth', args: [path, { cache: init?.cache }] });
    const signal = init?.signal ?? undefined;
    return delay(READ_LATENCY_MS).then(() => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return this.#cameraResponse(path);
    });
  }

  #cameraResponse(path: string): Response {
    if (!path.startsWith(CAMERA_PROXY_PREFIX)) return new Response(null, { status: HTTP_STATUS.notFound });
    const id = decodeURIComponent(path.slice(CAMERA_PROXY_PREFIX.length).split('?')[0] ?? '') as EntityId;
    if (this.#delivered[id] === undefined) return new Response(null, { status: HTTP_STATUS.notFound });
    const behavior = snapshotBehavior(this.scenario.behaviors, id, this.scenario.spec.defaultSnapshot);
    if (behavior === 'unauthorized') return new Response(null, { status: HTTP_STATUS.unauthorized });
    if (behavior === 'forbidden') return new Response(null, { status: HTTP_STATUS.forbidden });
    if (behavior === 'unavailable') return new Response(null, { status: HTTP_STATUS.unavailable });
    const image = new Blob([demoSnapshotSvg(id)], { type: 'image/svg+xml' });
    return new Response(image, { status: HTTP_STATUS.ok, headers: { 'content-type': 'image/svg+xml' } });
  }
}

function withState(
  entity: HassEntityLike,
  state: string,
  attributes: Readonly<Record<string, unknown>>,
): HassEntityLike {
  const at = new Date().toISOString();
  return Object.freeze({
    ...entity,
    state,
    attributes: Object.freeze({ ...entity.attributes, ...attributes }),
    last_changed: state === entity.state ? entity.last_changed : at,
    last_updated: at,
  });
}

/**
 * hajs's update rule: a new states map in which only the entities whose device object changed get the new object;
 * every other entity keeps the object already delivered (which, after a snapshot, is the snapshot's object).
 */
function withReplacedEntities(delivered: StatesMap, previous: StatesMap, next: StatesMap): StatesMap {
  const updated: Record<string, HassEntityLike> = { ...delivered };
  for (const [id, entity] of Object.entries(next)) {
    if (previous[id] !== entity) updated[id] = entity;
  }
  return Object.freeze(updated);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
