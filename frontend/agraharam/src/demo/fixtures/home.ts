/**
 * Home fixture (§10.2): rooms with lights, curtains and a room purifier, robot vacuums, appliances and the
 * studio monitors script, per scenario. Everything is fictional and every time is relative to the fixture clock.
 *
 * normal     four rooms (one lit), one docked vacuum, one running dishwasher, studio monitors (the §6.2.1 gate)
 * degraded   an unavailable light, a light that rejects actions, a garage-class cover listed as a curtain
 *            (read-only), a vacuum in error, a remaining time of null and a configured appliance that is missing
 * empty      nothing configured: the panel shows its empty state
 * starting   HA starting: some bound states have not arrived yet ("Loading", never "Not found")
 * dense      seven rooms, nine lights, four curtains, three vacuums (one with a derived battery), four appliances
 *            and long names, so the overview overflows into the home drawer
 * Every other scenario uses normal.
 */
import type { CardConfigInput, DemoScenarioId, EntityId } from '../../config/schema.ts';
import { COVER_FEATURE, FAN_FEATURE, VACUUM_FEATURE } from '../../ha/features.ts';
import type { HassEntityLike, RegistryEntryLike } from '../../ha/types.ts';
import { demoEntity, type DemoBehavior, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

/** HA brightness is 0–255. */
const BRIGHT = 180; // about 71 %
const DIM = 90; // about 35 %
const ALL_VACUUM_FEATURES = VACUUM_FEATURE.START | VACUUM_FEATURE.PAUSE | VACUUM_FEATURE.RETURN_HOME;
const COVER_FEATURES = COVER_FEATURE.OPEN | COVER_FEATURE.CLOSE;
const PURIFIER_FEATURES = FAN_FEATURE.SET_SPEED | FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_OFF | FAN_FEATURE.TURN_ON;
/** Minutes until the timestamp-style appliance finishes, so "Done …" always lies ahead of now. */
const WASHER_FINISH_MIN = 50;

type LightState = 'on' | 'off' | 'unavailable' | 'unknown' | 'absent';

interface DemoLight {
  readonly id: string;
  readonly name: string;
  readonly state: LightState;
  readonly brightness?: number;
  /** Defaults to ['brightness']; ['onoff'] has no brightness control. */
  readonly modes?: readonly string[];
}

interface DemoCurtain {
  readonly id: string;
  readonly name: string;
  readonly state: 'open' | 'closed';
  readonly position: number;
  readonly deviceClass: string;
}

interface DemoPurifier {
  readonly id: string;
  readonly name: string;
  readonly state: 'on' | 'off';
}

interface DemoRoom {
  readonly name: string;
  readonly lights: readonly DemoLight[];
  readonly curtains?: readonly DemoCurtain[];
  readonly purifier?: DemoPurifier;
}

interface DemoVacuum {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  /** A configured battery sensor and its state; 'absent' leaves the sensor out of the states. */
  readonly battery?: { readonly id: string; readonly state: string | 'absent' };
  /** No configured sensor: the battery is derived from this sensor on the vacuum's device (§4.4). */
  readonly derivedBattery?: { readonly id: string; readonly state: string; readonly device: string };
  /** The integration's own error text while in `error` (many robot integrations report one). */
  readonly error?: string;
}

interface DemoAppliance {
  readonly name: string;
  readonly status: { readonly id: string; readonly state: string | 'absent' };
  readonly remaining?: {
    readonly id: string;
    readonly state: string | 'absent' | 'finish';
    readonly kind: 'duration' | 'timestamp';
  };
}

interface HomeScene {
  readonly rooms: readonly DemoRoom[];
  readonly vacuums: readonly DemoVacuum[];
  readonly appliances: readonly DemoAppliance[];
  readonly studioMonitors: boolean;
  readonly behaviors: readonly DemoBehavior[];
}

const STUDIO_MONITORS = 'script.demo_studio_monitors';

const READING_BLIND: DemoCurtain = {
  id: 'cover.demo_reading_blind',
  name: 'Reading blind',
  state: 'closed',
  position: 0,
  deviceClass: 'blind',
};
const READING_PURIFIER: DemoPurifier = { id: 'fan.demo_reading_purifier', name: 'Reading purifier', state: 'on' };
/** A garage-class cover listed as a curtain: the room drawer must show it read-only (§4.7 step 5a). */
const WORKSHOP_SHUTTER: DemoCurtain = {
  id: 'cover.demo_workshop_shutter',
  name: 'Workshop roller door',
  state: 'closed',
  position: 0,
  deviceClass: 'garage',
};

const PEBBLE = 'vacuum.demo_pebble';
const PEBBLE_BATTERY = 'sensor.demo_pebble_battery';
const DISHWASHER_STATUS = 'sensor.demo_dishwasher_status';
const DISHWASHER_REMAINING = 'sensor.demo_dishwasher_remaining';

interface RoomOverrides {
  readonly path?: LightState;
  readonly steps?: LightState;
  readonly kitchen?: LightState;
}

function normalRooms(overrides: RoomOverrides = {}): DemoRoom[] {
  return [
    {
      name: 'Courtyard',
      lights: [
        { id: 'light.demo_courtyard_lantern', name: 'Lantern', state: 'on', brightness: BRIGHT },
        { id: 'light.demo_courtyard_path', name: 'Path lights', state: overrides.path ?? 'on', modes: ['onoff'] },
        { id: 'light.demo_courtyard_steps', name: 'Step lights', state: overrides.steps ?? 'off' },
      ],
    },
    {
      name: 'Reading room',
      lights: [{ id: 'light.demo_reading_lamp', name: 'Reading lamp', state: 'off' }],
      curtains: [READING_BLIND],
      purifier: READING_PURIFIER,
    },
    { name: 'Kitchen', lights: [{ id: 'light.demo_kitchen', name: 'Kitchen', state: overrides.kitchen ?? 'off' }] },
    { name: 'Workshop', lights: [{ id: 'light.demo_workshop', name: 'Workshop', state: 'off' }] },
  ];
}

const NORMAL: HomeScene = {
  rooms: normalRooms(),
  vacuums: [{ id: PEBBLE, name: 'Pebble', state: 'docked', battery: { id: PEBBLE_BATTERY, state: '82' } }],
  appliances: [
    {
      name: 'Dishwasher',
      status: { id: DISHWASHER_STATUS, state: 'Washing' },
      remaining: { id: DISHWASHER_REMAINING, state: '35', kind: 'duration' },
    },
  ],
  studioMonitors: true,
  behaviors: [],
};

const DEGRADED: HomeScene = {
  rooms: normalRooms({ path: 'unavailable' }).map((room) =>
    room.name === 'Workshop' ? { ...room, curtains: [WORKSHOP_SHUTTER] } : room,
  ),
  vacuums: [{ id: PEBBLE, name: 'Pebble', state: 'error', battery: { id: PEBBLE_BATTERY, state: '41' } }],
  appliances: [
    {
      name: 'Dishwasher',
      status: { id: DISHWASHER_STATUS, state: 'Washing' },
      remaining: { id: DISHWASHER_REMAINING, state: 'unknown', kind: 'duration' },
    },
    // Configured, but its status sensor does not exist: the row must say "Not found".
    { name: 'Dryer', status: { id: 'sensor.demo_dryer_status', state: 'absent' } },
  ],
  studioMonitors: true,
  behaviors: [{ entity: 'light.demo_kitchen' as EntityId, onInvoke: 'reject-validation' }],
};

const EMPTY: HomeScene = { rooms: [], vacuums: [], appliances: [], studioMonitors: false, behaviors: [] };

const STARTING: HomeScene = {
  // Kitchen has not reported at all ("Loading"); Courtyard is partly in ("2 on, 1 loading"), never "Off".
  rooms: normalRooms({ kitchen: 'absent', steps: 'absent' }),
  vacuums: [{ id: PEBBLE, name: 'Pebble', state: 'docked', battery: { id: PEBBLE_BATTERY, state: 'absent' } }],
  appliances: [
    {
      name: 'Dishwasher',
      status: { id: DISHWASHER_STATUS, state: 'Washing' },
      remaining: { id: DISHWASHER_REMAINING, state: 'absent', kind: 'duration' },
    },
  ],
  studioMonitors: true,
  behaviors: [],
};

const DENSE: HomeScene = {
  rooms: [
    {
      name: 'Courtyard',
      lights: [
        { id: 'light.demo_courtyard_lantern', name: 'Lantern', state: 'on', brightness: BRIGHT },
        { id: 'light.demo_courtyard_path', name: 'Path lights', state: 'on', modes: ['onoff'] },
      ],
    },
    {
      name: 'Reading room and upstairs library',
      lights: [{ id: 'light.demo_reading_lamp', name: 'Reading lamp beside the window seat', state: 'off' }],
      curtains: [READING_BLIND],
      purifier: READING_PURIFIER,
    },
    {
      name: 'Kitchen',
      lights: [
        { id: 'light.demo_kitchen', name: 'Kitchen', state: 'on', brightness: DIM },
        { id: 'light.demo_kitchen_counter', name: 'Counter strip', state: 'off', modes: ['color_temp'] },
      ],
    },
    {
      name: 'Workshop',
      lights: [{ id: 'light.demo_workshop', name: 'Workshop', state: 'off' }],
      curtains: [WORKSHOP_SHUTTER],
    },
    {
      name: 'Guest suite on the garden level',
      lights: [{ id: 'light.demo_guest_suite', name: 'Guest suite', state: 'off' }],
      curtains: [
        { id: 'cover.demo_guest_curtain', name: 'Guest curtain', state: 'open', position: 60, deviceClass: 'curtain' },
      ],
    },
    {
      name: 'Veranda',
      lights: [{ id: 'light.demo_veranda', name: 'Veranda lights', state: 'on', brightness: BRIGHT }],
      curtains: [
        { id: 'cover.demo_veranda_screen', name: 'Veranda screen', state: 'open', position: 100, deviceClass: 'shade' },
      ],
    },
    { name: 'Entry hall', lights: [{ id: 'light.demo_entry_hall', name: 'Entry hall', state: 'off' }] },
  ],
  vacuums: [
    { id: PEBBLE, name: 'Pebble', state: 'cleaning', battery: { id: PEBBLE_BATTERY, state: '64' } },
    {
      id: 'vacuum.demo_pebble_upstairs',
      name: 'Pebble upstairs, the second robot for the bedrooms',
      state: 'docked',
      derivedBattery: {
        id: 'sensor.demo_pebble_upstairs_battery',
        state: '100',
        device: 'demo-device-pebble-upstairs',
      },
    },
    {
      id: 'vacuum.demo_moss',
      name: 'Moss',
      state: 'error',
      error: 'Stuck under a chair',
      battery: { id: 'sensor.demo_moss_battery', state: '12' },
    },
  ],
  appliances: [
    {
      name: 'Dishwasher',
      status: { id: DISHWASHER_STATUS, state: 'Washing' },
      remaining: { id: DISHWASHER_REMAINING, state: '35', kind: 'duration' },
    },
    {
      name: 'Washing machine in the utility room',
      status: { id: 'sensor.demo_washer_status', state: 'Rinsing' },
      remaining: { id: 'sensor.demo_washer_finish', state: 'finish', kind: 'timestamp' },
    },
    { name: 'Dryer', status: { id: 'sensor.demo_dryer_status', state: 'Off' } },
    {
      name: 'Oven',
      status: { id: 'sensor.demo_oven_status', state: 'Preheating' },
      remaining: { id: 'sensor.demo_oven_remaining', state: '12', kind: 'duration' },
    },
  ],
  studioMonitors: true,
  behaviors: [],
};

function sceneFor(scenario: DemoScenarioId): HomeScene {
  switch (scenario) {
    case 'degraded':
      return DEGRADED;
    case 'empty':
      return EMPTY;
    case 'starting':
      return STARTING;
    case 'dense':
      return DENSE;
    default:
      return NORMAL;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Config

function config(scenario: DemoScenarioId): Partial<CardConfigInput> {
  const scene = sceneFor(scenario);
  return {
    ...(scene.rooms.length > 0 && { rooms: scene.rooms.map(roomConfig) }),
    ...(scene.vacuums.length > 0 && {
      vacuums: scene.vacuums.map((vacuum) => ({
        entity: vacuum.id,
        name: vacuum.name,
        ...(vacuum.battery !== undefined && { battery_sensor: vacuum.battery.id }),
      })),
    }),
    ...(scene.appliances.length > 0 && {
      appliances: scene.appliances.map((appliance) => ({
        name: appliance.name,
        status_sensor: appliance.status.id,
        ...(appliance.remaining !== undefined && { remaining_sensor: appliance.remaining.id }),
      })),
    }),
    ...(scene.studioMonitors && { studio_monitors_script: STUDIO_MONITORS }),
  };
}

function roomConfig(room: DemoRoom): NonNullable<CardConfigInput['rooms']>[number] {
  return {
    name: room.name,
    lights: room.lights.map((light) => light.id),
    ...(room.curtains !== undefined && { curtains: room.curtains.map((curtain) => curtain.id) }),
    ...(room.purifier !== undefined && { purifier: room.purifier.id }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// States

function states(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike[] {
  const scene = sceneFor(scenario);
  return [
    ...scene.rooms.flatMap((room) => roomStates(clock, room)),
    ...scene.vacuums.flatMap((vacuum) => vacuumStates(clock, vacuum)),
    ...scene.appliances.flatMap((appliance) => applianceStates(clock, appliance)),
    ...(scene.studioMonitors
      ? [
          demoEntity(clock, STUDIO_MONITORS, 'off', {
            friendly_name: 'Studio monitors',
            last_triggered: clock.at(-240),
            mode: 'single',
          }),
        ]
      : []),
  ];
}

function roomStates(clock: FixtureClock, room: DemoRoom): HassEntityLike[] {
  return [
    ...room.lights.filter((light) => light.state !== 'absent').map((light) => lightState(clock, light)),
    ...(room.curtains ?? []).map((curtain) =>
      demoEntity(clock, curtain.id, curtain.state, {
        friendly_name: curtain.name,
        device_class: curtain.deviceClass,
        current_position: curtain.position,
        supported_features: COVER_FEATURES,
      }),
    ),
    ...(room.purifier === undefined ? [] : [purifierState(clock, room.purifier)]),
  ];
}

function lightState(clock: FixtureClock, light: DemoLight): HassEntityLike {
  const modes = light.modes ?? ['brightness'];
  const dimmable = !modes.includes('onoff');
  const on = light.state === 'on';
  return demoEntity(clock, light.id, light.state, {
    friendly_name: light.name,
    supported_color_modes: modes,
    color_mode: on ? modes[0] : null,
    brightness: on && dimmable ? (light.brightness ?? BRIGHT) : null,
  });
}

function purifierState(clock: FixtureClock, purifier: DemoPurifier): HassEntityLike {
  return demoEntity(clock, purifier.id, purifier.state, {
    friendly_name: purifier.name,
    percentage: purifier.state === 'on' ? 40 : 0,
    percentage_step: 20,
    preset_mode: purifier.state === 'on' ? 'Sleep' : null,
    preset_modes: ['Auto', 'Sleep', 'Turbo'],
    supported_features: PURIFIER_FEATURES,
  });
}

function vacuumStates(clock: FixtureClock, vacuum: DemoVacuum): HassEntityLike[] {
  const result = [
    demoEntity(clock, vacuum.id, vacuum.state, {
      friendly_name: vacuum.name,
      supported_features: ALL_VACUUM_FEATURES,
      ...(vacuum.error !== undefined && { error: vacuum.error }),
    }),
  ];
  const battery = vacuum.battery ?? vacuum.derivedBattery;
  if (battery !== undefined && battery.state !== 'absent') {
    result.push(
      demoEntity(clock, battery.id, battery.state, {
        friendly_name: `${vacuum.name} battery`,
        unit_of_measurement: '%',
        device_class: 'battery',
      }),
    );
  }
  return result;
}

function applianceStates(clock: FixtureClock, appliance: DemoAppliance): HassEntityLike[] {
  const result: HassEntityLike[] = [];
  if (appliance.status.state !== 'absent') {
    result.push(
      demoEntity(clock, appliance.status.id, appliance.status.state, { friendly_name: `${appliance.name} status` }),
    );
  }
  const remaining = appliance.remaining;
  if (remaining !== undefined && remaining.state !== 'absent') {
    const attributes =
      remaining.kind === 'timestamp'
        ? { friendly_name: `${appliance.name} finish`, device_class: 'timestamp' }
        : { friendly_name: `${appliance.name} remaining`, device_class: 'duration', unit_of_measurement: 'min' };
    const state = remaining.state === 'finish' ? clock.at(WASHER_FINISH_MIN) : remaining.state;
    result.push(demoEntity(clock, remaining.id, state, attributes));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Registry and behaviors

/** Device entries only for vacuums whose battery is derived, so DemoHost derives it as HassHost would. */
function registry(scenario: DemoScenarioId): RegistryEntryLike[] {
  return sceneFor(scenario).vacuums.flatMap((vacuum) => {
    const derived = vacuum.derivedBattery;
    if (derived === undefined) return [];
    return [
      { entity_id: vacuum.id, device_id: derived.device },
      { entity_id: derived.id, device_id: derived.device },
    ];
  });
}

function behaviors(scenario: DemoScenarioId): readonly DemoBehavior[] {
  return sceneFor(scenario).behaviors;
}

export const homeFixture: SectionFixture = { config, states, registry, behaviors };
