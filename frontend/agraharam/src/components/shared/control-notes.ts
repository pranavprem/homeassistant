/**
 * What a section's single polite live region says (§7.2, §16.10), and the one panel-level notice that replaces
 * per-control reason lines when every control is paused for the same shared reason. Every section and drawer with
 * controls builds its notes here and renders them with agr-control-notes; button status text is static, so only that
 * region announces.
 *
 * Which tickets are announced is the same everywhere: one note per subject with a current ticket, in the section's
 * subject order, so a newer ticket never hides an older outcome that still needs acknowledging; plus a note for each
 * pending stepper draft and each discarded draft.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import type { DismissParts, DraftState } from '../../ha/actions/action-controller.ts';
import type { ActionErrorCode, ActionKey, ActionStatus, Availability } from '../../ha/actions/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { ticketPhaseCopy } from '../../model/action-copy.ts';
import type { Tone } from '../../model/display.ts';
import type { ChoiceVM, IconName } from '../../model/types.ts';

/** A device whose tickets and drafts the region reports, named as the user knows it (never an entity ID). */
export interface NoteSubject {
  readonly key: ActionKey;
  readonly name: string;
  /** Who a sent request waits for, when that is not the device itself (security: "the security controller"). */
  readonly waitingFor?: string;
  /** The words for a pending stepper draft ("Target 73°"): a stepper's own value change is otherwise silent. */
  readonly draftText?: (value: number) => string;
}

/**
 * Where a section's ticket progress (pending, sent, confirmed) shows: 'shown' in the region, or 'announced' only,
 * when the section's controls already show their own progress in place (Home rows, the security buttons).
 */
export type ProgressPresentation = 'shown' | 'announced';

export interface ControlNote {
  readonly id: string;
  readonly key: ActionKey;
  readonly source: 'ticket' | 'draft';
  /** Shown before the text unless the text already names the device. */
  readonly name?: string;
  readonly text: string;
  readonly tone: Tone;
  readonly icon?: IconName;
  readonly dismissible: boolean;
  /** Read by assistive technology only: the control shows the same progress in place. */
  readonly announceOnly: boolean;
  /** A ticket note that also stands for the draft its failure discarded; dismissing it clears both. */
  readonly clearsDraft?: boolean;
}

const NOTICE_ICON_SIZE = 16;

const DRAFT_COPY: Readonly<Record<Extract<DraftState, { phase: 'not-sent' }>['reason'], string>> = Object.freeze({
  disconnected: 'Not sent: Home Assistant was disconnected. Nothing was changed.',
  preview: 'Not sent: controls are off while you edit the dashboard.',
  config: 'Not sent: the dashboard configuration changed.',
  uncertain: "Your latest change wasn't sent. Use the control again to send it.",
  failed: "Your latest change wasn't sent. Use the control again to send it.",
});

/** Reasons that pause every control at once; one notice says it instead of a line under each control. */
const SHARED_REASONS: ReadonlySet<ActionErrorCode> = new Set(['controls-off', 'preview', 'disconnected']);

/** Whether a disabled reason is one of the panel-wide ones a single notice states (§16.10). */
function isSharedReason(reason: ActionErrorCode): boolean {
  return SHARED_REASONS.has(reason);
}

export function controlNotes(
  subjects: readonly NoteSubject[],
  statusOf: (key: ActionKey) => ActionStatus | undefined,
  draftOf: (key: ActionKey) => DraftState,
  progress: ProgressPresentation = 'shown',
): readonly ControlNote[] {
  return subjects.flatMap((subject) => {
    const status = statusOf(subject.key);
    const draft = draftOf(subject.key);
    // A draft discarded because this ticket failed or went uncertain says the same thing again; the ticket's
    // actionable message stands for both, so the region never shows one problem twice.
    const draftExplained = draft.phase === 'not-sent' && isProblem(status) && draft.reason === status?.phase;
    const notes: ControlNote[] = [];
    if (status !== undefined) notes.push(ticketNote(subject, status, draftExplained, progress));
    const draftNote = draftExplained ? undefined : noteForDraft(subject, draft);
    if (draftNote !== undefined) notes.push(draftNote);
    return notes;
  });
}

function isProblem(status: ActionStatus | undefined): boolean {
  return status?.phase === 'uncertain' || status?.phase === 'failed';
}

function ticketNote(
  subject: NoteSubject,
  status: ActionStatus,
  clearsDraft: boolean,
  progress: ProgressPresentation,
): ControlNote {
  const copy = ticketPhaseCopy(status, subject.waitingFor ?? subject.name);
  return {
    id: `${subject.key}:ticket:${status.id}`,
    key: subject.key,
    source: 'ticket',
    ...namedUnlessSaid(subject.name, copy.text),
    text: copy.text,
    tone: copy.tone,
    ...(status.phase === 'confirmed' && { icon: 'check' as const }),
    dismissible: copy.persistent,
    announceOnly: !copy.persistent && progress === 'announced',
    ...(clearsDraft && { clearsDraft }),
  };
}

/** A pending stepper draft is announced (the stepper shows "Setting …" itself); a discarded one waits for Dismiss. */
function noteForDraft(subject: NoteSubject, draft: DraftState): ControlNote | undefined {
  const base = { id: `${subject.key}:draft`, key: subject.key, source: 'draft' as const };
  if (draft.phase === 'not-sent') {
    const text = DRAFT_COPY[draft.reason];
    return { ...base, name: subject.name, text, tone: 'attention', dismissible: true, announceOnly: false };
  }
  if ((draft.phase === 'drafting' || draft.phase === 'held') && subject.draftText !== undefined) {
    const text = subject.draftText(draft.value);
    return { ...base, name: subject.name, text, tone: 'neutral', dismissible: false, announceOnly: true };
  }
  return undefined;
}

function namedUnlessSaid(name: string, text: string): { readonly name?: string } {
  return text.includes(name) ? {} : { name };
}

/**
 * Dismissing a note clears what it stands for (its draft, its stored ticket, or both) through the section's
 * ActionController, which also re-renders. `immediate` forgets a failure the section kept itself for a ticket note
 * (Home's ImmediateTickets).
 */
export function dismissNote(
  note: ControlNote,
  actions: { dismiss(key: ActionKey, parts: DismissParts): void },
  immediate?: { forget(key: ActionKey): void },
): void {
  const ticket = note.source === 'ticket';
  if (ticket) immediate?.forget(note.key);
  actions.dismiss(note.key, { draft: note.source === 'draft' || note.clearsDraft === true, ticket });
}

/** A choice group's activatable options; the pressed one is always disabled as "Current …" and says nothing shared. */
export function choiceControls(choice: ChoiceVM | undefined): readonly Availability[] {
  return (choice?.options ?? []).filter((option) => !option.pressed).map((option) => option.availability);
}

/** The shared reason when every control is disabled for the same panel-wide cause, else undefined. */
export function sharedNotice(availabilities: readonly Availability[]): string | undefined {
  const first = availabilities[0];
  if (first === undefined || first.enabled || !isSharedReason(first.reason)) return undefined;
  return availabilities.every((item) => !item.enabled && item.reason === first.reason) ? first.message : undefined;
}

/** The panel-level notice line; the section adds `noticeStyles`. */
export function renderNotice(text: string | undefined): TemplateResult | typeof nothing {
  if (text === undefined) return nothing;
  return html`<p class="notice">${renderIcon('info', NOTICE_ICON_SIZE)}<span>${text}</span></p>`;
}

export const noticeStyles = css`
  .notice {
    display: flex;
    align-items: center;
    gap: var(--agr-space-2);
    margin: 0;
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .notice svg {
    flex: none;
  }
`;
