/**
 * The alarm panel's state, judged once (§8.1): its label and tone, and the predicates the gateway, the header pill,
 * the security drawer and the confirm dialog share, so they can never word or judge the same state differently. The
 * label always reports the alarm panel's actual state; a policy value such as "Auto" never changes it.
 *
 * A domain module (§3): pure rules both the adapter (src/ha) and the view models (src/model) use. It reads entity
 * statuses through ha/normalize.ts and imports nothing from src/model or src/components. The icon for a state is
 * presentation and lives in model/alarm-labels.ts.
 */
import type { EntityId } from '../config/schema.ts';
import type { StoreView } from '../ha/entity-store.ts';
import { normalizeEntity, type NormalizedEntity, type Tone } from '../ha/normalize.ts';

/** `state` is the raw alarm state when one is known (also when stale), otherwise the normalized status. */
export interface AlarmDisplay {
  readonly state: string;
  readonly label: string;
  readonly tone: Tone;
  readonly stale: boolean;
}

const ARMED_TONE: Tone = 'ok';
const TRANSITION_TONE: Tone = 'attention';

const ALARM_STATES: Readonly<Record<string, { readonly label: string; readonly tone: Tone }>> = Object.freeze({
  disarmed: { label: 'Disarmed', tone: 'neutral' },
  armed_home: { label: 'Armed home', tone: ARMED_TONE },
  armed_away: { label: 'Armed away', tone: ARMED_TONE },
  armed_night: { label: 'Armed night', tone: ARMED_TONE },
  armed_vacation: { label: 'Armed vacation', tone: ARMED_TONE },
  armed_custom_bypass: { label: 'Armed custom', tone: ARMED_TONE },
  arming: { label: 'Arming', tone: TRANSITION_TONE },
  pending: { label: 'Entry delay', tone: TRANSITION_TONE },
  disarming: { label: 'Disarming', tone: TRANSITION_TONE },
  triggered: { label: 'Alarm triggered', tone: 'danger' },
});

/** Raw states in which the alarm sounds (or is about to): Silence sound then runs without confirmation (§7.1). */
const SOUNDING_STATES: ReadonlySet<string> = new Set(['triggered', 'pending']);

const UNKNOWN_LABEL = 'Alarm state unknown';
const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  unavailable: 'Alarm unavailable',
  'missing-binding': 'Alarm not found',
  loading: 'Loading',
});

/** Own keys only: a state such as "toString" or "constructor" must never match the object's prototype. */
function isKnownState(state: string): boolean {
  return Object.hasOwn(ALARM_STATES, state);
}

/**
 * The display for a normalized alarm entity. A stale value keeps its last known label with `stale: true`; the UI
 * pairs it with a separate "Last known" element.
 */
function alarmDisplay(alarm: NormalizedEntity): AlarmDisplay {
  if (alarm.status === 'available' || (alarm.status === 'disconnected' && alarm.entity !== undefined)) {
    const raw = alarm.entity?.state ?? '';
    const stale = alarm.status === 'disconnected';
    const known = isKnownState(raw) ? ALARM_STATES[raw] : undefined;
    if (known === undefined) return { state: raw, label: UNKNOWN_LABEL, tone: 'muted', stale };
    return { state: raw, label: known.label, tone: stale ? 'muted' : known.tone, stale };
  }
  const label = Object.hasOwn(STATUS_LABELS, alarm.status) ? STATUS_LABELS[alarm.status] : undefined;
  return { state: alarm.status, label: label ?? UNKNOWN_LABEL, tone: 'muted', stale: false };
}

/** The display for the configured alarm entity, read from the store now. */
export function alarmDisplayFor(store: StoreView, alarm: EntityId): AlarmDisplay {
  return alarmDisplay(normalizeEntity(store, alarm));
}

/** Armed in any mode, or on the way to armed. */
export function isArmedOrArming(alarm: AlarmDisplay): boolean {
  return !alarm.stale && (alarm.state.startsWith('armed_') || alarm.state === 'arming') && isKnownState(alarm.state);
}

/** A live, recognized alarm state; unknown, unavailable, missing, loading and stale states are not. */
export function isKnownAlarmState(alarm: AlarmDisplay): boolean {
  return !alarm.stale && isKnownState(alarm.state);
}

/** The live alarm is triggered or in its entry delay; a stale (last known) state never counts. */
export function isAlarmSounding(alarm: AlarmDisplay): boolean {
  return !alarm.stale && SOUNDING_STATES.has(alarm.state);
}
