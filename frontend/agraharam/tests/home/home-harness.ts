/**
 * A Home world wired like production (§2.1): a real EntityStore fed by hand, a HostReader whose phase follows the
 * store, the REAL action gateway (createGateway) over a recording ServicePort, and DashboardServices built
 * from them. Component tests mount agr-home and the Home drawers on it, so every assertion about calls is about
 * what would actually reach Home Assistant. Everything is fictional (`*.demo_*`).
 */
import type { DashboardServices } from '../../src/components/services.ts';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { createGateway } from '../../src/ha/actions/gateway.ts';
import { createInflightRegistry } from '../../src/ha/actions/inflight.ts';
import type { ActionGateway } from '../../src/ha/actions/types.ts';
import { connectionToken, EntityStore } from '../../src/ha/entity-store.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { ConnectionPhase, HostReader, ServiceCall, ServiceCallResult, ServicePort } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import type { ConfigLike, HassEntityLike, RegistryEntryLike } from '../../src/ha/types.ts';
import { settle } from '../helpers/dom.ts';

export type Attributes = Readonly<Record<string, unknown>>;
export type StateSpec = readonly [state: string, attributes?: Attributes];

const FIXED_TIME = '2026-09-30T17:21:00.000Z';
let contextCounter = 0;

function entity(id: string, state: string, attributes: Attributes = {}, contextId?: string): HassEntityLike {
  return Object.freeze({
    entity_id: id,
    state,
    attributes: Object.freeze({ ...attributes }),
    last_changed: FIXED_TIME,
    last_updated: FIXED_TIME,
    context: Object.freeze({
      id: contextId ?? `demo-context-${(contextCounter += 1)}`,
      parent_id: null,
      user_id: null,
    }),
  });
}

interface PendingCall {
  readonly call: ServiceCall;
  resolve(result: ServiceCallResult): void;
  reject(error: unknown): void;
}

/** Records every invoke; the test settles each promise explicitly. */
export class RecordingPort implements ServicePort {
  readonly calls: ServiceCall[] = [];
  readonly #pending: PendingCall[] = [];

  invoke(call: ServiceCall): Promise<ServiceCallResult> {
    this.calls.push(call);
    return new Promise((resolve, reject) => this.#pending.push({ call, resolve, reject }));
  }

  resolveNext(contextId = 'demo-call-context'): void {
    this.#take().resolve({ contextId });
  }

  rejectNext(error: unknown): void {
    this.#take().reject(error);
  }

  #take(): PendingCall {
    const next = this.#pending.shift();
    if (next === undefined) throw new Error('no unsettled call');
    return next;
  }
}

export interface HomeWorldOptions {
  readonly input: Readonly<Record<string, unknown>>;
  readonly states: Readonly<Record<string, StateSpec>>;
  readonly haState?: ConfigLike['state'];
  readonly preview?: boolean;
  /** Registry entries (entity_category for settings switches). */
  readonly registry?: readonly RegistryEntryLike[];
  /** Start with HA's entity registry not yet delivered (`hass.entities` null), as on every page load (§18). */
  readonly registryPending?: boolean;
}

export interface HomeWorld {
  readonly config: ResolvedConfig;
  readonly store: EntityStore;
  readonly port: RecordingPort;
  readonly gateway: ActionGateway;
  readonly services: DashboardServices;
  /** Replaces one entity with a new object and ingests a new states map (what a hass update does). */
  set(id: string, state: string, attributes?: Attributes, contextId?: string): void;
  setConnected(connected: boolean): void;
  /** The root's minute ticker (§9.1): a 'clock' meta change with no entity change. */
  tick(): void;
  /** HA's first registry message: `hass.entities` becomes a new non-null object, so the 'registry' meta fires. */
  deliverRegistry(): void;
}

export function homeConfig(input: Readonly<Record<string, unknown>>): ResolvedConfig {
  const result = validateConfig({ type: 'custom:agraharam-dashboard', controls: true, ...input });
  if (!result.ok) throw new Error(`test config invalid: ${JSON.stringify(result.issues)}`);
  return result.config;
}

export function homeWorld(options: HomeWorldOptions): HomeWorld {
  const config = homeConfig(options.input);
  const store = new EntityStore(config.bindings.keys());
  const port = new RecordingPort();
  let states: Readonly<Record<string, HassEntityLike>> = Object.freeze(
    Object.fromEntries(
      Object.entries(options.states).map(([id, [state, attributes]]) => [id, entity(id, state, attributes)]),
    ),
  );
  let connected = true;
  const haState = options.haState ?? 'RUNNING';
  const services = Object.freeze({});
  const user = Object.freeze({ id: 'demo-user', is_admin: true });
  const entries = new Map((options.registry ?? []).map((entry) => [entry.entity_id, entry]));
  /** Stands in for hass.entities: null until delivered, then a new identity (the 'registry' meta token). */
  let registryToken: Readonly<Record<string, RegistryEntryLike>> | null =
    options.registryPending === true ? null : Object.freeze(Object.fromEntries(entries));
  const ingest = (): void => {
    store.ingest({
      states,
      connected,
      resync: { armed: false },
      meta: {
        connection: connectionToken(connected, false, haState),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: registryToken ?? undefined,
        services,
        user,
      },
    });
  };
  ingest();
  const reader: HostReader = {
    kind: 'hass',
    store,
    connection: () => ({ phase: phaseOf(store), haState }),
    connectionGeneration: () => 1,
    registry: (id) => registryToken?.[id],
    registryLoaded: () => registryToken !== null,
    entitiesOnDevice: () => [],
    hasService: () => true,
    formatter: () => createFormatter({ temperatureUnit: '°F' }),
    isDarkMode: () => false,
    isAdmin: () => true,
    subscribeForecast: () => () => undefined,
    fetchCameraSnapshot: () => Promise.reject({ code: 'unsupported' }),
    openLiveStream: () => Promise.resolve({ kind: 'unsupported', reason: 'no-helpers' }),
    fetchCalendarEvents: () => Promise.reject({ code: 'unsupported' }),
  };
  const preview = options.preview ?? false;
  const gateway = createGateway({
    port,
    reader,
    config,
    isPreview: () => preview,
    inflight: createInflightRegistry(),
  });
  return {
    config,
    store,
    port,
    gateway,
    services: Object.freeze({
      config,
      reader,
      store,
      gateway,
      status: createStatusBoard(),
      warnings: [],
      mode: 'live',
      preview,
      theme: 'light',
    }),
    set(id, state, attributes = {}, contextId) {
      states = Object.freeze({ ...states, [id]: entity(id, state, attributes, contextId) });
      ingest();
    },
    setConnected(next) {
      connected = next;
      ingest();
    },
    tick() {
      store.tick();
    },
    deliverRegistry() {
      registryToken = Object.freeze(Object.fromEntries(entries));
      ingest();
    },
  };
}

function phaseOf(store: EntityStore): ConnectionPhase {
  if (!store.isReady()) return 'loading';
  if (store.isResyncing()) return 'resyncing';
  return store.isConnected() ? 'connected' : 'disconnected';
}

/** Mounts one Home element with the world's services and waits for every nested render. */
export async function mountWith<E extends HTMLElement & { services?: DashboardServices }>(
  tag: string,
  world: HomeWorld,
  extra: Partial<E> = {},
): Promise<E> {
  const element = document.createElement(tag) as E;
  Object.assign(element, extra, { services: world.services });
  document.body.append(element);
  await settle();
  return element;
}

/** Lets settled port promises run their gateway callbacks, then lets Lit render. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  await settle();
}
