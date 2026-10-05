/**
 * A controllable world for gateway tests: a real EntityStore fed by hand, a HostReader whose phase follows the store
 * (or an override), a ServicePort whose calls the test settles one by one, and a private in-flight registry.
 * Everything is fictional (`*.demo_*`). Tests use fake timers; `now()` follows Date.now(), which they advance.
 */
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { createGateway } from '../../src/ha/actions/gateway.ts';
import { createInflightRegistry } from '../../src/ha/actions/inflight.ts';
import type { ActionGateway, InflightRegistry } from '../../src/ha/actions/types.ts';
import { connectionToken, EntityStore } from '../../src/ha/entity-store.ts';
import {
  CLIMATE_FEATURE,
  COVER_FEATURE,
  FAN_FEATURE,
  MEDIA_PLAYER_FEATURE,
  VACUUM_FEATURE,
} from '../../src/ha/features.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { ConnectionPhase, HostReader, ServiceCall, ServiceCallResult, ServicePort } from '../../src/ha/host.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';

export const IDS = Object.freeze({
  kitchenLight: 'light.demo_kitchen',
  kitchenStrip: 'light.demo_kitchen_strip',
  courtyardLight: 'light.demo_courtyard',
  blind: 'cover.demo_kitchen_blind',
  roomPurifier: 'fan.demo_kitchen_purifier',
  purifier: 'fan.demo_purifier',
  thermostat: 'climate.demo_hall',
  bedClimate: 'climate.demo_bed',
  vacuum: 'vacuum.demo_pebble',
  vacuumBattery: 'sensor.demo_pebble_battery',
  speaker: 'media_player.demo_lounge',
  garage: 'cover.demo_garage',
  alarm: 'alarm_control_panel.demo_home',
  policy: 'input_select.demo_policy',
  silence: 'script.demo_silence',
  disarmHold: 'script.demo_disarm_hold',
  resumeAuto: 'script.demo_resume_auto',
  holdNight: 'script.demo_hold_night',
  holdAway: 'script.demo_hold_away',
  holdVacation: 'script.demo_hold_vacation',
  departure: 'script.demo_departure',
  studioMonitors: 'script.demo_studio_monitors',
  frontDoor: 'binary_sensor.demo_front_door',
});

export const FEATURES = Object.freeze({
  climate: CLIMATE_FEATURE.TARGET_TEMPERATURE,
  fan: FAN_FEATURE.SET_SPEED | FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF,
  vacuum: VACUUM_FEATURE.START | VACUUM_FEATURE.PAUSE | VACUUM_FEATURE.RETURN_HOME,
  cover: COVER_FEATURE.OPEN | COVER_FEATURE.CLOSE,
  media: Object.values(MEDIA_PLAYER_FEATURE).reduce((all, bit) => all | bit, 0),
});

/** A full fictional configuration exercising every action family, with controls on. */
export const BASE_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'custom:agraharam-dashboard',
  controls: true,
  climate: [{ entity: IDS.thermostat, name: 'Hall thermostat' }],
  air: [{ entity: IDS.purifier, name: 'Study purifier' }],
  bed_comfort: [IDS.bedClimate],
  rooms: [
    {
      name: 'Kitchen',
      lights: [IDS.kitchenLight, IDS.kitchenStrip],
      curtains: [IDS.blind],
      purifier: IDS.roomPurifier,
    },
    { name: 'Courtyard', lights: [IDS.courtyardLight] },
  ],
  vacuums: [{ entity: IDS.vacuum, name: 'Pebble' }],
  media: [{ entity: IDS.speaker, name: 'Lounge speaker' }],
  garage: { cover: IDS.garage, name: 'Garage' },
  security: {
    alarm: IDS.alarm,
    policy: IDS.policy,
    perimeter: [IDS.frontDoor, IDS.garage],
    actions: {
      silence_sound: IDS.silence,
      disarm_hold: IDS.disarmHold,
      resume_auto: IDS.resumeAuto,
      hold_night: IDS.holdNight,
      hold_away: IDS.holdAway,
      hold_vacation: IDS.holdVacation,
      prepare_departure: IDS.departure,
    },
  },
  studio_monitors_script: IDS.studioMonitors,
});

type StateSpec = readonly [state: string, attributes?: Readonly<Record<string, unknown>>];

const SCRIPT_IDLE: StateSpec = ['off', { last_triggered: '2026-09-29T10:00:00.000Z' }];

/** Every bound entity in an actionable, available state. */
export const BASE_STATES: Readonly<Record<string, StateSpec>> = Object.freeze({
  [IDS.kitchenLight]: ['off', { friendly_name: 'Kitchen pendant', supported_color_modes: ['brightness'] }],
  [IDS.kitchenStrip]: ['off', { friendly_name: 'Counter strip', supported_color_modes: ['onoff'] }],
  [IDS.courtyardLight]: ['on', { supported_color_modes: ['color_temp'], brightness: 128 }],
  [IDS.blind]: ['closed', { supported_features: FEATURES.cover, current_position: 0, device_class: 'blind' }],
  [IDS.roomPurifier]: [
    'off',
    {
      supported_features: FEATURES.fan,
      percentage: 0,
      percentage_step: 25,
      preset_modes: ['auto', 'sleep'],
      preset_mode: 'auto',
    },
  ],
  [IDS.purifier]: [
    'on',
    {
      friendly_name: 'Purifier (from HA)',
      supported_features: FEATURES.fan,
      percentage: 50,
      percentage_step: 1,
      preset_modes: ['auto', 'sleep', 'turbo'],
      preset_mode: 'auto',
    },
  ],
  [IDS.thermostat]: [
    'cool',
    {
      supported_features: FEATURES.climate,
      hvac_modes: ['off', 'cool', 'heat', 'auto'],
      min_temp: 45,
      max_temp: 95,
      temperature: 72,
    },
  ],
  [IDS.bedClimate]: ['heat', { supported_features: FEATURES.climate, temperature: 68 }],
  [IDS.vacuum]: ['docked', { supported_features: FEATURES.vacuum }],
  [IDS.vacuumBattery]: ['80', { device_class: 'battery' }],
  [IDS.speaker]: [
    'playing',
    {
      supported_features: FEATURES.media,
      volume_level: 0.3,
      is_volume_muted: false,
      source: 'Radio',
      source_list: ['Radio', 'Turntable', 'TV'],
      media_title: 'Evening raga',
      media_content_id: 'demo-track-1',
    },
  ],
  [IDS.garage]: ['closed', { supported_features: FEATURES.cover, device_class: 'garage' }],
  [IDS.alarm]: ['disarmed', {}],
  [IDS.policy]: ['Auto', {}],
  [IDS.frontDoor]: ['off', { device_class: 'door' }],
  [IDS.silence]: SCRIPT_IDLE,
  [IDS.disarmHold]: SCRIPT_IDLE,
  [IDS.resumeAuto]: SCRIPT_IDLE,
  [IDS.holdNight]: SCRIPT_IDLE,
  [IDS.holdAway]: SCRIPT_IDLE,
  [IDS.holdVacation]: SCRIPT_IDLE,
  [IDS.departure]: SCRIPT_IDLE,
  [IDS.studioMonitors]: SCRIPT_IDLE,
});

const FIXED_TIME = '2026-09-30T17:21:00.000Z';
let contextCounter = 0;

export function entity(
  id: string,
  state: string,
  attributes: Readonly<Record<string, unknown>> = {},
  contextId = `demo-context-${++contextCounter}`,
): HassEntityLike {
  return Object.freeze({
    entity_id: id,
    state,
    attributes: Object.freeze({ ...attributes }),
    last_changed: FIXED_TIME,
    last_updated: FIXED_TIME,
    context: Object.freeze({ id: contextId, parent_id: null, user_id: null }),
  });
}

export function configFrom(input: Readonly<Record<string, unknown>>): ResolvedConfig {
  const result = validateConfig(input);
  if (!result.ok) throw new Error(`test config invalid: ${JSON.stringify(result.issues)}`);
  return result.config;
}

interface Deferred {
  readonly call: ServiceCall;
  resolve(result: ServiceCallResult): void;
  reject(error: unknown): void;
}

/** Records every invoke and leaves the promise for the test to settle. */
export class FakePort implements ServicePort {
  readonly calls: ServiceCall[] = [];
  readonly #pending: Deferred[] = [];

  invoke(call: ServiceCall): Promise<ServiceCallResult> {
    this.calls.push(call);
    return new Promise((resolve, reject) => this.#pending.push({ call, resolve, reject }));
  }

  /** Resolves the oldest unsettled call. */
  resolve(contextId = 'demo-call-context'): void {
    this.#take().resolve({ contextId });
  }

  /** Rejects the oldest unsettled call. */
  reject(error: unknown): void {
    this.#take().reject(error);
  }

  #take(): Deferred {
    const next = this.#pending.shift();
    if (next === undefined) throw new Error('no unsettled call');
    return next;
  }
}

export interface HarnessOptions {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly config?: ResolvedConfig;
  readonly states?: Readonly<Record<string, StateSpec | null>>;
  readonly inflight?: InflightRegistry;
  /** The gateway's monotonic clock; defaults to Date.now(), which fake timers advance. */
  readonly now?: () => number;
}

export interface Harness {
  readonly gateway: ActionGateway;
  readonly port: FakePort;
  readonly store: EntityStore;
  /** The HostReader the harness gateway was built with (phase follows the store unless overridden). */
  readonly reader: HostReader;
  readonly config: ResolvedConfig;
  readonly inflight: InflightRegistry;
  preview: boolean;
  temperatureUnit: string;
  readonly missingServices: Set<string>;
  /** Forces reader.connection().phase regardless of the store (the live socket getter disagreeing). */
  phaseOverride: ConnectionPhase | undefined;
  /** Replaces one entity with a new object (optionally with a given context id) and ingests. */
  set(id: string, state: string, attributes?: Readonly<Record<string, unknown>>, contextId?: string): void;
  /** Merges attributes into the current entity (new object) and ingests. */
  patch(id: string, attributes: Readonly<Record<string, unknown>>, state?: string): void;
  remove(id: string): void;
  get(id: string): HassEntityLike | undefined;
  setConnected(connected: boolean): void;
  /** Two-step reconnect, step 1: socket back, barrier armed, same states reference (phase resyncing). */
  reconnectWithoutSnapshot(): void;
  /** Step 2: the snapshot replaces every entity object except `keep` (deleted during the outage). */
  deliverSnapshot(keep?: readonly string[]): void;
  changeUser(): void;
  now(): number;
  /** A second gateway over the same world (a rebuilt card), sharing the registry unless one is given. */
  newGateway(inflight?: InflightRegistry): ActionGateway;
}

export function harness(options: HarnessOptions = {}): Harness {
  const config = options.config ?? configFrom(options.input ?? BASE_INPUT);
  const store = new EntityStore(config.bindings.keys());
  const port = new FakePort();
  const inflight = options.inflight ?? createInflightRegistry();
  const now = options.now ?? (() => Date.now());
  const merged: Record<string, StateSpec | null> = { ...BASE_STATES, ...options.states };
  let states: Readonly<Record<string, HassEntityLike>> = Object.freeze(
    Object.fromEntries(
      Object.entries(merged)
        .filter((pair): pair is [string, StateSpec] => pair[1] !== null)
        .map(([id, [state, attributes]]) => [id, entity(id, state, attributes)]),
    ),
  );
  let connected = true;
  let armed = false;
  let base: Readonly<Record<string, HassEntityLike>> | undefined;
  let user = Object.freeze({ id: 'demo-user', is_admin: true });
  const services = Object.freeze({});

  const ingest = (): void => {
    store.ingest({
      states,
      connected,
      resync: { armed, ...(base !== undefined && { base }) },
      meta: {
        connection: connectionToken(connected, armed, 'RUNNING'),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: undefined,
        services,
        user,
      },
    });
  };
  ingest();

  const world = {
    preview: false,
    temperatureUnit: '°F',
    missingServices: new Set<string>(),
    phaseOverride: undefined as ConnectionPhase | undefined,
  };

  const reader: HostReader = {
    kind: 'hass',
    store,
    connection: () => ({ phase: world.phaseOverride ?? phaseOf(store) }),
    connectionGeneration: () => 1,
    registry: () => undefined,
    entitiesOnDevice: () => [],
    hasService: (domain, service) => !world.missingServices.has(`${domain}.${service}`),
    formatter: () => createFormatter({ temperatureUnit: world.temperatureUnit }),
    isDarkMode: () => false,
    isAdmin: () => true,
    subscribeForecast: () => () => undefined,
    fetchCameraSnapshot: () => Promise.reject({ code: 'unsupported' }),
    openLiveStream: () => Promise.resolve({ kind: 'unsupported', reason: 'no-helpers' }),
    fetchCalendarEvents: () => Promise.reject({ code: 'unsupported' }),
  };

  const build = (registry: InflightRegistry): ActionGateway =>
    createGateway({ port, reader, config, isPreview: () => world.preview, now, inflight: registry });

  const result: Harness = Object.assign(world, {
    gateway: build(inflight),
    port,
    store,
    reader,
    config,
    inflight,
    set(id: string, state: string, attributes: Readonly<Record<string, unknown>> = {}, contextId?: string) {
      states = Object.freeze({ ...states, [id]: entity(id, state, attributes, contextId) });
      ingest();
    },
    patch(id: string, attributes: Readonly<Record<string, unknown>>, state?: string) {
      const current = states[id];
      if (current === undefined) throw new Error(`no entity ${id}`);
      result.set(id, state ?? current.state, { ...current.attributes, ...attributes });
    },
    remove(id: string) {
      const next = { ...states };
      delete next[id];
      states = Object.freeze(next);
      ingest();
    },
    get: (id: string) => states[id],
    setConnected(next: boolean) {
      connected = next;
      ingest();
    },
    reconnectWithoutSnapshot() {
      connected = true;
      armed = true;
      base = states;
      ingest();
    },
    deliverSnapshot(keep: readonly string[] = []) {
      states = Object.freeze(
        Object.fromEntries(
          Object.entries(states).map(([id, value]) => [id, keep.includes(id) ? value : Object.freeze({ ...value })]),
        ),
      );
      armed = false;
      ingest();
    },
    changeUser() {
      user = Object.freeze({ id: 'demo-user', is_admin: true });
      ingest();
    },
    now,
    newGateway: (registry: InflightRegistry = inflight) => build(registry),
  });
  return result;
}

function phaseOf(store: EntityStore): ConnectionPhase {
  if (!store.isReady()) return 'loading';
  if (store.isResyncing()) return 'resyncing';
  return store.isConnected() ? 'connected' : 'disconnected';
}

/** Lets settled port promises run their gateway callbacks. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}
