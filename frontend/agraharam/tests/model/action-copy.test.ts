import { describe, expect, it } from 'vitest';
import type { SecurityActionRole } from '../../src/config/schema.ts';
import type { ActionKind, ActionStatus } from '../../src/ha/actions/types.ts';
import {
  confirmCopyFor,
  GARAGE_BUTTON_LABELS,
  SECURITY_ACTION_COPY,
  STUDIO_MONITORS_COPY,
  ticketPhaseCopy,
  ticketShortText,
} from '../../src/model/action-copy.ts';
import type { AlarmDisplay } from '../../src/domain/alarm.ts';

const ROLES = Object.keys(SECURITY_ACTION_COPY) as SecurityActionRole[];
const DISARMED: AlarmDisplay = { state: 'disarmed', label: 'Disarmed', tone: 'neutral', stale: false };

describe('action copy catalog (§8.2, §8.4, §8.5)', () => {
  it('has copy for every security role, and each confirm label equals its button label', () => {
    expect(ROLES.sort()).toEqual(
      [
        'disarm_hold',
        'hold_away',
        'hold_night',
        'hold_vacation',
        'prepare_departure',
        'resume_auto',
        'silence_sound',
      ].sort(),
    );
    for (const role of ROLES) {
      expect(SECURITY_ACTION_COPY[role].confirm.confirmLabel, role).toBe(SECURITY_ACTION_COPY[role].label);
    }
  });

  it('never words Disarm & Hold as silencing, and says departure does not move the door', () => {
    expect(SECURITY_ACTION_COPY.disarm_hold.label).toBe('Disarm & hold');
    expect(SECURITY_ACTION_COPY.disarm_hold.label.toLowerCase()).not.toContain('silence');
    expect(SECURITY_ACTION_COPY.silence_sound.label.toLowerCase()).not.toContain('disarm');
    // Silencing keeps protection; the persistent disarm turns it off and keeps it off.
    expect(SECURITY_ACTION_COPY.silence_sound.consequence).toBe(
      'Stops the alarm sound only. Protection and the current policy stay the same.',
    );
    expect(SECURITY_ACTION_COPY.silence_sound.confirm.body).toEqual([SECURITY_ACTION_COPY.silence_sound.consequence]);
    expect(SECURITY_ACTION_COPY.disarm_hold.consequence).toContain('Turns protection off and keeps it off');
    expect(SECURITY_ACTION_COPY.disarm_hold.confirm.body.join(' ')).toContain(
      'This is not the same as silencing the sound.',
    );
    expect(SECURITY_ACTION_COPY.prepare_departure.consequence).toBe(
      'Disarms for a trusted departure through the garage. It does not open the garage door.',
    );
  });

  it('looks confirm copy up by the action only', () => {
    const context = { alarm: DISARMED, departureConfigured: true };
    expect(confirmCopyFor({ kind: 'security.run', role: 'hold_night' }, context)?.title).toBe('Hold Night?');
    expect(confirmCopyFor({ kind: 'garage.open' }, context)?.confirmLabel).toBe(GARAGE_BUTTON_LABELS.open);
    expect(confirmCopyFor({ kind: 'garage.close' }, context)?.confirmLabel).toBe(GARAGE_BUTTON_LABELS.close);
    expect(confirmCopyFor({ kind: 'studio_monitors.run' }, context)).toBeUndefined();
  });

  it('adds no alarm line to Open when no alarm is configured', () => {
    expect(confirmCopyFor({ kind: 'garage.open' }, { departureConfigured: false })?.body).toEqual([
      'The door starts moving when you confirm.',
      'Make sure the doorway is clear.',
    ]);
  });

  it('words the studio monitors honestly: an action, "Requested", never an outlet state', () => {
    expect(STUDIO_MONITORS_COPY).toEqual({
      label: 'Studio monitors',
      button: 'Switch monitors',
      consequence: 'Switches both monitors together.',
    });
    expect(
      ticketShortText({ id: 1, key: 'studio_monitors', kind: 'studio_monitors.run', phase: 'confirmed', startedAt: 0 }),
    ).toBe('Requested');
  });
});

describe('ticket copy: one wording for every section (§7.2)', () => {
  function ticket(phase: ActionStatus['phase'], kind: ActionKind = 'light.turn_on', message?: string): ActionStatus {
    return {
      id: 1,
      key: 'entity:light.demo_lamp',
      kind,
      phase,
      startedAt: 0,
      ...(message !== undefined && { error: { code: 'timeout', message } }),
    };
  }

  it('words progress the same way everywhere, with a muted tone until the outcome', () => {
    expect(ticketPhaseCopy(ticket('pending'), 'Lamp')).toEqual({ text: 'Sending', tone: 'muted', persistent: false });
    expect(ticketPhaseCopy(ticket('sent'), 'Lamp')).toEqual({
      text: 'Waiting for Lamp',
      tone: 'muted',
      persistent: false,
    });
    expect(ticketPhaseCopy(ticket('confirmed'), 'Lamp')).toEqual({ text: 'Done', tone: 'ok', persistent: false });
  });

  it('says "Requested" for scripts, never "Done": the UI cannot know what a script did', () => {
    expect(ticketPhaseCopy(ticket('confirmed', 'security.run'), 'the security controller').text).toBe('Requested');
    expect(ticketShortText(ticket('confirmed', 'studio_monitors.run'))).toBe('Requested');
  });

  it("keeps an uncertain or failed outcome until dismissed, in the gateway's own words", () => {
    const timedOut = ticketPhaseCopy(ticket('uncertain', 'garage.open', 'The door has not reported open.'), 'Garage');
    expect(timedOut).toEqual({ text: 'The door has not reported open.', tone: 'attention', persistent: true });
    expect(ticketPhaseCopy(ticket('failed'), 'Lamp')).toEqual({
      text: 'Not done. Nothing will be retried automatically.',
      tone: 'danger',
      persistent: true,
    });
    expect(ticketPhaseCopy(ticket('uncertain'), 'Lamp').text).toBe(
      'No response yet. It may still respond. Check it before trying again.',
    );
  });

  it('gives controls one short word per phase', () => {
    expect(
      (['pending', 'sent', 'confirmed', 'uncertain', 'failed'] as const).map((phase) => ticketShortText(ticket(phase))),
    ).toEqual(['Sending', 'Waiting for a response', 'Done', 'No response yet', 'Not done']);
  });
});
