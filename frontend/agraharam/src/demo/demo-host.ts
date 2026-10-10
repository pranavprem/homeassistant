/**
 * DemoHost (§4.4, §10.1): a HostRuntime over the assembled fictional scenario. It makes no fetch, WebSocket or
 * XMLHttpRequest calls: states live in memory, actions mutate them through the shared simulator after a simulated
 * latency, and camera stills are generated SVG blobs. The real hass is never touched in demo mode.
 */
import type { DemoScenarioId, EntityId } from '../config/schema.ts';
import { validateConfig } from '../config/validate.ts';
import { deriveVacuumBatteries, indexEntitiesByDevice, type DeriveSources } from '../ha/derive.ts';
import { connectionToken, EntityStore, storeView, type StoreView } from '../ha/entity-store.ts';
import { createFormatter } from '../ha/format.ts';
import {
  runtimeKey,
  type CalendarEventLike,
  type CameraSnapshotRequest,
  type ConnectionInfo,
  type ForecastHandlers,
  type ForecastType,
  type Formatter,
  type HostError,
  type HostReader,
  type HostRuntime,
  type LiveStreamHandle,
  type PortNotSent,
  type ServiceCall,
  type ServiceCallResult,
  type ServicePort,
  type Unsubscribe,
} from '../ha/host.ts';
import { createStatusBoard, type StatusBoard } from '../ha/status-board.ts';
import type { RegistryEntryLike } from '../ha/types.ts';
import { SIMULATED_CALL_LATENCY_MS } from '../timing.ts';
import { log } from '../util/log.ts';
import './demo-stream.ts';
import { fixtureClock, type AssembledScenario } from './fixture-types.ts';
import { assembleScenario } from './scenarios.ts';
import { demoSnapshotSvg, ScenarioDevices, simulatedServiceRegistry, snapshotBehavior } from './simulate.ts';

interface DemoHostOptions {
  /** Simulated action latency range in ms (default 400–1200, §10.1). */
  readonly latencyMs?: [number, number];
  readonly random?: () => number;
  /** Wall clock for fixture times; e2e pins Date, so the default follows it. */
  readonly now?: () => number;
}

/** Reads (snapshots, calendar, forecast) answer quickly but asynchronously, as the real ones do. */
const READ_LATENCY_MS = 150;
const DEMO_TEMPERATURE_UNIT = '°F'; // the fixtures are written in °F
const DEMO_LENGTH_UNIT = 'mi'; // the same US household as FakeHass's unit system
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;
const NOT_CONNECTED: PortNotSent = Object.freeze({ portError: 'not-sent', reason: 'disconnected' });
const DISPOSED: PortNotSent = Object.freeze({ portError: 'not-sent', reason: 'disposed' });
const DISCONNECTED_ERROR: HostError = Object.freeze({ code: 'disconnected' });
const ABORTED_ERROR: HostError = Object.freeze({ code: 'aborted' });
const SESSION_DENIED: HostError = Object.freeze({ code: 'permission-denied', status: HTTP_UNAUTHORIZED });
const SNAPSHOT_ERRORS: Readonly<Record<'unauthorized' | 'forbidden' | 'unavailable', HostError>> = Object.freeze({
  unauthorized: SESSION_DENIED,
  forbidden: Object.freeze({ code: 'permission-denied', status: HTTP_FORBIDDEN }),
  unavailable: Object.freeze({ code: 'unavailable', status: HTTP_SERVICE_UNAVAILABLE }),
});
/** HA's forecast errors: a missing type is "not supported"; a fixture 'error' is a generic failure (§9.2). */
const FORECAST_NOT_SUPPORTED: HostError = Object.freeze({ code: 'unsupported', haCode: 'forecast_not_supported' });
const FORECAST_FAILED: HostError = Object.freeze({ code: 'unknown', haCode: 'home_assistant_error' });
const NO_ENTITIES: readonly EntityId[] = Object.freeze([]);

export class DemoHost implements HostRuntime {
  readonly reader: HostReader;
  readonly port: ServicePort;
  readonly status: StatusBoard = createStatusBoard();
  readonly #options: Required<DemoHostOptions>;
  readonly #formatter: Formatter = createFormatter({
    temperatureUnit: DEMO_TEMPERATURE_UNIT,
    lengthUnit: DEMO_LENGTH_UNIT,
  });
  readonly #readTimers = new Set<ReturnType<typeof setTimeout>>();
  #scenario: DemoScenarioId;
  #assembled!: AssembledScenario;
  #bound: readonly EntityId[] = NO_ENTITIES;
  #store!: EntityStore;
  #view!: StoreView;
  #devices!: ScenarioDevices;
  #services!: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  #registry: Readonly<Record<string, RegistryEntryLike>> = {};
  #byDevice: ReadonlyMap<string, EntityId[]> = new Map();
  #connected = true;
  #generation = 1;
  #heldFirstIngest = false;
  /** Mirrors HassHost's 401 session denial (§4.4): cleared by a generation change. */
  #snapshotDeniedAt: number | undefined;
  #disposed = false;

  constructor(scenario: DemoScenarioId, opts: DemoHostOptions = {}) {
    this.#options = {
      latencyMs: opts.latencyMs ?? [...SIMULATED_CALL_LATENCY_MS],
      random: opts.random ?? Math.random,
      now: opts.now ?? Date.now,
    };
    this.#scenario = scenario;
    this.reader = this.#createReader();
    this.port = Object.freeze({ invoke: (call: ServiceCall) => this.#invoke(call) });
    this.#load(scenario);
  }

  get key(): string {
    return runtimeKey('demo', this.#scenario, this.#bound);
  }

  /** Simulates the connection dropping (true restores it); a drop advances the socket generation. */
  setConnected(connected: boolean): void {
    if (this.#disposed || connected === this.#connected) return;
    this.#connected = connected;
    if (!connected) this.#generation += 1;
    if (!this.#heldFirstIngest) this.#ingest();
  }

  /** Delivers the first state snapshot held back by the 'loading' scenario. */
  releaseFirstIngest(): void {
    if (this.#disposed || !this.#heldFirstIngest) return;
    this.#heldFirstIngest = false;
    this.#ingest();
    this.#applyScenarioConnection();
  }

  /** Re-assembles the fixtures for another scenario on a new store, because the bound set can differ. The root never
   *  calls this: a scenario change is a new runtime key, so it replaces the whole runtime (§9.1). */
  setScenario(id: DemoScenarioId): void {
    if (this.#disposed) return;
    this.#devices.dispose();
    this.#scenario = id;
    this.#load(id);
  }

  tick(): void {
    this.#store.tick();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#devices.dispose();
    for (const timer of this.#readTimers) clearTimeout(timer);
    this.#readTimers.clear();
  }

  #load(id: DemoScenarioId): void {
    this.#assembled = assembleScenario(id, fixtureClock(this.#options.now()));
    const validation = validateConfig(this.#assembled.input);
    this.#bound = validation.ok ? [...validation.config.bindings.keys()] : NO_ENTITIES;
    this.#store = new EntityStore(this.#bound);
    this.#view = storeView(this.#store);
    this.#registry = Object.freeze(
      Object.fromEntries(this.#assembled.registry.map((entry) => [entry.entity_id, entry])),
    );
    this.#byDevice = indexEntitiesByDevice(this.#assembled.registry);
    this.#services = simulatedServiceRegistry(this.#assembled.spec.missingServices);
    this.#devices = new ScenarioDevices({
      states: this.#assembled.states,
      behaviors: this.#assembled.behaviors,
      ...(this.#assembled.spec.defaultInvoke !== undefined && { defaultInvoke: this.#assembled.spec.defaultInvoke }),
      latencyMs: this.#options.latencyMs,
      random: this.#options.random,
      now: this.#options.now,
      onChange: () => this.#ingest(),
    });
    this.#connected = true;
    this.#heldFirstIngest = this.#assembled.spec.holdFirstIngest;
    if (this.#heldFirstIngest) return;
    this.#ingest();
    this.#applyScenarioConnection();
  }

  /** 'offline' shows an initial snapshot, then the connection drops (§10.2). */
  #applyScenarioConnection(): void {
    if (this.#assembled.spec.connection === 'drop-after-first-ingest') this.setConnected(false);
  }

  #ingest(): void {
    if (this.#disposed || this.#heldFirstIngest) return;
    const spec = this.#assembled.spec;
    this.#store.ingest({
      states: this.#devices.states,
      connected: this.#connected,
      resync: { armed: false },
      meta: {
        connection: connectionToken(this.#connected, false, spec.haState),
        locale: this.#formatter,
        theme: false,
        registry: this.#registry,
        services: this.#services,
        user: spec.user,
      },
    });
    this.#store.setDerived(deriveVacuumBatteries(this.#vacuumsWithoutBattery(), this.#deriveSources()).values());
  }

  #vacuumsWithoutBattery(): EntityId[] {
    const vacuums = this.#assembled.input.vacuums ?? [];
    return vacuums.filter((vacuum) => vacuum.battery_sensor === undefined).map((vacuum) => vacuum.entity as EntityId);
  }

  #deriveSources(): DeriveSources {
    return {
      registry: (id) => this.#registry[id],
      entitiesOnDevice: (deviceId) => this.#byDevice.get(deviceId) ?? NO_ENTITIES,
      state: (id) => this.#devices.states[id],
    };
  }

  #createReader(): HostReader {
    // setScenario() replaces the store, so the reader resolves it on every access.
    const currentView = (): StoreView => this.#view;
    return Object.freeze({
      kind: 'demo' as const,
      get store(): StoreView {
        return currentView();
      },
      connection: () => this.#connectionInfo(),
      connectionGeneration: () => this.#generation,
      registry: (id: EntityId) => this.#registry[id],
      // The fixture registry exists from the start, as on a page whose registry has already arrived (§18).
      registryLoaded: () => true,
      entitiesOnDevice: (deviceId: string) => this.#byDevice.get(deviceId) ?? NO_ENTITIES,
      hasService: (domain: string, service: string) => {
        const services = this.#services[domain];
        return services !== undefined && Object.hasOwn(services, service);
      },
      formatter: () => this.#formatter,
      // The demo theme follows the real HA theme, which only the root reads (§10.1); sections use services.theme.
      isDarkMode: () => false,
      isAdmin: () => this.#assembled.spec.user.is_admin,
      // Fixture forecasts are per type: the scenario has one weather entity.
      subscribeForecast: (_id: EntityId, type: ForecastType, handlers: ForecastHandlers) =>
        this.#subscribeForecast(type, handlers),
      fetchCameraSnapshot: (id: EntityId, request: CameraSnapshotRequest) => this.#fetchCameraSnapshot(id, request),
      openLiveStream: () => this.#openLiveStream(),
      fetchCalendarEvents: (id: EntityId, range: { start: Date; end: Date }, signal: AbortSignal) =>
        this.#fetchCalendarEvents(id, range, signal),
    });
  }

  #connectionInfo(): ConnectionInfo {
    if (!this.#store.isReady()) return { phase: 'loading' };
    const details = { haState: this.#assembled.spec.haState, haVersion: this.#assembled.spec.haVersion };
    return { phase: this.#connected ? 'connected' : 'disconnected', ...details };
  }

  #invoke(call: ServiceCall): Promise<ServiceCallResult> {
    if (this.#disposed) return Promise.reject(DISPOSED);
    if (!this.#connected || !this.#store.isReady()) return Promise.reject(NOT_CONNECTED);
    return this.#devices.invoke(call);
  }

  #subscribeForecast(type: ForecastType, handlers: ForecastHandlers): Unsubscribe {
    let active = true;
    const forecast = this.#assembled.forecasts[type];
    this.#afterRead(() => {
      if (!active) return;
      try {
        if (!this.#connected) handlers.error(DISCONNECTED_ERROR);
        else if (forecast === undefined) handlers.error(FORECAST_NOT_SUPPORTED);
        else if (forecast === 'error') handlers.error(FORECAST_FAILED);
        else handlers.next({ type, forecast });
      } catch {
        log.error('forecast-handler-failed');
      }
    });
    return () => {
      active = false;
    };
  }

  #fetchCameraSnapshot(id: EntityId, request: CameraSnapshotRequest): Promise<Blob> {
    if (this.#disposed || !this.#connected) return Promise.reject(DISCONNECTED_ERROR);
    if (this.#snapshotDeniedAt === this.#generation) return Promise.reject(SESSION_DENIED);
    const behavior = snapshotBehavior(this.#assembled.behaviors, id, this.#assembled.spec.defaultSnapshot);
    return new Promise<Blob>((resolve, reject) => {
      if (request.signal.aborted) {
        reject(ABORTED_ERROR);
        return;
      }
      const onAbort = (): void => reject(ABORTED_ERROR);
      request.signal.addEventListener('abort', onAbort, { once: true });
      this.#afterRead(() => {
        request.signal.removeEventListener('abort', onAbort);
        if (behavior === 'ok') {
          resolve(new Blob([demoSnapshotSvg(id)], { type: 'image/svg+xml' }));
          return;
        }
        if (behavior === 'unauthorized') this.#snapshotDeniedAt = this.#generation;
        reject(SNAPSHOT_ERRORS[behavior]);
      });
    });
  }

  #openLiveStream(): Promise<LiveStreamHandle> {
    const element = document.createElement('agr-demo-stream');
    return Promise.resolve({ kind: 'demo', element, dispose: () => element.remove() });
  }

  #fetchCalendarEvents(
    id: EntityId,
    range: { start: Date; end: Date },
    signal: AbortSignal,
  ): Promise<readonly CalendarEventLike[]> {
    if (this.#disposed || !this.#connected) return Promise.reject(DISCONNECTED_ERROR);
    const events = (this.#assembled.calendarEvents[id] ?? []).filter((event) => overlaps(event, range));
    return new Promise((resolve, reject) => {
      this.#afterRead(() => (signal.aborted ? reject(ABORTED_ERROR) : resolve(events)));
    });
  }

  #afterRead(run: () => void): void {
    const timer = setTimeout(() => {
      this.#readTimers.delete(timer);
      run();
    }, READ_LATENCY_MS);
    this.#readTimers.add(timer);
  }
}

function overlaps(event: CalendarEventLike, range: { start: Date; end: Date }): boolean {
  return Date.parse(event.end) > range.start.getTime() && Date.parse(event.start) < range.end.getTime();
}
