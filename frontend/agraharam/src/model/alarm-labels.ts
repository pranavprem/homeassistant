/**
 * The alarm state's icon (§8.1), shared by the header pill and the security drawer. The state itself, its label and
 * every predicate on it are judged once in domain/alarm.ts.
 */
import type { AlarmDisplay } from '../domain/alarm.ts';
import type { IconName } from './types.ts';

/**
 * Shape follows meaning, so the state never depends on color alone: off when disarmed, a check when armed, an alert
 * for a triggered alarm and for every transition (arming, entry delay, disarming), and a plain shield for anything
 * not known live (stale, unknown, unavailable, not found, loading).
 */
export function alarmIcon(alarm: AlarmDisplay): IconName {
  if (alarm.stale) return 'shield';
  if (alarm.state === 'disarmed') return 'shield-off';
  if (alarm.tone === 'ok') return 'shield-check';
  if (alarm.tone === 'danger' || alarm.tone === 'attention') return 'shield-alert';
  return 'shield';
}
