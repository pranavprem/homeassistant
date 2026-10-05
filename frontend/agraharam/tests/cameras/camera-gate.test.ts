/**
 * §12.1 rows 3 and 9: the camera gate fails CLOSED. Only the exact opposite of the configured "on" value, freshly
 * delivered after the last reconnect, lets the camera checks run.
 */
import { describe, expect, it } from 'vitest';
import { cameraGate, cameraGateFor, privacyOffValue, type CameraGateInput } from '../../src/ha/camera-gate.ts';
import { fakeStore, testEntity } from '../helpers/fake-store.ts';
import { configFrom } from '../helpers/services.ts';

const LIVE: CameraGateInput = { ready: true, live: true, resyncing: false, camera: 'available' };
const PRIVACY_ON = { kind: 'privacy', certainty: 'on', label: 'Privacy on' };
const PRIVACY_UNKNOWN = { kind: 'privacy', certainty: 'unknown', label: 'Privacy status unavailable' };

function withPrivacy(state: string | undefined, onValue: 'on' | 'off' = 'on', fresh = true): CameraGateInput {
  return { ...LIVE, privacy: { state, onValue, fresh } };
}

describe('cameraGate (§9.3)', () => {
  it('is loading before the first ingest and disconnected while not live', () => {
    expect(cameraGate({ ...LIVE, ready: false })).toEqual({ kind: 'loading' });
    expect(cameraGate({ ...LIVE, live: false })).toEqual({ kind: 'disconnected', label: 'Paused while disconnected' });
    expect(cameraGate({ ...LIVE, live: false, resyncing: true })).toEqual({
      kind: 'disconnected',
      label: 'Reconnecting',
    });
  });

  it('checks the connection before privacy, so an uncertain state never shows a stale "Privacy on"', () => {
    expect(cameraGate({ ...withPrivacy('on'), live: false }).kind).toBe('disconnected');
  });

  it('privacy state on → privacy(on); off → the camera checks run', () => {
    expect(cameraGate(withPrivacy('on'))).toEqual(PRIVACY_ON);
    expect(cameraGate(withPrivacy('off'))).toEqual({ kind: 'allowed' });
  });

  it.each(['unknown', 'unavailable', '', 'On', 'OFF', 'true', 'false', 'enabled', 'disabled', 'idle'])(
    'privacy state %j → privacy(unknown)',
    (state) => {
      expect(cameraGate(withPrivacy(state))).toEqual(PRIVACY_UNKNOWN);
    },
  );

  it('a missing privacy entity → privacy(unknown)', () => {
    expect(cameraGate(withPrivacy(undefined))).toEqual(PRIVACY_UNKNOWN);
  });

  it("privacy_on_value: 'off' inverts the meaning", () => {
    expect(privacyOffValue('off')).toBe('on');
    expect(cameraGate(withPrivacy('off', 'off'))).toEqual(PRIVACY_ON);
    expect(cameraGate(withPrivacy('on', 'off'))).toEqual({ kind: 'allowed' });
    expect(cameraGate(withPrivacy('enabled', 'off'))).toEqual(PRIVACY_UNKNOWN);
  });

  it('a privacy object the reconnect snapshot did not replace is never trusted, whatever it says', () => {
    expect(cameraGate(withPrivacy('off', 'on', false))).toEqual(PRIVACY_UNKNOWN);
    expect(cameraGate(withPrivacy('on', 'on', false))).toEqual(PRIVACY_UNKNOWN);
  });

  it('camera statuses: missing, offline, loading while HA starts, and allowed', () => {
    expect(cameraGate({ ...LIVE, camera: 'missing-binding' })).toEqual({ kind: 'missing', label: 'Camera not found' });
    expect(cameraGate({ ...LIVE, camera: 'unavailable' })).toEqual({ kind: 'offline', label: 'Offline' });
    expect(cameraGate({ ...LIVE, camera: 'disconnected' })).toEqual({ kind: 'offline', label: 'Offline' });
    expect(cameraGate({ ...LIVE, camera: 'loading' })).toEqual({ kind: 'loading' });
    expect(cameraGate({ ...LIVE, camera: 'unknown' })).toEqual({ kind: 'allowed' });
    expect(cameraGate(LIVE)).toEqual({ kind: 'allowed' });
  });

  it('privacy blocks before the camera checks (a private, offline camera reads "Privacy on")', () => {
    expect(cameraGate({ ...withPrivacy('on'), camera: 'unavailable' })).toEqual(PRIVACY_ON);
  });
});

describe('cameraGateFor reads the store (§9.3, §16.10)', () => {
  const config = configFrom({
    cameras: [
      { entity: 'camera.demo_hall', name: 'Hall', privacy_entity: 'switch.demo_hall_camera_privacy' },
      { entity: 'camera.demo_side_path', name: 'Side path' },
    ],
  });
  const [hall, side] = config.cameras;
  if (hall === undefined || side === undefined) throw new Error('config');
  const states = [
    testEntity('camera.demo_hall', 'idle'),
    testEntity('switch.demo_hall_camera_privacy', 'off'),
    testEntity('camera.demo_side_path', 'idle'),
  ];

  it('allows a camera whose privacy entity is freshly off', () => {
    expect(cameraGateFor(fakeStore(states), hall)).toEqual({ kind: 'allowed' });
  });

  it('closes during the resync barrier and when the live phase is not connected', () => {
    expect(cameraGateFor(fakeStore(states, { connected: false, resyncing: true }), hall)).toEqual({
      kind: 'disconnected',
      label: 'Reconnecting',
    });
    expect(cameraGateFor(fakeStore(states), side, false).kind).toBe('disconnected');
  });

  it('closes on a privacy entity that was not refreshed by the snapshot', () => {
    expect(cameraGateFor(fakeStore(states, { notFresh: ['switch.demo_hall_camera_privacy'] }), hall)).toEqual(
      PRIVACY_UNKNOWN,
    );
  });

  it('reads "Camera not found" for an absent camera, and loading while HA starts', () => {
    const without = states.filter((state) => state.entity_id !== 'camera.demo_side_path');
    expect(cameraGateFor(fakeStore(without), side).kind).toBe('missing');
    expect(cameraGateFor(fakeStore(without, { haState: 'STARTING' }), side).kind).toBe('loading');
  });
});
