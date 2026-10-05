import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { validateConfig, type ConfigIssue, type ValidationResult } from '../../src/config/validate.ts';

const TYPE = 'custom:agraharam-dashboard';

function issuesOf(input: Record<string, unknown>): readonly ConfigIssue[] {
  const result = validateConfig({ type: TYPE, ...input });
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

function okConfig(input: Record<string, unknown>): Extract<ValidationResult, { ok: true }> {
  const result = validateConfig({ type: TYPE, ...input });
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result;
}

function codesAt(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(issuesOf(input).map((issue) => [issue.path, issue.code]));
}

const SECURITY = {
  alarm: 'alarm_control_panel.demo_home',
  policy: 'input_select.demo_policy',
};

describe('validateConfig: top level (rules 1–2)', () => {
  it.each([null, 'demo', 42, ['x'], new Date()])('rejects a non-mapping (%j) with not-object', (input) => {
    expect(validateConfig(input)).toEqual({
      ok: false,
      issues: [{ path: '', code: 'not-object', message: 'The card configuration must be a mapping.' }],
    });
  });

  it('accepts the minimal config with defaults (controls off)', () => {
    const { config, warnings } = okConfig({});
    expect(config).toMatchObject({
      title: 'Agraharam',
      demo: false,
      demoScenario: 'normal',
      controls: false,
      diagnostics: false,
      people: [],
      rooms: [],
      cameras: [],
    });
    expect([...config.bindings]).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('allows HA-managed keys and rejects unknown keys with a did-you-mean hint', () => {
    expect(okConfig({ view_layout: {}, layout_options: {}, grid_options: {}, visibility: [] }).config.demo).toBe(false);
    const [issue] = issuesOf({ camras: [] });
    expect(issue).toEqual({
      path: 'camras',
      code: 'unknown-key',
      message: 'camras: unknown key. Did you mean "cameras"?',
    });
    expect(issuesOf({ zzzzzzzz: 1 })[0]?.message).toBe('zzzzzzzz: unknown key.');
  });

  it('rejects unknown keys inside nested mappings', () => {
    expect(codesAt({ garage: { cover: 'cover.demo_garage', door: 'x' } })).toEqual({ 'garage.door': 'unknown-key' });
  });

  it('checks scalar types, the title length and the demo scenario', () => {
    expect(codesAt({ demo: 'yes', diagnostics: 1, controls: 'true' })).toEqual({
      demo: 'wrong-type',
      diagnostics: 'wrong-type',
      controls: 'wrong-type',
    });
    expect(codesAt({ title: 'x'.repeat(41) })).toEqual({ title: 'too-long' });
    expect(codesAt({ title: '   ' })).toEqual({ title: 'invalid-value' });
    expect(codesAt({ demo: true, demo_scenario: 'chaos' })).toEqual({ demo_scenario: 'invalid-value' });
    expect(okConfig({ title: '  Home  ' }).config.title).toBe('Home');
  });
});

describe('validateConfig: entity references (rules 3 and 5)', () => {
  it('names the path and the expected domains for a wrong domain', () => {
    const [issue] = issuesOf({
      cameras: [
        { entity: 'camera.demo_a', name: 'A' },
        { entity: 'camera.demo_b', name: 'B' },
        { entity: 'camera.demo_c', name: 'C', privacy_entity: 'light.demo_lamp' },
      ],
    });
    expect(issue).toEqual({
      path: 'cameras[2].privacy_entity',
      code: 'wrong-domain',
      message:
        'cameras[2].privacy_entity: expected a switch, binary_sensor or input_boolean entity, got "light.demo_lamp".',
    });
  });

  it.each(['Light.Kitchen', 'light.', '.demo', 'light.demo__x', 'light.demo_', 'light.a.b', ''])(
    'rejects the malformed entity ID %j',
    (id) => {
      expect(codesAt({ weather: id })).toEqual({ weather: 'invalid-entity-id' });
    },
  );

  it('accepts refs as strings or { entity, name } and requires entity in the object form', () => {
    const { config } = okConfig({ people: ['person.demo_a', { entity: 'person.demo_b', name: ' B ' }] });
    expect(config.people).toEqual([{ entity: 'person.demo_a' }, { entity: 'person.demo_b', name: 'B' }]);
    expect(codesAt({ people: [{ name: 'No entity' }] })).toEqual({ 'people[0].entity': 'required' });
  });

  it('allows only scripts for security actions and studio monitors, so no raw arm or disarm is configurable', () => {
    expect(
      codesAt({
        security: {
          ...SECURITY,
          actions: { disarm_hold: 'alarm_control_panel.demo_home', hold_away: 'input_select.demo_policy' },
        },
        studio_monitors_script: 'switch.demo_monitors',
      }),
    ).toEqual({
      'security.actions.disarm_hold': 'wrong-domain',
      'security.actions.hold_away': 'wrong-domain',
      studio_monitors_script: 'wrong-domain',
    });
  });

  it('enforces list types and limits', () => {
    expect(codesAt({ people: 'person.demo_a' })).toEqual({ people: 'wrong-type' });
    const people = Array.from({ length: 9 }, (_, index) => `person.demo_${index}`);
    expect(codesAt({ people })).toEqual({ people: 'too-many' });
  });

  it('requires the mandatory fields of each section', () => {
    expect(
      codesAt({
        rooms: [{}],
        vacuums: [{}],
        appliances: [{}],
        cameras: [{}],
        garage: {},
        vehicle: {},
        security: {},
      }),
    ).toEqual({
      'rooms[0].name': 'required',
      'rooms[0].lights': 'required',
      'vacuums[0].entity': 'required',
      'appliances[0].name': 'required',
      'appliances[0].status_sensor': 'required',
      'cameras[0].entity': 'required',
      'cameras[0].name': 'required',
      'garage.cover': 'required',
      'vehicle.name': 'required',
      'vehicle.battery_sensor': 'required',
      'vehicle.range_sensor': 'required',
      'security.alarm': 'required',
      'security.policy': 'required',
    });
  });
});

describe('validateConfig: action safety (rules 4 and 6)', () => {
  it('rejects one entity in two action families, but lets read-only roles overlap', () => {
    const [issue] = issuesOf({
      garage: { cover: 'cover.demo_garage' },
      rooms: [{ name: 'Garage', lights: [], curtains: ['cover.demo_garage'] }],
    });
    expect(issue).toMatchObject({ path: 'garage.cover', code: 'duplicate-actionable' });
    expect(issue?.message).toContain('rooms[0].curtains[0]');
    const { config } = okConfig({
      garage: { cover: 'cover.demo_garage' },
      security: { ...SECURITY, perimeter: ['cover.demo_garage'] },
    });
    expect(config.bindings.get('cover.demo_garage' as EntityId)).toEqual(['garage_cover', 'perimeter']);
  });

  it('rejects a curtain that is also a monitored entry point or the garage door (rule 4a)', () => {
    expect(
      codesAt({
        security: { ...SECURITY, perimeter: ['binary_sensor.demo_front_door', 'cover.demo_side_gate'] },
        rooms: [{ name: 'Hall', lights: [], curtains: ['cover.demo_blind', 'cover.demo_side_gate'] }],
      }),
    ).toEqual({ 'rooms[0].curtains[1]': 'curtain-conflict' });
    const issues = issuesOf({
      garage: { cover: 'cover.demo_garage' },
      rooms: [{ name: 'Garage', lights: [], curtains: ['cover.demo_garage'] }],
    });
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['garage.cover', 'duplicate-actionable'],
      ['rooms[0].curtains[0]', 'curtain-conflict'],
    ]);
    expect(issues[1]?.message).toBe(
      "rooms[0].curtains[0]: cover.demo_garage is the garage door (garage.cover). Curtain controls move without confirmation, so it can't also be a curtain.",
    );
  });

  it('keeps a perimeter cover that is not a curtain, and curtain issues are warnings in demo mode', () => {
    const { config } = okConfig({
      security: { ...SECURITY, perimeter: ['cover.demo_side_gate'] },
      rooms: [{ name: 'Hall', lights: [], curtains: ['cover.demo_blind'] }],
    });
    expect(config.rooms[0]?.curtains).toEqual(['cover.demo_blind']);
    const demo = validateConfig({
      type: 'custom:agraharam-dashboard',
      demo: true,
      security: { ...SECURITY, perimeter: ['cover.demo_side_gate'] },
      rooms: [{ name: 'Hall', lights: [], curtains: ['cover.demo_side_gate'] }],
    });
    expect(demo.ok).toBe(true);
    expect(demo.ok && demo.warnings.map((warning) => warning.path)).toEqual(['rooms[0].curtains[0]']);
  });

  it('allows the same fan as an air tile and a room purifier (one family)', () => {
    const { config } = okConfig({
      air: ['fan.demo_purifier'],
      rooms: [{ name: 'Study', lights: [], purifier: 'fan.demo_purifier' }],
    });
    expect(config.bindings.get('fan.demo_purifier' as EntityId)).toEqual(['air', 'room_purifier']);
  });

  it('rejects the same script in two security roles (silence_sound and disarm_hold)', () => {
    const [issue] = issuesOf({
      security: {
        ...SECURITY,
        actions: { disarm_hold: 'script.demo_disarm', silence_sound: 'script.demo_disarm' },
      },
    });
    expect(issue).toMatchObject({ path: 'security.actions.silence_sound', code: 'duplicate-security-script' });
  });

  it('rejects a script shared between a security role and the studio monitors', () => {
    expect(
      codesAt({
        security: { ...SECURITY, actions: { hold_night: 'script.demo_x' } },
        studio_monitors_script: 'script.demo_x',
      }),
    ).toEqual({ studio_monitors_script: 'duplicate-actionable' });
  });
});

describe('validateConfig: values (rules 7–8)', () => {
  it.each(['On', 'true', 'enabled', true, 1])('rejects privacy_on_value %j without coercion', (value) => {
    expect(
      codesAt({
        cameras: [{ entity: 'camera.demo_a', name: 'A', privacy_entity: 'switch.demo_p', privacy_on_value: value }],
      }),
    ).toEqual({ 'cameras[0].privacy_on_value': 'invalid-value' });
  });

  it('defaults privacy_on_value to on and keeps off; an on value without its entity is half a binding', () => {
    const { config } = okConfig({
      cameras: [
        { entity: 'camera.demo_a', name: 'A', privacy_entity: 'switch.demo_p' },
        { entity: 'camera.demo_b', name: 'B', privacy_entity: 'binary_sensor.demo_q', privacy_on_value: 'off' },
      ],
    });
    expect(config.cameras.map((camera) => camera.privacy?.onValue)).toEqual(['on', 'off']);
    expect(codesAt({ cameras: [{ entity: 'camera.demo_a', name: 'A', privacy_on_value: 'on' }] })).toEqual({
      'cameras[0].privacy_entity': 'required',
    });
  });

  it('checks snapshot_interval (integer 5–600 s) and converts it to ms, defaulting thumbnails on', () => {
    const camera = { entity: 'camera.demo_a', name: 'A' };
    expect(okConfig({ cameras: [camera] }).config.cameras[0]).toMatchObject({
      thumbnails: true,
      snapshotIntervalMs: 10_000,
    });
    expect(
      okConfig({ cameras: [{ ...camera, snapshot_interval: 5, thumbnails: false }] }).config.cameras[0],
    ).toMatchObject({
      thumbnails: false,
      snapshotIntervalMs: 5_000,
    });
    expect(codesAt({ cameras: [{ ...camera, snapshot_interval: 4 }] })).toEqual({
      'cameras[0].snapshot_interval': 'out-of-range',
    });
    expect(codesAt({ cameras: [{ ...camera, snapshot_interval: 601 }] })).toEqual({
      'cameras[0].snapshot_interval': 'out-of-range',
    });
    expect(codesAt({ cameras: [{ ...camera, snapshot_interval: 7.5 }] })).toEqual({
      'cameras[0].snapshot_interval': 'wrong-type',
    });
  });

  it('defaults live view on per camera; live: false turns it off and anything but a boolean is wrong-type', () => {
    const camera = { entity: 'camera.demo_a', name: 'A' };
    expect(okConfig({ cameras: [camera] }).config.cameras[0]?.live).toBe(true);
    expect(okConfig({ cameras: [{ ...camera, live: false }] }).config.cameras[0]?.live).toBe(false);
    expect(codesAt({ cameras: [{ ...camera, live: 'no' }] })).toEqual({ 'cameras[0].live': 'wrong-type' });
  });

  it('checks charge_limit_pct (integer 50–100) and name lengths', () => {
    const vehicle = { name: 'Demo sedan', battery_sensor: 'sensor.demo_b', range_sensor: 'sensor.demo_r' };
    expect(okConfig({ vehicle: { ...vehicle, charge_limit_pct: 80 } }).config.vehicle?.chargeLimitPct).toBe(80);
    expect(codesAt({ vehicle: { ...vehicle, charge_limit_pct: 49 } })).toEqual({
      'vehicle.charge_limit_pct': 'out-of-range',
    });
    expect(codesAt({ vehicle: { ...vehicle, name: 'n'.repeat(61) } })).toEqual({ 'vehicle.name': 'too-long' });
  });

  it('defaults the garage name and accepts the vehicle charger fields', () => {
    const { config } = okConfig({
      garage: { cover: 'cover.demo_garage' },
      vehicle: {
        name: 'Demo sedan',
        battery_sensor: 'sensor.demo_b',
        range_sensor: 'sensor.demo_r',
        charger_status: 'binary_sensor.demo_charging',
      },
    });
    expect(config.garage).toEqual({ cover: 'cover.demo_garage', name: 'Garage' });
    expect(config.vehicle?.chargerStatus).toBe('binary_sensor.demo_charging');
  });
});

describe('validateConfig: demo mode (rule 9)', () => {
  it('returns demo settings with empty bindings and turns binding issues and controls into warnings', () => {
    const result = okConfig({
      demo: true,
      demo_scenario: 'degraded',
      title: 'Preview',
      diagnostics: true,
      controls: true,
      weather: 'light.demo_wrong',
      people: ['person.demo_a'],
    });
    expect(result.config).toMatchObject({
      demo: true,
      demoScenario: 'degraded',
      title: 'Preview',
      diagnostics: true,
      controls: false,
      people: [],
    });
    expect([...result.config.bindings]).toEqual([]);
    expect(result.warnings.map((warning) => [warning.path, warning.code])).toEqual([
      ['weather', 'ignored-in-demo'],
      ['controls', 'ignored-in-demo'],
    ]);
  });

  it('still rejects issues in the keys demo mode uses, and unknown top-level keys', () => {
    expect(codesAt({ demo: true, title: 7 })).toEqual({ title: 'wrong-type' });
    expect(codesAt({ demo: true, demo_scenaro: 'normal' })).toEqual({ demo_scenaro: 'unknown-key' });
  });

  it('imports nothing outside src/config, so the generator can run it with Node type stripping', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/config/validate.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.every((path) => path?.startsWith('./'))).toBe(true);
  });
});

describe('validateConfig: result (rule 10)', () => {
  it('is deeply frozen, and bindings cannot be extended', () => {
    const { config } = okConfig({
      rooms: [{ name: 'Kitchen', lights: ['light.demo_kitchen'] }],
      climate: [{ entity: 'climate.demo_bedroom' }],
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.rooms)).toBe(true);
    expect(Object.isFrozen(config.rooms[0]?.lights)).toBe(true);
    expect(Object.isFrozen(config.bindings.get('light.demo_kitchen' as EntityId))).toBe(true);
    expect('set' in config.bindings).toBe(false);
    expect([...config.bindings.keys()]).toEqual(['climate.demo_bedroom', 'light.demo_kitchen']);
  });

  it('records only configured IDs in bindings, with every role', () => {
    const { config } = okConfig({
      vacuums: [{ entity: 'vacuum.demo_pebble' }],
      security: { ...SECURITY, actions: { hold_night: 'script.demo_hold_night' } },
    });
    expect(Object.fromEntries(config.bindings)).toEqual({
      'vacuum.demo_pebble': ['vacuum'],
      'alarm_control_panel.demo_home': ['alarm'],
      'input_select.demo_policy': ['policy'],
      'script.demo_hold_night': ['security_action'],
    });
  });
});
