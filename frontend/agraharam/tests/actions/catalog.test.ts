/**
 * The catalog's static guarantees (§7.1, §12.1 row 6): only the listed services exist, scripts run only through
 * script.turn_on with no data (never `variables`), there is nothing for alarm panels, helpers, selects, switches,
 * automations or cameras, and every kind's roles, feature masks, confirmation rule and timeout match the design.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONABLE_ROLE_FAMILY, type EntityId, type SecurityActionRole } from '../../src/config/schema.ts';
import { ACTION_CATALOG, confirmRuleFor, specFor } from '../../src/ha/actions/catalog.ts';
import { ACTION_TIMEOUT_MS, type ActionKind, type ActionRequest } from '../../src/ha/actions/types.ts';
import { ROWS } from './rows.ts';

/** Every kind the catalog defines. */
const ACTION_KINDS = Object.keys(ACTION_CATALOG) as ActionKind[];

const SECURITY_ROLES: readonly SecurityActionRole[] = [
  'disarm_hold',
  'silence_sound',
  'resume_auto',
  'hold_night',
  'hold_away',
  'hold_vacation',
  'prepare_departure',
];

const e = (id: string): EntityId => id as EntityId;

/** Written out independently of the catalog, so a dropped or added kind fails here. */
const EXPECTED_KINDS: readonly ActionKind[] = [
  'light.turn_on',
  'light.turn_off',
  'light.set_brightness',
  'room.lights_on',
  'room.lights_off',
  'climate.set_temperature',
  'climate.set_hvac_mode',
  'fan.turn_on',
  'fan.turn_off',
  'fan.set_percentage',
  'fan.set_preset_mode',
  'vacuum.start',
  'vacuum.pause',
  'vacuum.return_to_base',
  'garage.open',
  'garage.close',
  'curtain.open',
  'curtain.close',
  'media.play',
  'media.pause',
  'media.next',
  'media.previous',
  'media.volume_set',
  'media.volume_mute',
  'media.select_source',
  'security.run',
  'studio_monitors.run',
];

/** §7.1 "Capability" column: masks of which ALL bits of ANY one are needed. */
const EXPECTED_REQUIRES: Readonly<Record<ActionKind, readonly number[]>> = {
  'light.turn_on': [],
  'light.turn_off': [],
  'light.set_brightness': [],
  'room.lights_on': [],
  'room.lights_off': [],
  'climate.set_temperature': [1],
  'climate.set_hvac_mode': [],
  'fan.turn_on': [32],
  'fan.turn_off': [16],
  'fan.set_percentage': [1],
  'fan.set_preset_mode': [1, 8],
  'vacuum.start': [8192],
  'vacuum.pause': [4],
  'vacuum.return_to_base': [16],
  'garage.open': [1],
  'garage.close': [2],
  'curtain.open': [1],
  'curtain.close': [2],
  'media.play': [16384],
  'media.pause': [1],
  'media.next': [32],
  'media.previous': [16],
  'media.volume_set': [4],
  'media.volume_mute': [8],
  'media.select_source': [2048],
  'security.run': [],
  'studio_monitors.run': [],
};

const FORBIDDEN_DOMAINS = [
  'alarm_control_panel',
  'input_boolean',
  'input_select',
  'input_number',
  'input_text',
  'input_datetime',
  'input_button',
  'select',
  'switch',
  'automation',
  'camera',
  'lock',
  'siren',
];

describe('catalog coverage', () => {
  it('has exactly one spec per action kind', () => {
    expect([...ACTION_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort());
    expect(Object.keys(ROWS).sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it('calls only the services listed in §7.1', () => {
    const services = new Set(
      ACTION_KINDS.map((kind) => `${ACTION_CATALOG[kind].domain}.${ACTION_CATALOG[kind].service}`),
    );
    expect([...services].sort()).toEqual(
      [
        'light.turn_on',
        'light.turn_off',
        'climate.set_temperature',
        'climate.set_hvac_mode',
        'fan.turn_on',
        'fan.turn_off',
        'fan.set_percentage',
        'fan.set_preset_mode',
        'vacuum.start',
        'vacuum.pause',
        'vacuum.return_to_base',
        'cover.open_cover',
        'cover.close_cover',
        'media_player.media_play',
        'media_player.media_pause',
        'media_player.media_next_track',
        'media_player.media_previous_track',
        'media_player.volume_set',
        'media_player.volume_mute',
        'media_player.select_source',
        'script.turn_on',
      ].sort(),
    );
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(ACTION_CATALOG)).toBe(true);
    for (const kind of ACTION_KINDS) {
      const spec = ACTION_CATALOG[kind];
      expect(Object.isFrozen(spec), kind).toBe(true);
      expect(Object.isFrozen(spec.roles), kind).toBe(true);
      expect(Object.isFrozen(spec.requires), kind).toBe(true);
    }
  });
});

describe('catalog safety (§12.1 row 6)', () => {
  it('has no alarm, helper, select, switch, automation or camera domain', () => {
    for (const kind of ACTION_KINDS) {
      expect(FORBIDDEN_DOMAINS, kind).not.toContain(ACTION_CATALOG[kind].domain);
    }
  });

  it('runs scripts only through script.turn_on, with no data and never variables', () => {
    for (const kind of ACTION_KINDS) {
      const spec = ACTION_CATALOG[kind];
      if (spec.domain !== 'script') continue;
      expect(spec.service, kind).toBe('turn_on');
      const data = specFor(ROWS[kind].req).data(ROWS[kind].req);
      expect(data, kind).toEqual({});
    }
  });

  it('never builds a `variables` key for any kind', () => {
    for (const kind of ACTION_KINDS) {
      const req = ROWS[kind].req;
      expect(Object.keys(specFor(req).data(req)), kind).not.toContain('variables');
    }
  });

  it('targets only actionable roles, each within the spec family', () => {
    for (const kind of ACTION_KINDS) {
      const spec = ACTION_CATALOG[kind];
      expect(spec.roles.length, kind).toBeGreaterThan(0);
      for (const role of spec.roles) {
        const family = ACTIONABLE_ROLE_FAMILY[role];
        expect(family, `${kind} ${role}`).toBeDefined();
        // Room actions act on room lights, whose own family is 'light'.
        expect(family === spec.family || (spec.family === 'room' && family === 'light'), kind).toBe(true);
      }
    }
  });

  it('security actions are scripts resolved from the configuration, never from the request', () => {
    const spec = ACTION_CATALOG['security.run'];
    expect(spec).toMatchObject({ target: 'security', domain: 'script', roles: ['security_action'] });
    expect(ACTION_CATALOG['studio_monitors.run']).toMatchObject({ target: 'studio_monitors', domain: 'script' });
    expect(ACTION_CATALOG['garage.open'].target).toBe('garage');
    expect(ACTION_CATALOG['garage.close'].target).toBe('garage');
  });

  it('the catalog source holds no raw alarm, helper-write or automation service strings', () => {
    const source = readFileSync(join(process.cwd(), 'src/ha/actions/catalog.ts'), 'utf8');
    const banned = [
      ['alarm', 'arm'].join('_'),
      ['alarm', 'disarm'].join('_'),
      ['select', 'option'].join('_'),
      ['input_boolean', 'turn'].join('.'),
      ['set', 'value'].join('_'),
      'variables:',
    ];
    for (const word of banned) expect(source, word).not.toContain(word);
  });
});

describe('§7.1 columns', () => {
  it('feature masks match the capability column', () => {
    for (const kind of ACTION_KINDS) expect(ACTION_CATALOG[kind].requires, kind).toEqual(EXPECTED_REQUIRES[kind]);
  });

  it('the garage and security actions confirm always; only Silence Sound may skip it, while the alarm sounds', () => {
    for (const kind of ACTION_KINDS) {
      if (kind === 'security.run') continue;
      const expected = kind === 'garage.open' || kind === 'garage.close' ? 'always' : 'never';
      expect(ACTION_CATALOG[kind].confirm, kind).toBe(expected);
    }
    for (const role of SECURITY_ROLES) {
      const expected = role === 'silence_sound' ? 'unless-alarm-sounding' : 'always';
      expect(confirmRuleFor({ kind: 'security.run', role }), role).toBe(expected);
    }
  });

  it('the garage always denies an unknown position; toggles, curtains and return-to-dock allow it', () => {
    const allow = new Set<ActionKind>([
      'light.turn_on',
      'light.turn_off',
      'fan.turn_on',
      'fan.turn_off',
      'vacuum.return_to_base',
      'curtain.open',
      'curtain.close',
    ]);
    for (const kind of ACTION_KINDS) {
      expect(ACTION_CATALOG[kind].unknownState, kind).toBe(allow.has(kind) ? 'allow' : 'deny');
    }
  });

  it('timeouts follow the family (10 s light/media/scripts, 15 s room, 20 s climate/fan, 30 s vacuum, 60 s covers)', () => {
    const seconds = (kind: ActionKind): number => ACTION_TIMEOUT_MS[ACTION_CATALOG[kind].family] / 1000;
    expect(seconds('light.turn_on')).toBe(10);
    expect(seconds('room.lights_on')).toBe(15);
    expect(seconds('climate.set_hvac_mode')).toBe(20);
    expect(seconds('fan.set_percentage')).toBe(20);
    expect(seconds('vacuum.start')).toBe(30);
    expect(seconds('garage.open')).toBe(60);
    expect(seconds('curtain.close')).toBe(60);
    expect(seconds('media.next')).toBe(10);
    expect(seconds('security.run')).toBe(10);
    expect(seconds('studio_monitors.run')).toBe(10);
    for (const [kind, row] of Object.entries(ROWS) as [ActionKind, (typeof ROWS)[ActionKind]][]) {
      expect(seconds(kind) * 1000, kind).toBe(row.timeoutMs);
    }
  });

  it('rounds volume to 0.01 and passes validated fields through unchanged', () => {
    const volume: ActionRequest = { kind: 'media.volume_set', entity: e('media_player.demo_lounge'), level: 0.333333 };
    expect(specFor(volume).data(volume)).toEqual({ volume_level: 0.33 });
    const preset: ActionRequest = { kind: 'fan.set_preset_mode', entity: e('fan.demo_purifier'), preset: 'sleep' };
    expect(specFor(preset).data(preset)).toEqual({ preset_mode: 'sleep' });
  });

  it('refuses garage, gate and door covers for curtain kinds only', () => {
    expect(ACTION_CATALOG['curtain.open'].refusedDeviceClasses).toEqual(['garage', 'gate', 'door']);
    expect(ACTION_CATALOG['curtain.close'].refusedDeviceClasses).toEqual(['garage', 'gate', 'door']);
    expect(ACTION_CATALOG['garage.open'].refusedDeviceClasses).toBeUndefined();
  });
});
