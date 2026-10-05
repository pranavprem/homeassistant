/** HA rejection mapping (§4.7) and the sanitizer for quoted runtime text. */
import { describe, expect, it } from 'vitest';
import {
  HA_MESSAGE_MAX_CHARS,
  isPortNotSent,
  mapRejection,
  plainText,
  sanitizeHaMessage,
  withoutEntityIds,
} from '../../src/ha/actions/error-map.ts';

describe('mapRejection', () => {
  it.each([
    ['not_found', { code: 'not_found', message: 'Service not found.' }, 'service-missing', 'failed'],
    ['invalid_format', { code: 'invalid_format', message: 'extra keys' }, 'bad-request', 'failed'],
    ['service_validation_error', { code: 'service_validation_error', message: 'Too hot' }, 'rejected', 'failed'],
    ['Unauthorized message', { code: 'home_assistant_error', message: 'Unauthorized' }, 'permission-denied', 'failed'],
    ['unauthorized code', { code: 'unauthorized', message: 'Unauthorized' }, 'permission-denied', 'failed'],
    ['other home_assistant_error', { code: 'home_assistant_error', message: 'Jammed' }, 'device-error', 'failed'],
    ['bare 3', 3, 'connection-lost', 'uncertain'],
    ['nested 3', { error: { code: 3 } }, 'connection-lost', 'uncertain'],
    ['nested HA error', { error: { code: 'not_found' } }, 'service-missing', 'failed'],
    ['other hajs number', 1, 'unknown', 'failed'],
    ['an Error', new Error('boom'), 'unknown', 'failed'],
    ['a string', 'boom', 'unknown', 'failed'],
    ['undefined', undefined, 'unknown', 'failed'],
    ['unknown code', { code: 'timeout', message: 'slow' }, 'unknown', 'failed'],
  ])('%s → %s (%s)', (_label, error, code, outcome) => {
    expect(mapRejection(error)).toMatchObject({ code, outcome, notSent: false });
  });

  it('PortNotSent → disconnected, failed, notSent', () => {
    expect(mapRejection({ portError: 'not-sent', reason: 'disconnected' })).toEqual({
      code: 'disconnected',
      outcome: 'failed',
      notSent: true,
    });
    expect(isPortNotSent({ portError: 'not-sent', reason: 'disposed' })).toBe(true);
    expect(isPortNotSent({ code: 'not-sent' })).toBe(false);
  });

  it('quotes HA only for rejected and device-error, and keeps the HA code for diagnostics', () => {
    expect(mapRejection({ code: 'service_validation_error', message: 'Setpoint too high' })).toEqual({
      code: 'rejected',
      outcome: 'failed',
      notSent: false,
      haCode: 'service_validation_error',
      haMessage: 'Setpoint too high',
    });
    expect(mapRejection({ code: 'not_found', message: 'Service light.turn_on not found.' })).not.toHaveProperty(
      'haMessage',
    );
    expect(mapRejection({ code: 'home_assistant_error', message: '   ' })).not.toHaveProperty('haMessage');
  });
});

describe('sanitizeHaMessage and plainText', () => {
  it('keeps markup as literal text (escaping happens at render time)', () => {
    expect(sanitizeHaMessage('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('collapses whitespace and strips control and bidi-override characters', () => {
    expect(sanitizeHaMessage(' Line one\n\tline\u0007 two‮ ')).toBe('Line one line two');
  });

  it('caps at 160 characters with an ellipsis, counting code points', () => {
    const long = '🔥'.repeat(200);
    const capped = sanitizeHaMessage(long) ?? '';
    expect([...capped]).toHaveLength(HA_MESSAGE_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
    expect(sanitizeHaMessage('x'.repeat(HA_MESSAGE_MAX_CHARS))).toBe('x'.repeat(HA_MESSAGE_MAX_CHARS));
  });

  it('returns undefined for non-strings and blank text', () => {
    expect(sanitizeHaMessage(42)).toBeUndefined();
    expect(sanitizeHaMessage('\u0000\u0001')).toBeUndefined();
    expect(plainText(undefined, 10)).toBeUndefined();
    expect(plainText('Hall lamp', 4)).toBe('Hal…');
  });
});

describe('entity IDs never reach normal UI through HA messages (§7.3)', () => {
  /** The same shape check the gateway suite uses for every user-facing message. */
  const ENTITY_ID_SHAPE = /\b[a-z_]+\.[a-z0-9_]+\b/;

  it.each([
    ['Entity cover.demo_x does not support action cover.open_cover', 'Entity does not support action'],
    ['Referenced entities light.demo_a, light.demo_b and light.demo_c are missing', 'Referenced entities are missing'],
    ["Entity 'light.demo_kitchen' not found.", 'Entity not found.'],
    ['Unable to find entity light.demo_kitchen.', 'Unable to find entity.'],
    ['script.demo_disarm failed: timeout', 'failed: timeout'],
  ])('%s → %s', (raw, shown) => {
    expect(sanitizeHaMessage(raw)).toBe(shown);
    expect(sanitizeHaMessage(raw)).not.toMatch(ENTITY_ID_SHAPE);
  });

  it('keeps numbers, longer dotted runs and text without IDs exactly as they were', () => {
    expect(withoutEntityIds('Setpoint 21.5 is above 30')).toBe('Setpoint 21.5 is above 30');
    expect(withoutEntityIds("Can't reach it, 'twice' tried")).toBe("Can't reach it, 'twice' tried");
    expect(withoutEntityIds('Version 2026.10 required')).toBe('Version 2026.10 required');
  });

  it('caps the stripped text, and falls back to no message when nothing readable remains', () => {
    const long = `light.demo_kitchen ${'x'.repeat(400)}`;
    const capped = sanitizeHaMessage(long) ?? '';
    expect([...capped]).toHaveLength(HA_MESSAGE_MAX_CHARS);
    expect(capped.startsWith('x')).toBe(true);
    expect(sanitizeHaMessage('light.demo_kitchen')).toBeUndefined();
    expect(mapRejection({ code: 'home_assistant_error', message: 'cover.demo_x' })).not.toHaveProperty('haMessage');
  });

  it('maps a device error quoting HA without its entity IDs', () => {
    expect(
      mapRejection({ code: 'home_assistant_error', message: 'Entity cover.demo_x does not support this' }),
    ).toMatchObject({ code: 'device-error', haMessage: 'Entity does not support this' });
  });
});
