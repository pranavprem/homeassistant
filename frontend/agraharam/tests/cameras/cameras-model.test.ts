/** The cameras selector (§4.8, §6.2.1): budget, private count, per-camera settings and live availability. */
import { describe, expect, it } from 'vitest';
import type { ConnectionPhase } from '../../src/ha/host.ts';
import { liveAvailability } from '../../src/domain/live-view.ts';
import { selectAllCameraTiles, selectCameras } from '../../src/model/cameras.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const CAMERAS = [
  { entity: 'camera.demo_c1', name: 'One', privacy_entity: 'switch.demo_c1_privacy' },
  { entity: 'camera.demo_c2', name: 'Two', thumbnails: false, snapshot_interval: 30 },
  { entity: 'camera.demo_c3', name: 'Three', privacy_entity: 'switch.demo_c3_privacy' },
  { entity: 'camera.demo_c4', name: 'Four' },
  { entity: 'camera.demo_c5', name: 'Five', privacy_entity: 'binary_sensor.demo_c5_privacy', privacy_on_value: 'off' },
  { entity: 'camera.demo_c6', name: 'Six', live: false },
];

const STATES = [
  ...CAMERAS.map((camera) => testEntity(camera.entity, 'idle')),
  testEntity('switch.demo_c1_privacy', 'on'),
  testEntity('switch.demo_c3_privacy', 'unknown'),
  testEntity('binary_sensor.demo_c5_privacy', 'off'),
];

function input(
  options: FakeStoreOptions = {},
  phase: ConnectionPhase = 'connected',
  extra: Record<string, unknown> = {},
): SelectorInput {
  const store = fakeStore(STATES, options);
  return {
    config: configFrom({ cameras: CAMERAS, ...extra }),
    store,
    reader: fakeReader(store, () => phase),
    gateway: new FakeGateway(),
    now: new Date(),
  };
}

describe('selectCameras (§4.8, §6.2.1)', () => {
  it('shows at most four tiles in config order and counts the rest as overflow', () => {
    const vm = selectCameras(input(), { preview: false });
    expect(vm.tiles.map((tile) => tile.name)).toEqual(['One', 'Two', 'Three', 'Four']);
    expect(vm.overflow).toBe(2);
  });

  it('counts privacy that is known to be on across every camera, not unknown privacy', () => {
    const vm = selectCameras(input(), { preview: false });
    expect(vm.privateCount).toBe(2);
    expect(selectAllCameraTiles(input(), { preview: false }).map((tile) => tile.gate.kind)).toEqual([
      'privacy',
      'allowed',
      'privacy',
      'allowed',
      'privacy',
      'allowed',
    ]);
  });

  it('carries thumbnails and the snapshot interval per camera', () => {
    const [one, two] = selectCameras(input(), { preview: false }).tiles;
    expect(one).toMatchObject({ key: 'camera.demo_c1', thumbnails: true, intervalMs: 10_000 });
    expect(two).toMatchObject({ key: 'camera.demo_c2', thumbnails: false, intervalMs: 30_000 });
  });

  it('offers live view for an allowed camera, and never as an action (controls: false keeps it)', () => {
    const tiles = selectAllCameraTiles(input({}, 'connected', { controls: false }), { preview: false });
    expect(tiles[3]?.live).toEqual({ enabled: true, confirm: false });
  });

  it('turns live view off in edit mode', () => {
    expect(selectCameras(input(), { preview: true }).tiles[3]?.live).toMatchObject({
      enabled: false,
      reason: 'preview',
    });
  });

  it('closes every camera while not live, including a stale phase the store has not seen yet', () => {
    const stale = selectAllCameraTiles(input({}, 'disconnected'), { preview: false });
    expect(new Set(stale.map((tile) => tile.gate.kind))).toEqual(new Set(['disconnected']));
    expect(stale[3]?.live).toMatchObject({ enabled: false, reason: 'disconnected' });
    const resyncing = selectAllCameraTiles(input({ connected: false, resyncing: true }, 'resyncing'), {
      preview: false,
    });
    expect(resyncing[3]?.gate).toEqual({ kind: 'disconnected', label: 'Reconnecting' });
    expect(resyncing[3]?.live).toMatchObject({ message: 'Paused until Home Assistant sends current states.' });
    expect(selectCameras(input({ connected: false }, 'disconnected'), { preview: false }).privateCount).toBe(0);
  });

  it('carries each binding key, so a tile drops its picture when the binding changes', () => {
    const [one, two] = selectCameras(input(), { preview: false }).tiles;
    expect(one?.binding).toBe('camera.demo_c1|switch.demo_c1_privacy|on');
    expect(two?.binding).toBe('camera.demo_c2||');
  });

  it('offers no live view at all for a camera whose config turns it off (live: false, §9.4)', () => {
    const six = selectAllCameraTiles(input(), { preview: false })[5];
    expect(six?.gate.kind).toBe('allowed');
    expect(six?.live).toBeUndefined();
    expect(six).not.toHaveProperty('live');
  });

  it('is loading before the first ingest', () => {
    const tiles = selectAllCameraTiles(input({ ready: false }, 'loading'), { preview: false });
    expect(new Set(tiles.map((tile) => tile.gate.kind))).toEqual(new Set(['loading']));
  });
});

describe('liveAvailability (§9.4)', () => {
  const CAMERA = configFrom({ cameras: CAMERAS }).cameras[0]!;

  it.each([
    [
      { kind: 'privacy', certainty: 'on', label: 'Privacy on' },
      'not-applicable',
      'Live view stays off while privacy is on.',
    ],
    [{ kind: 'offline', label: 'Offline' }, 'unavailable', 'This camera is offline.'],
    [{ kind: 'missing', label: 'Camera not found' }, 'missing-entity', "This camera wasn't found in Home Assistant."],
    [{ kind: 'denied', label: 'No access' }, 'permission-denied', "Your Home Assistant user can't view this camera."],
  ] as const)('%o → disabled(%s)', (gate, reason, message) => {
    expect(liveAvailability(CAMERA, gate, false)).toEqual({ enabled: false, reason, message });
  });

  it('refuses a camera whose config turns live view off, whatever its gate', () => {
    expect(liveAvailability({ ...CAMERA, live: false }, { kind: 'allowed' }, false)).toEqual({
      enabled: false,
      reason: 'not-allowed',
      message: 'Live view is turned off for this camera.',
    });
  });
});
