import { describe, expect, it } from 'vitest';
import { domainOf, isValidEntityId } from '../../src/config/entity-id.ts';

/** HA core's MAX_LENGTH_STATE_ENTITY_ID. */
const MAX_LENGTH = 255;

// Mirrors HA core's valid_entity_id: two parts of lowercase alphanumeric runs joined by single underscores.
const VALID_IDS = ['light.demo_kitchen', 'sensor.demo_a1_b2', 'binary_sensor.demo_front_door', 'x.demo_1', '1.demo_2'];
const INVALID_IDS = [
  '',
  'light',
  '.demo_kitchen',
  'light.',
  'light..demo',
  'light.demo.kitchen',
  'Light.demo_kitchen',
  'light.Demo_kitchen',
  '_light.demo',
  'light_.demo',
  'li__ght.demo',
  'light._demo',
  'light.demo_',
  'light.demo__kitchen',
  'light.demo-kitchen',
  'light.demo kitchen',
  'light.démo',
];

describe('isValidEntityId', () => {
  it.each(VALID_IDS)('accepts %s', (id) => {
    expect(isValidEntityId(id)).toBe(true);
  });

  it.each(INVALID_IDS)('rejects %j', (id) => {
    expect(isValidEntityId(id)).toBe(false);
  });

  it('enforces the 255-character limit', () => {
    const prefix = 'light.demo_';
    expect(isValidEntityId(prefix + 'a'.repeat(MAX_LENGTH - prefix.length))).toBe(true);
    expect(isValidEntityId(prefix + 'a'.repeat(MAX_LENGTH - prefix.length + 1))).toBe(false);
  });
});

describe('domainOf', () => {
  it('returns the part before the first dot', () => {
    expect(domainOf('binary_sensor.demo_front_door')).toBe('binary_sensor');
  });

  it('returns an empty string when there is no dot', () => {
    expect(domainOf('nodot')).toBe('');
  });
});
