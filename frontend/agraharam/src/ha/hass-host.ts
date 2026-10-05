/**
 * HassHost (§4.4): the runtime over the `hass` object HA hands the card. It is the ONLY module that reads `hass`
 * (the root has two listed exceptions) and the only caller of hass.callService, through ServicePort.invoke, which
 * only the action gateway receives. Reads go through the src/ha/hass/* seams.
 */
import type { EntityId } from '../config/schema.ts';
import { log } from '../util/log.ts';
import { deriveVacuumBatteries, indexEntitiesByDevice, vacuumDeviceEntities, type DeriveSources } from './derive.ts';
import { connectionToken, EntityStore, storeView, type StoreView } from './entity-store.ts';
import { isHostError } from './errors.ts';
import { createFormatter } from './format.ts';
import { fetchCalendarEvents } from './hass/calendar.ts';
import { fetchSnapshot, openLiveStream, type LiveStreamContext } from './hass/camera.ts';
import { subscribeForecast } from './hass/forecast.ts';
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
} from './host.ts';
import { resyncTrackerFor, type ResyncEvent, type ResyncTracker } from './resync.ts';
import { createStatusBoard, type StatusBoard } from './status-board.ts';
import type { ConnectionLike, HassLike } from './types.ts';

interface HassHostOptions {
  /** Configured vacuums without `battery_sensor`; their battery is derived from the vacuum's device (§4.4). */
  readonly vacuums?: readonly EntityId[];
}

type TrackedElement = HTMLElement & { hass?: unknown };

const HTTP_UNAUTHORIZED = 401;
const NOT_CONNECTED: PortNotSent = Object.freeze({ portError: 'not-sent', reason: 'disconnected' });
const DISPOSED: PortNotSent = Object.freeze({ portError: 'not-sent', reason: 'disposed' });
const DISCONNECTED_ERROR: HostError = Object.freeze({ code: 'disconnected' });
const SESSION_DENIED: HostError = Object.freeze({ code: 'permission-denied', status: HTTP_UNAUTHORIZED });
const NO_HELPERS: LiveStreamHandle = Object.freeze({ kind: 'unsupported', reason: 'no-helpers' });
const NO_ENTITIES: readonly EntityId[] = Object.freeze([]);
const NO_HASS_FORMATTER = createFormatter({ temperatureUnit: '' });

/**
 * Camera session denial (§4.4, §16.10). A Bearer-authenticated 401 means session trouble, not one camera, and every
 * attempt counts toward HA's http.ban, so after one 401 every snapshot request on that connection fails at once
 * until the socket generation or the user changes. Module level, so a runtime rebuilt by setConfig or orphan
 * disposal cannot reset it.
 */
const cameraDenials = new WeakMap<ConnectionLike, { readonly generation: number; readonly user: unknown }>();

/** One definition of "connected" (§16.10): HA's flag AND the live socket getter, read now. */
function isLive(hass: HassLike): boolean {
  return hass.connected && hass.connection.connected === true;
}

function haStateOf(hass: HassLike): string {
  return hass.config.state ?? 'RUNNING';
}

export class HassHost implements HostRuntime {
  readonly reader: HostReader;
  readonly port: ServicePort;
  readonly key: string;
  readonly status: StatusBoard = createStatusBoard();
  readonly #store: EntityStore;
  readonly #view: StoreView;
  readonly #vacuums: readonly EntityId[];
  readonly #tracked = new Set<TrackedElement>();
  #hass: HassLike | undefined;
  /** StoreSnapshot.connected of the last ingest. */
  #connected = false;
  #connection: ConnectionLike | undefined;
  #tracker: ResyncTracker | undefined;
  #trackerUnsubscribe: Unsubscribe | undefined;
  #formatter: { readonly token: readonly unknown[]; readonly formatter: Formatter } | undefined;
  #devices: { readonly registry: unknown; readonly byDevice: ReadonlyMap<string, EntityId[]> } | undefined;
  /** Entities on a vacuum's device whose state has not arrived yet; one appearing triggers re-derivation. */
  #awaitedDeviceEntities: ReadonlySet<EntityId> = new Set();
  /**
   * The barrier cleared on another host's observation while this host's own last map was an older one (a detached
   * panel's retained hass). The tracker's freshness base is newer than that map, so an entity that changed in between
   * would read as fresh and connected with its pre-outage object. The host stays resyncing until its own next
   * update(), whose map the tracker has then observed.
   */
  #heldUntilUpdate = false;
  #disposed = false;

  constructor(bound: Iterable<EntityId>, options: HassHostOptions = {}) {
    const boundIds = [...bound];
    this.#store = new EntityStore(boundIds);
    this.#view = storeView(this.#store);
    this.#vacuums = options.vacuums ?? [];
    this.key = runtimeKey('hass', undefined, boundIds);
    this.reader = this.#createReader();
    this.port = Object.freeze({ invoke: (call: ServiceCall) => this.#invoke(call) });
  }

  /** Called by the root with every hass HA pushes (and never with a retained one: the tracker observes it). */
  update(hass: HassLike): void {
    if (this.#disposed) return;
    const previous = this.#hass;
    this.#hass = hass;
    const tracker = this.#followConnection(hass.connection);
    const wasArmed = tracker.armed() || this.#heldUntilUpdate;
    const connected = isLive(hass);
    tracker.observe(hass.states, connected);
    this.#heldUntilUpdate = false;
    this.#ingest(hass, connected);
    this.#refreshDerived(previous, hass, wasArmed && !tracker.armed());
    this.#forwardToTracked(hass);
  }

  tick(): void {
    this.#store.tick();
  }

  /** Unsubscribes from the tracker and drops the last hass, so a disposed host retains nothing page-lifetime. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#trackerUnsubscribe?.();
    this.#trackerUnsubscribe = undefined;
    this.#tracked.clear();
    this.#hass = undefined;
  }

  #createReader(): HostReader {
    return Object.freeze({
      kind: 'hass' as const,
      store: this.#view,
      connection: () => this.#connectionInfo(),
      connectionGeneration: () => this.#tracker?.generation() ?? 0,
      registry: (id: EntityId) => this.#hass?.entities?.[id],
      entitiesOnDevice: (deviceId: string) => this.#deviceIndex().get(deviceId) ?? NO_ENTITIES,
      hasService: (domain: string, service: string) => {
        const services = this.#hass?.services[domain];
        return services !== undefined && Object.hasOwn(services, service);
      },
      formatter: () => this.#currentFormatter(),
      isDarkMode: () => this.#hass?.themes?.darkMode === true,
      isAdmin: () => this.#hass?.user?.is_admin === true,
      subscribeForecast: (id: EntityId, type: ForecastType, handlers: ForecastHandlers) =>
        this.#subscribeForecast(id, type, handlers),
      fetchCameraSnapshot: (id: EntityId, request: CameraSnapshotRequest) => this.#fetchCameraSnapshot(id, request),
      openLiveStream: (id: EntityId) => this.#openLiveStream(id),
      fetchCalendarEvents: (id: EntityId, range: { start: Date; end: Date }, signal: AbortSignal) =>
        this.#fetchCalendarEvents(id, range, signal),
    });
  }

  /** Moves to the tracker of a new connection object; the tracker alone listens on the connection. */
  #followConnection(connection: ConnectionLike): ResyncTracker {
    if (this.#tracker !== undefined && connection === this.#connection) return this.#tracker;
    const previous = this.#tracker;
    this.#trackerUnsubscribe?.();
    const tracker = resyncTrackerFor(connection, previous);
    this.#tracker = tracker;
    this.#connection = connection;
    this.#trackerUnsubscribe = tracker.subscribe((event) => this.#onTrackerEvent(event));
    return tracker;
  }

  /** Tracker events re-ingest the last hass (without observing it again), so the phase changes at once. */
  #onTrackerEvent(event: ResyncEvent): void {
    const hass = this.#hass;
    if (hass === undefined || this.#disposed) return;
    if (event === 'cleared' && hass.states !== this.#tracker?.lastObserved()) this.#heldUntilUpdate = true;
    this.#ingest(hass, isLive(hass));
    if (event === 'cleared' && !this.#heldUntilUpdate) this.#refreshDerived(hass, hass, true);
  }

  /** The barrier as this host must apply it: the tracker's, or held until this host's own next update. */
  #armed(): boolean {
    return this.#heldUntilUpdate || this.#tracker?.armed() === true;
  }

  #ingest(hass: HassLike, connected: boolean): void {
    this.#connected = connected;
    const armed = this.#armed();
    const base = this.#tracker?.base();
    this.#store.ingest({
      states: hass.states,
      connected,
      resync: base === undefined ? { armed } : { armed, base },
      meta: {
        connection: connectionToken(connected, armed, hass.config.state),
        locale: [hass.locale, hass.formatEntityState, hass.formatEntityAttributeValue, hass.config.unit_system],
        theme: hass.themes?.darkMode === true,
        registry: hass.entities,
        services: hass.services,
        user: hass.user,
      },
    });
  }

  /** 'connected' only with the last ingested flag, the live socket getter right now and a clear barrier. */
  #connectionInfo(): ConnectionInfo {
    const hass = this.#hass;
    if (hass === undefined || !this.#store.isReady()) return { phase: 'loading' };
    const details = {
      ...(hass.config.state !== undefined && { haState: hass.config.state }),
      ...(hass.config.version !== undefined && { haVersion: hass.config.version }),
    };
    if (!this.#connected || hass.connection.connected !== true) return { phase: 'disconnected', ...details };
    if (this.#armed()) return { phase: 'resyncing', ...details };
    return { phase: 'connected', ...details };
  }

  /**
   * The only hass.callService call site. It refuses unless the phase is 'connected' right now: hajs queues messages
   * while a hidden tab's socket is suspended and would send them on the next socket, so a call made then must
   * never leave the browser (§4.4). notifyOnError is false because the dashboard renders its own errors.
   */
  #invoke(call: ServiceCall): Promise<ServiceCallResult> {
    if (this.#disposed) return Promise.reject(DISPOSED);
    const hass = this.#hass;
    if (hass === undefined || this.#connectionInfo().phase !== 'connected') return Promise.reject(NOT_CONNECTED);
    const entityIds = call.target.entity_id;
    const target = { entity_id: typeof entityIds === 'string' ? entityIds : [...entityIds] };
    try {
      return hass
        .callService(call.domain, call.service, { ...call.data }, target, false, false)
        .then((result) => ({ contextId: result?.context?.id ?? '' }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #currentFormatter(): Formatter {
    const hass = this.#hass;
    if (hass === undefined) return NO_HASS_FORMATTER;
    const token = [hass.locale, hass.formatEntityState, hass.formatEntityAttributeValue, hass.config.unit_system];
    const cached = this.#formatter;
    if (cached !== undefined && cached.token.every((value, index) => Object.is(value, token[index]))) {
      return cached.formatter;
    }
    const formatEntityState = hass.formatEntityState;
    const formatAttribute = hass.formatEntityAttributeValue;
    const formatter = createFormatter({
      ...(hass.locale !== undefined && { locale: hass.locale }),
      serverTimeZone: hass.config.time_zone,
      temperatureUnit: hass.config.unit_system.temperature,
      // Feature-detected (§4.4): older frontends lack them, and the Intl fallback takes over.
      ...(formatEntityState !== undefined && {
        formatEntityState: (e, state) => formatEntityState.call(hass, e, state),
      }),
      ...(formatAttribute !== undefined && {
        formatEntityAttributeValue: (e, attribute, value) => formatAttribute.call(hass, e, attribute, value),
      }),
    });
    this.#formatter = { token, formatter };
    return formatter;
  }

  #deviceIndex(): ReadonlyMap<string, EntityId[]> {
    const registry = this.#hass?.entities;
    if (this.#devices === undefined || this.#devices.registry !== registry) {
      this.#devices = { registry, byDevice: indexEntitiesByDevice(registry) };
    }
    return this.#devices.byDevice;
  }

  /** Re-derive on the first ingest, a registry change, HA becoming RUNNING, the barrier clearing, or a state first
   *  appearing on a vacuum's device (the battery device_class is a state attribute, so it can arrive late). */
  #refreshDerived(previous: HassLike | undefined, hass: HassLike, barrierCleared: boolean): void {
    if (this.#vacuums.length === 0) return;
    const needed =
      previous === undefined ||
      previous.entities !== hass.entities ||
      (haStateOf(previous) !== 'RUNNING' && haStateOf(hass) === 'RUNNING') ||
      barrierCleared ||
      [...this.#awaitedDeviceEntities].some((id) => hass.states[id] !== undefined);
    if (!needed) return;
    const sources: DeriveSources = {
      registry: (id) => hass.entities?.[id],
      entitiesOnDevice: (deviceId) => this.#deviceIndex().get(deviceId) ?? NO_ENTITIES,
      state: (id) => hass.states[id],
    };
    this.#store.setDerived(deriveVacuumBatteries(this.#vacuums, sources).values());
    this.#awaitedDeviceEntities = new Set(
      vacuumDeviceEntities(this.#vacuums, sources).filter((id) => hass.states[id] === undefined),
    );
  }

  #forwardToTracked(hass: HassLike): void {
    for (const element of [...this.#tracked]) {
      try {
        element.hass = hass;
      } catch {
        log.error('live-forward-failed');
      }
    }
  }

  #subscribeForecast(id: EntityId, type: ForecastType, handlers: ForecastHandlers): Unsubscribe {
    const hass = this.#hass;
    if (hass === undefined) return reportLater(handlers);
    return subscribeForecast(hass.connection, id, type, handlers, () => this.reader.connectionGeneration());
  }

  #fetchCameraSnapshot(id: EntityId, request: CameraSnapshotRequest): Promise<Blob> {
    const hass = this.#hass;
    if (hass === undefined || this.#connectionInfo().phase !== 'connected') return Promise.reject(DISCONNECTED_ERROR);
    if (this.#isCameraSessionDenied(hass)) return Promise.reject(SESSION_DENIED);
    return fetchSnapshot(hass, id, request).catch((error: unknown) => {
      if (isHostError(error) && error.status === HTTP_UNAUTHORIZED) {
        cameraDenials.set(hass.connection, { generation: this.reader.connectionGeneration(), user: hass.user });
      }
      throw error;
    });
  }

  #isCameraSessionDenied(hass: HassLike): boolean {
    const denial = cameraDenials.get(hass.connection);
    if (denial === undefined) return false;
    if (denial.generation === this.reader.connectionGeneration() && denial.user === hass.user) return true;
    cameraDenials.delete(hass.connection);
    return false;
  }

  #openLiveStream(id: EntityId): Promise<LiveStreamHandle> {
    const opened = this.#hass;
    if (opened === undefined || this.#disposed) return Promise.resolve(NO_HELPERS);
    const context: LiveStreamContext = {
      hass: () => this.#hass ?? opened,
      track: (element) => {
        this.#tracked.add(element);
        return () => {
          this.#tracked.delete(element);
        };
      },
    };
    return openLiveStream(context, id);
  }

  #fetchCalendarEvents(
    id: EntityId,
    range: { start: Date; end: Date },
    signal: AbortSignal,
  ): Promise<readonly CalendarEventLike[]> {
    const hass = this.#hass;
    if (hass === undefined || this.#connectionInfo().phase !== 'connected') return Promise.reject(DISCONNECTED_ERROR);
    return fetchCalendarEvents(hass, id, range, signal);
  }
}

/** Without a hass there is no connection: report 'disconnected' asynchronously, as a real subscription would. */
function reportLater(handlers: ForecastHandlers): Unsubscribe {
  let active = true;
  queueMicrotask(() => {
    if (!active) return;
    try {
      handlers.error(DISCONNECTED_ERROR);
    } catch {
      log.error('forecast-handler-failed');
    }
  });
  return () => {
    active = false;
  };
}
