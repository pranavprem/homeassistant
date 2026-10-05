/**
 * Comfort fixture (§10.2). Fictional devices only. `normal` is exactly one climate device and one air
 * purifier (two tiles, no overflow, no bed tile); other scenarios add the honest states the Climate panel and drawer
 * must design for: an unavailable purifier, a fan that never confirms, a missing current temperature, and the dense
 * mix of four purifiers and two bed sides.
 */
import type { CardConfigInput, DemoScenarioId, EntityId } from '../../config/schema.ts';
import { CLIMATE_FEATURE, FAN_FEATURE } from '../../ha/features.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type DemoBehavior, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

const BEDROOM = 'climate.demo_bedroom';
const PURIFIER = 'fan.demo_purifier';
const HALL_FAN = 'fan.demo_hall_air_mover';
const STUDY_PURIFIER = 'fan.demo_study_air_cleaner';
const LOFT_PURIFIER = 'fan.demo_loft_air_cleaner';
const NURSERY_PURIFIER = 'fan.demo_nursery_air_cleaner';
const BED_LEFT = 'climate.demo_bed_left_side';
const BED_RIGHT = 'climate.demo_bed_right_side';

const PURIFIER_FEATURES = FAN_FEATURE.SET_SPEED | FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_OFF | FAN_FEATURE.TURN_ON;
const SIMPLE_FAN_FEATURES = FAN_FEATURE.SET_SPEED | FAN_FEATURE.TURN_OFF | FAN_FEATURE.TURN_ON;
const PURIFIER_PRESETS = ['Auto', 'Sleep', 'Turbo'];

function bedroom(clock: FixtureClock, scenario: DemoScenarioId): HassEntityLike {
  const degraded = scenario === 'degraded';
  return demoEntity(clock, BEDROOM, degraded ? 'heat' : 'cool', {
    friendly_name: 'Bedroom',
    // degraded: the room sensor stopped reporting, so the tile shows "No data", never 0.
    current_temperature: degraded ? null : 74,
    temperature: degraded ? 68 : 72,
    hvac_modes: ['off', 'cool', 'heat', 'fan_only'],
    hvac_action: degraded ? 'heating' : 'cooling',
    min_temp: 60,
    max_temp: 86,
    target_temp_step: 1,
    supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
  });
}

function purifier(clock: FixtureClock, scenario: DemoScenarioId): HassEntityLike {
  if (scenario === 'degraded') return demoEntity(clock, PURIFIER, 'unavailable', { friendly_name: 'Purifier' }, 95);
  return demoEntity(clock, PURIFIER, 'on', {
    friendly_name: 'Purifier',
    percentage: 40,
    percentage_step: 20,
    preset_mode: 'Sleep',
    preset_modes: PURIFIER_PRESETS,
    supported_features: PURIFIER_FEATURES,
  });
}

function hallFan(clock: FixtureClock): HassEntityLike {
  return demoEntity(clock, HALL_FAN, 'off', {
    friendly_name: 'Hall fan',
    percentage: 0,
    percentage_step: 100 / 3,
    supported_features: SIMPLE_FAN_FEATURES,
  });
}

function densePurifier(
  clock: FixtureClock,
  id: string,
  name: string,
  state: 'on' | 'off',
  preset: string | null,
  percentage: number,
): HassEntityLike {
  return demoEntity(clock, id, state, {
    friendly_name: name,
    percentage,
    percentage_step: 25,
    preset_mode: preset,
    preset_modes: ['Auto', 'Night', 'Boost', 'Allergen'],
    supported_features: PURIFIER_FEATURES,
  });
}

function bedSide(clock: FixtureClock, id: string, name: string, current: number, target: number): HassEntityLike {
  return demoEntity(clock, id, 'heat_cool', {
    friendly_name: name,
    current_temperature: current,
    temperature: target,
    hvac_modes: ['off', 'heat_cool'],
    supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
  });
}

const DENSE_AIR: readonly { readonly entity: EntityId; readonly name: string }[] = [
  { entity: PURIFIER as EntityId, name: 'Purifier' },
  { entity: STUDY_PURIFIER as EntityId, name: 'Study air cleaner by the long bookshelf wall' },
  { entity: LOFT_PURIFIER as EntityId, name: 'Loft air cleaner' },
  { entity: NURSERY_PURIFIER as EntityId, name: 'Nursery air cleaner' },
];

function config(scenario: DemoScenarioId): Partial<CardConfigInput> {
  switch (scenario) {
    case 'empty':
      return {};
    case 'degraded':
      return {
        climate: [{ entity: BEDROOM, name: 'Bedroom' }],
        air: [
          { entity: PURIFIER, name: 'Purifier' },
          { entity: HALL_FAN, name: 'Hall fan' },
        ],
      };
    case 'dense':
      return {
        climate: [{ entity: BEDROOM, name: 'Primary bedroom heat pump with a long name' }],
        air: DENSE_AIR.map(({ entity, name }) => ({ entity, name })),
        bed_comfort: [
          { entity: BED_LEFT, name: 'Bed, left side' },
          { entity: BED_RIGHT, name: 'Bed, right side' },
        ],
      };
    default:
      return {
        climate: [{ entity: BEDROOM, name: 'Bedroom' }],
        air: [{ entity: PURIFIER, name: 'Purifier' }],
      };
  }
}

function states(scenario: DemoScenarioId, clock: FixtureClock): readonly HassEntityLike[] {
  switch (scenario) {
    case 'empty':
      return [];
    case 'degraded':
      return [bedroom(clock, scenario), purifier(clock, scenario), hallFan(clock)];
    case 'dense':
      return [
        bedroom(clock, scenario),
        purifier(clock, scenario),
        densePurifier(clock, STUDY_PURIFIER, 'Study air cleaner', 'on', 'Night', 25),
        densePurifier(clock, LOFT_PURIFIER, 'Loft air cleaner', 'off', null, 0),
        densePurifier(clock, NURSERY_PURIFIER, 'Nursery air cleaner', 'on', 'Allergen', 75),
        bedSide(clock, BED_LEFT, 'Bed, left side', 81, 79),
        bedSide(clock, BED_RIGHT, 'Bed, right side', 77, 75),
      ];
    default:
      return [bedroom(clock, scenario), purifier(clock, scenario)];
  }
}

function behaviors(scenario: DemoScenarioId): readonly DemoBehavior[] {
  // degraded: a fan that accepts the call but never reports the change, so the ticket times out as uncertain.
  return scenario === 'degraded' ? [{ entity: HALL_FAN as EntityId, onInvoke: 'never-confirm' }] : [];
}

export const comfortFixture: SectionFixture = { config, states, behaviors };
