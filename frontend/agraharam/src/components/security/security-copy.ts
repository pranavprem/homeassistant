/**
 * Static security drawer copy (§8.1, §8.3). Button labels, consequence lines, confirm text and ticket text are NOT
 * here: they live in model/action-copy.ts so the drawer and agr-confirm-dialog can never word an action differently.
 */
import type { SecurityActionVM } from '../../model/types.ts';

export const SECURITY_DRAWER_HEADING = 'Security';

export const SECURITY_GROUP_HEADINGS = Object.freeze({
  status: 'Status',
  actions: 'Actions',
  perimeter: 'Monitored entry points',
});

/**
 * §8.1: each status row's label and the helper text that is always shown beneath it, in household words. Every
 * concept keeps its own labelled row: what the alarm panel reports, how the house arms, what the controller would
 * pick, the read-only setup mode and the controller's own status message are never merged into one sentence.
 */
export const STATUS_ROWS = Object.freeze({
  alarm: { label: 'Alarm', helper: 'What the alarm panel reports right now.' },
  policy: { label: 'Arming policy', helper: 'How the house decides when to arm. It is not the alarm state.' },
  suggested: { label: 'Would choose', helper: 'The mode the security controller would pick right now.' },
  commissioning: {
    label: 'Commissioning',
    helper: 'Setup mode for the security system. Changed outside this dashboard.',
  },
  health: { label: 'Health', helper: 'A status message from the security controller, not a sensor test.' },
});

/** §8.2 group headings, in display order. */
export const ACTION_GROUP_HEADINGS: Readonly<Record<SecurityActionVM['group'], string>> = Object.freeze({
  sound: 'Sound',
  disarm: 'Disarm',
  hold: 'Holds',
  auto: 'Auto',
  departure: 'Departure',
});

export const PERIMETER_FOOTER =
  'Only the sensors listed here are shown. A camera picture is not a monitored entry point.';
export const PERIMETER_EMPTY = 'No entry-point sensors are configured for this dashboard.';

export const NOT_CONFIGURED = Object.freeze({
  heading: 'Security is not set up',
  message: 'No alarm panel is configured for this dashboard.',
});

export const LAST_KNOWN = 'Last known';
