import { describe, expect, it } from 'vitest';
import { ACTIONABLE_ROLE_FAMILY, DOMAINS_BY_ROLE, type BindingRole } from '../../src/config/schema.ts';

/**
 * Domains that must never be reachable as an action target (§1.2 item 6, §7.1). `switch` left this list
 * deliberately in §18: room lighting switches are actionable through the one role `room_switch`, which the narrow
 * switch rule below pins. The display-only reading domains joined it, so a collection can never become a control.
 */
const NEVER_ACTIONABLE_DOMAINS = [
  'alarm_control_panel',
  'input_boolean',
  'input_select',
  'input_text',
  'input_datetime',
  'select',
  'automation',
  'camera',
  'number',
  'update',
  'event',
  'lock',
  'homeassistant',
];

describe('DOMAINS_BY_ROLE', () => {
  it('lists at least one domain for every role', () => {
    for (const domains of Object.values(DOMAINS_BY_ROLE)) expect(domains.length).toBeGreaterThan(0);
  });

  it('allows only scripts for security actions and studio monitors (§4.2 rule 5)', () => {
    expect(DOMAINS_BY_ROLE.security_action).toEqual(['script']);
    expect(DOMAINS_BY_ROLE.studio_monitors).toEqual(['script']);
  });

  it('allows only scripts for the whole-house shortcuts (§18)', () => {
    expect(DOMAINS_BY_ROLE.house_shortcut).toEqual(['script']);
  });

  it('allows only switches for room lighting switches (§18)', () => {
    expect(DOMAINS_BY_ROLE.room_switch).toEqual(['switch']);
  });

  it('allows exactly the read-only reading domains for collections (§18), and none that invite an action', () => {
    expect([...DOMAINS_BY_ROLE.collection].sort()).toEqual(
      [
        'sensor',
        'binary_sensor',
        'number',
        'select',
        'light',
        'switch',
        'fan',
        'climate',
        'vacuum',
        'cover',
        'lock',
        'media_player',
        'update',
        'input_text',
        'input_datetime',
        'input_boolean',
        'input_select',
        'event',
      ].sort(),
    );
    for (const domain of ['camera', 'alarm_control_panel', 'person', 'device_tracker', 'script', 'scene', 'button']) {
      expect(DOMAINS_BY_ROLE.collection).not.toContain(domain);
    }
  });

  it('allows exactly the privacy domains whose states are on/off', () => {
    expect(DOMAINS_BY_ROLE.camera_privacy).toEqual(['switch', 'binary_sensor', 'input_boolean']);
  });

  it('is frozen, including every domain list', () => {
    expect(Object.isFrozen(DOMAINS_BY_ROLE)).toBe(true);
    for (const domains of Object.values(DOMAINS_BY_ROLE)) expect(Object.isFrozen(domains)).toBe(true);
  });
});

describe('ACTIONABLE_ROLE_FAMILY', () => {
  it('maps exactly the controllable roles to their action family', () => {
    expect(ACTIONABLE_ROLE_FAMILY).toEqual({
      climate: 'climate',
      air: 'fan',
      room_purifier: 'fan',
      room_light: 'light',
      room_curtain: 'curtain',
      vacuum: 'vacuum',
      media: 'media',
      garage_cover: 'garage',
      security_action: 'security',
      studio_monitors: 'studio_monitors',
      room_switch: 'switch',
      house_shortcut: 'shortcut',
    });
    expect(Object.isFrozen(ACTIONABLE_ROLE_FAMILY)).toBe(true);
  });

  it('never makes readings actionable: collection has no action family', () => {
    expect(Object.hasOwn(ACTIONABLE_ROLE_FAMILY, 'collection')).toBe(false);
    expect(ACTIONABLE_ROLE_FAMILY.collection).toBeUndefined();
  });

  it('never makes alarm, helper, automation, camera or display-only domains actionable', () => {
    const actionableRoles = Object.keys(ACTIONABLE_ROLE_FAMILY) as BindingRole[];
    for (const role of actionableRoles) {
      for (const domain of DOMAINS_BY_ROLE[role]) expect(NEVER_ACTIONABLE_DOMAINS).not.toContain(domain);
    }
  });

  it('makes switches actionable through room_switch only (the narrow switch rule, §18)', () => {
    const actionableRoles = Object.keys(ACTIONABLE_ROLE_FAMILY) as BindingRole[];
    expect(actionableRoles.filter((role) => DOMAINS_BY_ROLE[role].includes('switch'))).toEqual(['room_switch']);
  });

  it('makes scripts actionable only through the security, studio monitors and shortcut roles', () => {
    const actionableRoles = Object.keys(ACTIONABLE_ROLE_FAMILY) as BindingRole[];
    expect(actionableRoles.filter((role) => DOMAINS_BY_ROLE[role].includes('script')).sort()).toEqual(
      ['house_shortcut', 'security_action', 'studio_monitors'].sort(),
    );
  });
});
