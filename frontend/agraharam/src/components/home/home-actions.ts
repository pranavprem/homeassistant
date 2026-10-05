/**
 * Gesture routing shared by the Home section and its two drawers (§7.2). Leaves emit intent events; the element
 * holding the ActionController turns each into exactly one request (or a confirm request when the Availability says
 * so), and reports its tickets through the section's single live region (control-notes.ts).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { EntityId } from '../../config/schema.ts';
import type { ActionController } from '../../ha/actions/action-controller.ts';
import {
  newerStatus,
  type ActionErrorCode,
  type ActionKey,
  type ActionRequest,
  type ActionStatus,
  type Availability,
} from '../../ha/actions/types.ts';
import { isScriptAction, ticketShortText } from '../../model/action-copy.ts';
import { isDefined } from '../../util/defined.ts';
import { requestConfirm } from '../shell/overlay-types.ts';
import { sharedNotice } from '../shared/control-notes.ts';

// ---------------------------------------------------------------------------------------------------------------
// Intent events emitted by the Home leaves ({ bubbles: true, composed: false }: they stop at the element that
// rendered the leaf, which holds the ActionController).

export interface RoomQuickDetail {
  readonly room: number;
  readonly next: 'on' | 'off';
}
export type VacuumCommand = 'start' | 'pause' | 'return';
export interface VacuumCommandDetail {
  readonly entity: EntityId;
  readonly command: VacuumCommand;
}
export interface LightCommandDetail {
  readonly entity: EntityId;
  readonly command: 'on' | 'off';
}
export interface BrightnessDraftDetail {
  readonly entity: EntityId;
  readonly value: number;
}
export interface CurtainCommandDetail {
  readonly entity: EntityId;
  readonly command: 'open' | 'close';
}

export function emit<T>(target: HTMLElement, type: string, detail: T): void {
  target.dispatchEvent(new CustomEvent<T>(type, { bubbles: true, composed: false, detail }));
}

// ---------------------------------------------------------------------------------------------------------------
// Requests (callers never pass domains, services or data: §4.7)

export function roomRequest(detail: RoomQuickDetail): ActionRequest {
  return { kind: detail.next === 'off' ? 'room.lights_off' : 'room.lights_on', room: detail.room };
}

const VACUUM_KINDS = Object.freeze({
  start: 'vacuum.start',
  pause: 'vacuum.pause',
  return: 'vacuum.return_to_base',
} as const);

export function vacuumRequest(detail: VacuumCommandDetail): ActionRequest {
  return { kind: VACUUM_KINDS[detail.command], entity: detail.entity };
}

export function lightRequest(detail: LightCommandDetail): ActionRequest {
  return { kind: detail.command === 'on' ? 'light.turn_on' : 'light.turn_off', entity: detail.entity };
}

export function curtainRequest(detail: CurtainCommandDetail): ActionRequest {
  return { kind: detail.command === 'open' ? 'curtain.open' : 'curtain.close', entity: detail.entity };
}

/**
 * One gesture, one request (§7.2), for the element holding the ActionController: a disabled Availability sends
 * nothing, `confirm: true` goes through the confirm dialog and never calls request(), and an immediate failure is
 * kept so the live region can say why nothing happened. The trigger is the control that emitted the intent, for
 * focus to return to.
 */
export function performFromEvent(
  host: HTMLElement,
  actions: ActionController,
  tickets: ImmediateTickets,
  request: ActionRequest,
  event: Event,
): void {
  const availability = actions.evaluate(request);
  if (!availability.enabled) return;
  const trigger = (event.composedPath()[0] as HTMLElement | undefined) ?? host;
  if (availability.confirm) {
    requestConfirm(host, request, trigger);
    return;
  }
  tickets.record(actions.request(request));
}

// ---------------------------------------------------------------------------------------------------------------
// Tickets

/**
 * Failed results returned straight from request(): the gateway may not store a precheck failure, but the user
 * still needs to hear why nothing happened. Kept per key until dismissed or superseded by a newer ticket.
 */
export class ImmediateTickets implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #failed = new Map<ActionKey, ActionStatus>();

  constructor(host: ReactiveControllerHost) {
    this.#host = host;
    host.addController(this);
  }

  record(status: ActionStatus): void {
    if (status.phase === 'failed') this.#failed.set(status.key, status);
    else this.#failed.delete(status.key);
    this.#host.requestUpdate();
  }

  /** The newer of the gateway's ticket and a recorded immediate failure, by ticket id. */
  current(key: ActionKey, fromGateway: ActionStatus | undefined): ActionStatus | undefined {
    return newerStatus(fromGateway, this.#failed.get(key));
  }

  /** The user dismissed the key's ticket note; the ActionController dismisses the gateway's side and re-renders. */
  forget(key: ActionKey): void {
    this.#failed.delete(key);
  }

  /** Nothing pending survives an unmount: a remount starts with a clean live region. */
  hostDisconnected(): void {
    this.#failed.clear();
  }
}

/**
 * Short in-place text for a control's own row while its ticket is open; undefined at rest and once a device's
 * ticket is confirmed, because the row then shows the observed state itself. Scripts report none, so they keep
 * "Requested".
 */
export function rowStatusText(status: ActionStatus | undefined): string | undefined {
  if (status === undefined || (status.phase === 'confirmed' && !isScriptAction(status.kind))) return undefined;
  return ticketShortText(status);
}

// ---------------------------------------------------------------------------------------------------------------
// Panel-level notice

/**
 * One notice when every control shares a panel-wide reason (controls off, editing, disconnected) instead of a line
 * under each control (§16.10); the same rule as the other sections.
 */
export function panelNotice(availabilities: readonly (Availability | undefined)[]): string | undefined {
  return sharedNotice(availabilities.filter(isDefined));
}

/**
 * Reasons a row spells out next to its controls: they explain something the row's state text does not. Busy and
 * "already open" read from the row's own status, unavailable and missing from its state text.
 */
const ROW_REASONS: ReadonlySet<ActionErrorCode> = new Set([
  'permission-denied',
  'service-missing',
  'unsupported',
  'not-allowed',
  'domain-mismatch',
  'state-unknown',
]);

/** The first reason among a row's controls worth showing as visible meta text (§7.2), if any. */
export function rowReason(availabilities: readonly (Availability | undefined)[]): string | undefined {
  for (const availability of availabilities) {
    if (availability !== undefined && !availability.enabled && ROW_REASONS.has(availability.reason)) {
      return availability.message;
    }
  }
  return undefined;
}

declare global {
  interface HTMLElementEventMap {
    'agr-home-room-quick': CustomEvent<RoomQuickDetail>;
    'agr-home-vacuum': CustomEvent<VacuumCommandDetail>;
    'agr-home-light': CustomEvent<LightCommandDetail>;
    'agr-home-brightness': CustomEvent<BrightnessDraftDetail>;
    'agr-home-curtain': CustomEvent<CurtainCommandDetail>;
  }
}
