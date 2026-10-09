/**
 * The catalog's static guarantees (§7.1, §12.1 row 6, §18): exactly the listed (kind, domain, service, roles) calls
 * exist, scripts run only through script.turn_on with no data (never `variables`), there is nothing for alarm panels,
 * helpers, selects, automations, cameras or display-only domains, `switch` is reachable only as turn_on/turn_off on
 * room lighting switches, readings (`collection`) are never a target, and every kind's roles, feature masks,
 * confirmation rule and timeout match the design.
 *
 * §18 replaced the old "no switch domain" guarantee with the narrower rules below; it was never simply removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIONABLE_ROLE_FAMILY,
  SHORTCUT_ROLES,
  type BindingRole,
  type EntityId,
  type SecurityActionRole,
} from '../../src/config/schema.ts';
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
  'switch.turn_on',
  'switch.turn_off',
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
  'shortcut.run',
];

/** §7.1 "Capability" column: masks of which ALL bits of ANY one are needed. */
const EXPECTED_REQUIRES: Readonly<Record<ActionKind, readonly number[]>> = {
  'light.turn_on': [],
  'light.turn_off': [],
  'light.set_brightness': [],
  'switch.turn_on': [],
  'switch.turn_off': [],
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
  'shortcut.run': [],
};

/**
 * Every call the catalog can make, written out independently (§18 exact call allowlist): one entry per single-target
 * kind, and one per part for the room kinds (lights first, then lighting switches). A new or widened call fails.
 */
const EXPECTED_CALLS: readonly string[] = [
  'light.turn_on | light.turn_on | room_light',
  'light.turn_off | light.turn_off | room_light',
  'light.set_brightness | light.turn_on | room_light',
  'switch.turn_on | switch.turn_on | room_switch',
  'switch.turn_off | switch.turn_off | room_switch',
  'room.lights_on | light.turn_on | room_light',
  'room.lights_on | switch.turn_on | room_switch',
  'room.lights_off | light.turn_off | room_light',
  'room.lights_off | switch.turn_off | room_switch',
  'climate.set_temperature | climate.set_temperature | climate',
  'climate.set_hvac_mode | climate.set_hvac_mode | climate',
  'fan.turn_on | fan.turn_on | air,room_purifier',
  'fan.turn_off | fan.turn_off | air,room_purifier',
  'fan.set_percentage | fan.set_percentage | air,room_purifier',
  'fan.set_preset_mode | fan.set_preset_mode | air,room_purifier',
  'vacuum.start | vacuum.start | vacuum',
  'vacuum.pause | vacuum.pause | vacuum',
  'vacuum.return_to_base | vacuum.return_to_base | vacuum',
  'garage.open | cover.open_cover | garage_cover',
  'garage.close | cover.close_cover | garage_cover',
  'curtain.open | cover.open_cover | room_curtain',
  'curtain.close | cover.close_cover | room_curtain',
  'media.play | media_player.media_play | media',
  'media.pause | media_player.media_pause | media',
  'media.next | media_player.media_next_track | media',
  'media.previous | media_player.media_previous_track | media',
  'media.volume_set | media_player.volume_set | media',
  'media.volume_mute | media_player.volume_mute | media',
  'media.select_source | media_player.select_source | media',
  'security.run | script.turn_on | security_action',
  'studio_monitors.run | script.turn_on | studio_monitors',
  'shortcut.run | script.turn_on | house_shortcut',
];

interface PlannedCall {
  readonly kind: ActionKind;
  readonly domain: string;
  readonly service: string;
  readonly roles: readonly BindingRole[];
}

/** Every call each spec can make: its parts when it has them (room kinds), else its own domain and service. */
function catalogCalls(): PlannedCall[] {
  return ACTION_KINDS.flatMap((kind): PlannedCall[] => {
    const spec = ACTION_CATALOG[kind];
    if (spec.parts !== undefined) {
      return spec.parts.map((part) => ({ kind, domain: part.domain, service: part.service, roles: [part.role] }));
    }
    return [{ kind, domain: spec.domain, service: spec.service, roles: spec.roles }];
  });
}

const callLine = (call: PlannedCall): string =>
  `${call.kind} | ${call.domain}.${call.service} | ${[...call.roles].sort().join(',')}`;

/**
 * Domains no spec or part may call. `switch` left this list in §18 only because the narrow switch rule below pins it
 * to turn_on/turn_off on room lighting switches; the cross-domain `homeassistant` services and the display-only
 * reading domains joined it.
 */
const FORBIDDEN_DOMAINS = [
  'alarm_control_panel',
  'input_boolean',
  'input_select',
  'input_number',
  'input_text',
  'input_datetime',
  'input_button',
  'select',
  'automation',
  'camera',
  'lock',
  'siren',
  'homeassistant',
  'number',
  'update',
  'event',
  'scene',
  'button',
  'text',
];

describe('catalog coverage', () => {
  it('has exactly one spec per action kind', () => {
    expect([...ACTION_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort());
    expect(Object.keys(ROWS).sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it('makes exactly the allowlisted (kind, domain.service, roles) calls, room parts included (§18)', () => {
    expect(catalogCalls().map(callLine).sort()).toEqual([...EXPECTED_CALLS].sort());
  });

  it('gives room kinds exactly two parts in order, lights then lighting switches, and only room kinds have parts', () => {
    for (const kind of ACTION_KINDS) {
      const spec = ACTION_CATALOG[kind];
      if (kind !== 'room.lights_on' && kind !== 'room.lights_off') {
        expect(spec.parts, kind).toBeUndefined();
        continue;
      }
      expect(spec.target, kind).toBe('room');
      expect(
        spec.parts?.map((part) => `${part.role}:${part.domain}`),
        kind,
      ).toEqual(['room_light:light', 'room_switch:switch']);
      // The spec's own domain and service are its first part's (the light-only call is unchanged).
      expect(`${spec.domain}.${spec.service}`, kind).toBe(`${spec.parts?.[0]?.domain}.${spec.parts?.[0]?.service}`);
      expect(new Set(spec.parts?.map((part) => part.service)).size, kind).toBe(1);
    }
  });

  it('calls only the services listed in §7.1', () => {
    const services = new Set(
      ACTION_KINDS.map((kind) => `${ACTION_CATALOG[kind].domain}.${ACTION_CATALOG[kind].service}`),
    );
    expect([...services].sort()).toEqual(
      [
        'light.turn_on',
        'light.turn_off',
        'switch.turn_on',
        'switch.turn_off',
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
      if (spec.parts !== undefined) {
        expect(Object.isFrozen(spec.parts), kind).toBe(true);
        for (const part of spec.parts) expect(Object.isFrozen(part), kind).toBe(true);
      }
      if (spec.refusedEntityCategories !== undefined) expect(Object.isFrozen(spec.refusedEntityCategories)).toBe(true);
    }
  });
});

describe('catalog safety (§12.1 row 6)', () => {
  it('has no alarm, helper, select, automation, camera, cross-domain or display-only domain, in any spec or part', () => {
    for (const call of catalogCalls()) expect(FORBIDDEN_DOMAINS, call.kind).not.toContain(call.domain);
    for (const kind of ACTION_KINDS) expect(FORBIDDEN_DOMAINS, kind).not.toContain(ACTION_CATALOG[kind].domain);
  });

  it('reaches switch only as turn_on or turn_off, only for room lighting switches, with no data (§18)', () => {
    const switchCalls = catalogCalls().filter((call) => call.domain === 'switch');
    expect(switchCalls.length).toBeGreaterThan(0);
    for (const call of switchCalls) {
      expect(['turn_on', 'turn_off'], call.kind).toContain(call.service);
      expect(call.roles, call.kind).toEqual(['room_switch']);
    }
    for (const kind of ['switch.turn_on', 'switch.turn_off', 'room.lights_on', 'room.lights_off'] as const) {
      const req = ROWS[kind].req;
      expect(specFor(req).data(req), kind).toEqual({});
    }
    // No other spec lists room_switch, and room_switch is never a target outside the switch and room kinds.
    const listing = ACTION_KINDS.filter(
      (kind) =>
        ACTION_CATALOG[kind].roles.includes('room_switch') ||
        (ACTION_CATALOG[kind].parts ?? []).some((part) => part.role === 'room_switch'),
    );
    expect(listing.sort()).toEqual(['room.lights_off', 'room.lights_on', 'switch.turn_off', 'switch.turn_on']);
  });

  it('refuses settings and diagnostic switches (entity_category config or diagnostic) in every switch spec', () => {
    for (const kind of ACTION_KINDS) {
      const spec = ACTION_CATALOG[kind];
      const reachesSwitch = spec.domain === 'switch' || (spec.parts ?? []).some((part) => part.domain === 'switch');
      if (reachesSwitch)
        expect([...(spec.refusedEntityCategories ?? [])].sort(), kind).toEqual(['config', 'diagnostic']);
      else expect(spec.refusedEntityCategories, kind).toBeUndefined();
    }
  });

  it('never targets a reading: no spec or part lists the collection role', () => {
    for (const kind of ACTION_KINDS) {
      const spec = ACTION_CATALOG[kind];
      expect(spec.roles, kind).not.toContain('collection');
      for (const part of spec.parts ?? []) expect(part.role, kind).not.toBe('collection');
    }
    expect(catalogCalls().some((call) => call.roles.includes('collection'))).toBe(false);
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
      const roles = [...spec.roles, ...(spec.parts ?? []).map((part) => part.role)];
      for (const role of roles) {
        const family = ACTIONABLE_ROLE_FAMILY[role];
        expect(family, `${kind} ${role}`).toBeDefined();
        // Room actions act on room lights and lighting switches, whose own families are 'light' and 'switch'
        // (§18); no other spec reaches outside its own family.
        const roomMember = spec.family === 'room' && (family === 'light' || family === 'switch');
        expect(family === spec.family || roomMember, `${kind} ${role}`).toBe(true);
      }
    }
  });

  it('shortcuts are scripts resolved from the configuration by role, never from the request', () => {
    expect(ACTION_CATALOG['shortcut.run']).toMatchObject({
      target: 'shortcut',
      domain: 'script',
      service: 'turn_on',
      roles: ['house_shortcut'],
      family: 'shortcut',
    });
    for (const role of SHORTCUT_ROLES) {
      const req: ActionRequest = { kind: 'shortcut.run', role };
      expect(specFor(req).data(req), role).toEqual({});
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

  it('the garage, security and shortcut actions confirm always; only Silence Sound may skip it, while the alarm sounds', () => {
    const always = new Set<ActionKind>(['garage.open', 'garage.close', 'shortcut.run']);
    for (const kind of ACTION_KINDS) {
      if (kind === 'security.run') continue;
      expect(ACTION_CATALOG[kind].confirm, kind).toBe(always.has(kind) ? 'always' : 'never');
    }
    for (const role of SHORTCUT_ROLES) expect(confirmRuleFor({ kind: 'shortcut.run', role }), role).toBe('always');
    for (const role of SECURITY_ROLES) {
      const expected = role === 'silence_sound' ? 'unless-alarm-sounding' : 'always';
      expect(confirmRuleFor({ kind: 'security.run', role }), role).toBe(expected);
    }
  });

  it('the garage always denies an unknown position; toggles, curtains and return-to-dock allow it', () => {
    const allow = new Set<ActionKind>([
      'light.turn_on',
      'light.turn_off',
      'switch.turn_on',
      'switch.turn_off',
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

  it('timeouts follow the family (10 s light/switch/media/scripts, 15 s room, 20 s climate/fan, 30 s vacuum, 60 s covers)', () => {
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
    expect(seconds('switch.turn_on')).toBe(10);
    expect(seconds('switch.turn_off')).toBe(10);
    expect(seconds('shortcut.run')).toBe(10);
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
