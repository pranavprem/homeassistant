/** selectAirTile and the shared choice helpers (§7.1 fan rows, §7.2, §16.10 seam). */
import { describe, expect, it, vi } from 'vitest';
import { fanSpeedRequest } from '../../src/components/shared/agr-fan-controls.ts';
import type { Availability } from '../../src/ha/actions/types.ts';
import { FAN_FEATURE } from '../../src/ha/features.ts';
import { selectAirTile, speedPercentage } from '../../src/model/air.ts';
import { choiceReason, humanizeOption, stringList } from '../../src/model/choice.ts';
import type { ChoiceVM, StepperVM } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { selectorInputFor } from './support.ts';

const FAN = 'fan.demo_purifier';
const REF = { entity: entityId(FAN), name: 'Purifier' };
const CONFIG = { air: [FAN] };
const ALL = FAN_FEATURE.SET_SPEED | FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF;

function fan(state: string, attributes: Record<string, unknown> = {}) {
  return testEntity(FAN, state, {
    percentage: 40,
    percentage_step: 20,
    preset_mode: 'Sleep',
    preset_modes: ['Auto', 'Sleep', 'Turbo'],
    supported_features: ALL,
    ...attributes,
  });
}

function tileFor(state: ReturnType<typeof fan> | undefined, gateway = new FakeGateway(), store = {}) {
  return selectAirTile(selectorInputFor(state ? [state] : [], { config: CONFIG, gateway, store }), REF, 'air');
}

/** HA's percentage for speed n of `count`: (n × 100) // count (homeassistant/util/percentage.py). */
function haPercentage(n: number, count: number): number {
  return Math.floor((n * 100) / count);
}

/** Decimal places of a number's attribute string, the form a browser parses for min, max, step and value. */
function decimalPlaces(value: number): number {
  return String(value).split('.')[1]?.length ?? 0;
}

/** The number as an integer count of 10^-scale units (non-negative values without exponents only). */
function scaledUnits(value: number, scale: number): bigint {
  const [whole = '0', fraction = ''] = String(value).split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
}

/**
 * The value a browser gives input[type=range] (HTML "range" value sanitization, which happy-dom doesn't do): clamped
 * to [min, max], snapped to the nearest step from min, and never past the last step at or below max. Browsers do this
 * in decimal on the attribute strings (Chromium's Decimal); JS floats would round 3 × (100 / 3) to exactly 100.
 */
function rangeSanitize(value: number, slider: Pick<StepperVM, 'min' | 'max' | 'step'>): number {
  const numbers = [value, slider.min, slider.max, slider.step];
  const scale = Math.max(...numbers.map(decimalPlaces));
  const [raw = 0n, min = 0n, max = 0n, step = 1n] = numbers.map((n) => scaledUnits(n, scale));
  const clamped = raw < min ? min : raw > max ? max : raw;
  const top = min + ((max - min) / step) * step;
  const nearest = min + ((2n * (clamped - min) + step) / (2n * step)) * step;
  return Number(nearest > top ? top : nearest) / 10 ** scale;
}

function speedSlider(count: number, percentage: number): StepperVM {
  const slider = tileFor(fan('on', { percentage_step: 100 / count, percentage, preset_mode: null })).percentage;
  if (slider === undefined) throw new Error('speed slider missing');
  return slider;
}

describe('selectAirTile', () => {
  it('reads an on purifier: preset detail, speed slider on its step, presets, and a turn-off toggle', () => {
    const gateway = new FakeGateway();
    const evaluate = vi.spyOn(gateway, 'evaluate');
    const tile = tileFor(fan('on'), gateway);
    expect(tile).toMatchObject({
      key: FAN,
      name: 'Purifier',
      status: 'available',
      power: 'on',
      detail: { kind: 'value', text: 'Sleep' },
      toggle: { enabled: true },
      percentage: { value: 40, min: 0, max: 100, step: 20, unit: '%' },
    });
    expect(tile.presets?.options.map((option) => [option.value, option.pressed])).toEqual([
      ['Auto', false],
      ['Sleep', true],
      ['Turbo', false],
    ]);
    expect(evaluate).toHaveBeenCalledWith({ kind: 'fan.turn_off', entity: FAN });
    expect(evaluate).toHaveBeenCalledWith({ kind: 'fan.set_percentage', entity: FAN, percentage: 20 });
  });

  it('shows the speed when no preset is active, and "Off" with a turn-on toggle when off', () => {
    expect(tileFor(fan('on', { preset_mode: null })).detail).toMatchObject({ text: '40%' });
    const gateway = new FakeGateway();
    const evaluate = vi.spyOn(gateway, 'evaluate');
    const off = tileFor(fan('off', { percentage: null, preset_mode: null }), gateway);
    expect(off).toMatchObject({ power: 'off', detail: { text: 'Off' }, percentage: { value: 0 } });
    expect(evaluate).toHaveBeenCalledWith({ kind: 'fan.turn_on', entity: FAN });
  });

  it('gates speed and presets by feature bits (presets need PRESET_MODE or SET_SPEED, §7.1)', () => {
    const presetOnly = tileFor(fan('on', { supported_features: FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_OFF }));
    expect(presetOnly.percentage).toBeUndefined();
    expect(presetOnly.presets).toBeDefined();
    const speedOnly = tileFor(fan('on', { supported_features: FAN_FEATURE.SET_SPEED, preset_modes: [] }));
    expect(speedOnly.percentage).toBeDefined();
    expect(speedOnly.presets).toBeUndefined();
    const neither = tileFor(fan('on', { supported_features: FAN_FEATURE.TURN_OFF }));
    expect(neither.percentage).toBeUndefined();
    expect(neither.presets).toBeUndefined();
  });

  it('keeps a fractional percentage_step (three speeds) for the slider', () => {
    expect(tileFor(fan('on', { percentage_step: 100 / 3 })).percentage?.step).toBeCloseTo(33.333, 3);
  });

  it("reproduces Chromium's clamp of HA's raw three-speed step, which the slider grid must avoid", () => {
    // 3 × 33.333333333333336 is just over 100, so a browser tops the track out at the second speed.
    expect(rangeSanitize(100, { min: 0, max: 100, step: 100 / 3 })).toBeCloseTo(66.667, 3);
  });

  it.each([3, 4, 5, 6, 7, 12])('%i speeds: the top of the grid reaches 100 and sends set_percentage 100', (count) => {
    const slider = speedSlider(count, 100);
    expect(slider).toMatchObject({ value: 100, min: 0, max: 100 });
    const top = Math.round(slider.max / slider.step) * slider.step;
    expect(top).toBeLessThanOrEqual(slider.max);
    // A fan at 100% puts the thumb at the end of the track, and the end of the track maps back to 100.
    expect(rangeSanitize(slider.value, slider)).toBeCloseTo(top, 9);
    expect(slider.max - top).toBeLessThan(0.001);
    expect(speedPercentage(top)).toBe(100);
    expect(fanSpeedRequest(entityId(FAN), top)).toEqual({ kind: 'fan.set_percentage', entity: FAN, percentage: 100 });
  });

  it.each([3, 6, 7])("%i speeds: every grid point sends HA's own percentage for that speed", (count) => {
    const slider = speedSlider(count, 100);
    for (let n = 1; n <= count; n += 1) {
      const position = rangeSanitize(n * slider.step, slider);
      expect(fanSpeedRequest(entityId(FAN), position)).toEqual({
        kind: 'fan.set_percentage',
        entity: FAN,
        percentage: haPercentage(n, count),
      });
      // The observed percentage HA reports for speed n puts the thumb on grid point n.
      expect(rangeSanitize(haPercentage(n, count), slider)).toBeCloseTo(position, 9);
    }
  });

  it('starts the speed track at the first speed when the device cannot turn off', () => {
    const noOff = tileFor(fan('on', { percentage_step: 25, supported_features: FAN_FEATURE.SET_SPEED }));
    expect(noOff.percentage).toMatchObject({ min: 25, max: 100, step: 25 });
  });

  it.each([0, -5, 'x', 150])('falls back to a step of 1 for an unusable percentage_step (%s)', (step) => {
    expect(tileFor(fan('on', { percentage_step: step })).percentage?.step).toBe(1);
  });

  it("marks the toggle unsupported when the device lacks the bit, but keeps the gateway's reason first", () => {
    const noTurnOff = tileFor(fan('on', { supported_features: FAN_FEATURE.SET_SPEED | FAN_FEATURE.TURN_ON }));
    expect(noTurnOff.toggle).toEqual({
      enabled: false,
      reason: 'unsupported',
      message: "Purifier doesn't support this control.",
    });
    const controlsOff: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are off.' };
    const gateway = new FakeGateway();
    gateway.availability = controlsOff;
    expect(tileFor(fan('on', { supported_features: FAN_FEATURE.SET_SPEED }), gateway).toggle).toEqual(controlsOff);
  });

  it('with an unknown state, enables the toggle only when turning on and off are both allowed', () => {
    const gateway = new FakeGateway();
    gateway.availability = (req) =>
      req.kind === 'fan.turn_off'
        ? { enabled: false, reason: 'unsupported', message: 'No off.' }
        : { enabled: true, confirm: false };
    const tile = tileFor(fan('unknown'), gateway);
    expect(tile.power).toBe('unknown');
    expect(tile.detail).toMatchObject({ kind: 'absent', label: 'Unknown' });
    expect(tile.toggle).toEqual({ enabled: false, reason: 'unsupported', message: 'No off.' });
  });

  it.each([
    ['unavailable', fan('unavailable'), {}, 'Unavailable'],
    ['missing-binding', undefined, {}, 'Not found'],
    ['loading', undefined, { ready: false }, 'Loading'],
  ] as const)('%s: power unknown, its own label, no speed or presets', (status, state, store, label) => {
    const tile = tileFor(state, new FakeGateway(), store);
    expect(tile).toMatchObject({ status, power: 'unknown', detail: { kind: 'absent', label } });
    expect(tile.percentage).toBeUndefined();
    expect(tile.presets).toBeUndefined();
  });

  it('keeps last known values, marked stale, while disconnected', () => {
    const tile = tileFor(fan('on'), new FakeGateway(), { connected: false });
    expect(tile).toMatchObject({ status: 'disconnected', power: 'on', detail: { text: 'Sleep', stale: true } });
  });

  it('disables every other preset while a ticket is in flight and exposes the ticket', () => {
    const gateway = new FakeGateway();
    gateway.request({ kind: 'fan.set_preset_mode', entity: entityId(FAN), preset: 'Auto' });
    const tile = tileFor(fan('on'), gateway);
    expect(tile.pending?.phase).toBe('pending');
    expect(tile.presets?.pending?.kind).toBe('fan.set_preset_mode');
    expect(
      tile.presets?.options.filter((option) => !option.pressed).every((option) => !option.availability.enabled),
    ).toBe(true);
  });

  it('uses the role only for the fallback name', () => {
    const input = selectorInputFor([testEntity(FAN, 'on')], { config: CONFIG });
    expect(selectAirTile(input, { entity: entityId(FAN) }, 'room_purifier').name).toBe('Purifier');
    expect(selectAirTile(input, { entity: entityId(FAN) }, 'air').name).toBe('Air purifier');
  });
});

describe('fan speed requests', () => {
  it.each([
    [0, { kind: 'fan.turn_off', entity: FAN }],
    [100 / 3, { kind: 'fan.set_percentage', entity: FAN, percentage: 33 }],
    // HA maps 67 to speed 3 of 3, so speed 2 must send 66 (floor, as HA itself reports it), never round up.
    [200 / 3, { kind: 'fan.set_percentage', entity: FAN, percentage: 66 }],
    [66.666666, { kind: 'fan.set_percentage', entity: FAN, percentage: 66 }],
    [99.999999, { kind: 'fan.set_percentage', entity: FAN, percentage: 100 }],
    [100, { kind: 'fan.set_percentage', entity: FAN, percentage: 100 }],
    [40, { kind: 'fan.set_percentage', entity: FAN, percentage: 40 }],
    [0.4, { kind: 'fan.set_percentage', entity: FAN, percentage: 1 }],
  ])('%d%% → %j (set_percentage takes integers 1–100 only)', (value, request) => {
    expect(fanSpeedRequest(entityId(FAN), value)).toEqual(request);
  });

  it('maps whole percentages to themselves, so a draft compares equal to the observed value', () => {
    for (let percentage = 0; percentage <= 100; percentage += 1) expect(speedPercentage(percentage)).toBe(percentage);
  });
});

describe('choice helpers', () => {
  it('humanizes raw option values and keeps mixed case', () => {
    expect(humanizeOption('fan_only')).toBe('Fan only');
    expect(humanizeOption('sleep')).toBe('Sleep');
    expect(humanizeOption('Turbo')).toBe('Turbo');
  });

  it('keeps distinct non-empty strings only', () => {
    expect(stringList(['Auto', '', 3, 'Auto', 'Sleep', null])).toEqual(['Auto', 'Sleep']);
    expect(stringList('Auto')).toEqual([]);
  });

  it('surfaces a reason only when every other option shares it', () => {
    const busy = { enabled: false, reason: 'busy', message: 'Waiting.' } as const;
    const current = { enabled: false, reason: 'not-applicable', message: 'Current mode' } as const;
    const choice = (others: readonly Availability[]): ChoiceVM => ({
      label: 'Mode',
      options: [
        { value: 'cool', label: 'Cool', pressed: true, availability: current },
        ...others.map((availability, index) => ({ value: `m${index}`, label: 'M', pressed: false, availability })),
      ],
    });
    expect(choiceReason(choice([busy, busy]))).toBe('Waiting.');
    expect(choiceReason(choice([busy, { enabled: true, confirm: false }]))).toBeUndefined();
    expect(choiceReason(choice([]))).toBeUndefined();
  });
});
