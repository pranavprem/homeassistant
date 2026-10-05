/**
 * Action gateway contract (§4.7). Every mutation goes through one ActionGateway; callers name an action
 * kind and its arguments, never a domain, service, data payload or script entity ID.
 */
import type { ActionFamily, EntityId, SecurityActionRole } from '../../config/schema.ts';
import type { Unsubscribe } from '../host.ts';
import type { ConfirmationToken } from './confirmation.ts';
import { copyActionRequest } from './validate-args.ts';

export type ActionKind =
  | 'light.turn_on'
  | 'light.turn_off'
  | 'light.set_brightness'
  | 'room.lights_on'
  | 'room.lights_off'
  | 'climate.set_temperature'
  | 'climate.set_hvac_mode'
  | 'fan.turn_on'
  | 'fan.turn_off'
  | 'fan.set_percentage'
  | 'fan.set_preset_mode'
  | 'vacuum.start'
  | 'vacuum.pause'
  | 'vacuum.return_to_base'
  | 'garage.open'
  | 'garage.close'
  | 'curtain.open'
  | 'curtain.close'
  | 'media.play'
  | 'media.pause'
  | 'media.next'
  | 'media.previous'
  | 'media.volume_set'
  | 'media.volume_mute'
  | 'media.select_source'
  | 'security.run'
  | 'studio_monitors.run';

/** Callers never pass domain, service, data or script entity IDs. */
export type ActionRequest =
  | { kind: 'light.turn_on' | 'light.turn_off'; entity: EntityId }
  | { kind: 'light.set_brightness'; entity: EntityId; pct: number }
  | { kind: 'room.lights_on' | 'room.lights_off'; room: number } // index into config.rooms
  | { kind: 'climate.set_temperature'; entity: EntityId; temperature: number }
  | { kind: 'climate.set_hvac_mode'; entity: EntityId; mode: string }
  | { kind: 'fan.turn_on' | 'fan.turn_off'; entity: EntityId }
  | { kind: 'fan.set_percentage'; entity: EntityId; percentage: number }
  | { kind: 'fan.set_preset_mode'; entity: EntityId; preset: string }
  | { kind: 'vacuum.start' | 'vacuum.pause' | 'vacuum.return_to_base'; entity: EntityId }
  | { kind: 'garage.open' | 'garage.close' } // target = config.garage.cover
  | { kind: 'curtain.open' | 'curtain.close'; entity: EntityId }
  | { kind: 'media.play' | 'media.pause' | 'media.next' | 'media.previous'; entity: EntityId }
  | { kind: 'media.volume_set'; entity: EntityId; level: number }
  | { kind: 'media.volume_mute'; entity: EntityId; muted: boolean }
  | { kind: 'media.select_source'; entity: EntityId; source: string }
  | { kind: 'security.run'; role: SecurityActionRole } // script from config only
  | { kind: 'studio_monitors.run' };

/**
 * A frozen copy of `value`, read once and validated as the gateway's step 1 validates, or undefined when it is not a
 * well-formed ActionRequest. The gateway takes one at the start of request() and judges only that copy; UI code that
 * holds a request across user time (the overlay host before mounting a confirm dialog) takes one too, so the action
 * confirmed is the action shown, whatever the caller does with its own object. Never throws: an exotic object (a
 * Proxy whose traps throw) is simply not a request.
 */
export function frozenActionRequest(value: unknown): ActionRequest | undefined {
  try {
    return copyActionRequest(value);
  } catch {
    return undefined;
  }
}

/** The newer of two statuses for one key (ticket ids increase monotonically across the page). */
export function newerStatus(a: ActionStatus | undefined, b: ActionStatus | undefined): ActionStatus | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return b.id > a.id ? b : a;
}

export type ActionKey = `entity:${string}` | `room:${number}` | 'garage' | 'security' | 'studio_monitors';
export type ActionPhase = 'pending' | 'sent' | 'confirmed' | 'uncertain' | 'failed';

/**
 * The ticket key for a request. All security roles share 'security' (§4.7 step 13). Shared by the gateway, the
 * ActionController and every section, so a section always watches the key its request is ticketed under.
 */
export function actionKeyFor(req: ActionRequest): ActionKey {
  switch (req.kind) {
    case 'room.lights_on':
    case 'room.lights_off':
      return `room:${req.room}`;
    case 'garage.open':
    case 'garage.close':
      return 'garage';
    case 'security.run':
      return 'security';
    case 'studio_monitors.run':
      return 'studio_monitors';
    default:
      return `entity:${req.entity}`;
  }
}

export type ActionErrorCode =
  | 'disconnected'
  | 'preview'
  | 'controls-off'
  | 'not-allowed'
  | 'domain-mismatch'
  | 'missing-entity'
  | 'unavailable'
  | 'state-unknown'
  | 'not-applicable'
  | 'unsupported'
  | 'service-missing'
  | 'invalid-argument'
  | 'confirmation-required'
  | 'busy'
  | 'permission-denied'
  | 'not-sent' // disposed gateway or stale gesture epoch: invoke never called
  | 'rejected'
  | 'bad-request'
  | 'device-error'
  | 'connection-lost'
  | 'timeout'
  | 'reversed' // garage observed moving back the other way (§7.1)
  | 'unknown';
export interface ActionError {
  readonly code: ActionErrorCode;
  readonly message: string; // user-facing, actionable (§7.3)
  readonly haCode?: string | number; // diagnostics only
}
/** `confirm: true` means the UI must route the gesture through agr-confirm-dialog (agr-request-confirm) instead of
 *  calling request() directly. It is computed from the same state as request() step 11, so it is live (for
 *  example Silence Sound flips to confirm: false while the alarm is triggered). */
export type Availability =
  | { readonly enabled: true; readonly confirm: boolean }
  | { readonly enabled: false; readonly reason: ActionErrorCode; readonly message: string };

/** The one enabled, no-confirmation Availability: plain buttons that open drawers or dismiss notes, and the gateway. */
export const ENABLED: Availability = Object.freeze({ enabled: true, confirm: false });

export interface ActionStatus {
  readonly id: number;
  readonly key: ActionKey;
  readonly kind: ActionKind;
  readonly phase: ActionPhase;
  readonly progress?: 'moving'; // e.g. garage 'opening' observed while awaiting 'open'
  readonly error?: ActionError; // failed | uncertain
  /** Monotonic milliseconds (performance.now()), never Date.now(): e2e pins Date with page.clock.setFixedTime,
   *  which would freeze wall-clock durations and in-flight expiry. Diagnostics shows durations only. */
  readonly startedAt: number;
  readonly settledAt?: number;
}

/**
 * A ticket still waiting for its outcome (pending or sent). The one definition of "in flight" shared by the
 * ActionController (held drafts), the choice-group builder (busy options) and every button's activation guard.
 */
export function isTicketInFlight(status: ActionStatus | undefined): status is ActionStatus {
  return status?.phase === 'pending' || status?.phase === 'sent';
}

export interface RequestOptions {
  /** Minted by agr-confirm-dialog for exactly this request (confirmation.ts) and spent by the request presenting it. */
  readonly confirmation?: ConfirmationToken;
  /** Gesture epoch captured when the user started the gesture (drafts, confirm dialogs). A mismatch with
   *  epoch() at request time → failed('not-sent'), invoke never called. */
  readonly epoch?: number;
}
export interface ActionGateway {
  /** Pure: no side effects. Runs pipeline steps 0–10, 12 and 13 and NEVER returns 'confirmation-required':
   *  step 11 becomes the `confirm` flag of an enabled Availability. Sections render it; the confirm dialog
   *  re-runs it while open to re-check every precondition. */
  evaluate(req: ActionRequest): Availability;
  /** Never throws. Returns 'failed' immediately if any precheck fails; otherwise 'pending'. */
  request(req: ActionRequest, opts?: RequestOptions): ActionStatus;
  status(key: ActionKey): ActionStatus | undefined;
  subscribe(key: ActionKey | '*', listener: (s: ActionStatus) => void): Unsubscribe;
  /** Last 20 settled or failed tickets, newest first (ring buffer; diagnostics only). Empty in the null gateway. */
  recent(): readonly ActionStatus[];
  /** Increments on dispose(), on every transition of the connection phase away from 'connected', and on
   *  invalidate(). Drafts and open confirm dialogs that captured an older epoch are discarded. */
  epoch(): number;
  onEpochChange(listener: (epoch: number) => void): Unsubscribe;
  invalidate(reason: 'preview'): void; // the root calls this when preview turns on
  dismiss(key: ActionKey): void; // clears a terminal status from the UI
  /** Clears timers; non-terminal tickets → uncertain; in-flight registry entries are KEPT until they expire
   *  (the call may still be executing). After dispose, request() returns failed('not-sent') without invoking. */
  dispose(): void;
  readonly disposed: boolean;
}

/** Implemented by src/ha/actions/inflight.ts: module scope, shared by every gateway and card instance in the
 *  page. Keyed by resolved TARGET entity ID (not ActionKey), so a new card instance after a real route change, or
 *  a gateway rebuilt by setConfig, still sees the garage door as busy while an earlier open_cover may be executing.
 *  `until` and `now` are monotonic performance.now() values. */
export interface InflightRegistry {
  mark(targets: readonly EntityId[], until: number): void; // until = start + family timeout
  clear(targets: readonly EntityId[]): void; // on confirmed, failed or reversed only
  isBusy(target: EntityId, now: number): boolean; // expired entries are pruned on read
}

export const ACTION_TIMEOUT_MS: Readonly<Record<ActionFamily, number>> = Object.freeze({
  light: 10_000,
  room: 15_000,
  climate: 20_000,
  fan: 20_000,
  vacuum: 30_000,
  garage: 60_000,
  curtain: 60_000,
  media: 10_000,
  security: 10_000,
  studio_monitors: 10_000,
});
export const CONFIRMED_DISPLAY_MS = 4_000; // confirmed/"Requested" shown, then auto-dismissed
export const CONFIRM_DIALOG_TIMEOUT_MS = 60_000; // an unanswered confirm dialog cancels itself
export const SLIDER_COMMIT_DEBOUNCE_MS = 400; // agr-slider: commit on change, debounced
export const STEPPER_COMMIT_DEBOUNCE_MS = 800; // agr-stepper: accumulate taps, one call
