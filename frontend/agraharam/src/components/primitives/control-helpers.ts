/**
 * Plain helpers the control primitives share (§5.5), in a module that registers no element: importing one never
 * defines agr-button, agr-slider or agr-stepper as a side effect.
 */
import type { DraftState } from '../../ha/actions/action-controller.ts';

/** Whether a control's label, status or reason text is visible, or only read through aria-describedby. */
export type TextDisplay = 'visible' | 'hidden';
/** Where a disabled control's reason shows. */
export type ReasonDisplay = TextDisplay;

/** Detail of 'agr-draft', emitted by agr-slider and agr-stepper. */
export interface DraftDetail {
  readonly value: number;
}

const NOT_SENT_TEXT = 'Not sent';
const DEGREE = '°';

/** Held keys auto-repeat keydown, and a held Enter would click once per repeat. */
export function suppressKeyRepeat(event: KeyboardEvent): void {
  if (event.repeat) event.preventDefault();
}

/** Visible meta text, or the same text visually hidden (still read through aria-describedby). */
export function textClass(display: TextDisplay): string {
  return display === 'visible' ? 't-meta' : 'visually-hidden';
}

/** The value a gesture builds on: the draft while drafting or held, else the observed value. */
export function draftBase(draft: DraftState, observed: number | null): number | null {
  return draft.phase === 'drafting' || draft.phase === 'held' ? draft.value : observed;
}

/** "Setting 72°F" while a draft is pending, "Not sent" after it was discarded, else nothing. */
export function draftStatusText(draft: DraftState, describe: (value: number) => string): string | undefined {
  if (draft.phase === 'drafting' || draft.phase === 'held') return `Setting ${describe(draft.value)}`;
  if (draft.phase === 'not-sent') return NOT_SENT_TEXT;
  return undefined;
}

function isDegreeUnit(unit: string): boolean {
  return unit.startsWith(DEGREE);
}

/** The scale letter of a degree unit ("F" for "°F"), which the visible value drops; '' for any other unit. */
export function degreeScale(unit: string): string {
  return isDegreeUnit(unit) ? unit.slice(DEGREE.length) : '';
}

/**
 * A stepper value as the rest of the dashboard SHOWS temperatures: a degree unit shows only its degree sign ("72°"),
 * any other unit in full.
 */
export function stepperValueText(value: number, unit: string): string {
  return isDegreeUnit(unit) ? `${value}${DEGREE}` : `${value}${unit}`;
}

/** A stepper value as assistive technology READS it, scale included ("72°F"): its status line and announcements. */
export function stepperSpokenText(value: number, unit: string): string {
  return `${value}${unit}`;
}
