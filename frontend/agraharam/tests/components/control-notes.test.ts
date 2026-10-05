/**
 * The shared section live-region notes (§7.2, §16.10): one note per subject's ticket, pending stepper draft or
 * discarded draft, never the same problem twice, and one panel notice when every control shares a panel-wide reason.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DraftState } from '../../src/ha/actions/action-controller.ts';
import type { ActionKey, ActionStatus, Availability } from '../../src/ha/actions/types.ts';
import '../../src/components/shared/agr-control-notes.ts';
import { controlNotes, dismissNote, sharedNotice } from '../../src/components/shared/control-notes.ts';

const KEY: ActionKey = 'entity:fan.demo_purifier';
const SUBJECTS = [{ key: KEY, name: 'Purifier' }];

function status(phase: ActionStatus['phase'], message?: string): ActionStatus {
  return {
    id: 7,
    key: KEY,
    kind: 'fan.set_percentage',
    phase,
    startedAt: 0,
    ...(message !== undefined && { error: { code: phase === 'failed' ? 'rejected' : 'timeout', message } }),
  };
}

const notSent = (reason: Extract<DraftState, { phase: 'not-sent' }>['reason']): DraftState => ({
  phase: 'not-sent',
  value: 40,
  reason,
});

describe('controlNotes', () => {
  it('shows one note when a draft was discarded by the failure its ticket already reports', () => {
    const notes = controlNotes(
      SUBJECTS,
      () => status('failed', "Home Assistant didn't accept the request: out of range"),
      () => notSent('failed'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: 'ticket', dismissible: true, clearsDraft: true, tone: 'danger' });
    expect(notes[0]?.text).toContain("didn't accept");
  });

  it('merges an uncertain ticket with the draft it held back in the same way', () => {
    const notes = controlNotes(
      SUBJECTS,
      () => status('uncertain', "Purifier didn't confirm within 20 seconds."),
      () => notSent('uncertain'),
    );
    expect(notes.map((note) => note.source)).toEqual(['ticket']);
  });

  it('keeps both notes when the draft was discarded for another reason', () => {
    const notes = controlNotes(
      SUBJECTS,
      () => status('failed', 'Not sent.'),
      () => notSent('disconnected'),
    );
    expect(notes.map((note) => note.source)).toEqual(['ticket', 'draft']);
    expect(notes[0]?.clearsDraft).toBeUndefined();
  });

  it('lists every subject with a ticket in subject order, so a newer ticket never hides an older outcome', () => {
    const lamp: ActionKey = 'entity:light.demo_lamp';
    const statuses: Partial<Record<ActionKey, ActionStatus>> = {
      [KEY]: status('uncertain', "Purifier didn't confirm within 20 seconds."),
      [lamp]: { ...status('pending'), id: 9, key: lamp, kind: 'light.turn_on', startedAt: 5 },
    };
    const notes = controlNotes(
      [...SUBJECTS, { key: lamp, name: 'Lamp' }],
      (key) => statuses[key],
      () => ({ phase: 'idle' }),
    );
    expect(notes.map((note) => [note.key, note.text])).toEqual([
      [KEY, "Purifier didn't confirm within 20 seconds."],
      [lamp, 'Sending'],
    ]);
  });

  it('words every phase from the one ticket copy, naming the device unless the text already does', () => {
    const notes = (phase: ActionStatus['phase']) =>
      controlNotes(
        SUBJECTS,
        () => status(phase),
        () => ({ phase: 'idle' }),
      );
    expect(notes('pending')[0]).toMatchObject({ name: 'Purifier', text: 'Sending', tone: 'muted', dismissible: false });
    expect(notes('sent')[0]).toMatchObject({ text: 'Waiting for Purifier', tone: 'muted' });
    expect(notes('sent')[0]?.name).toBeUndefined();
    expect(notes('confirmed')[0]).toMatchObject({ text: 'Done', tone: 'ok', icon: 'check' });
    expect(notes('uncertain')[0]).toMatchObject({ tone: 'attention', dismissible: true });
    expect(notes('failed')[0]).toMatchObject({ tone: 'danger', dismissible: true });
  });

  it('announces progress only, and keeps outcomes visible, where the controls show their own progress', () => {
    const progress = controlNotes(
      SUBJECTS,
      () => status('sent'),
      () => ({ phase: 'idle' }),
      'announced',
    );
    expect(progress[0]).toMatchObject({ announceOnly: true });
    const outcome = controlNotes(
      SUBJECTS,
      () => status('failed', 'Rejected.'),
      () => ({ phase: 'idle' }),
      'announced',
    );
    expect(outcome[0]).toMatchObject({ announceOnly: false, dismissible: true });
  });

  it('announces a pending stepper target ("Target 73°") without a Dismiss, and only for subjects that ask', () => {
    const drafting = (): DraftState => ({ phase: 'drafting', value: 73 });
    const stepper = [{ ...SUBJECTS[0]!, draftText: (value: number) => `Target ${value}°` }];
    expect(controlNotes(stepper, () => undefined, drafting)).toEqual([
      expect.objectContaining({
        source: 'draft',
        name: 'Purifier',
        text: 'Target 73°',
        tone: 'neutral',
        dismissible: false,
        announceOnly: true,
      }),
    ]);
    expect(
      controlNotes(
        stepper,
        () => undefined,
        () => ({ phase: 'held', value: 74 }),
      )[0]?.text,
    ).toBe('Target 74°');
    expect(controlNotes(SUBJECTS, () => undefined, drafting)).toEqual([]);
  });

  it('shows a lone discarded draft as its own dismissible note', () => {
    const notes = controlNotes(
      SUBJECTS,
      () => undefined,
      () => notSent('config'),
    );
    expect(notes).toEqual([expect.objectContaining({ source: 'draft', dismissible: true })]);
  });
});

describe('dismissNote', () => {
  it('clears the draft and the stored ticket a merged note stands for', () => {
    const actions = { dismiss: vi.fn() };
    const immediate = { forget: vi.fn() };
    const [note] = controlNotes(
      SUBJECTS,
      () => status('failed', 'Rejected.'),
      () => notSent('failed'),
    );
    dismissNote(note!, actions, immediate);
    expect(actions.dismiss).toHaveBeenCalledWith(KEY, { draft: true, ticket: true });
    expect(immediate.forget).toHaveBeenCalledWith(KEY);
  });

  it('clears only what a plain note stands for', () => {
    const actions = { dismiss: vi.fn() };
    const immediate = { forget: vi.fn() };
    const [ticket, draft] = controlNotes(
      SUBJECTS,
      () => status('failed', 'Rejected.'),
      () => notSent('preview'),
    );
    dismissNote(ticket!, actions, immediate);
    expect(actions.dismiss).toHaveBeenLastCalledWith(KEY, { draft: false, ticket: true });
    dismissNote(draft!, actions, immediate);
    expect(actions.dismiss).toHaveBeenLastCalledWith(KEY, { draft: true, ticket: false });
    expect(immediate.forget).toHaveBeenCalledTimes(1);
  });
});

describe('sharedNotice', () => {
  const off: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are off.' };
  const unsupported: Availability = { enabled: false, reason: 'unsupported', message: "Doesn't support this." };

  it('returns the panel-wide reason only when every control shares it', () => {
    expect(sharedNotice([off, off])).toBe('Controls are off.');
    expect(sharedNotice([off, unsupported])).toBeUndefined();
    expect(sharedNotice([unsupported, unsupported])).toBeUndefined();
    expect(sharedNotice([])).toBeUndefined();
    expect(sharedNotice([{ enabled: true, confirm: false }])).toBeUndefined();
  });
});

describe('agr-control-notes region', () => {
  it('announces each note on its own: role status with aria-atomic false, additions and text only', async () => {
    const region = document.createElement('agr-control-notes');
    region.notes = controlNotes(
      SUBJECTS,
      () => status('failed', 'Rejected.'),
      () => ({ phase: 'idle' }),
    );
    document.body.append(region);
    await region.updateComplete;
    const live = region.shadowRoot?.querySelector('[role="status"]');
    expect(live?.getAttribute('aria-atomic')).toBe('false');
    expect(live?.getAttribute('aria-relevant')).toBe('additions text');
    region.remove();
  });
});
