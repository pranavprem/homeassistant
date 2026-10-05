import { describe, expect, it } from 'vitest';
import { ACTIONABLE_ROLE_FAMILY, DOMAINS_BY_ROLE, type BindingRole } from '../../src/config/schema.ts';

/** Domains that must never be reachable as an action target (§1.2 item 6, §7.1). */
const NEVER_ACTIONABLE_DOMAINS = [
  'alarm_control_panel',
  'input_boolean',
  'input_select',
  'input_text',
  'select',
  'switch',
  'automation',
  'camera',
];

describe('DOMAINS_BY_ROLE', () => {
  it('lists at least one domain for every role', () => {
    for (const domains of Object.values(DOMAINS_BY_ROLE)) expect(domains.length).toBeGreaterThan(0);
  });

  it('allows only scripts for security actions and studio monitors (§4.2 rule 5)', () => {
    expect(DOMAINS_BY_ROLE.security_action).toEqual(['script']);
    expect(DOMAINS_BY_ROLE.studio_monitors).toEqual(['script']);
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
    });
    expect(Object.isFrozen(ACTIONABLE_ROLE_FAMILY)).toBe(true);
  });

  it('never makes alarm, helper, switch, automation or camera domains actionable', () => {
    const actionableRoles = Object.keys(ACTIONABLE_ROLE_FAMILY) as BindingRole[];
    for (const role of actionableRoles) {
      for (const domain of DOMAINS_BY_ROLE[role]) expect(NEVER_ACTIONABLE_DOMAINS).not.toContain(domain);
    }
  });
});
