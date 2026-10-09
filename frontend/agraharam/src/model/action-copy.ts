/**
 * The one catalog of action copy (§5.2, §7.2, §8.2, §8.4, §8.5): ticket wording for every section, and the security,
 * garage and studio-monitor buttons, consequence lines and confirmations. Panels and drawers read button labels and
 * consequence lines from here, and agr-confirm-dialog reads its title, body and button label from here by the action
 * it will execute, so the text shown can never differ from the action sent. A confirm dialog's button label always
 * equals the panel or drawer button that opened it.
 *
 * Buttons use sentence case (§16.13). Night, Away and Vacation are the controller's protection modes and Auto its
 * policy, so they keep their capitals, as in the consequence lines ("Requests Night protection").
 */
import type { SecurityActionRole, ShortcutRole } from '../config/schema.ts';
import { isArmedOrArming, isKnownAlarmState, type AlarmDisplay } from '../domain/alarm.ts';
import type { ActionKind, ActionPhase, ActionRequest, ActionStatus } from '../ha/actions/types.ts';
import type { Tone } from './display.ts';
import type { SecurityActionVM } from './types.ts';

/** How a ticket reads in a section's live region (§7.2). */
interface TicketPhaseCopy {
  readonly text: string;
  readonly tone: Tone;
  /** Uncertain and failed outcomes stay until the user dismisses them. */
  readonly persistent: boolean;
}

/** Scripts report "Requested", never "Done": the UI cannot know what a script did (§8.2). */
const SCRIPT_KINDS: ReadonlySet<ActionKind> = new Set(['security.run', 'studio_monitors.run', 'shortcut.run']);
/** A room action of which only part went out (§18); never "No response yet", which would hide that part went out. */
const PARTLY_DONE = 'Partly done';
const TICKET_TONES: Readonly<Record<ActionPhase, Tone>> = Object.freeze({
  pending: 'muted',
  sent: 'muted',
  confirmed: 'ok',
  uncertain: 'attention',
  failed: 'danger',
});
const SHORT_TEXT: Readonly<Record<Exclude<ActionPhase, 'confirmed'>, string>> = Object.freeze({
  pending: 'Sending',
  sent: 'Waiting for a response',
  uncertain: 'No response yet',
  failed: 'Not done',
});
/**
 * Every uncertain or failed ticket the gateway settles carries its §7.3 message, which already words the garage's and
 * the security controller's own lines (messages.ts); these read only if one ever arrives without a message.
 */
const PROBLEM_FALLBACK: Readonly<Record<'uncertain' | 'failed', string>> = Object.freeze({
  uncertain: 'No response yet. It may still respond. Check it before trying again.',
  failed: 'Not done. Nothing will be retried automatically.',
});

/** Whether the action runs a script, which reports no outcome of its own ("Requested", never "Done"). */
export function isScriptAction(kind: ActionKind): boolean {
  return SCRIPT_KINDS.has(kind);
}

/** The word a control shows beside itself while its ticket is open: "Sending", "Done", "No response yet", … */
export function ticketShortText(status: ActionStatus): string {
  if (status.partial === true) return PARTLY_DONE;
  if (status.phase !== 'confirmed') return SHORT_TEXT[status.phase];
  return isScriptAction(status.kind) ? 'Requested' : 'Done';
}

/**
 * The one wording of a ticket for every section's live region (§7.2): "Sending", "Waiting for <subject>", "Done"
 * ("Requested" for scripts), and the gateway's own message for an uncertain or failed outcome. `subject` names who
 * the request waits for, in plain words ("Courtyard lights", "the security controller"), never an entity ID.
 */
export function ticketPhaseCopy(status: ActionStatus, subject: string): TicketPhaseCopy {
  const tone = TICKET_TONES[status.phase];
  switch (status.phase) {
    case 'pending':
    case 'confirmed':
      return { text: ticketShortText(status), tone, persistent: false };
    case 'sent':
      return { text: `Waiting for ${subject}`, tone, persistent: false };
    case 'uncertain':
    case 'failed':
      return { text: status.error?.message ?? PROBLEM_FALLBACK[status.phase], tone, persistent: true };
  }
}

export interface ConfirmCopy {
  readonly title: string;
  /** Body lines in order; a disabled confirm shows its reason in place of the last line (§5.2 rule 2). */
  readonly body: readonly string[];
  readonly confirmLabel: string;
}

/** Live context the dialog reads from the store, used only for the garage Open alarm line (§8.5). */
export interface ConfirmContext {
  /** Present when security.alarm is configured. */
  readonly alarm?: AlarmDisplay;
  readonly departureConfigured: boolean;
}

interface SecurityActionCopy {
  readonly group: SecurityActionVM['group'];
  readonly label: string;
  readonly consequence: string;
  readonly confirm: ConfirmCopy;
}

export const SECURITY_ACTION_COPY: Readonly<Record<SecurityActionRole, SecurityActionCopy>> = Object.freeze({
  silence_sound: {
    group: 'sound',
    label: 'Silence sound',
    consequence: 'Stops the alarm sound only. Protection and the current policy stay the same.',
    // Shown only while the alarm is not triggered or pending (§7.1); while it sounds, Silence sound runs at once.
    confirm: {
      title: 'Silence sound?',
      body: ['Stops the alarm sound only. Protection and the current policy stay the same.'],
      confirmLabel: 'Silence sound',
    },
  },
  disarm_hold: {
    group: 'disarm',
    label: 'Disarm & hold',
    consequence: 'Turns protection off and keeps it off until you resume Auto arming or choose another hold.',
    confirm: {
      title: 'Disarm and hold?',
      body: [
        'Protection turns off and stays off until you resume Auto arming or choose another hold. This is not the same as silencing the sound.',
      ],
      confirmLabel: 'Disarm & hold',
    },
  },
  hold_night: {
    group: 'hold',
    label: 'Hold Night',
    consequence: 'Requests Night protection and keeps it until you resume Auto arming.',
    confirm: {
      title: 'Hold Night?',
      body: ['The security controller will arm Night and keep it until you resume Auto arming.'],
      confirmLabel: 'Hold Night',
    },
  },
  hold_away: {
    group: 'hold',
    label: 'Hold Away',
    consequence: 'Requests Away protection and keeps it until you resume Auto arming.',
    confirm: {
      title: 'Hold Away?',
      body: ['The security controller will arm Away and keep it until you resume Auto arming.'],
      confirmLabel: 'Hold Away',
    },
  },
  hold_vacation: {
    group: 'hold',
    label: 'Hold Vacation',
    consequence: 'Requests Vacation protection and keeps it until you resume Auto arming.',
    confirm: {
      title: 'Hold Vacation?',
      body: ['The security controller will arm Vacation and keep it until you resume Auto arming.'],
      confirmLabel: 'Hold Vacation',
    },
  },
  resume_auto: {
    group: 'auto',
    label: 'Resume Auto arming',
    consequence: 'Ends the current hold so the Auto policy chooses the mode again. Commissioning is not changed.',
    confirm: {
      title: 'Resume Auto arming?',
      body: [
        'The Auto policy will choose the mode, which may arm or disarm the house right away. Commissioning is not changed.',
      ],
      confirmLabel: 'Resume Auto arming',
    },
  },
  prepare_departure: {
    group: 'departure',
    label: 'Prepare garage departure',
    consequence: 'Disarms for a trusted departure through the garage. It does not open the garage door.',
    confirm: {
      title: 'Prepare garage departure?',
      body: [
        'This disarms the house so you can leave through the garage. The garage door does not move. Open it separately from the Garage panel.',
      ],
      confirmLabel: 'Prepare garage departure',
    },
  },
});

export const GARAGE_BUTTON_LABELS = Object.freeze({ open: 'Open garage', close: 'Close garage' });

const GARAGE_CONFIRM: Readonly<Record<'open' | 'close', ConfirmCopy>> = Object.freeze({
  open: {
    title: 'Open the garage door?',
    body: ['The door starts moving when you confirm.', 'Make sure the doorway is clear.'],
    confirmLabel: GARAGE_BUTTON_LABELS.open,
  },
  close: {
    title: 'Close the garage door?',
    body: ['The door starts moving when you confirm.', 'Make sure nothing is in the doorway.'],
    confirmLabel: GARAGE_BUTTON_LABELS.close,
  },
});

/** A script with no state: the button names an action ("Switch monitors"), never a state toggle (§8.4). */
export const STUDIO_MONITORS_COPY = Object.freeze({
  label: 'Studio monitors',
  button: 'Switch monitors',
  consequence: 'Switches both monitors together.',
});

interface ShortcutButtonCopy {
  /** The short visible text; the row's "Whole house" label gives it context. */
  readonly label: string;
  /** The button's accessible name and the live region's subject; the confirm title names the same thing. */
  readonly accessibleLabel: string;
  readonly confirm: ConfirmCopy;
}

interface ShortcutCopy {
  readonly label: string;
  readonly groupLabel: string;
  readonly consequence: string;
  readonly buttons: Readonly<Record<ShortcutRole, ShortcutButtonCopy>>;
}

/**
 * The Whole-house row (§18). Labels are fixed in code, never configured, so a button can never describe a script as
 * something else. The confirm label names the verb ("Toggle lights") where the one-row button cannot.
 */
export const SHORTCUT_COPY: ShortcutCopy = Object.freeze({
  label: 'Whole house',
  groupLabel: 'Whole house shortcuts',
  consequence: "Each button runs the household's whole-house script after you confirm.",
  buttons: {
    lights_toggle: {
      label: 'Lights',
      accessibleLabel: 'Whole-house lights',
      confirm: {
        title: 'Toggle the whole-house lights?',
        body: [
          "Runs the household's whole-house lights script. The script decides which lights turn on or off; this dashboard can't tell in advance.",
        ],
        confirmLabel: 'Toggle lights',
      },
    },
    curtains_toggle: {
      label: 'Curtains',
      accessibleLabel: 'Whole-house curtains',
      confirm: {
        title: 'Toggle the whole-house curtains?',
        body: [
          "Runs the household's whole-house curtains script. Curtains and blinds across the house may open or close; this dashboard can't tell in advance which way.",
          'Make sure nothing is in the way of a moving curtain.',
        ],
        confirmLabel: 'Toggle curtains',
      },
    },
  },
});

const DEPARTURE_HINT = 'To leave without setting it off, use Prepare garage departure in Security first.';
const ALARM_UNAVAILABLE_LINE =
  "The alarm state isn't available right now. Opening the garage may set it off if the house is armed.";

/**
 * The only path to confirm dialog text (§5.2 rule 1). Undefined for actions that never ask for confirmation.
 * The garage Open line is information only: it never offers a shortcut and never chains the departure script.
 */
export function confirmCopyFor(action: ActionRequest, context: ConfirmContext): ConfirmCopy | undefined {
  switch (action.kind) {
    case 'security.run':
      return SECURITY_ACTION_COPY[action.role].confirm;
    case 'shortcut.run':
      return SHORTCUT_COPY.buttons[action.role].confirm;
    case 'garage.close':
      return GARAGE_CONFIRM.close;
    case 'garage.open':
      return withAlarmLine(GARAGE_CONFIRM.open, garageOpenAlarmLine(context));
    default:
      return undefined;
  }
}

/** §8.5: armed or arming warns (plus the departure hint when configured); an unknown, unavailable, missing or stale
 *  alarm warns that the state is unknown; disarmed, pending, triggered and disarming add nothing. */
function garageOpenAlarmLine(context: ConfirmContext): string | undefined {
  const alarm = context.alarm;
  if (alarm === undefined) return undefined;
  if (isArmedOrArming(alarm)) {
    const warning = `The alarm is ${alarm.label}. Opening the garage may set it off.`;
    return context.departureConfigured ? `${warning} ${DEPARTURE_HINT}` : warning;
  }
  return isKnownAlarmState(alarm) ? undefined : ALARM_UNAVAILABLE_LINE;
}

/** Inserts `line` before the body's last line. */
function withAlarmLine(copy: ConfirmCopy, line: string | undefined): ConfirmCopy {
  if (line === undefined) return copy;
  const body = [...copy.body];
  body.splice(body.length - 1, 0, line);
  return { ...copy, body };
}
