/**
 * Overlay events and the drawer element contract (§5.2). Sections and drawers dispatch the two request events
 * through requestDrawer() and requestConfirm() (bubbles and composed, so they cross shadow roots); the root stops
 * them on its shadow root and calls the overlay host, which alone decides which drawer is mounted.
 *
 *   new CustomEvent<OpenDrawerDetail>('agr-open-drawer', { bubbles: true, composed: true, detail })
 *   new CustomEvent<ConfirmDetail>('agr-request-confirm', { bubbles: true, composed: true, detail })
 *   new CustomEvent('agr-drawer-closed', { bubbles: true, composed: true })   dispatched by agr-drawer
 */
import type { EntityId } from '../../config/schema.ts';
import type { ActionRequest } from '../../ha/actions/types.ts';
import type { DashboardServices } from '../services.ts';

export type DrawerRequest =
  | { id: 'room'; room: number }
  | { id: 'home' }
  | { id: 'climate'; entity?: EntityId }
  | { id: 'security' }
  | { id: 'media'; entity: EntityId }
  | { id: 'health' }
  | { id: 'household' }
  | { id: 'diagnostics' }
  | { id: 'cameras' }
  | { id: 'camera'; entity: EntityId }
  | { id: 'readings' }
  /** `select`: the aircraft (its validated ICAO hex) whose row opens expanded, if it is still listed. */
  | { id: 'sky'; select?: string }
  | { id: 'weather' };
export interface OpenDrawerDetail {
  readonly request: DrawerRequest;
  readonly trigger: HTMLElement;
}
/** No caller-supplied copy: the dialog derives title, body and button label from the action itself. */
export interface ConfirmDetail {
  readonly action: ActionRequest;
  readonly trigger: HTMLElement;
}

/** Asks the root to open a drawer; focus returns to `trigger` when it closes (§5.4 rule 7). */
export function requestDrawer(host: HTMLElement, request: DrawerRequest, trigger: HTMLElement): void {
  const detail: OpenDrawerDetail = { request, trigger };
  host.dispatchEvent(new CustomEvent('agr-open-drawer', { bubbles: true, composed: true, detail }));
}

/**
 * Asks the root to show agr-confirm-dialog for `action`, the only path to a confirmed request (§5.2). Dispatch it
 * exactly when the control's Availability is `{ enabled: true, confirm: true }`.
 */
export function requestConfirm(host: HTMLElement, action: ActionRequest, trigger: HTMLElement): void {
  const detail: ConfirmDetail = { action, trigger };
  host.dispatchEvent(new CustomEvent('agr-request-confirm', { bubbles: true, composed: true, detail }));
}

/** Every drawer file (agr-room-drawer, agr-security-drawer, …) is a LitElement implementing this. */
export interface DrawerElement<R extends DrawerRequest = DrawerRequest> extends HTMLElement {
  services: DashboardServices; // set by the overlay host before first render, updated on publish
  request: R; // narrowed by id, for example { id: 'room'; room: number }
}

/** The overlay host alone decides which drawer is mounted ('camera' mounts agr-camera-dialog). */
export const DRAWER_TAGS: Readonly<Record<Exclude<DrawerRequest['id'], 'camera'>, string>> = Object.freeze({
  room: 'agr-room-drawer',
  home: 'agr-home-drawer',
  climate: 'agr-climate-drawer',
  security: 'agr-security-drawer',
  media: 'agr-media-drawer',
  health: 'agr-health-drawer',
  household: 'agr-household-drawer',
  diagnostics: 'agr-diagnostics-drawer',
  cameras: 'agr-cameras-drawer',
  readings: 'agr-readings-drawer',
  sky: 'agr-sky-drawer',
  weather: 'agr-weather-drawer',
});

declare global {
  interface HTMLElementEventMap {
    'agr-open-drawer': CustomEvent<OpenDrawerDetail>;
    'agr-request-confirm': CustomEvent<ConfirmDetail>;
    'agr-drawer-closed': CustomEvent<null>;
  }
}
