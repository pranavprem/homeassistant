/**
 * Request shape and argument validation (§4.7 steps 1 and 10, §12.1 row 8): strict shapes refuse injected keys,
 * arguments respect each entity's own limits, lists and feature bits, and temperatures accept exactly the values
 * stepValue can produce, so the stepper and the gateway can never disagree.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { frozenActionRequest, type ActionRequest } from '../../src/ha/actions/types.ts';
import { argumentsValid } from '../../src/ha/actions/validate-args.ts';
import { stepValue, temperatureGrid, temperatureStep } from '../../src/domain/steps.ts';
import { entity, FEATURES, harness, IDS } from './harness.ts';

const e = (id: string): EntityId => id as EntityId;
const THERMOSTAT = e(IDS.thermostat);
const temperature = (value: number): ActionRequest => ({
  kind: 'climate.set_temperature',
  entity: THERMOSTAT,
  temperature: value,
});

/**
 * §7.1, written independently of the implementation: in range, and either a multiple of the step (tolerance 1e-6)
 * or exactly min_temp or max_temp.
 */
function onGridPerSpec(value: number, grid: { min: number; max: number; step: number }): boolean {
  if (value < grid.min || value > grid.max) return false;
  if (value === grid.min || value === grid.max) return true;
  const steps = value / grid.step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

describe('request shape (step 1, through frozenActionRequest)', () => {
  const isRequest = (value: unknown) => frozenActionRequest(value) !== undefined;

  it('accepts exactly the keys of each variant', () => {
    expect(isRequest({ kind: 'light.turn_on', entity: 'light.demo_kitchen' })).toBe(true);
    expect(isRequest({ kind: 'garage.open' })).toBe(true);
    expect(isRequest({ kind: 'security.run', role: 'hold_away' })).toBe(true);
    expect(isRequest({ kind: 'room.lights_off', room: 0 })).toBe(true);
    expect(isRequest(Object.assign(Object.create(null), { kind: 'studio_monitors.run' }))).toBe(true);
    // §18
    expect(isRequest({ kind: 'switch.turn_on', entity: 'switch.demo_desk_lamp' })).toBe(true);
    expect(isRequest({ kind: 'switch.turn_off', entity: 'switch.demo_desk_lamp' })).toBe(true);
    expect(isRequest({ kind: 'shortcut.run', role: 'lights_toggle' })).toBe(true);
    expect(isRequest({ kind: 'shortcut.run', role: 'curtains_toggle' })).toBe(true);
  });

  it.each([
    ['extra domain', { kind: 'light.turn_on', entity: 'light.demo_kitchen', domain: 'light' }],
    ['extra service', { kind: 'light.turn_on', entity: 'light.demo_kitchen', service: 'turn_on' }],
    ['extra data', { kind: 'garage.close', data: {} }],
    ['extra entity_id', { kind: 'studio_monitors.run', entity_id: 'script.demo_other' }],
    ['missing field', { kind: 'light.set_brightness', entity: 'light.demo_kitchen' }],
    ['wrong field type', { kind: 'media.volume_mute', entity: 'media_player.demo_lounge', muted: 'true' }],
    ['malformed entity ID', { kind: 'fan.turn_on', entity: 'fan.demo__purifier' }],
    ['fractional room', { kind: 'room.lights_on', room: 1.5 }],
    ['unknown role', { kind: 'security.run', role: 'arm_away' }],
    ['unknown kind', { kind: 'switch.toggle', entity: 'switch.demo_plug' }],
    ['cross-domain kind', { kind: 'homeassistant.turn_on', entity: 'switch.demo_plug' }],
    ['a reading kind', { kind: 'collection.read', entity: 'sensor.demo_ink' }],
    ['unknown shortcut role', { kind: 'shortcut.run', role: 'garage_toggle' }],
    ['shortcut role in another case', { kind: 'shortcut.run', role: 'Lights_toggle' }],
    ['shortcut without a role', { kind: 'shortcut.run' }],
    ['shortcut with a script', { kind: 'shortcut.run', role: 'lights_toggle', entity: 'script.demo_other' }],
    ['shortcut with variables', { kind: 'shortcut.run', role: 'lights_toggle', variables: { all: true } }],
    ['shortcut with a confirmation flag', { kind: 'shortcut.run', role: 'lights_toggle', confirmed: true }],
    ['switch without an entity', { kind: 'switch.turn_on' }],
    ['switch with a room', { kind: 'switch.turn_off', entity: 'switch.demo_plug', room: 0 }],
    ['switch with data', { kind: 'switch.turn_on', entity: 'switch.demo_plug', data: {} }],
    ['malformed switch ID', { kind: 'switch.turn_on', entity: 'switch.Demo' }],
    ['symbol key', { kind: 'garage.open', [Symbol('x')]: 1 }],
    ['own __proto__ key', JSON.parse('{"kind": "garage.open", "__proto__": {"x": 1}}')],
    ['getter', Object.defineProperty({}, 'kind', { get: () => 'garage.open', enumerable: true })],
    ['array', ['light.turn_on']],
    ['string', 'light.turn_on'],
    ['undefined', undefined],
  ])('refuses %s', (_label, input) => {
    expect(isRequest(input)).toBe(false);
  });

  it('knows every kind and nothing else', () => {
    expect(isRequest({ kind: 'media.select_source', entity: 'media_player.demo_lounge', source: 'TV' })).toBe(true);
    expect(isRequest({ kind: 'toString' })).toBe(false);
    expect(isRequest({ kind: '__proto__' })).toBe(false);
  });

  it("reads the caller's object exactly once (prototype, keys and each descriptor) and never through get", () => {
    const reads: string[] = [];
    const target = { kind: 'security.run', role: 'silence_sound' };
    const proxy = new Proxy(target, {
      getPrototypeOf: (t) => (reads.push('prototype'), Reflect.getPrototypeOf(t)),
      ownKeys: (t) => (reads.push('keys'), Reflect.ownKeys(t)),
      getOwnPropertyDescriptor: (t, key) => (
        reads.push(`descriptor:${String(key)}`),
        Reflect.getOwnPropertyDescriptor(t, key)
      ),
      get: (t, key) => (reads.push(`get:${String(key)}`), Reflect.get(t, key)),
    });
    const copy = frozenActionRequest(proxy);
    expect(copy).toEqual({ kind: 'security.run', role: 'silence_sound' });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(reads.sort()).toEqual(['descriptor:kind', 'descriptor:role', 'keys', 'prototype']);
  });

  it('never throws: a Proxy whose traps throw is simply not a request', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    expect(frozenActionRequest(hostile)).toBeUndefined();
  });
});

describe('argumentsValid (step 10)', () => {
  const UNIT = { temperatureUnit: '°F' };
  const thermostat = entity(IDS.thermostat, 'cool', { min_temp: 45, max_temp: 95, temperature: 72 });

  it('temperature: finite, within min/max and on the grid', () => {
    expect(argumentsValid(temperature(72), thermostat, UNIT)).toBe(true);
    expect(argumentsValid(temperature(45), thermostat, UNIT)).toBe(true);
    expect(argumentsValid(temperature(95), thermostat, UNIT)).toBe(true);
    expect(argumentsValid(temperature(96), thermostat, UNIT)).toBe(false);
    expect(argumentsValid(temperature(44), thermostat, UNIT)).toBe(false);
    expect(argumentsValid(temperature(72.5), thermostat, UNIT)).toBe(false);
    expect(argumentsValid(temperature(Number.NaN), thermostat, UNIT)).toBe(false);
  });

  it('temperature fails closed without min_temp or max_temp', () => {
    expect(argumentsValid(temperature(72), entity(IDS.thermostat, 'cool', {}), UNIT)).toBe(false);
    expect(temperatureGrid({ min_temp: 30, max_temp: 10 }, '°C')).toBeUndefined();
  });

  it('step: target_temp_step, else 1 °F or 0.5 °C', () => {
    expect(temperatureStep({ target_temp_step: 0.1 }, '°F')).toBe(0.1);
    expect(temperatureStep({}, '°F')).toBe(1);
    expect(temperatureStep({}, '°C')).toBe(0.5);
    expect(temperatureStep({ target_temp_step: 0 }, '°C')).toBe(0.5);
    expect(temperatureStep({ target_temp_step: '1' }, '°C')).toBe(0.5);
  });

  it('accepts an off-grid converted min_temp exactly, as stepValue can reach it', () => {
    const celsius = entity(IDS.thermostat, 'heat', { min_temp: 7.2, max_temp: 35 });
    const unit = { temperatureUnit: '°C' };
    expect(stepValue(7.5, -1, { min: 7.2, max: 35, step: 0.5 })).toBe(7.2);
    expect(argumentsValid(temperature(7.2), celsius, unit)).toBe(true);
    expect(argumentsValid(temperature(7.3), celsius, unit)).toBe(false);
  });

  it('accepts every stepValue output and nothing off the grid (property test over seeded random grids)', () => {
    const random = mulberry32(20261003);
    for (let run = 0; run < 400; run += 1) {
      const step = [0.1, 0.5, 1, 2, 0.25][Math.floor(random() * 5)] ?? 1;
      const min = Math.round((random() * 20 + 5) * 10) / 10;
      const max = Math.round((min + 5 + random() * 30) * 10) / 10;
      const grid = { min, max, step };
      const subject = entity(IDS.thermostat, 'heat', { min_temp: min, max_temp: max, target_temp_step: step });
      const base = min + random() * (max - min);
      for (const direction of [1, -1] as const) {
        const value = stepValue(base, direction, grid);
        expect(argumentsValid(temperature(value), subject, UNIT), JSON.stringify({ grid, base, value })).toBe(true);
      }
      const probe = Math.round((min + random() * (max - min)) * 1000) / 1000;
      expect(argumentsValid(temperature(probe), subject, UNIT), JSON.stringify({ grid, probe })).toBe(
        onGridPerSpec(probe, grid),
      );
    }
  });

  it('modes, presets and sources must be in the entity list exactly', () => {
    const climate = entity(IDS.thermostat, 'cool', { hvac_modes: ['off', 'cool'] });
    expect(argumentsValid({ kind: 'climate.set_hvac_mode', entity: THERMOSTAT, mode: 'cool' }, climate, UNIT)).toBe(
      true,
    );
    expect(argumentsValid({ kind: 'climate.set_hvac_mode', entity: THERMOSTAT, mode: ' cool' }, climate, UNIT)).toBe(
      false,
    );
    const fan = entity(IDS.purifier, 'on', { preset_modes: ['auto'] });
    const preset = (value: string): ActionRequest => ({
      kind: 'fan.set_preset_mode',
      entity: e(IDS.purifier),
      preset: value,
    });
    expect(argumentsValid(preset('auto'), fan, UNIT)).toBe(true);
    expect(argumentsValid(preset('Auto'), fan, UNIT)).toBe(false);
    const player = entity(IDS.speaker, 'on', { source_list: 'Radio' });
    const source: ActionRequest = { kind: 'media.select_source', entity: e(IDS.speaker), source: 'Radio' };
    expect(argumentsValid(source, player, UNIT)).toBe(false);
  });

  it('volume is finite within 0–1; percentages are integers 1–100', () => {
    const volume = (level: number): ActionRequest => ({ kind: 'media.volume_set', entity: e(IDS.speaker), level });
    expect(argumentsValid(volume(0), undefined, UNIT)).toBe(true);
    expect(argumentsValid(volume(1), undefined, UNIT)).toBe(true);
    expect(argumentsValid(volume(1.01), undefined, UNIT)).toBe(false);
    expect(argumentsValid(volume(Number.POSITIVE_INFINITY), undefined, UNIT)).toBe(false);
    const pct = (value: number): ActionRequest => ({
      kind: 'fan.set_percentage',
      entity: e(IDS.purifier),
      percentage: value,
    });
    expect(argumentsValid(pct(1), undefined, UNIT)).toBe(true);
    expect(argumentsValid(pct(100), undefined, UNIT)).toBe(true);
    expect(argumentsValid(pct(12.5), undefined, UNIT)).toBe(false);
  });
});

describe('gateway validation outcomes (§12.1 row 8)', () => {
  it('out of range, off step, or not in the list → invalid-argument', () => {
    const h = harness();
    const reasons = [
      temperature(120),
      temperature(72.4),
      { kind: 'climate.set_hvac_mode', entity: THERMOSTAT, mode: 'eco' } as const,
      { kind: 'fan.set_preset_mode', entity: e(IDS.purifier), preset: 'nap' } as const,
      { kind: 'media.select_source', entity: e(IDS.speaker), source: 'Bluetooth' } as const,
      { kind: 'media.volume_set', entity: e(IDS.speaker), level: 1.5 } as const,
    ].map((req) => h.gateway.evaluate(req));
    for (const availability of reasons)
      expect(availability).toMatchObject({ enabled: false, reason: 'invalid-argument' });
  });

  it('brightness on an onoff-only light and a missing feature bit → unsupported', () => {
    const h = harness();
    expect(h.gateway.evaluate({ kind: 'light.set_brightness', entity: e(IDS.kitchenStrip), pct: 50 })).toMatchObject({
      enabled: false,
      reason: 'unsupported',
    });
    h.patch(IDS.speaker, { supported_features: FEATURES.media & ~2048 });
    expect(h.gateway.evaluate({ kind: 'media.select_source', entity: e(IDS.speaker), source: 'TV' })).toMatchObject({
      enabled: false,
      reason: 'unsupported',
    });
  });

  it('missing service → service-missing; unconfigured entity → not-allowed', () => {
    const h = harness();
    h.missingServices.add('media_player.select_source');
    expect(h.gateway.evaluate({ kind: 'media.select_source', entity: e(IDS.speaker), source: 'TV' })).toMatchObject({
      enabled: false,
      reason: 'service-missing',
    });
    expect(h.gateway.evaluate({ kind: 'fan.turn_on', entity: e('fan.demo_unconfigured') })).toMatchObject({
      enabled: false,
      reason: 'not-allowed',
    });
  });

  it('a fan ID with a light kind → not-allowed; injected keys → not-allowed', () => {
    const h = harness();
    expect(h.gateway.evaluate({ kind: 'light.turn_off', entity: e(IDS.purifier) })).toMatchObject({
      enabled: false,
      reason: 'not-allowed',
    });
    for (const key of ['domain', 'service', 'data', 'entity_id']) {
      const injected = { kind: 'light.turn_on', entity: IDS.kitchenLight, [key]: 'x' } as unknown as ActionRequest;
      expect(h.gateway.evaluate(injected), key).toMatchObject({ enabled: false, reason: 'not-allowed' });
    }
    expect(h.port.calls).toEqual([]);
  });
});

/** A small seeded PRNG, so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
