import { describe, expect, it } from 'vitest';
import type { DemoScenarioId } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { assembleScenario } from '../../src/demo/scenarios.ts';
import { GARAGE_STATE_UNKNOWN_COPY } from '../../src/ha/actions/messages.ts';
import type { Availability } from '../../src/ha/actions/types.ts';
import { connectionToken, EntityStore } from '../../src/ha/entity-store.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import { DOOR_MOVING_REASON, selectGarage } from '../../src/model/garage.ts';
import type { GarageVM, SelectorInput } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';
import { GARAGE_INPUT, GARAGE_STATES, IDS, type StateSpec } from './world.ts';

const NOW = new Date(2026, 8, 30, 17, 51, 0);
const DISABLED_MOVING: Availability = { enabled: false, reason: 'not-applicable', message: 'Already open' };

function select(
  states: Readonly<Record<string, StateSpec | undefined>> = {},
  options: FakeStoreOptions & { input?: Record<string, unknown>; gateway?: FakeGateway } = {},
): GarageVM {
  const merged = { ...GARAGE_STATES, ...states };
  const entities = Object.entries(merged)
    .filter((entry): entry is [string, StateSpec] => entry[1] !== undefined)
    .map(([id, [state, attributes]]) => testEntity(id, state, attributes));
  const store = fakeStore(entities, options);
  return selectGarage(inputFor(store, options.input ?? GARAGE_INPUT, options.gateway ?? new FakeGateway()));
}

function inputFor(store: StoreView, input: Record<string, unknown>, gateway: FakeGateway): SelectorInput {
  return { config: configFrom({ controls: true, ...input }), store, reader: fakeReader(store), gateway, now: NOW };
}

describe('selectGarage: the door (§8.5)', () => {
  it.each([
    ['closed', 'Closed', 'neutral'],
    ['open', 'Open', 'attention'],
    ['opening', 'Opening', 'attention'],
    ['closing', 'Closing', 'attention'],
  ] as const)('a %s door reads "%s"', (state, label, tone) => {
    const door = select({ [IDS.garage]: [state, {}] }).door;
    expect(door).toMatchObject({ name: 'Garage', status: 'available', position: state, label, tone });
  });

  it('reads "Position unknown" for the unknown state and for any state HA does not define', () => {
    expect(select({ [IDS.garage]: ['unknown', {}] }).door).toMatchObject({
      status: 'unknown',
      position: 'unknown',
      label: 'Position unknown',
      tone: 'muted',
    });
    expect(select({ [IDS.garage]: ['stopped', {}] }).door).toMatchObject({
      position: 'unknown',
      label: 'Position unknown',
    });
  });

  it('explains an undefined cover state with the unknown-position copy, never "Already open Already closed"', () => {
    const gateway = new FakeGateway();
    gateway.availability = DISABLED_MOVING;
    const door = select({ [IDS.garage]: ['stopped', {}] }, { gateway }).door;
    for (const action of [door?.open, door?.close]) {
      if (action !== undefined) expect(action).toMatchObject({ enabled: false, message: GARAGE_STATE_UNKNOWN_COPY });
    }
    expect(door?.open ?? door?.close).toBeDefined();
  });

  it('keeps unavailable, missing, offline and loading distinct', () => {
    expect(select({ [IDS.garage]: ['unavailable', {}] }).door).toMatchObject({
      status: 'unavailable',
      label: 'Unavailable',
    });
    expect(select({ [IDS.garage]: undefined }).door).toMatchObject({ status: 'missing-binding', label: 'Not found' });
    expect(select({ [IDS.garage]: undefined }, { connected: false }).door).toMatchObject({
      status: 'disconnected',
      label: 'Offline',
    });
    expect(select({ [IDS.garage]: undefined }, { haState: 'STARTING' }).door).toMatchObject({ status: 'loading' });
    const loading = select({}, { ready: false }).door;
    expect(loading).toMatchObject({ status: 'loading', label: 'Loading' });
    expect(loading?.open).toBeUndefined();
    expect(loading?.close).toBeUndefined();
  });

  it('keeps the last known position while disconnected, muted', () => {
    expect(select({}, { connected: false }).door).toMatchObject({
      status: 'disconnected',
      position: 'closed',
      label: 'Closed',
      tone: 'muted',
    });
  });

  it('offers "Open" when closed and "Close" when open, never a toggle', () => {
    const closed = select({ [IDS.garage]: ['closed', {}] }).door;
    expect(closed?.open).toBeDefined();
    expect(closed?.close).toBeUndefined();
    const open = select({ [IDS.garage]: ['open', {}] }).door;
    expect(open?.open).toBeUndefined();
    expect(open?.close).toBeDefined();
  });

  it('offers both, as the gateway evaluates them, while moving or of unknown position', () => {
    const gateway = new FakeGateway();
    gateway.availability = { enabled: false, reason: 'state-unknown', message: 'No position.' };
    const unknown = select({ [IDS.garage]: ['unknown', {}] }, { gateway }).door;
    expect(unknown?.open).toEqual(gateway.availability);
    expect(unknown?.close).toEqual(gateway.availability);
  });

  it('words a moving door itself instead of the precondition text', () => {
    const gateway = new FakeGateway();
    gateway.availability = DISABLED_MOVING;
    const door = select({ [IDS.garage]: ['opening', {}] }, { gateway }).door;
    expect(door?.open).toEqual({ ...DISABLED_MOVING, message: DOOR_MOVING_REASON });
    expect(door?.close).toEqual({ ...DISABLED_MOVING, message: DOOR_MOVING_REASON });
    // Only the moving case is reworded: a closed door's own precondition text stays the gateway's.
    expect(select({ [IDS.garage]: ['closed', {}] }, { gateway }).door?.open).toEqual(DISABLED_MOVING);
  });

  it('evaluates garage.open and garage.close and carries the garage ticket', () => {
    const gateway = new FakeGateway();
    const seen: string[] = [];
    gateway.availability = (req) => {
      seen.push(req.kind);
      return { enabled: true, confirm: true };
    };
    gateway.request({ kind: 'garage.open' });
    const door = select({ [IDS.garage]: ['unknown', {}] }, { gateway }).door;
    expect(seen).toEqual(['garage.open', 'garage.close']);
    expect(door?.pending).toMatchObject({ key: 'garage', kind: 'garage.open', phase: 'pending' });
  });

  it('omits the door when no garage is configured, and both parts when neither is', () => {
    expect(select({}, { input: { vehicle: GARAGE_INPUT.vehicle } }).door).toBeUndefined();
    expect(select({}, { input: { garage: GARAGE_INPUT.garage } }).vehicle).toBeUndefined();
    expect(select({}, { input: {} })).toEqual({});
  });
});

describe('selectGarage: the vehicle (read-only telemetry)', () => {
  it('formats battery, range and the charge limit', () => {
    expect(select().vehicle).toMatchObject({
      name: 'Demo sedan',
      battery: { kind: 'value', text: '62%', stale: false },
      batteryPct: 62,
      range: { kind: 'value', text: '210 mi' },
      chargeLimitPct: 80,
    });
  });

  it.each([
    ['null-like', 'unknown', 'Unknown'],
    ['unavailable', 'unavailable', 'Unavailable'],
    ['non-numeric', 'n/a', 'No data'],
  ])('a %s battery is absent, never 0%%', (_label, state, absentLabel) => {
    const vehicle = select({ [IDS.battery]: [state, {}] }).vehicle;
    expect(vehicle?.battery).toMatchObject({ kind: 'absent', label: absentLabel });
    expect(vehicle?.batteryPct).toBeNull();
    expect(JSON.stringify(vehicle)).not.toMatch(/(?:^|\D)0%/);
  });

  it('clamps the bar but not the reading', () => {
    const vehicle = select({ [IDS.battery]: ['104', {}] }).vehicle;
    expect(vehicle?.batteryPct).toBe(100);
    expect(vehicle?.battery).toMatchObject({ text: '104%' });
  });

  it('shows a missing range sensor as "Not found" and an unavailable one as "Unavailable"', () => {
    expect(select({ [IDS.range]: undefined }).vehicle?.range).toMatchObject({ kind: 'absent', label: 'Not found' });
    expect(select({ [IDS.range]: ['unavailable', {}] }).vehicle?.range).toMatchObject({ label: 'Unavailable' });
  });

  it('marks every reading stale while disconnected', () => {
    const vehicle = select({}, { connected: false }).vehicle;
    expect(vehicle?.battery).toMatchObject({ kind: 'value', text: '62%', stale: true });
    expect(vehicle?.range).toMatchObject({ stale: true });
    expect(vehicle?.batteryPct).toBe(62);
  });

  it('shows charger power only while charging, and the session energy', () => {
    expect(select().vehicle?.charger).toMatchObject({
      status: { kind: 'value', text: 'Charging' },
      charging: true,
      power: { kind: 'value', text: '7.2 kW' },
      session: { kind: 'value', text: '12.4 kWh' },
    });
    const parked = select({ [IDS.chargerStatus]: ['complete', {}], [IDS.chargerPower]: ['0', {}] }).vehicle?.charger;
    expect(parked).toMatchObject({ status: { text: 'Complete' }, charging: false });
    expect(parked?.power).toBeUndefined();
  });

  it('words raw enum states for people and reads a binary charging sensor', () => {
    expect(select({ [IDS.chargerStatus]: ['no_power', {}] }).vehicle?.charger?.status).toMatchObject({
      text: 'No power',
    });
    const binary = {
      ...GARAGE_INPUT,
      vehicle: { ...GARAGE_INPUT.vehicle, charger_status: 'binary_sensor.demo_sedan_charging' },
    };
    const on = select({ 'binary_sensor.demo_sedan_charging': ['on', {}] }, { input: binary }).vehicle?.charger;
    expect(on).toMatchObject({ status: { text: 'Charging' }, charging: true });
    const off = select({ 'binary_sensor.demo_sedan_charging': ['off', {}] }, { input: binary }).vehicle?.charger;
    expect(off).toMatchObject({ status: { text: 'Not charging' }, charging: false });
  });

  it('keeps a power reading visible when the charger status is unknown', () => {
    const charger = select({ [IDS.chargerStatus]: ['unavailable', {}] }).vehicle?.charger;
    expect(charger?.status).toMatchObject({ kind: 'absent', label: 'Unavailable' });
    expect(charger?.power).toMatchObject({ kind: 'value', text: '7.2 kW' });
  });

  it('derives the charger line from power alone when no status sensor is configured', () => {
    const { charger_status: _status, ...vehicle } = GARAGE_INPUT.vehicle;
    const charger = select({}, { input: { ...GARAGE_INPUT, vehicle } }).vehicle?.charger;
    expect(charger).toMatchObject({ status: { text: 'Charging' }, charging: true, power: { text: '7.2 kW' } });
  });

  it('has no charger line without a charger status or power sensor', () => {
    const vehicle = { name: 'Demo sedan', battery_sensor: IDS.battery, range_sensor: IDS.range };
    const vm = select({}, { input: { vehicle } }).vehicle;
    expect(vm?.charger).toBeUndefined();
    expect(vm?.chargeLimitPct).toBeUndefined();
  });
});

describe('selectGarage over the demo scenarios (fixture check)', () => {
  function selectScenario(id: DemoScenarioId): GarageVM {
    const scenario = assembleScenario(id, fixtureClock(NOW.getTime()));
    const result = validateConfig(scenario.input);
    if (!result.ok) throw new Error('invalid scenario config');
    const store = new EntityStore(result.config.bindings.keys());
    store.ingest({
      states: Object.fromEntries(scenario.states.map((state) => [state.entity_id, state])),
      connected: true,
      resync: { armed: false },
      meta: {
        connection: connectionToken(true, false, 'RUNNING'),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: undefined,
        services: undefined,
        user: undefined,
      },
    });
    const gateway = new FakeGateway();
    return selectGarage({ config: result.config, store, reader: fakeReader(store), gateway, now: NOW });
  }

  it('normal: closed door; 62 % and charging toward an 80 % limit', () => {
    const vm = selectScenario('normal');
    expect(vm.door).toMatchObject({ label: 'Closed' });
    expect(vm.vehicle).toMatchObject({ batteryPct: 62, chargeLimitPct: 80, charger: { charging: true } });
  });

  it('degraded: position unknown with both actions offered; range unavailable', () => {
    const vm = selectScenario('degraded');
    expect(vm.door).toMatchObject({ label: 'Position unknown' });
    expect(vm.door?.open).toBeDefined();
    expect(vm.door?.close).toBeDefined();
    expect(vm.vehicle?.range).toMatchObject({ kind: 'absent', label: 'Unavailable' });
  });

  it('empty: the configured door is missing ("Not found") and there is no vehicle; dense: the door is open', () => {
    expect(selectScenario('empty').door).toMatchObject({ status: 'missing-binding', label: 'Not found' });
    expect(selectScenario('empty').vehicle).toBeUndefined();
    expect(selectScenario('dense').door).toMatchObject({ label: 'Open' });
  });
});
