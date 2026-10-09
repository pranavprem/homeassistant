/**
 * Collections fixture (§10.2, §18): house readings for the House panel's readings fact and the readings drawer.
 * Everything is fictional and every time is relative to the fixture clock.
 *
 * dense      seven groups, about 45 rows over all eighteen readable domains, so search shows; attention rows in most
 *            groups, a duration in every unit style, timestamps, a date-only helper, an event and an uptime
 * degraded   two small groups with every honest absent state: unavailable, unknown under a rule, missing (no state),
 *            not a number under a range rule, attention, and rule-less unknowns
 * offline    the degraded groups with healthy values, shown stale while the connection is down
 * starting   the same healthy groups with two readings not delivered yet ("Loading", never "Not found")
 * Every other scenario configures no collections, so `normal` and the hard layout gate are unchanged.
 *
 * Rows may name entities another fixture owns (the vacuum, a courtyard light): those are configuration overlaps
 * only, and their states come from that fixture.
 */
import type { CardConfigInput, DemoScenarioId } from '../../config/schema.ts';
import type { HassEntityLike, RegistryEntryLike } from '../../ha/types.ts';
import { demoEntity, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

type CollectionsInput = NonNullable<CardConfigInput['collections']>;

/** One reading's state, or 'absent' for an entity HA does not report. */
interface DemoReading {
  readonly id: string;
  readonly state: (clock: FixtureClock) => string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

const MINUTES_PER_DAY = 1_440;
const ABSENT = 'absent';
const ALWAYS = (state: string) => (): string => state;

// ---------------------------------------------------------------------------------------------------------------
// Dense: seven groups over all eighteen domains

const DENSE_COLLECTIONS: CollectionsInput = [
  {
    name: 'Printer',
    icon: 'printer',
    entities: [
      { entity: 'sensor.demo_printer_status', name: 'Status', attention: { equals: ['error', 'offline'] } },
      { entity: 'sensor.demo_printer_progress', name: 'Progress' },
      { entity: 'sensor.demo_printer_black_ink', name: 'Black ink', attention: { below: 15 } },
      { entity: 'sensor.demo_printer_finish', name: 'Finishes' },
      { entity: 'binary_sensor.demo_printer_jam', name: 'Paper jam', attention: { equals: 'on' } },
    ],
  },
  {
    name: 'Vacuum care',
    icon: 'robot-vacuum',
    entities: [
      { entity: 'sensor.demo_pebble_main_brush_left', name: 'Main brush', attention: { below: 10 } },
      { entity: 'sensor.demo_pebble_filter_left', name: 'Filter', attention: { below: 10 } },
      { entity: 'binary_sensor.demo_pebble_water_shortage', name: 'Water tank', attention: { equals: 'on' } },
      { entity: 'sensor.demo_pebble_dock_clean_water', name: 'Dock clean water', attention: { below: 20 } },
      { entity: 'vacuum.demo_pebble', name: 'Pebble' },
    ],
  },
  {
    name: 'Filters and batteries',
    icon: 'battery',
    entities: [
      { entity: 'sensor.demo_purifier_filter_life', name: 'Purifier filter', attention: { below: 20 } },
      { entity: 'sensor.demo_hall_smoke_battery', name: 'Hall smoke alarm', attention: { below: 20 } },
      { entity: 'sensor.demo_side_lock_battery', name: 'Side door lock', attention: { below: 20 } },
      { entity: 'input_datetime.demo_hvac_filter_changed', name: 'HVAC filter changed' },
      { entity: 'sensor.demo_water_filter_days', name: 'Water filter left' },
      { entity: 'update.demo_hub_firmware', name: 'Hub firmware', attention: { equals: 'on' } },
    ],
  },
  {
    name: 'Rooms',
    icon: 'thermometer',
    entities: [
      { entity: 'sensor.demo_study_co2', name: 'Study CO2', attention: { above: 1000 } },
      { entity: 'sensor.demo_study_humidity', name: 'Study humidity', attention: { below: 30, above: 60 } },
      { entity: 'binary_sensor.demo_study_occupancy', name: 'Study occupancy' },
      { entity: 'sensor.demo_loft_pm25', name: 'Loft PM2.5', attention: { above: 35 } },
      { entity: 'fan.demo_attic_fan', name: 'Attic fan' },
      { entity: 'climate.demo_garage_heater', name: 'Garage heater' },
      { entity: 'cover.demo_skylight', name: 'Skylight' },
      { entity: 'light.demo_courtyard_lantern', name: 'Courtyard lantern' },
      { entity: 'input_boolean.demo_guest_mode', name: 'Guest mode' },
      { entity: 'input_select.demo_house_mode', name: 'House mode' },
    ],
  },
  {
    name: 'Kitchen and laundry',
    icon: 'refrigerator',
    entities: [
      { entity: 'sensor.demo_fridge_temperature', name: 'Fridge', attention: { above: 41 } },
      { entity: 'number.demo_fridge_setpoint', name: 'Fridge setpoint' },
      { entity: 'binary_sensor.demo_fridge_door', name: 'Fridge door', attention: { equals: 'on' } },
      { entity: 'sensor.demo_freezer_temperature', name: 'Freezer', attention: { above: 10 } },
      { entity: 'sensor.demo_washer_time_left', name: 'Washer' },
      { entity: 'sensor.demo_washer_done', name: 'Washer done' },
      { entity: 'select.demo_dryer_mode', name: 'Dryer mode' },
      { entity: 'sensor.demo_dishwasher_rinse_aid', name: 'Rinse aid', attention: { equals: 'low' } },
    ],
  },
  {
    name: 'Device health',
    icon: 'heart-pulse',
    entities: [
      { entity: 'binary_sensor.demo_nas_problem', name: 'NAS', attention: { equals: 'on' } },
      { entity: 'sensor.demo_router_uptime', name: 'Router uptime' },
      { entity: 'update.demo_router_firmware', name: 'Router firmware', attention: { equals: 'on' } },
      { entity: 'switch.demo_aquarium_pump', name: 'Aquarium pump' },
      { entity: 'media_player.demo_garage_radio', name: 'Garage radio' },
      { entity: 'lock.demo_side_door', name: 'Side door', attention: { equals: 'unlocked' } },
      { entity: 'event.demo_doorbell_button', name: 'Doorbell' },
      { entity: 'input_text.demo_house_note', name: 'House note' },
      { entity: 'sensor.demo_hub_heartbeat', name: 'Hub heartbeat', attention: { above: 300 } },
      { entity: 'sensor.demo_hub_up_since', name: 'Hub up' },
    ],
  },
  {
    name: 'Car',
    icon: 'car',
    entities: [
      { entity: 'sensor.demo_sedan_tire_fl', name: 'Front left tyre', attention: { below: 38 } },
      { entity: 'sensor.demo_sedan_tire_fr', name: 'Front right tyre', attention: { below: 38 } },
      { entity: 'sensor.demo_sedan_odometer', name: 'Odometer' },
      { entity: 'number.demo_sedan_charge_limit', name: 'Charge limit' },
      { entity: 'sensor.demo_sedan_inside_temp', name: 'Inside' },
      { entity: 'binary_sensor.demo_sedan_windows', name: 'Windows', attention: { equals: 'on' } },
      { entity: 'lock.demo_sedan_doors', name: 'Doors', attention: { equals: 'unlocked' } },
      { entity: 'sensor.demo_sedan_charge_time_left', name: 'Charge time left' },
    ],
  },
];

const percent = (name: string): Readonly<Record<string, unknown>> => ({
  friendly_name: name,
  unit_of_measurement: '%',
});
const temperature = (name: string): Readonly<Record<string, unknown>> => ({
  friendly_name: name,
  unit_of_measurement: '°F',
  device_class: 'temperature',
});
const duration = (name: string, unit: string): Readonly<Record<string, unknown>> => ({
  friendly_name: name,
  unit_of_measurement: unit,
  device_class: 'duration',
});
const timestamp = (name: string): Readonly<Record<string, unknown>> => ({
  friendly_name: name,
  device_class: 'timestamp',
});

const DENSE_READINGS: readonly DemoReading[] = [
  // Printer
  { id: 'sensor.demo_printer_status', state: ALWAYS('printing'), attributes: { friendly_name: 'Printer status' } },
  { id: 'sensor.demo_printer_progress', state: ALWAYS('42'), attributes: percent('Printer progress') },
  { id: 'sensor.demo_printer_black_ink', state: ALWAYS('12'), attributes: percent('Black ink') },
  { id: 'sensor.demo_printer_finish', state: (clock) => clock.at(35), attributes: timestamp('Print finishes') },
  {
    id: 'binary_sensor.demo_printer_jam',
    state: ALWAYS('off'),
    attributes: { friendly_name: 'Paper jam', device_class: 'problem' },
  },
  // Vacuum care
  { id: 'sensor.demo_pebble_main_brush_left', state: ALWAYS('112'), attributes: duration('Main brush left', 'h') },
  { id: 'sensor.demo_pebble_filter_left', state: ALWAYS('6'), attributes: duration('Filter left', 'h') },
  {
    id: 'binary_sensor.demo_pebble_water_shortage',
    state: ALWAYS('on'),
    attributes: { friendly_name: 'Water shortage', device_class: 'problem' },
  },
  { id: 'sensor.demo_pebble_dock_clean_water', state: ALWAYS('80'), attributes: percent('Dock clean water') },
  // Filters and batteries
  { id: 'sensor.demo_purifier_filter_life', state: ALWAYS('23'), attributes: percent('Purifier filter life') },
  {
    id: 'sensor.demo_hall_smoke_battery',
    state: ALWAYS('9'),
    attributes: { ...percent('Hall smoke alarm battery'), device_class: 'battery' },
  },
  { id: 'sensor.demo_side_lock_battery', state: ALWAYS('unavailable'), attributes: percent('Side lock battery') },
  {
    id: 'input_datetime.demo_hvac_filter_changed',
    state: (clock) => localDayKey(clock, -86),
    attributes: { friendly_name: 'HVAC filter changed', has_date: true, has_time: false },
  },
  { id: 'sensor.demo_water_filter_days', state: ALWAYS('41'), attributes: duration('Water filter left', 'd') },
  { id: 'update.demo_hub_firmware', state: ALWAYS('on'), attributes: { friendly_name: 'Hub firmware' } },
  // Rooms
  {
    id: 'sensor.demo_study_co2',
    state: ALWAYS('1180'),
    attributes: { friendly_name: 'Study CO2', unit_of_measurement: 'ppm', device_class: 'carbon_dioxide' },
  },
  {
    id: 'sensor.demo_study_humidity',
    state: ALWAYS('48'),
    attributes: { ...percent('Study humidity'), device_class: 'humidity' },
  },
  {
    id: 'binary_sensor.demo_study_occupancy',
    state: ALWAYS('on'),
    attributes: { friendly_name: 'Study occupancy', device_class: 'occupancy' },
  },
  {
    id: 'sensor.demo_loft_pm25',
    state: ALWAYS('6'),
    attributes: { friendly_name: 'Loft PM2.5', unit_of_measurement: 'µg/m³', device_class: 'pm25' },
  },
  { id: 'fan.demo_attic_fan', state: ALWAYS('on'), attributes: { friendly_name: 'Attic fan', percentage: 40 } },
  {
    id: 'climate.demo_garage_heater',
    state: ALWAYS('heat'),
    attributes: { friendly_name: 'Garage heater', current_temperature: 55 },
  },
  {
    id: 'cover.demo_skylight',
    state: ALWAYS('open'),
    attributes: { friendly_name: 'Skylight', current_position: 40 },
  },
  { id: 'input_boolean.demo_guest_mode', state: ALWAYS('off'), attributes: { friendly_name: 'Guest mode' } },
  { id: 'input_select.demo_house_mode', state: ALWAYS('Evening'), attributes: { friendly_name: 'House mode' } },
  // Kitchen and laundry
  { id: 'sensor.demo_fridge_temperature', state: ALWAYS('38'), attributes: temperature('Fridge temperature') },
  { id: 'number.demo_fridge_setpoint', state: ALWAYS('37'), attributes: temperature('Fridge setpoint') },
  {
    id: 'binary_sensor.demo_fridge_door',
    state: ALWAYS('off'),
    attributes: { friendly_name: 'Fridge door', device_class: 'door' },
  },
  { id: 'sensor.demo_freezer_temperature', state: ALWAYS('2'), attributes: temperature('Freezer temperature') },
  { id: 'sensor.demo_washer_time_left', state: ALWAYS('5100'), attributes: duration('Washer time left', 's') },
  { id: 'sensor.demo_washer_done', state: (clock) => clock.dayAt(1, 7, 40), attributes: timestamp('Washer done') },
  { id: 'select.demo_dryer_mode', state: ALWAYS('Delicate'), attributes: { friendly_name: 'Dryer mode' } },
  { id: 'sensor.demo_dishwasher_rinse_aid', state: ALWAYS('low'), attributes: { friendly_name: 'Rinse aid' } },
  // Device health
  {
    id: 'binary_sensor.demo_nas_problem',
    state: ALWAYS('off'),
    attributes: { friendly_name: 'NAS problem', device_class: 'problem' },
  },
  { id: 'sensor.demo_router_uptime', state: ALWAYS('273600'), attributes: duration('Router uptime', 's') },
  { id: 'update.demo_router_firmware', state: ALWAYS('off'), attributes: { friendly_name: 'Router firmware' } },
  { id: 'switch.demo_aquarium_pump', state: ALWAYS('off'), attributes: { friendly_name: 'Aquarium pump' } },
  { id: 'media_player.demo_garage_radio', state: ALWAYS('off'), attributes: { friendly_name: 'Garage radio' } },
  { id: 'lock.demo_side_door', state: ALWAYS('locked'), attributes: { friendly_name: 'Side door' } },
  {
    id: 'event.demo_doorbell_button',
    state: (clock) => clock.at(-12),
    attributes: { friendly_name: 'Doorbell', event_type: 'single_press', device_class: 'doorbell' },
  },
  {
    id: 'input_text.demo_house_note',
    state: ALWAYS('Recycling goes out Thursday'),
    attributes: { friendly_name: 'House note' },
  },
  { id: 'sensor.demo_hub_heartbeat', state: ALWAYS('45'), attributes: duration('Hub heartbeat', 's') },
  {
    id: 'sensor.demo_hub_up_since',
    state: (clock) => clock.at(-9 * MINUTES_PER_DAY),
    attributes: { friendly_name: 'Hub up since', device_class: 'uptime' },
  },
  // Car
  {
    id: 'sensor.demo_sedan_tire_fl',
    state: ALWAYS('41'),
    attributes: { friendly_name: 'Front left tyre', unit_of_measurement: 'psi', device_class: 'pressure' },
  },
  {
    id: 'sensor.demo_sedan_tire_fr',
    state: ALWAYS('36'),
    attributes: { friendly_name: 'Front right tyre', unit_of_measurement: 'psi', device_class: 'pressure' },
  },
  {
    id: 'sensor.demo_sedan_odometer',
    state: ALWAYS('18432'),
    attributes: { friendly_name: 'Odometer', unit_of_measurement: 'mi', device_class: 'distance' },
  },
  { id: 'number.demo_sedan_charge_limit', state: ALWAYS('80'), attributes: percent('Charge limit') },
  { id: 'sensor.demo_sedan_inside_temp', state: ALWAYS('71'), attributes: temperature('Inside temperature') },
  {
    id: 'binary_sensor.demo_sedan_windows',
    state: ALWAYS('off'),
    attributes: { friendly_name: 'Windows', device_class: 'window' },
  },
  { id: 'lock.demo_sedan_doors', state: ALWAYS('locked'), attributes: { friendly_name: 'Doors' } },
  { id: 'sensor.demo_sedan_charge_time_left', state: ALWAYS('1.25'), attributes: duration('Charge time left', 'h') },
];

/** Registry display precision, so the fallback formatter shows "2.0 °F" as HA would. */
const DENSE_REGISTRY: readonly RegistryEntryLike[] = [
  { entity_id: 'sensor.demo_freezer_temperature', display_precision: 1 },
];

// ---------------------------------------------------------------------------------------------------------------
// Degraded, offline and starting: two small groups

const SMALL_COLLECTIONS: CollectionsInput = [
  {
    name: 'Vacuum care',
    icon: 'robot-vacuum',
    entities: [
      { entity: 'sensor.demo_pebble_filter_left', name: 'Filter', attention: { below: 10 } },
      { entity: 'sensor.demo_pebble_main_brush_left', name: 'Main brush', attention: { below: 10 } },
      { entity: 'binary_sensor.demo_pebble_water_shortage', name: 'Water tank', attention: { equals: 'on' } },
      { entity: 'sensor.demo_pebble_dock_clean_water', name: 'Dock clean water', attention: { below: 20 } },
    ],
  },
  {
    name: 'Batteries',
    icon: 'battery',
    entities: [
      { entity: 'sensor.demo_hall_smoke_battery', name: 'Hall smoke alarm', attention: { below: 20 } },
      { entity: 'sensor.demo_side_lock_battery', name: 'Side door lock', attention: { below: 20 } },
      { entity: 'event.demo_doorbell_button', name: 'Doorbell' },
      { entity: 'sensor.demo_remote_battery', name: 'TV remote' },
    ],
  },
];

/** Every honest absent state: attention, unavailable, unknown under a rule, missing, not a number, rule-less unknowns. */
const DEGRADED_READINGS: readonly DemoReading[] = [
  { id: 'sensor.demo_pebble_filter_left', state: ALWAYS('6'), attributes: duration('Filter left', 'h') },
  {
    id: 'sensor.demo_pebble_main_brush_left',
    state: ALWAYS('unavailable'),
    attributes: duration('Main brush left', 'h'),
  },
  {
    id: 'binary_sensor.demo_pebble_water_shortage',
    state: ALWAYS('unknown'),
    attributes: { friendly_name: 'Water shortage', device_class: 'problem' },
  },
  { id: 'sensor.demo_pebble_dock_clean_water', state: ALWAYS(ABSENT) },
  {
    id: 'sensor.demo_hall_smoke_battery',
    state: ALWAYS('low'),
    attributes: { friendly_name: 'Hall smoke alarm battery', device_class: 'enum' },
  },
  {
    id: 'sensor.demo_side_lock_battery',
    state: ALWAYS('9'),
    attributes: { ...percent('Side lock battery'), device_class: 'battery' },
  },
  {
    id: 'event.demo_doorbell_button',
    state: ALWAYS('unknown'),
    attributes: { friendly_name: 'Doorbell', device_class: 'doorbell' },
  },
  { id: 'sensor.demo_remote_battery', state: ALWAYS('unknown'), attributes: percent('TV remote battery') },
];

/** The same rows with healthy values: what `offline` shows stale and what `starting` delivers in part. */
const HEALTHY_READINGS: readonly DemoReading[] = [
  { id: 'sensor.demo_pebble_filter_left', state: ALWAYS('40'), attributes: duration('Filter left', 'h') },
  { id: 'sensor.demo_pebble_main_brush_left', state: ALWAYS('112'), attributes: duration('Main brush left', 'h') },
  {
    id: 'binary_sensor.demo_pebble_water_shortage',
    state: ALWAYS('off'),
    attributes: { friendly_name: 'Water shortage', device_class: 'problem' },
  },
  { id: 'sensor.demo_pebble_dock_clean_water', state: ALWAYS('80'), attributes: percent('Dock clean water') },
  {
    id: 'sensor.demo_hall_smoke_battery',
    state: ALWAYS('88'),
    attributes: { ...percent('Hall smoke alarm battery'), device_class: 'battery' },
  },
  {
    id: 'sensor.demo_side_lock_battery',
    state: ALWAYS('64'),
    attributes: { ...percent('Side lock battery'), device_class: 'battery' },
  },
  {
    id: 'event.demo_doorbell_button',
    state: (clock) => clock.at(-120),
    attributes: { friendly_name: 'Doorbell', event_type: 'single_press', device_class: 'doorbell' },
  },
  { id: 'sensor.demo_remote_battery', state: ALWAYS('55'), attributes: percent('TV remote battery') },
];

/** HA is still starting: these two have not been delivered yet. */
const NOT_YET_DELIVERED: ReadonlySet<string> = new Set([
  'sensor.demo_pebble_dock_clean_water',
  'sensor.demo_side_lock_battery',
]);

// ---------------------------------------------------------------------------------------------------------------
// Fixture

function config(scenario: DemoScenarioId): Partial<CardConfigInput> {
  switch (scenario) {
    case 'dense':
      return { collections: DENSE_COLLECTIONS };
    case 'degraded':
    case 'offline':
    case 'starting':
      return { collections: SMALL_COLLECTIONS };
    default:
      return {};
  }
}

function readingsFor(scenario: DemoScenarioId): readonly DemoReading[] {
  switch (scenario) {
    case 'dense':
      return DENSE_READINGS;
    case 'degraded':
      return DEGRADED_READINGS;
    case 'offline':
      return HEALTHY_READINGS;
    case 'starting':
      return HEALTHY_READINGS.filter((reading) => !NOT_YET_DELIVERED.has(reading.id));
    default:
      return [];
  }
}

function states(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike[] {
  return readingsFor(scenario).flatMap((reading) => {
    const state = reading.state(clock);
    return state === ABSENT ? [] : [demoEntity(clock, reading.id, state, reading.attributes)];
  });
}

function registry(scenario: DemoScenarioId): readonly RegistryEntryLike[] {
  return scenario === 'dense' ? DENSE_REGISTRY : [];
}

/** 'YYYY-MM-DD' of the local day `offsetDays` from now, as HA writes a date-only input_datetime. */
function localDayKey(clock: FixtureClock, offsetDays: number): string {
  const day = new Date(clock.dayAt(offsetDays, 12, 0));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export const collectionsFixture: SectionFixture = { config, states, registry };
