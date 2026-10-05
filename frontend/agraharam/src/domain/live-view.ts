/**
 * Whether a camera's live view may open (§9.4), and the reason it may not, worded once for the tile, the cameras
 * drawer and the live-view dialog. Live view is a read, not an action, so it never goes through the gateway and
 * `controls: false` does not turn it off; edit-mode preview does.
 *
 * A domain module (§3): a pure rule both the adapter (ha/live-view-controller.ts) and the view models
 * (model/cameras.ts) use. It builds on the camera gate's verdict and imports nothing from src/model or
 * src/components.
 */
import { ENABLED, type Availability } from '../ha/actions/types.ts';
import { GATE_LABELS, type CameraBinding, type CameraGate } from '../ha/camera-gate.ts';

/** Why live view cannot open, worded for the reason a disabled tile or dialog button carries. */
export const LIVE_REASONS = Object.freeze({
  preview: 'Live view is off while you edit the dashboard.',
  disconnected: 'Paused while Home Assistant is disconnected.',
  resyncing: 'Paused until Home Assistant sends current states.',
  loading: 'Waiting for Home Assistant.',
  privacyOn: 'Live view stays off while privacy is on.',
  privacyUnknown: 'Live view stays off until the privacy status is known.',
  offline: 'This camera is offline.',
  missing: "This camera wasn't found in Home Assistant.",
  denied: "Your Home Assistant user can't view this camera.",
  turnedOff: 'Live view is turned off for this camera.',
} as const);

/** Live view opens only for a camera whose config allows it, with an allowed gate, outside edit mode (§9.4). */
export function liveAvailability(camera: CameraBinding, gate: CameraGate, preview: boolean): Availability {
  if (!camera.live) return disabled('not-allowed', LIVE_REASONS.turnedOff);
  if (gate.kind === 'allowed') {
    return preview ? disabled('preview', LIVE_REASONS.preview) : ENABLED;
  }
  switch (gate.kind) {
    case 'loading':
      return disabled('disconnected', LIVE_REASONS.loading);
    case 'disconnected':
      return disabled(
        'disconnected',
        gate.label === GATE_LABELS.resyncing ? LIVE_REASONS.resyncing : LIVE_REASONS.disconnected,
      );
    case 'privacy':
      return disabled('not-applicable', gate.certainty === 'on' ? LIVE_REASONS.privacyOn : LIVE_REASONS.privacyUnknown);
    case 'offline':
      return disabled('unavailable', LIVE_REASONS.offline);
    case 'missing':
      return disabled('missing-entity', LIVE_REASONS.missing);
    case 'denied':
      return disabled('permission-denied', LIVE_REASONS.denied);
  }
}

function disabled(reason: Extract<Availability, { enabled: false }>['reason'], message: string): Availability {
  return Object.freeze({ enabled: false, reason, message });
}
