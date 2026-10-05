/**
 * Security drawer selector (§8.1–§8.3). The actual alarm state, the selected policy, the suggested mode,
 * commissioning and the controller's health text are separate values and never merged into one sentence. Actions
 * exist only for configured roles, in the §8.2 group order, with labels and consequences from model/action-copy.ts.
 */
import type { SecurityActionRole } from '../config/schema.ts';
import { alarmDisplayFor } from '../domain/alarm.ts';
import { ABSENT_LABELS, normalizeEntity, textDisplay, type NormalizedEntity } from '../ha/normalize.ts';
import { SECURITY_ACTION_COPY } from './action-copy.ts';
import { friendlyName } from './display.ts';
import { perimeterPosition } from './perimeter.ts';
import type { PerimeterItemVM, SecurityActionVM, SecurityVM, SelectorInput } from './types.ts';

type Commissioning = NonNullable<SecurityVM['commissioning']>;

/** §8.2 order: Sound, Disarm, Holds, Auto, Departure. */
const SECURITY_ROLE_ORDER: readonly SecurityActionRole[] = Object.freeze([
  'silence_sound',
  'disarm_hold',
  'hold_night',
  'hold_away',
  'hold_vacation',
  'resume_auto',
  'prepare_departure',
]);

/** §8.1: the commissioning interlock (the system's setup mode) is reported in plain words, never controlled here. */
const COMMISSIONING_LABELS = Object.freeze({ on: 'Setup mode on', off: 'Off' });

/** §8.1: health text is capped so a runaway controller message cannot take over the drawer. */
export const HEALTH_TEXT_MAX_CHARS = 200;
const ELLIPSIS = '…';

const PERIMETER_FALLBACK_NAME = 'Entry point';

/** No alarm is configured: the drawer shows its "not set up" state instead of these values. */
const NOT_CONFIGURED: SecurityVM = Object.freeze({
  alarm: Object.freeze({ state: 'missing-binding', label: 'Alarm not found', tone: 'muted', stale: false }),
  perimeter: Object.freeze([]),
  actions: Object.freeze([]),
});

export function selectSecurity(input: SelectorInput): SecurityVM {
  const security = input.config.security;
  if (security === undefined) return NOT_CONFIGURED;
  const { store } = input;
  const formatter = input.reader.formatter();
  const formatted = (n: NormalizedEntity) => textDisplay(n, (e) => formatter.entityState(e));
  return {
    alarm: alarmDisplayFor(store, security.alarm),
    policy: formatted(normalizeEntity(store, security.policy)),
    ...(security.suggested !== undefined && { suggested: formatted(normalizeEntity(store, security.suggested)) }),
    ...(security.commissioning !== undefined && {
      commissioning: commissioningState(normalizeEntity(store, security.commissioning)),
    }),
    ...(security.healthText !== undefined && {
      health: textDisplay(normalizeEntity(store, security.healthText), (e) => capHealthText(e.state)),
    }),
    perimeter: security.perimeter.map((ref) => perimeterItem(input, ref.entity, ref.name)),
    actions: selectActions(input),
  };
}

function selectActions(input: SelectorInput): SecurityActionVM[] {
  const configured = input.config.security?.actions ?? {};
  return SECURITY_ROLE_ORDER.filter((role) => configured[role] !== undefined).map((role) => actionVM(input, role));
}

/** The ticket all roles share is attributed to its button by the drawer (SecurityTickets), never here. */
function actionVM(input: SelectorInput, role: SecurityActionRole): SecurityActionVM {
  const copy = SECURITY_ACTION_COPY[role];
  return {
    role,
    group: copy.group,
    label: copy.label,
    consequence: copy.consequence,
    availability: input.gateway.evaluate({ kind: 'security.run', role }),
  };
}

/** on → "Setup mode on", off → "Off", anything else → the normalized status label. A stale value keeps its last
 *  known reading (the drawer adds "Last known"). */
function commissioningState(n: NormalizedEntity): Commissioning {
  const readable = n.status === 'available' || n.status === 'disconnected';
  const state = readable ? n.entity?.state : undefined;
  if (state === 'on') return { status: n.status, on: true, label: COMMISSIONING_LABELS.on };
  if (state === 'off') return { status: n.status, on: false, label: COMMISSIONING_LABELS.off };
  const reason = n.status === 'available' || n.status === 'privacy' ? 'unknown' : n.status;
  return { status: n.status, on: null, label: ABSENT_LABELS[reason] };
}

function capHealthText(text: string): string {
  // Code points, not UTF-16 units, so an emoji at the cut is never split into a lone surrogate.
  const characters = Array.from(text.trim());
  if (characters.length <= HEALTH_TEXT_MAX_CHARS) return characters.join('');
  return (
    characters
      .slice(0, HEALTH_TEXT_MAX_CHARS - ELLIPSIS.length)
      .join('')
      .trimEnd() + ELLIPSIS
  );
}

function perimeterItem(
  input: SelectorInput,
  entity: PerimeterItemVM['key'],
  configuredName: string | undefined,
): PerimeterItemVM {
  const normalized = normalizeEntity(input.store, entity);
  const { position, label } = perimeterPosition(normalized);
  return {
    key: entity,
    name: friendlyName(input.store, entity, configuredName, PERIMETER_FALLBACK_NAME),
    status: normalized.status,
    position,
    label,
  };
}
