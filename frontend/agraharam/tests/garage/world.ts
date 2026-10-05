/**
 * A small fictional world for the garage and security tests: a real EntityStore fed by hand (with attributes), the
 * real gateway over a recording ServicePort with a private in-flight registry, and DashboardServices around them.
 * Every ID is `*.demo_*`.
 */
import { vi } from 'vitest';
import type { DashboardServices } from '../../src/components/services.ts';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { createGateway } from '../../src/ha/actions/gateway.ts';
import { createInflightRegistry } from '../../src/ha/actions/inflight.ts';
import type { ActionGateway } from '../../src/ha/actions/types.ts';
import { connectionToken, EntityStore } from '../../src/ha/entity-store.ts';
import { COVER_FEATURE } from '../../src/ha/features.ts';
import type { ConnectionPhase, ServiceCall, ServiceCallResult } from '../../src/ha/host.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { testEntity } from '../helpers/fake-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';
import type { FakeGateway } from '../helpers/fake-gateway.ts';

export const IDS = Object.freeze({
  garage: 'cover.demo_garage',
  battery: 'sensor.demo_sedan_battery',
  range: 'sensor.demo_sedan_range',
  chargerStatus: 'sensor.demo_sedan_charging',
  chargerPower: 'sensor.demo_sedan_charger_power',
  session: 'sensor.demo_sedan_session_energy',
  alarm: 'alarm_control_panel.demo_home',
  policy: 'input_select.demo_security_policy',
  suggested: 'sensor.demo_security_suggested_mode',
  commissioning: 'input_boolean.demo_security_commissioning',
  health: 'input_text.demo_security_health',
  frontDoor: 'binary_sensor.demo_front_door',
  backDoor: 'binary_sensor.demo_back_door',
  silence: 'script.demo_silence_sound',
  disarmHold: 'script.demo_disarm_hold',
  resumeAuto: 'script.demo_resume_auto',
  holdNight: 'script.demo_hold_night',
  holdAway: 'script.demo_hold_away',
  holdVacation: 'script.demo_hold_vacation',
  departure: 'script.demo_prepare_departure',
});

export const ROLE_SCRIPTS = Object.freeze({
  silence_sound: IDS.silence,
  disarm_hold: IDS.disarmHold,
  resume_auto: IDS.resumeAuto,
  hold_night: IDS.holdNight,
  hold_away: IDS.holdAway,
  hold_vacation: IDS.holdVacation,
  prepare_departure: IDS.departure,
});

export const GARAGE_FEATURES = COVER_FEATURE.OPEN | COVER_FEATURE.CLOSE;

export const GARAGE_INPUT = Object.freeze({
  garage: { cover: IDS.garage, name: 'Garage' },
  vehicle: {
    name: 'Demo sedan',
    battery_sensor: IDS.battery,
    range_sensor: IDS.range,
    charger_status: IDS.chargerStatus,
    charger_power: IDS.chargerPower,
    session_energy: IDS.session,
    charge_limit_pct: 80,
  },
});

export const SECURITY_INPUT = Object.freeze({
  security: {
    alarm: IDS.alarm,
    policy: IDS.policy,
    suggested_mode: IDS.suggested,
    commissioning: IDS.commissioning,
    health_text: IDS.health,
    perimeter: [{ entity: IDS.frontDoor, name: 'Front door' }, IDS.backDoor, IDS.garage],
    actions: ROLE_SCRIPTS,
  },
});

export type StateSpec = readonly [state: string, attributes?: Readonly<Record<string, unknown>>];

const SCRIPT_IDLE: StateSpec = ['off', { last_triggered: '2026-09-29T10:00:00.000Z' }];

export const GARAGE_STATES: Readonly<Record<string, StateSpec>> = Object.freeze({
  [IDS.garage]: [
    'closed',
    { friendly_name: 'Garage door', device_class: 'garage', supported_features: GARAGE_FEATURES },
  ],
  [IDS.battery]: ['62', { unit_of_measurement: '%', device_class: 'battery' }],
  [IDS.range]: ['210', { unit_of_measurement: 'mi', device_class: 'distance' }],
  [IDS.chargerStatus]: ['charging', {}],
  [IDS.chargerPower]: ['7.2', { unit_of_measurement: 'kW', device_class: 'power' }],
  [IDS.session]: ['12.4', { unit_of_measurement: 'kWh', device_class: 'energy' }],
});

export const SECURITY_STATES: Readonly<Record<string, StateSpec>> = Object.freeze({
  [IDS.alarm]: ['disarmed', {}],
  [IDS.policy]: ['Auto', { options: ['Auto', 'Hold Away'] }],
  [IDS.suggested]: ['Disarmed', {}],
  [IDS.commissioning]: ['off', {}],
  [IDS.health]: ['Controller online', {}],
  [IDS.frontDoor]: ['off', { device_class: 'door' }],
  [IDS.backDoor]: ['off', { device_class: 'door', friendly_name: 'Back door' }],
  ...Object.fromEntries(Object.values(ROLE_SCRIPTS).map((id) => [id, SCRIPT_IDLE])),
});

export interface World {
  readonly config: ResolvedConfig;
  readonly store: EntityStore;
  /** Replaces one entity with a new object (a missing spec removes it) and ingests a new states map. */
  set(id: string, state: string | undefined, attributes?: Readonly<Record<string, unknown>>): void;
  setConnected(connected: boolean): void;
  get(id: string): HassEntityLike | undefined;
}

export function world(
  input: Readonly<Record<string, unknown>>,
  states: Readonly<Record<string, StateSpec>>,
  options: { readonly haState?: 'RUNNING' | 'STARTING' } = {},
): World {
  const config = configFrom({ controls: true, ...input });
  const store = new EntityStore(config.bindings.keys());
  let current: Record<string, HassEntityLike> = Object.fromEntries(
    Object.entries(states).map(([id, [state, attributes]]) => [id, testEntity(id, state, attributes)]),
  );
  let connected = true;
  const haState = options.haState ?? 'RUNNING';
  const ingest = (): void => {
    store.ingest({
      states: current,
      connected,
      resync: { armed: false },
      meta: {
        connection: connectionToken(connected, false, haState),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: undefined,
        services: undefined,
        user: undefined,
      },
    });
  };
  ingest();
  return {
    config,
    store,
    set(id, state, attributes) {
      const next = { ...current };
      if (state === undefined) delete next[id];
      else next[id] = testEntity(id, state, attributes ?? current[id]?.attributes ?? {});
      current = next;
      ingest();
    },
    setConnected(next) {
      connected = next;
      ingest();
    },
    get: (id) => current[id],
  };
}

export interface RecordingPort {
  readonly calls: ServiceCall[];
  invoke(call: ServiceCall): Promise<ServiceCallResult>;
}

/** Records every call; resolves at once with a fictional context id. */
export function recordingPort(): RecordingPort {
  const calls: ServiceCall[] = [];
  return {
    calls,
    invoke: vi.fn((call: ServiceCall) => {
      calls.push(call);
      return Promise.resolve({ contextId: `demo-context-${calls.length}` });
    }),
  };
}

/** The real gateway over `w` and `port`, with its own in-flight registry so tests never share locks. */
export function realGateway(
  w: World,
  port: RecordingPort,
  phase: () => ConnectionPhase = () => (w.store.isConnected() ? 'connected' : 'disconnected'),
): ActionGateway {
  const reader = fakeServices({ store: w.store, phase }).reader;
  return createGateway({
    port,
    reader,
    config: w.config,
    isPreview: () => false,
    inflight: createInflightRegistry(),
  });
}

/** DashboardServices over `w` with `gateway` (real or fake). */
export function servicesFor(
  w: World,
  gateway: ActionGateway,
  phase: () => ConnectionPhase = () => (w.store.isConnected() ? 'connected' : 'disconnected'),
): DashboardServices {
  const services = fakeServices({ config: w.config, store: w.store, phase });
  return { ...services, gateway };
}

/** DashboardServices whose gateway is the FakeGateway, for UI-only checks. */
export function fakeGatewayServices(w: World, gateway: FakeGateway): DashboardServices & { gateway: FakeGateway } {
  return fakeServices({ config: w.config, store: w.store, gateway });
}
