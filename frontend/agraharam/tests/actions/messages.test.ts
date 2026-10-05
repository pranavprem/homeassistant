/** User-facing action copy (§7.3, §7.1 not-applicable, §8.2 and §8.5 ticket copy). */
import { describe, expect, it } from 'vitest';
import type { NotApplicableReason } from '../../src/ha/actions/catalog.ts';
import {
  actionMessage,
  GARAGE_TICKET_COPY,
  NOT_APPLICABLE_COPY,
  SECURITY_TICKET_COPY,
  stoppedWatchingMessage,
  type ActionSubject,
  type MessageContext,
} from '../../src/ha/actions/messages.ts';
import type { ActionErrorCode } from '../../src/ha/actions/types.ts';

const LAMP: ActionSubject = { name: 'Reading lamp', plural: false };
const LIGHTS: ActionSubject = { name: 'the Kitchen lights', plural: true };
const ctx = (extra: Partial<MessageContext> = {}): MessageContext => ({ stage: 'evaluate', subject: LAMP, ...extra });

const ALL_CODES: readonly ActionErrorCode[] = [
  'disconnected',
  'preview',
  'controls-off',
  'not-allowed',
  'domain-mismatch',
  'missing-entity',
  'unavailable',
  'state-unknown',
  'not-applicable',
  'unsupported',
  'service-missing',
  'invalid-argument',
  'confirmation-required',
  'busy',
  'permission-denied',
  'not-sent',
  'rejected',
  'bad-request',
  'device-error',
  'connection-lost',
  'timeout',
  'reversed',
  'unknown',
];

describe('actionMessage', () => {
  it('has actionable copy for every code: capitalized, no placeholders, no entity IDs', () => {
    for (const code of ALL_CODES) {
      const message = actionMessage(code, ctx({ timeoutMs: 20_000 }));
      expect(message.length, code).toBeGreaterThan(10);
      expect(message.charAt(0), code).toBe(message.charAt(0).toUpperCase());
      expect(message, code).not.toMatch(/[{}]/);
      expect(message, code).not.toMatch(/\b[a-z_]+\.[a-z0-9_]+\b/);
    }
  });

  it.each([
    ['preview', 'Controls are off while you edit the dashboard.'],
    ['controls-off', 'Controls are turned off in the dashboard configuration.'],
    ['not-allowed', "This control isn't set up for Reading lamp in the dashboard configuration."],
    ['missing-entity', "Reading lamp wasn't found in Home Assistant."],
    ['unavailable', 'Reading lamp is unavailable right now.'],
    ['state-unknown', "Reading lamp hasn't reported its state, so this control is paused until it does."],
    ['unsupported', "Reading lamp doesn't support this control."],
    ['service-missing', "Home Assistant isn't offering this control right now. The integration may still be loading."],
    ['invalid-argument', 'That value is outside what Reading lamp accepts.'],
    ['busy', 'Waiting for Reading lamp to respond to the last request.'],
    ['permission-denied', "Your Home Assistant user can't control Reading lamp. Ask an administrator for access."],
    ['not-sent', 'Not sent. Nothing was changed. Use the control again to send it.'],
    ['bad-request', "The dashboard sent a request Home Assistant couldn't read. Nothing changed. Please report this."],
    [
      'connection-lost',
      'The connection dropped while sending. The request may or may not have reached Reading lamp. Check it before trying again.',
    ],
    ['unknown', 'Something went wrong sending the request. Nothing will be retried automatically.'],
  ] as const)('%s reads as in §7.3', (code, expected) => {
    expect(actionMessage(code, ctx())).toBe(expected);
  });

  it('words disconnected by stage and phase', () => {
    expect(actionMessage('disconnected', ctx())).toBe('Paused while Home Assistant is disconnected.');
    expect(actionMessage('disconnected', ctx({ resyncing: true }))).toBe(
      'Paused until Home Assistant sends current states.',
    );
    expect(actionMessage('disconnected', ctx({ stage: 'request' }))).toBe(
      'Not sent: Home Assistant was disconnected. Nothing was changed.',
    );
  });

  it('agrees verbs with plural subjects and capitalizes them', () => {
    expect(actionMessage('unavailable', ctx({ subject: LIGHTS }))).toBe(
      'The Kitchen lights are unavailable right now.',
    );
    expect(actionMessage('missing-entity', ctx({ subject: LIGHTS }))).toBe(
      "The Kitchen lights weren't found in Home Assistant.",
    );
    expect(actionMessage('state-unknown', ctx({ subject: LIGHTS }))).toBe(
      "The Kitchen lights haven't reported their state, so this control is paused until they do.",
    );
    expect(actionMessage('unsupported', ctx({ subject: LIGHTS }))).toBe(
      "The Kitchen lights don't support this control.",
    );
  });

  it('quotes HA for rejected and device-error, with a fallback when HA said nothing', () => {
    expect(actionMessage('rejected', ctx({ haMessage: 'Setpoint too high' }))).toBe(
      "Home Assistant didn't accept the request: Setpoint too high",
    );
    expect(actionMessage('rejected', ctx())).toBe("Home Assistant didn't accept the request.");
    expect(actionMessage('device-error', ctx({ haMessage: 'Bulb offline.' }))).toBe(
      'Reading lamp reported an error: Bulb offline. Check the device, then try again.',
    );
    expect(actionMessage('device-error', ctx())).toBe(
      'Reading lamp reported an error. Check the device, then try again.',
    );
  });

  it('uses the configured timeout in seconds', () => {
    expect(actionMessage('timeout', ctx({ timeoutMs: 20_000 }))).toBe(
      "Reading lamp didn't confirm within 20 seconds. It may still respond. Check it before trying again.",
    );
  });

  it('reuses the garage and security panel copy (§8.2, §8.5)', () => {
    expect(actionMessage('timeout', ctx({ kind: 'garage.open' }))).toBe(GARAGE_TICKET_COPY.uncertainOpen);
    expect(actionMessage('timeout', ctx({ kind: 'garage.close' }))).toBe(GARAGE_TICKET_COPY.uncertainClose);
    expect(actionMessage('reversed', ctx({ kind: 'garage.open' }))).toBe(GARAGE_TICKET_COPY.reversedOpen);
    expect(actionMessage('reversed', ctx({ kind: 'garage.close' }))).toBe(GARAGE_TICKET_COPY.reversedClose);
    expect(actionMessage('timeout', ctx({ kind: 'security.run' }))).toBe(SECURITY_TICKET_COPY.uncertain);
    expect(actionMessage('state-unknown', ctx({ kind: 'garage.close' }))).toBe(
      "The garage door hasn't reported its position, so it can't be moved from here.",
    );
    expect(actionMessage('not-allowed', ctx({ garageLikeCover: 'garage-panel' }))).toBe(
      'This garage door is moved from the Garage panel, which asks for confirmation first.',
    );
    expect(actionMessage('not-allowed', ctx({ garageLikeCover: 'elsewhere' }))).toBe(
      "Garage, gate and door covers can't be moved from this dashboard.",
    );
  });

  it('reads not-applicable from the contextual copy, with the "Current …" wording varying by kind', () => {
    const reasons = Object.keys(NOT_APPLICABLE_COPY) as NotApplicableReason[];
    for (const reason of reasons) {
      expect(actionMessage('not-applicable', ctx({ notApplicable: reason }))).toBe(NOT_APPLICABLE_COPY[reason]);
    }
    expect(NOT_APPLICABLE_COPY['current-mode']).toBe('Current mode');
    expect(NOT_APPLICABLE_COPY['current-preset']).toBe('Current preset');
    expect(NOT_APPLICABLE_COPY['current-source']).toBe('Current source');
    expect(NOT_APPLICABLE_COPY['already-open']).toBe('Already open');
    expect(NOT_APPLICABLE_COPY['already-running']).toBe('Already running');
  });

  it('says a disposed gateway stopped watching, not that the call failed', () => {
    expect(stoppedWatchingMessage({ name: 'the garage door', plural: false })).toBe(
      "The garage door hadn't confirmed when the dashboard stopped watching. It may still respond. Check it before trying again.",
    );
  });
});
