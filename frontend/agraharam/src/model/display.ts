/**
 * Display and Tone helpers shared by the section selectors (§4.6), so every panel words and colors the same
 * absent states the same way.
 */
import type { EntityId } from '../config/schema.ts';
import type { StoreView } from '../ha/entity-store.ts';
import { ABSENT_LABELS, type Display, type EntityStatus, type Tone } from '../ha/normalize.ts';

// §3/§4.6 name this module as the home of the display types, so sections can import them from here.
export type { Display, EntityStatus, Tone };

type AbsentReason = Extract<Display, { kind: 'absent' }>['reason'];

/** The visible stand-in for an absent value (§4.6); its label is always shown or read beside it, never the glyph alone. */
export const ABSENT_GLYPH = '—';

export function valueDisplay(text: string, stale = false): Display {
  return { kind: 'value', text, stale };
}

export function absentDisplay(reason: AbsentReason): Display {
  return { kind: 'absent', reason, label: ABSENT_LABELS[reason] };
}

/** The visible text of a Display: the value, or the absent label ("Unavailable", "No data", …). */
export function displayText(display: Display): string {
  return display.kind === 'value' ? display.text : display.label;
}

/** The configured name, else HA's friendly name, else `fallback`. Entity IDs are never shown in normal UI. */
export function friendlyName(store: StoreView, id: EntityId, configured: string | undefined, fallback: string): string {
  if (configured !== undefined && configured !== '') return configured;
  const name = store.get(id)?.attributes['friendly_name'];
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : fallback;
}
