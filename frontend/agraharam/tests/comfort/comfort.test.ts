/** Comfort selectors (§4.8, §6.2.1, §7.1; §12.1 row 8): steps and units, statuses, budget, summary, bed read-only. */
import { describe, expect, it, vi } from 'vitest';
import { climateIcon } from '../../src/components/comfort/agr-comfort-tile.ts';
import { CLIMATE_FEATURE, FAN_FEATURE } from '../../src/ha/features.ts';
import type { Availability } from '../../src/ha/actions/types.ts';
import type { ComfortVM, SelectorInput } from '../../src/model/types.ts';
import { isStepValue, temperatureGrid } from '../../src/domain/steps.ts';
import {
  comfortOverview,
  comfortSummary,
  selectBedTile,
  selectClimateTile,
  selectComfortTiles,
} from '../../src/model/comfort.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { selectorInputFor } from './support.ts';

/** The Climate panel as agr-comfort builds it: every tile, cut to the overview budget. */
function selectComfort(input: SelectorInput, budget?: number): ComfortVM {
  return comfortOverview(selectComfortTiles(input), budget);
}

const CLIMATE = 'climate.demo_bedroom';
const FAN = 'fan.demo_purifier';
const BED = 'climate.demo_bed_left_side';
const REF = { entity: entityId(CLIMATE), name: 'Bedroom' };
const CONFIG = { climate: [CLIMATE] };

function climate(state = 'cool', attributes: Record<string, unknown> = {}) {
  return testEntity(CLIMATE, state, {
    current_temperature: 74,
    temperature: 72,
    hvac_modes: ['off', 'cool', 'heat', 'fan_only'],
    hvac_action: 'cooling',
    min_temp: 60,
    max_temp: 86,
    supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
    ...attributes,
  });
}

describe('climate tile', () => {
  it('shows current and target in the compact style, with "Cooling to 72°" from hvac_action', () => {
    const tile = selectClimateTile(selectorInputFor([climate()], { config: CONFIG }), REF);
    expect(tile).toMatchObject({
      name: 'Bedroom',
      status: 'available',
      current: { kind: 'value', text: '74°' },
      target: { kind: 'value', text: '72°' },
      modeLabel: 'Cool',
      action: 'cooling',
      actionLabel: 'Cooling to 72°',
    });
  });

  it.each([
    ['heat', 'heating', 'Heating to 72°'],
    ['cool', 'idle', 'Idle, set to 72°'],
    ['off', 'off', 'Off'],
    ['heat_cool', undefined, 'Heat/Cool, set to 72°'],
    ['off', undefined, 'Off'],
  ])('mode %s with hvac_action %s reads "%s"', (mode, action, label) => {
    const tile = selectClimateTile(selectorInputFor([climate(mode, { hvac_action: action })], { config: CONFIG }), REF);
    expect(tile.actionLabel).toBe(label);
  });

  it.each([
    ['off', undefined, 'power'],
    ['off', 'off', 'power'],
    ['cool', 'idle', 'thermometer'],
    ['cool', 'cooling', 'snowflake'],
  ] as const)('mode %s with hvac_action %s shows the %s icon, from raw values', (mode, action, icon) => {
    const tile = selectClimateTile(selectorInputFor([climate(mode, { hvac_action: action })], { config: CONFIG }), REF);
    expect(climateIcon(tile).icon).toBe(icon);
    expect(climateIcon({ ...tile, modeLabel: 'Off' }).icon).toBe(icon);
  });

  it('uses target_temp_step for the stepper when the entity reports it', () => {
    const state = climate('cool', { target_temp_step: 0.5, temperature: 21.5, min_temp: 7, max_temp: 35 });
    const tile = selectClimateTile(selectorInputFor([state], { config: CONFIG, unit: '°C' }), REF);
    expect(tile.setTemperature).toMatchObject({ value: 21.5, min: 7, max: 35, step: 0.5, unit: '°C' });
  });

  it('defaults the step to 1 for °F and 0.5 for °C, with the unit from the unit system', () => {
    const fahrenheit = selectClimateTile(selectorInputFor([climate()], { config: CONFIG, unit: '°F' }), REF);
    expect(fahrenheit.setTemperature).toMatchObject({ step: 1, unit: '°F' });
    const celsius = selectClimateTile(
      selectorInputFor([climate('cool', { temperature: 22, min_temp: 7, max_temp: 35 })], {
        config: CONFIG,
        unit: '°C',
      }),
      REF,
    );
    expect(celsius.setTemperature).toMatchObject({ step: 0.5, unit: '°C' });
  });

  it("offers no stepper when the range is missing, not numeric or inverted, matching the gateway's validation", () => {
    expect(temperatureGrid(climate('heat', { min_temp: 7, max_temp: 35 }).attributes, '°C')).toEqual({
      min: 7,
      max: 35,
      step: 0.5,
    });
    for (const range of [
      { min_temp: undefined, max_temp: undefined },
      { min_temp: '7', max_temp: '35' },
      { min_temp: 30, max_temp: 10 },
    ]) {
      const state = climate('heat', range);
      expect(temperatureGrid(state.attributes, '°C')).toBeUndefined();
      expect(selectClimateTile(selectorInputFor([state], { config: CONFIG, unit: '°C' }), REF).setTemperature).toBe(
        undefined,
      );
    }
  });

  it('evaluates the stepper with a value the stepper can produce, even for an off-grid observed target', () => {
    const gateway = new FakeGateway();
    const evaluate = vi.spyOn(gateway, 'evaluate');
    const state = climate('heat', { temperature: 22.3, target_temp_step: 0.5, min_temp: 7.2, max_temp: 30 });
    selectClimateTile(selectorInputFor([state], { config: CONFIG, gateway, unit: '°C' }), REF);
    const probe = evaluate.mock.calls.map(([req]) => req).find((req) => req.kind === 'climate.set_temperature');
    expect(probe).toEqual({ kind: 'climate.set_temperature', entity: CLIMATE, temperature: 22.5 });
    expect(isStepValue(22.5, { min: 7.2, max: 30, step: 0.5 })).toBe(true);
  });

  it('offers no stepper without TARGET_TEMPERATURE, and none while the target is null', () => {
    const unsupported = selectClimateTile(
      selectorInputFor([climate('cool', { supported_features: 0 })], { config: CONFIG }),
      REF,
    );
    expect(unsupported.setTemperature).toBeUndefined();
    expect(unsupported.target).toBeUndefined();
    const noTarget = selectClimateTile(
      selectorInputFor([climate('off', { temperature: null })], { config: CONFIG }),
      REF,
    );
    expect(noTarget.setTemperature).toBeUndefined();
    expect(noTarget.target).toEqual({ kind: 'absent', reason: 'no-data', label: 'No data' });
  });

  it('builds HVAC modes from hvac_modes; the current mode is pressed and disabled, the rest ask the gateway', () => {
    const gateway = new FakeGateway();
    const tile = selectClimateTile(selectorInputFor([climate()], { config: CONFIG, gateway }), REF);
    expect(tile.hvacModes?.options.map((option) => [option.value, option.label, option.pressed])).toEqual([
      ['off', 'Off', false],
      ['cool', 'Cool', true],
      ['heat', 'Heat', false],
      ['fan_only', 'Fan only', false],
    ]);
    expect(tile.hvacModes?.options[1]?.availability).toEqual({
      enabled: false,
      reason: 'not-applicable',
      message: 'Current mode',
    });
    expect(tile.hvacModes?.options[0]?.availability).toEqual({ enabled: true, confirm: false });
  });

  it('disables every other mode while a ticket on the device is in flight', () => {
    const gateway = new FakeGateway();
    gateway.request({ kind: 'climate.set_hvac_mode', entity: entityId(CLIMATE), mode: 'heat' });
    const tile = selectClimateTile(selectorInputFor([climate()], { config: CONFIG, gateway }), REF);
    const others = tile.hvacModes?.options.filter((option) => !option.pressed) ?? [];
    expect(others.map((option) => option.availability)).toEqual(
      others.map(() => ({
        enabled: false,
        reason: 'busy',
        message: 'Waiting for Bedroom to respond to the last request.',
      })),
    );
    expect(tile.hvacModes?.pending?.kind).toBe('climate.set_hvac_mode');
  });

  it.each([
    ['unavailable', [testEntity(CLIMATE, 'unavailable')], {}, 'Unavailable'],
    ['unknown', [testEntity(CLIMATE, 'unknown')], {}, 'Unknown'],
    ['missing-binding', [], {}, 'Not found'],
    ['loading', [], { ready: false }, 'Loading'],
  ] as const)('%s keeps its own label and offers no controls', (status, states, store, label) => {
    const tile = selectClimateTile(selectorInputFor(states, { config: CONFIG, store }), REF);
    expect(tile.status).toBe(status);
    expect(tile.modeLabel).toBe(label);
    expect(tile.current).toMatchObject({ kind: 'absent', label });
    expect(tile.setTemperature).toBeUndefined();
    expect(tile.hvacModes).toBeUndefined();
  });

  it('shows the last known values as stale while disconnected', () => {
    const tile = selectClimateTile(selectorInputFor([climate()], { config: CONFIG, store: { connected: false } }), REF);
    expect(tile.status).toBe('disconnected');
    expect(tile.current).toEqual({ kind: 'value', text: '74°', stale: true });
  });

  it('never shows a null current temperature as 0', () => {
    const tile = selectClimateTile(
      selectorInputFor([climate('cool', { current_temperature: null })], { config: CONFIG }),
      REF,
    );
    expect(tile.current).toEqual({ kind: 'absent', reason: 'no-data', label: 'No data' });
  });
});

describe('bed tile (read-only by construction)', () => {
  it('has no control fields and never asks the gateway about the bed', () => {
    const gateway = new FakeGateway();
    const evaluate = vi.spyOn(gateway, 'evaluate');
    const state = testEntity(BED, 'heat_cool', {
      current_temperature: 81,
      temperature: 79,
      supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
    });
    const input = selectorInputFor([state], { config: { bed_comfort: [BED] }, gateway });
    const tile = selectBedTile(input, { entity: entityId(BED), name: 'Bed, left side' });
    expect(Object.keys(tile).sort()).toEqual(['current', 'key', 'name', 'status', 'target']);
    expect(tile.current).toMatchObject({ kind: 'value', text: '81°' });
    selectComfort(input);
    expect(evaluate.mock.calls.filter(([req]) => 'entity' in req && req.entity === BED)).toEqual([]);
  });
});

describe('Climate panel budget and summary (§6.2.1)', () => {
  const fan = (id: string) => testEntity(id, 'on', { supported_features: FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF });
  const bed = testEntity(BED, 'heat_cool', { current_temperature: 80 });
  const fans = ['fan.demo_purifier', 'fan.demo_study_air_cleaner', 'fan.demo_loft_air_cleaner'];

  it('shows at most two tiles, climate first, then air, then bed, and counts the rest', () => {
    const input = selectorInputFor([climate(), ...fans.map(fan), bed], {
      config: { climate: [CLIMATE], air: fans, bed_comfort: [BED] },
    });
    const vm = selectComfort(input);
    expect(vm.climate.map((tile) => tile.key)).toEqual([CLIMATE]);
    expect(vm.air.map((tile) => tile.key)).toEqual([FAN]);
    expect(vm.bed).toEqual([]);
    expect(vm.overflow).toBe(3);
    expect(selectComfortTiles(input).map((tile) => tile.kind)).toEqual(['climate', 'air', 'air', 'air', 'bed']);
  });

  it('shows bed tiles when nothing else fills the budget', () => {
    const vm = selectComfort(selectorInputFor([bed], { config: { bed_comfort: [BED] } }));
    expect(vm.bed.map((tile) => tile.key)).toEqual([BED]);
    expect(vm.overflow).toBe(0);
  });

  it('shows a second row when the root raises the budget, and counts what is still left', () => {
    const input = selectorInputFor([climate(), ...fans.map(fan), bed], {
      config: { climate: [CLIMATE], air: fans, bed_comfort: [BED] },
    });
    const vm = selectComfort(input, 4);
    expect(vm.climate.map((tile) => tile.key)).toEqual([CLIMATE]);
    expect(vm.air.map((tile) => tile.key)).toEqual(fans);
    expect(vm.overflow).toBe(1);
  });

  it('reads the pill like the reference, "74° inside": the live current temperature of the first climate device', () => {
    const vm = selectComfort(selectorInputFor([climate()], { config: CONFIG }));
    expect(vm.summary).toEqual({ label: '74° inside', tone: 'neutral' });
    const ids = ['climate.demo_zone_0', 'climate.demo_zone_1'];
    const zones = [
      testEntity(ids[0] as string, 'cool', { current_temperature: 71 }),
      testEntity(ids[1] as string, 'heat', { current_temperature: 66 }),
    ];
    expect(selectComfort(selectorInputFor(zones, { config: { climate: ids } })).summary?.label).toBe('71° inside');
  });

  it('skips a device without a live reading and shows no pill when none has one', () => {
    const ids = ['climate.demo_zone_0', 'climate.demo_zone_1'];
    const zones = [
      testEntity(ids[0] as string, 'unavailable'),
      testEntity(ids[1] as string, 'heat', { current_temperature: 66 }),
    ];
    expect(selectComfort(selectorInputFor(zones, { config: { climate: ids } })).summary?.label).toBe('66° inside');
    expect(
      selectComfort(selectorInputFor([climate('cool', { current_temperature: undefined })], { config: CONFIG }))
        .summary,
    ).toBeUndefined();
  });

  it('never reports a stale or absent reading', () => {
    const stale = selectComfortTiles(selectorInputFor([climate()], { config: CONFIG, store: { connected: false } }));
    expect(comfortSummary(stale)).toBeUndefined();
  });

  it('asks the gateway for every control it renders and keeps Availability verbatim', () => {
    const disabled: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are turned off.' };
    const gateway = new FakeGateway();
    gateway.availability = disabled;
    const tile = selectClimateTile(selectorInputFor([climate()], { config: CONFIG, gateway }), REF);
    expect(tile.setTemperature?.availability).toEqual(disabled);
    expect(tile.hvacModes?.options.filter((option) => !option.pressed).map((option) => option.availability)).toEqual([
      disabled,
      disabled,
      disabled,
    ]);
  });
});
