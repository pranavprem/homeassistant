import { describe, expect, it } from 'vitest';
import type { EntityId, ResolvedConfig } from '../../src/config/schema.ts';
import type { ActionRequest, Availability } from '../../src/ha/actions/types.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import { GARAGE_LIKE_COVER_COPY } from '../../src/ha/actions/messages.ts';
import { VACUUM_FEATURE } from '../../src/ha/features.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { HostReader } from '../../src/ha/host.ts';
import type { HassEntityLike, RegistryEntryLike } from '../../src/ha/types.ts';
import {
  applianceIcon,
  homeActionKeys,
  homeEntityIds,
  roomActionKeys,
  selectHome,
  selectHomeDetail,
  selectRoom,
} from '../../src/model/home.ts';
import { VACUUM_ERROR_MAX_CHARS, VACUUM_STARTING_REASON } from '../../src/model/home/vacuums.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const NOW = new Date('2026-09-30T17:51:00-07:00');
const ALL_VACUUM_BITS = VACUUM_FEATURE.START | VACUUM_FEATURE.PAUSE | VACUUM_FEATURE.RETURN_HOME;

interface Setup {
  readonly config?: Record<string, unknown>;
  readonly states?: readonly HassEntityLike[];
  readonly store?: FakeStoreOptions;
  readonly gateway?: FakeGateway;
  readonly registry?: readonly RegistryEntryLike[];
}

function input(setup: Setup): SelectorInput & { gateway: FakeGateway } {
  const config: ResolvedConfig = configFrom(setup.config ?? {});
  const store: StoreView = fakeStore(setup.states ?? [], setup.store);
  const gateway = setup.gateway ?? new FakeGateway();
  const registry = new Map((setup.registry ?? []).map((entry) => [entry.entity_id, entry]));
  const reader: HostReader = {
    ...fakeReader(store),
    registry: (id) => registry.get(id),
    entitiesOnDevice: (deviceId) =>
      [...registry.values()]
        .filter((entry) => entry.device_id === deviceId)
        .map((entry) => entry.entity_id as EntityId),
  };
  return { config, store, reader, gateway, now: NOW };
}

function light(id: string, state: string, attributes: Record<string, unknown> = {}): HassEntityLike {
  return testEntity(id, state, { friendly_name: id.split('_').pop(), supported_color_modes: ['onoff'], ...attributes });
}

/** Records every request the selector evaluated, and answers enabled. */
function recordingGateway(): FakeGateway & { evaluated: ActionRequest[] } {
  const gateway = new FakeGateway() as FakeGateway & { evaluated: ActionRequest[] };
  gateway.evaluated = [];
  gateway.availability = (req) => {
    gateway.evaluated.push(req);
    return { enabled: true, confirm: false };
  };
  return gateway;
}

const ROOM_CONFIG = {
  rooms: [
    { name: 'Courtyard', lights: ['light.demo_a', 'light.demo_b', 'light.demo_c'] },
    { name: 'Reading room', lights: ['light.demo_d'] },
  ],
};

describe('rooms', () => {
  it('summarizes lights and picks the quick toggle from the observed state', () => {
    const gateway = recordingGateway();
    const vm = selectHome(
      input({
        config: ROOM_CONFIG,
        states: [
          light('light.demo_a', 'on'),
          light('light.demo_b', 'on'),
          light('light.demo_c', 'off'),
          light('light.demo_d', 'off'),
        ],
        gateway,
      }),
    );
    const [courtyard, reading] = vm.rooms;
    expect(courtyard).toMatchObject({ summary: '2 of 3 on', lightsOn: 2, lightsTotal: 3, tone: 'ok' });
    expect(courtyard?.quickToggle?.next).toBe('off');
    expect(reading).toMatchObject({ summary: 'Off', tone: 'neutral' });
    expect(reading?.quickToggle?.next).toBe('on');
    expect(vm.lightsOn).toBe(2);
  });

  it('builds the quick toggle from ONE room action, never from per-light toggles', () => {
    const gateway = recordingGateway();
    const room = selectRoom(
      input({ config: ROOM_CONFIG, states: [light('light.demo_a', 'on'), light('light.demo_b', 'off')], gateway }),
      0,
    );
    expect(room?.quickToggle?.availability).toBe(room?.allOff);
    expect(gateway.evaluated).toContainEqual({ kind: 'room.lights_off', room: 0 });
    expect(gateway.evaluated).toContainEqual({ kind: 'room.lights_on', room: 0 });
  });

  it('carries the room ticket and the gateway reason for a disabled quick toggle', () => {
    const gateway = new FakeGateway();
    const disabled: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are off.' };
    gateway.availability = disabled;
    gateway.request({ kind: 'room.lights_on', room: 1 });
    const vm = selectHome(input({ config: ROOM_CONFIG, states: [light('light.demo_d', 'off')], gateway }));
    expect(vm.rooms[1]?.quickToggle?.availability).toEqual(disabled);
    expect(vm.rooms[1]?.pending?.phase).toBe('pending');
  });

  it.each([
    [['on'], 'On'],
    [['on', 'on', 'on'], 'All on'],
    [['on', 'unavailable', 'off'], '1 on, 1 unavailable'],
    [['off', 'unknown', 'off'], 'Off, 1 not reporting'],
    [['unavailable', 'unavailable', 'unavailable'], 'Unavailable'],
    [['unknown'], 'Unknown'],
  ])('lights %j read "%s"', (states, summary) => {
    const ids = states.map((_state, index) => `light.demo_l${index}`);
    const vm = selectHome(
      input({
        config: { rooms: [{ name: 'Room', lights: ids }] },
        states: states.map((state, index) => light(ids[index] ?? '', state)),
      }),
    );
    expect(vm.rooms[0]?.summary).toBe(summary);
  });

  it('reads "Not found" for a room whose lights are missing, and "Loading" before the first state', () => {
    const config = { rooms: [{ name: 'Room', lights: ['light.demo_gone'] }] };
    expect(selectHome(input({ config })).rooms[0]?.summary).toBe('Not found');
    expect(selectHome(input({ config, store: { ready: false } })).rooms[0]).toMatchObject({
      summary: 'Loading',
      freshness: 'loading',
    });
  });

  it('reads "Loading" while HA starts and a room\'s lights have not reported yet', () => {
    const config = { rooms: [{ name: 'Room', lights: ['light.demo_late'] }] };
    expect(selectHome(input({ config, store: { haState: 'STARTING' } })).rooms[0]).toMatchObject({
      summary: 'Loading',
      tone: 'muted',
    });
  });

  it('keeps last known values while disconnected, muted and stale, with no light count', () => {
    const vm = selectHome(
      input({ config: ROOM_CONFIG, states: [light('light.demo_a', 'on')], store: { connected: false } }),
    );
    expect(vm.rooms[0]).toMatchObject({ freshness: 'stale', tone: 'muted', lightsOn: 1 });
    expect(vm.rooms[0]?.lights[0]).toMatchObject({ status: 'disconnected', on: true });
    expect(vm.lightsOn).toBeNull();
  });

  it('offers two explicit buttons for a light in an unknown state (§7.2)', () => {
    const gateway = recordingGateway();
    const room = selectRoom(input({ config: ROOM_CONFIG, states: [light('light.demo_a', 'unknown')], gateway }), 0);
    const lamp = room?.lights[0];
    expect(lamp?.on).toBeNull();
    expect(lamp?.explicit).toBeDefined();
    expect(gateway.evaluated).toContainEqual({ kind: 'light.turn_on', entity: 'light.demo_a' });
    expect(gateway.evaluated).toContainEqual({ kind: 'light.turn_off', entity: 'light.demo_a' });
  });

  it('offers brightness only for brightness-capable color modes, as a percentage never shown for off', () => {
    const room = selectRoom(
      input({
        config: ROOM_CONFIG,
        states: [
          light('light.demo_a', 'on', { supported_color_modes: ['brightness'], brightness: 180 }),
          light('light.demo_b', 'on', { supported_color_modes: ['onoff'] }),
          light('light.demo_c', 'off', { supported_color_modes: ['color_temp'], brightness: null }),
        ],
      }),
      0,
    );
    const [dimmable, onOff, off] = room?.lights ?? [];
    expect(dimmable).toMatchObject({ brightnessPct: 71 });
    expect(dimmable?.brightness).toBeDefined();
    expect(onOff?.brightness).toBeUndefined();
    expect(off).toMatchObject({ brightnessPct: null });
    expect(off?.brightness).toBeDefined();
  });

  it('cuts the overview to six rooms, lit rooms first, in configuration order (§6.2.1)', () => {
    const rooms = Array.from({ length: 8 }, (_unused, index) => ({
      name: `Room ${index}`,
      lights: [`light.demo_r${index}`],
    }));
    const lit = new Set([6, 7]);
    const vm = selectHome(
      input({
        config: { rooms },
        states: rooms.map((_room, index) => light(`light.demo_r${index}`, lit.has(index) ? 'on' : 'off')),
      }),
    );
    expect(vm.rooms.map((room) => room.index)).toEqual([0, 1, 2, 3, 6, 7]);
    expect(vm.roomsOverflow).toBe(2);
    expect(selectHomeDetail(input({ config: { rooms } })).rooms).toHaveLength(8);
  });

  it('renders garage, gate and door covers read-only in a room, without asking the gateway', () => {
    const gateway = recordingGateway();
    const room = selectRoom(
      input({
        config: { rooms: [{ name: 'Hall', lights: [], curtains: ['cover.demo_blind', 'cover.demo_gate'] }] },
        states: [
          testEntity('cover.demo_blind', 'open', {
            device_class: 'blind',
            current_position: 40,
            friendly_name: 'Blind',
          }),
          testEntity('cover.demo_gate', 'closed', { device_class: 'gate', friendly_name: 'Gate' }),
        ],
        gateway,
      }),
      0,
    );
    const [blind, gate] = room?.curtains ?? [];
    expect(blind).toMatchObject({ readOnly: false, label: 'Open 40%' });
    expect(gate).toMatchObject({ readOnly: true, reason: GARAGE_LIKE_COVER_COPY.elsewhere, label: 'Closed' });
    expect(gate?.open).toMatchObject({ enabled: false, reason: 'not-allowed' });
    expect(gate?.close).toMatchObject({ enabled: false, reason: 'not-allowed' });
    const curtainCalls = gateway.evaluated.filter((req) => req.kind.startsWith('curtain.'));
    expect(curtainCalls.every((req) => 'entity' in req && req.entity === 'cover.demo_blind')).toBe(true);
  });

  it('points the configured garage cover to the Garage panel (a config that bypassed validation)', () => {
    const setup = input({
      config: { rooms: [{ name: 'Hall', lights: [], curtains: ['cover.demo_garage_door'] }] },
      states: [testEntity('cover.demo_garage_door', 'closed', { device_class: 'garage', friendly_name: 'Door' })],
    });
    // Validation refuses a garage cover in a room (§4.2 rule 4), so the config is assembled by hand.
    const config = { ...setup.config, garage: { cover: 'cover.demo_garage_door' as EntityId, name: 'Garage' } };
    const curtain = selectRoom({ ...setup, config }, 0)?.curtains[0];
    expect(curtain).toMatchObject({ readOnly: true, reason: GARAGE_LIKE_COVER_COPY['garage-panel'] });
    expect(curtain?.open).toMatchObject({ enabled: false, reason: 'not-allowed' });
  });

  it('labels a curtain whose position is unknown', () => {
    const room = selectRoom(
      input({
        config: { rooms: [{ name: 'Hall', lights: [], curtains: ['cover.demo_blind'] }] },
        states: [testEntity('cover.demo_blind', 'unknown', { device_class: 'blind' })],
      }),
      0,
    );
    expect(room?.curtains[0]?.label).toBe('Position unknown');
  });

  it('returns undefined for a room index that is no longer configured', () => {
    expect(selectRoom(input({ config: ROOM_CONFIG }), 5)).toBeUndefined();
  });
});

describe('vacuums', () => {
  const config = { vacuums: [{ entity: 'vacuum.demo_pebble', name: 'Pebble', battery_sensor: 'sensor.demo_battery' }] };

  function vacuum(state: string, features = ALL_VACUUM_BITS, battery: string | null = '82') {
    const states = [testEntity('vacuum.demo_pebble', state, { supported_features: features })];
    if (battery !== null) states.push(testEntity('sensor.demo_battery', battery, { unit_of_measurement: '%' }));
    return selectHome(input({ config, states })).vacuums[0];
  }

  it.each([
    ['docked', ['start']],
    ['cleaning', ['pause', 'returnHome']],
    ['returning', ['start', 'pause']],
    ['paused', ['start', 'returnHome']],
    ['idle', ['start', 'returnHome']],
    ['error', ['start', 'returnHome']],
    // Shown so the gateway can say why start and pause are paused (state-unknown), rather than hidden.
    ['unknown', ['start', 'pause', 'returnHome']],
    ['unavailable', []],
  ])('%s offers %j', (state, actions) => {
    const vm = vacuum(state);
    const offered = (['start', 'pause', 'returnHome'] as const).filter((action) => vm?.[action] !== undefined);
    expect(offered).toEqual(actions);
  });

  it('labels start as Resume while paused and names the activity in plain words', () => {
    expect(vacuum('paused')).toMatchObject({ startLabel: 'Resume', activityLabel: 'Paused' });
    expect(vacuum('returning')).toMatchObject({ activityLabel: 'Returning to dock', tone: 'ok' });
    expect(vacuum('error')).toMatchObject({ activityLabel: 'Needs attention', tone: 'attention' });
  });

  it("names what is wrong whenever the integration reports it, and falls back only when it doesn't", () => {
    const withError = (error: unknown) => {
      const states = [
        testEntity('vacuum.demo_pebble', 'error', { supported_features: ALL_VACUUM_BITS, error }),
        testEntity('sensor.demo_battery', '82', { unit_of_measurement: '%' }),
      ];
      return selectHome(input({ config, states })).vacuums[0]?.activityLabel;
    };
    expect(withError('bin full')).toBe('Bin full');
    expect(withError('  Stuck  ')).toBe('Stuck');
    expect(withError('')).toBe('Needs attention');
    expect(withError('   ')).toBe('Needs attention');
    expect(withError(42)).toBe('Needs attention');
    expect(withError('Main brush jammed, clean the brush and restart')).toBe(
      'Main brush jammed, clean the brush and restart',
    );
    // A runaway message is cut with an ellipsis, never replaced by the generic label.
    const cut = withError('x'.repeat(VACUUM_ERROR_MAX_CHARS + 30)) ?? '';
    expect(Array.from(cut)).toHaveLength(VACUUM_ERROR_MAX_CHARS);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('while Home Assistant starts, a vacuum service not offered yet says so in one short line', () => {
    const missing: Availability = {
      enabled: false,
      reason: 'service-missing',
      message: "Home Assistant isn't offering this control right now. The integration may still be loading.",
    };
    const gateway = new FakeGateway();
    gateway.availability = missing;
    const states = [testEntity('vacuum.demo_pebble', 'docked', { supported_features: ALL_VACUUM_BITS })];
    const base = input({ config, states, gateway, store: { haState: 'STARTING' } });
    const startingInput = {
      ...base,
      reader: { ...base.reader, connection: () => ({ phase: 'connected' as const, haState: 'STARTING' as const }) },
    };
    const starting = selectHome(startingInput).vacuums[0];
    expect(starting?.start).toEqual({ ...missing, message: VACUUM_STARTING_REASON });
    // Once HA is running, a missing service keeps the general reason: it is not about starting any more.
    const running = selectHome(input({ config, states, gateway })).vacuums[0];
    expect(running?.start).toEqual(missing);
  });

  it('hides actions whose feature bit is missing', () => {
    const vm = vacuum('docked', VACUUM_FEATURE.RETURN_HOME);
    expect(vm?.start).toBeUndefined();
    expect(vacuum('cleaning', VACUUM_FEATURE.START)?.pause).toBeUndefined();
  });

  it('shows the configured battery, and an absent battery rather than 0', () => {
    expect(vacuum('docked')).toMatchObject({ batteryPct: 82, batteryDerived: false });
    expect(vacuum('docked')?.battery).toMatchObject({ kind: 'value', text: '82%' });
    for (const value of ['unknown', 'unavailable', '']) {
      const vm = vacuum('docked', ALL_VACUUM_BITS, value);
      expect(vm?.batteryPct).toBeNull();
      expect(vm?.battery?.kind).toBe('absent');
    }
    expect(vacuum('docked', ALL_VACUUM_BITS, null)?.battery).toMatchObject({ kind: 'absent', label: 'Not found' });
  });

  it('derives the battery from the vacuum device when no sensor is configured, else shows none', () => {
    const bare = { vacuums: [{ entity: 'vacuum.demo_pebble' }] };
    const states = [
      testEntity('vacuum.demo_pebble', 'docked', { supported_features: ALL_VACUUM_BITS, friendly_name: 'Pebble' }),
      testEntity('sensor.demo_pebble_battery', '64', { device_class: 'battery', unit_of_measurement: '%' }),
    ];
    const registry: RegistryEntryLike[] = [
      { entity_id: 'vacuum.demo_pebble', device_id: 'device-demo' },
      { entity_id: 'sensor.demo_pebble_battery', device_id: 'device-demo' },
    ];
    const derived = selectHome(input({ config: bare, states, registry })).vacuums[0];
    expect(derived).toMatchObject({ name: 'Pebble', batteryPct: 64, batteryDerived: true });
    const none = selectHome(input({ config: bare, states })).vacuums[0];
    expect(none?.battery).toBeUndefined();
    expect(none?.batteryPct).toBeNull();
  });

  it('shows at most two vacuums: error first, then cleaning or returning, in configuration order', () => {
    const ids = ['vacuum.demo_a', 'vacuum.demo_b', 'vacuum.demo_c'];
    const vm = selectHome(
      input({
        config: { vacuums: ids.map((entity) => ({ entity })) },
        states: [
          testEntity('vacuum.demo_a', 'docked'),
          testEntity('vacuum.demo_b', 'cleaning'),
          testEntity('vacuum.demo_c', 'error'),
        ],
      }),
    );
    expect(vm.vacuums.map((item) => item.key)).toEqual(['vacuum.demo_b', 'vacuum.demo_c']);
    expect(vm.vacuumsOverflow).toBe(1);
  });
});

describe('appliances', () => {
  const remainingConfig = (remaining: string) => ({
    appliances: [{ name: 'Dishwasher', status_sensor: 'sensor.demo_status', remaining_sensor: remaining }],
  });

  function appliance(remaining: HassEntityLike, status = 'Washing') {
    return selectHome(
      input({
        config: remainingConfig(remaining.entity_id),
        states: [testEntity('sensor.demo_status', status), remaining],
      }),
    ).appliances[0];
  }

  it('formats a duration in minutes as time left', () => {
    const vm = appliance(
      testEntity('sensor.demo_remaining', '35', { device_class: 'duration', unit_of_measurement: 'min' }),
    );
    expect(vm).toMatchObject({ active: true, statusText: { kind: 'value', text: 'Washing' } });
    expect(vm?.remaining).toMatchObject({ kind: 'value', text: '35 min left' });
    const hours = appliance(testEntity('sensor.demo_remaining', '1.5', { unit_of_measurement: 'h' }));
    expect(hours?.remaining).toMatchObject({ text: '1 h 30 min left' });
  });

  it('renders a null or unknown remaining value as absent, never 0 min', () => {
    for (const state of ['unknown', '']) {
      const vm = appliance(
        testEntity('sensor.demo_remaining', state, { device_class: 'duration', unit_of_measurement: 'min' }),
      );
      expect(vm?.remaining?.kind).toBe('absent');
    }
    const nonNumeric = appliance(testEntity('sensor.demo_remaining', 'soon', { device_class: 'duration' }));
    expect(nonNumeric?.remaining).toMatchObject({ kind: 'absent', label: 'No data' });
  });

  it('renders a future timestamp as the finish time, and nothing once it has passed', () => {
    const finish = new Date(NOW.getTime() + 40 * 60_000);
    const expected = `Done ${createFormatter({ temperatureUnit: '°F' }).time(finish)}`;
    const vm = appliance(testEntity('sensor.demo_remaining', finish.toISOString(), { device_class: 'timestamp' }));
    expect(vm?.remaining).toMatchObject({ kind: 'value', text: expected });
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    expect(appliance(testEntity('sensor.demo_remaining', past, { device_class: 'timestamp' }))?.remaining).toBe(
      undefined,
    );
  });

  it('collapses idle appliances into a count and keeps missing ones visible', () => {
    const vm = selectHome(
      input({
        config: {
          appliances: [
            { name: 'Washer', status_sensor: 'sensor.demo_washer' },
            { name: 'Dryer', status_sensor: 'sensor.demo_dryer' },
            { name: 'Oven', status_sensor: 'sensor.demo_oven' },
          ],
        },
        states: [testEntity('sensor.demo_washer', 'Off'), testEntity('sensor.demo_dryer', 'Standby')],
      }),
    );
    expect(vm.idleCount).toBe(2);
    expect(vm.appliances.map((item) => [item.name, item.status])).toEqual([['Oven', 'missing-binding']]);
  });

  it('shows at most three active appliances; the rest count as overflow', () => {
    const names = ['A', 'B', 'C', 'D', 'E'];
    const vm = selectHome(
      input({
        config: { appliances: names.map((name) => ({ name, status_sensor: `sensor.demo_${name.toLowerCase()}` })) },
        states: names.map((name) => testEntity(`sensor.demo_${name.toLowerCase()}`, 'Running')),
      }),
    );
    expect(vm.appliances.map((item) => item.name)).toEqual(['A', 'B', 'C']);
    expect(vm.appliancesOverflow).toBe(2);
  });
});

describe('studio monitors', () => {
  it('is absent without a script and evaluates the script action when configured', () => {
    expect(selectHome(input({})).studioMonitors).toBeUndefined();
    const gateway = recordingGateway();
    const vm = selectHome(
      input({
        config: { studio_monitors_script: 'script.demo_monitors' },
        states: [testEntity('script.demo_monitors', 'off')],
        gateway,
      }),
    );
    expect(vm.studioMonitors?.availability).toEqual({ enabled: true, confirm: false });
    expect(gateway.evaluated).toContainEqual({ kind: 'studio_monitors.run' });
  });

  it('carries the script ticket', () => {
    const gateway = new FakeGateway();
    gateway.request({ kind: 'studio_monitors.run' });
    gateway.settle('studio_monitors', 'confirmed');
    const vm = selectHome(input({ config: { studio_monitors_script: 'script.demo_monitors' }, gateway }));
    expect(vm.studioMonitors?.pending?.phase).toBe('confirmed');
  });
});

describe('bindings', () => {
  it('lists every entity Home reads and every ticket key it watches', () => {
    const config = configFrom({
      rooms: [{ name: 'Hall', lights: ['light.demo_a'], curtains: ['cover.demo_c'], purifier: 'fan.demo_p' }],
      vacuums: [{ entity: 'vacuum.demo_v', battery_sensor: 'sensor.demo_vb' }],
      appliances: [{ name: 'Washer', status_sensor: 'sensor.demo_ws', remaining_sensor: 'sensor.demo_wr' }],
      studio_monitors_script: 'script.demo_sm',
    });
    expect(new Set(homeEntityIds(config, undefined))).toEqual(
      new Set([
        'light.demo_a',
        'cover.demo_c',
        'fan.demo_p',
        'vacuum.demo_v',
        'sensor.demo_vb',
        'sensor.demo_ws',
        'sensor.demo_wr',
        'script.demo_sm',
      ]),
    );
    expect(homeActionKeys(config)).toEqual(['room:0', 'entity:vacuum.demo_v', 'studio_monitors']);
    expect(roomActionKeys(config, 0)).toEqual([
      'room:0',
      'entity:light.demo_a',
      'entity:cover.demo_c',
      'entity:fan.demo_p',
    ]);
  });

  it('reports an unconfigured Home', () => {
    expect(selectHome(input({})).configured).toBe(false);
  });
});

describe('applianceIcon (an oven never shows a washing machine)', () => {
  it.each([
    ['Dishwasher', 'utensils'],
    ['Washing machine in the utility room', 'washing-machine'],
    ['Laundry', 'washing-machine'],
    ['Dryer', 'shirt'],
    ['Oven', 'cooking-pot'],
    ['Kitchen range', 'cooking-pot'],
    ['Microwave', 'microwave'],
    ['Garage freezer', 'refrigerator'],
    ['Bread maker', 'plug'],
  ])('%s → %s', (name, icon) => {
    expect(applianceIcon(name)).toBe(icon);
  });
});
