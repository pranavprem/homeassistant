/**
 * Garage and vehicle fixture (§10.2). Fictional and clock-relative.
 *
 *   normal    door closed; "Demo sedan" at 62 %, charging at 7.2 kW, limit 80 %
 *   degraded  door position unknown (Open and Close disabled); vehicle range unavailable
 *   empty     garage door configured but missing from Home Assistant ("Not found", §10.2); no vehicle
 *   dense     door open (Close offered); a long vehicle name; charging complete at the limit
 *   others    as normal (offline and loading show the same data stale or late)
 */
import type { CardConfigInput, DemoScenarioId } from '../../config/schema.ts';
import { COVER_FEATURE } from '../../ha/features.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

const GARAGE_DOOR = 'cover.demo_garage';
const BATTERY = 'sensor.demo_sedan_battery';
const RANGE = 'sensor.demo_sedan_range';
const CHARGER_STATUS = 'sensor.demo_sedan_charging';
const CHARGER_POWER = 'sensor.demo_sedan_charger_power';
const SESSION_ENERGY = 'sensor.demo_sedan_session_energy';

const CHARGE_LIMIT_PCT = 80;
/** Minutes since the door last moved, so its last_changed is a believable evening time. */
const DOOR_CHANGED_MIN_AGO = 300;

interface VehicleReadings {
  readonly name: string;
  readonly battery: string;
  readonly range: string;
  readonly charger: string;
  readonly power: string;
  readonly session: string;
}

const NORMAL_VEHICLE: VehicleReadings = {
  name: 'Demo sedan',
  battery: '62',
  range: '210',
  charger: 'charging',
  power: '7.2',
  session: '12.4',
};

const VEHICLE_BY_SCENARIO: Readonly<Partial<Record<DemoScenarioId, VehicleReadings>>> = Object.freeze({
  degraded: { ...NORMAL_VEHICLE, battery: '41', range: 'unavailable', charger: 'stopped', power: '0', session: '0' },
  dense: {
    name: 'Demo long-range touring sedan with a long name',
    battery: '80',
    range: '268',
    charger: 'complete',
    power: '0',
    session: '31.6',
  },
});

const DOOR_STATE_BY_SCENARIO: Readonly<Partial<Record<DemoScenarioId, string>>> = Object.freeze({
  degraded: 'unknown',
  dense: 'open',
});

/** The configured cover has no state at all, so the panel shows "Not found" (§10.2 'empty'). */
function hasDoorState(scenario: DemoScenarioId): boolean {
  return scenario !== 'empty';
}

function hasVehicle(scenario: DemoScenarioId): boolean {
  return scenario !== 'empty';
}

function readingsFor(scenario: DemoScenarioId): VehicleReadings {
  return VEHICLE_BY_SCENARIO[scenario] ?? NORMAL_VEHICLE;
}

function vehicleConfig(scenario: DemoScenarioId): NonNullable<CardConfigInput['vehicle']> {
  return {
    name: readingsFor(scenario).name,
    battery_sensor: BATTERY,
    range_sensor: RANGE,
    charger_status: CHARGER_STATUS,
    charger_power: CHARGER_POWER,
    session_energy: SESSION_ENERGY,
    charge_limit_pct: CHARGE_LIMIT_PCT,
  };
}

function doorState(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike {
  return demoEntity(
    clock,
    GARAGE_DOOR,
    DOOR_STATE_BY_SCENARIO[scenario] ?? 'closed',
    {
      friendly_name: 'Garage door',
      device_class: 'garage',
      supported_features: COVER_FEATURE.OPEN | COVER_FEATURE.CLOSE,
    },
    DOOR_CHANGED_MIN_AGO,
  );
}

function vehicleStates(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike[] {
  const readings = readingsFor(scenario);
  return [
    demoEntity(clock, BATTERY, readings.battery, {
      friendly_name: 'Demo sedan battery',
      unit_of_measurement: '%',
      device_class: 'battery',
      state_class: 'measurement',
    }),
    demoEntity(clock, RANGE, readings.range, {
      friendly_name: 'Demo sedan range',
      unit_of_measurement: 'mi',
      device_class: 'distance',
    }),
    demoEntity(clock, CHARGER_STATUS, readings.charger, {
      friendly_name: 'Demo sedan charging',
      device_class: 'enum',
      options: ['starting', 'charging', 'stopped', 'complete', 'disconnected', 'no_power'],
    }),
    demoEntity(clock, CHARGER_POWER, readings.power, {
      friendly_name: 'Demo sedan charger power',
      unit_of_measurement: 'kW',
      device_class: 'power',
    }),
    demoEntity(clock, SESSION_ENERGY, readings.session, {
      friendly_name: 'Demo sedan session energy',
      unit_of_measurement: 'kWh',
      device_class: 'energy',
    }),
  ];
}

export const garageFixture: SectionFixture = {
  config: (scenario) => ({
    garage: { cover: GARAGE_DOOR, name: 'Garage' },
    ...(hasVehicle(scenario) && { vehicle: vehicleConfig(scenario) }),
  }),
  states: (scenario, clock) => [
    ...(hasDoorState(scenario) ? [doorState(scenario, clock)] : []),
    ...(hasVehicle(scenario) ? vehicleStates(scenario, clock) : []),
  ],
};
