/**
 * Camera privacy and availability gate (§9.3). Pure, and it fails CLOSED: a camera picture or stream is allowed
 * only when the store is live, the camera exists, and (with a privacy binding) the privacy entity reports EXACTLY
 * the opposite of its configured "on" value in an object the post-reconnect snapshot delivered. Anything else
 * (unknown, unavailable, empty, a missing entity, any unexpected string such as "On", "true" or "enabled", or a
 * privacy object that predates the last reconnect) keeps the camera closed.
 */
import type { ResolvedConfig } from '../config/schema.ts';
import type { StoreView } from './entity-store.ts';
import { normalizeEntity, type EntityStatus } from './normalize.ts';

export type CameraBinding = ResolvedConfig['cameras'][number];

/** The gate's verdict for one camera (§9.3); `label` is the visible copy for every closed state. */
export type CameraGate =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'privacy'; readonly certainty: 'on' | 'unknown'; readonly label: string }
  | { readonly kind: 'offline' | 'missing' | 'disconnected' | 'denied'; readonly label: string };
type PrivacyOnValue = 'on' | 'off';

interface CameraPrivacyInput {
  /** The privacy entity's current state; undefined when the entity is absent. */
  readonly state: string | undefined;
  readonly onValue: PrivacyOnValue;
  /** StoreView.freshSinceResync(privacy entity): the object was replaced since the last barrier arm. */
  readonly fresh: boolean;
}

export interface CameraGateInput {
  readonly ready: boolean;
  /** States are current: connected AND the resync barrier is clear (false while resyncing). */
  readonly live: boolean;
  readonly resyncing: boolean;
  /** The camera entity's normalized status (normalizeEntity). */
  readonly camera: EntityStatus;
  readonly privacy?: CameraPrivacyInput;
}

/** Visible gate copy (§9.3). Kept here so the tile, drawer and dialog word every closed state the same way. */
export const GATE_LABELS = Object.freeze({
  disconnected: 'Paused while disconnected',
  resyncing: 'Reconnecting',
  privacyOn: 'Privacy on',
  privacyUnknown: 'Privacy status unavailable',
  missing: 'Camera not found',
  offline: 'Offline',
  denied: 'No access',
} as const);

const LOADING: CameraGate = Object.freeze({ kind: 'loading' });
const ALLOWED: CameraGate = Object.freeze({ kind: 'allowed' });

/** The value of a privacy entity that means "privacy off": the exact opposite of the configured on value. */
export function privacyOffValue(onValue: PrivacyOnValue): PrivacyOnValue {
  return onValue === 'on' ? 'off' : 'on';
}

/** First match wins (§9.3, §16.9: the live check precedes privacy, so an uncertain state says so). */
export function cameraGate(input: CameraGateInput): CameraGate {
  if (!input.ready) return LOADING;
  if (!input.live) {
    return { kind: 'disconnected', label: input.resyncing ? GATE_LABELS.resyncing : GATE_LABELS.disconnected };
  }
  const privacy = input.privacy;
  if (privacy !== undefined && !(privacy.fresh && privacy.state === privacyOffValue(privacy.onValue))) {
    return privacy.fresh && privacy.state === privacy.onValue
      ? { kind: 'privacy', certainty: 'on', label: GATE_LABELS.privacyOn }
      : { kind: 'privacy', certainty: 'unknown', label: GATE_LABELS.privacyUnknown };
  }
  return gateForCameraStatus(input.camera);
}

/**
 * Live camera statuses: 'available' and 'unknown' (cameras report idle, streaming or recording; an unknown state
 * does not hide a picture the privacy check already allowed). Absent while HA starts reads as loading, absent
 * otherwise as missing. Every other status, including an object the reconnect snapshot did not replace, is
 * offline: the gate never opens on a status it does not recognise.
 */
function gateForCameraStatus(status: EntityStatus): CameraGate {
  switch (status) {
    case 'available':
    case 'unknown':
      return ALLOWED;
    case 'loading':
      return LOADING;
    case 'missing-binding':
      return { kind: 'missing', label: GATE_LABELS.missing };
    default:
      return { kind: 'offline', label: GATE_LABELS.offline };
  }
}

/**
 * The gate for one configured camera, read from the store. `live` also requires the reader's phase to be
 * 'connected' when given, so a socket that closed between ingests is treated as disconnected (§16.10).
 */
export function cameraGateFor(store: StoreView, camera: CameraBinding, phaseConnected = true): CameraGate {
  const live = store.isConnected() && phaseConnected;
  const privacy = camera.privacy;
  return cameraGate({
    ready: store.isReady(),
    live,
    resyncing: store.isResyncing(),
    camera: normalizeEntity(store, camera.entity).status,
    ...(privacy !== undefined && {
      privacy: {
        state: store.get(privacy.entity)?.state,
        onValue: privacy.onValue,
        fresh: store.freshSinceResync(privacy.entity),
      },
    }),
  });
}

/** The identity of a camera binding: camera, privacy entity and on value (§9.3 "changed"). */
export function cameraBindingKey(camera: CameraBinding): string {
  return [camera.entity, camera.privacy?.entity ?? '', camera.privacy?.onValue ?? ''].join('|');
}
