/**
 * §12.1 row 9 (thumbnails): the tile and its SnapshotController. Closed gates never fetch and never offer live view;
 * pictures are object URLs that are always revoked; cadence is visible-only; a rotating access_token changes
 * nothing; 401/403 stop. The second half runs the section over a REAL HassHost driven by FakeHass for the
 * disconnect, resync-barrier and session-denial cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/cameras/agr-camera-tile.ts';
import '../../src/components/cameras/agr-cameras.ts';
import '../../src/components/cameras/agr-camera-dialog.ts';
import type { AgrCameraTile } from '../../src/components/cameras/agr-camera-tile.ts';
import type { AgrCameraDialog } from '../../src/components/cameras/agr-camera-dialog.ts';
import type { AgrCameras } from '../../src/components/cameras/agr-cameras.ts';
import type { OpenDrawerDetail } from '../../src/components/shell/overlay-types.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { backoffDelay, snapshotSize } from '../../src/ha/snapshot-controller.ts';
import type { CameraTileVM } from '../../src/model/types.ts';
import { settle } from '../helpers/dom.ts';
import { FakeIntersectionObserver, setIntersecting, setVisibility } from '../helpers/observers.ts';
import {
  FakeHass,
  FakeSnapshotSource,
  fetchWithAuthCalls,
  FRONT_GATE,
  HALL_PRIVACY,
  hassRuntime,
  liveUrls,
  revokedUrls,
  tileVm,
  type HassRuntime,
} from './camera-harness.ts';

const INTERVAL = 10_000;
const PRIVACY_ON: CameraTileVM['gate'] = { kind: 'privacy', certainty: 'on', label: 'Privacy on' };

async function flush(element?: { updateComplete: Promise<boolean> }): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await element?.updateComplete;
}

async function mountTile(vm: CameraTileVM, source = new FakeSnapshotSource()) {
  const tile = document.createElement('agr-camera-tile');
  tile.vm = vm;
  tile.source = source;
  tile.focusKey = 'camera:0:live';
  document.body.append(tile);
  await tile.updateComplete;
  return { tile, source };
}

async function setVm(tile: AgrCameraTile, vm: CameraTileVM): Promise<void> {
  tile.vm = vm;
  await flush(tile);
}

function shadow(tile: AgrCameraTile): ShadowRoot {
  if (tile.shadowRoot === null) throw new Error('no shadow root');
  return tile.shadowRoot;
}

function picture(tile: AgrCameraTile): HTMLImageElement | null {
  return shadow(tile).querySelector('img.picture');
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('agr-camera-tile: closed gates (§9.3)', () => {
  it.each<[string, CameraTileVM['gate'], string]>([
    ['privacy on', PRIVACY_ON, 'Privacy on'],
    [
      'privacy unknown (or an unexpected state string)',
      { kind: 'privacy', certainty: 'unknown', label: 'Privacy status unavailable' },
      'Privacy status unavailable',
    ],
    ['offline', { kind: 'offline', label: 'Offline' }, 'Offline'],
    ['missing', { kind: 'missing', label: 'Camera not found' }, 'Camera not found'],
    ['disconnected', { kind: 'disconnected', label: 'Paused while disconnected' }, 'Paused while disconnected'],
  ])('%s: never fetches, never offers live view, shows the reason in a 4:3 tile', async (_name, gate, label) => {
    const { tile, source } = await mountTile(
      tileVm({ gate, live: { enabled: false, reason: 'not-applicable', message: 'x' } }),
    );
    setIntersecting(tile, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.calls).toEqual([]);
    expect(shadow(tile).querySelector('button')).toBeNull();
    expect(shadow(tile).querySelector('.tile')?.textContent).toContain(label);
    expect(shadow(tile).querySelector('.tile')?.textContent).toContain('Front gate');
  });

  it('while disconnected shows only "Paused" (the banner says why) and keeps the full reason for assistive tech', async () => {
    const { tile } = await mountTile(
      tileVm({
        gate: { kind: 'disconnected', label: 'Paused while disconnected' },
        live: { enabled: false, reason: 'not-applicable', message: 'x' },
      }),
    );
    const visible = shadow(tile).querySelector('.reason');
    expect(visible?.textContent).toBe('Paused');
    expect(visible?.getAttribute('aria-hidden')).toBe('true');
    expect(shadow(tile).querySelector('.visually-hidden')?.textContent).toBe('Paused while disconnected');
  });

  it('renders a 4:3 box in every state (§6.5)', async () => {
    const styles = (customElements.get('agr-camera-tile') as unknown as { elementStyles: { cssText: string }[] })
      .elementStyles;
    expect(styles.some((style) => /\.tile\s*{[^}]*aspect-ratio:\s*4\s*\/\s*3/.test(style.cssText))).toBe(true);
    const closed = { enabled: false, reason: 'not-applicable', message: 'x' } as const;
    const states: CameraTileVM[] = [
      tileVm({ gate: { kind: 'loading' } }),
      tileVm({ gate: PRIVACY_ON, live: closed }),
      tileVm({ gate: { kind: 'offline', label: 'Offline' }, live: closed }),
      tileVm({ gate: { kind: 'missing', label: 'Camera not found' }, live: closed }),
      tileVm({ gate: { kind: 'disconnected', label: 'Paused while disconnected' }, live: closed }),
      tileVm({ gate: { kind: 'denied', label: 'No access' }, live: closed }),
      tileVm({ thumbnails: false }),
      tileVm(),
    ];
    for (const vm of states) {
      const { tile } = await mountTile(vm);
      expect(shadow(tile).querySelectorAll('.tile')).toHaveLength(1);
      tile.remove();
    }
  });

  it('a loading tile is a skeleton without text', async () => {
    const { tile, source } = await mountTile(tileVm({ gate: { kind: 'loading' } }));
    setIntersecting(tile, true);
    expect(source.calls).toEqual([]);
    expect(shadow(tile).querySelectorAll('[aria-hidden="true"] .skeleton')).toHaveLength(2);
    expect(shadow(tile).querySelector('.visually-hidden')?.textContent).toContain('Loading');
  });
});

describe('agr-camera-tile: pictures (§9.3)', () => {
  it('while the first picture loads, says "Loading picture" visibly over a placeholder fill (§16.14)', async () => {
    const { tile } = await mountTile(tileVm());
    expect(picture(tile)).toBeNull();
    expect(shadow(tile).querySelector('.reason')?.textContent).toBe('Loading picture');
    expect(shadow(tile).querySelector('.fill')?.getAttribute('aria-hidden')).toBe('true');
    expect(shadow(tile).querySelector('button.tile')?.textContent).toContain('Front gate');
  });

  it('fetches only while on screen and visible, then shows the still as an object URL', async () => {
    const { tile, source } = await mountTile(tileVm());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(source.calls).toEqual([]);
    setVisibility('hidden');
    setIntersecting(tile, true);
    expect(source.calls).toEqual([]);
    setVisibility('visible');
    expect(source.calls).toHaveLength(1);
    const size = source.calls[0]?.request;
    expect(size?.width && size.width % 160).toBe(0);
    expect(size?.height).toBe(Math.round((size?.width ?? 0) * 0.75));
    source.resolveNext();
    await flush(tile);
    expect(picture(tile)?.src).toMatch(/^blob:/);
    expect(picture(tile)?.alt).toBe('');
  });

  it('honors snapshot_interval: one refresh per interval, never earlier', async () => {
    const { tile, source } = await mountTile(tileVm({ intervalMs: 30_000 }));
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(source.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.calls).toHaveLength(2);
    source.resolveNext();
    await flush(tile);
    expect(revokedUrls()).toHaveLength(1);
    expect(liveUrls()).toHaveLength(1);
  });

  it('thumbnails: false never fetches and offers "Live view on request"', async () => {
    const { tile, source } = await mountTile(tileVm({ thumbnails: false }));
    setIntersecting(tile, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.calls).toEqual([]);
    const button = shadow(tile).querySelector('button');
    expect(button?.textContent).toContain('Live view on request');
    expect(button?.getAttribute('aria-disabled')).toBeNull();
  });

  it('live: false shows the picture with no live affordance: no button, nothing focusable, no drawer request', async () => {
    const opened = vi.fn();
    document.body.addEventListener('agr-open-drawer', opened);
    const { live: _live, ...withoutLive } = tileVm();
    const { tile, source } = await mountTile(withoutLive);
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    expect(picture(tile)).not.toBeNull();
    expect(shadow(tile).querySelector('button')).toBeNull();
    expect(shadow(tile).querySelector('[data-focus-key]')).toBeNull();
    (shadow(tile).querySelector('.tile') as HTMLElement).click();
    expect(opened).not.toHaveBeenCalled();
    document.body.removeEventListener('agr-open-drawer', opened);
  });

  it('live: false with thumbnails: false says "Live view off" and fetches nothing', async () => {
    const { live: _live, ...withoutLive } = tileVm({ thumbnails: false });
    const { tile, source } = await mountTile(withoutLive);
    setIntersecting(tile, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.calls).toEqual([]);
    expect(shadow(tile).querySelector('button')).toBeNull();
    expect(shadow(tile).textContent).toContain('Live view off');
  });

  it('a new state object with only a rotated access_token neither refetches nor resets the picture', async () => {
    const vm = tileVm();
    const { tile, source } = await mountTile(vm);
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    const url = picture(tile)?.src;
    for (let i = 0; i < 5; i += 1)
      await setVm(tile, { ...vm, gate: { kind: 'allowed' }, live: { enabled: true, confirm: false } });
    expect(source.calls).toHaveLength(1);
    expect(revokedUrls()).toEqual([]);
    expect(picture(tile)?.src).toBe(url);
  });

  it('privacy turning on mid-fetch aborts, revokes the shown picture at once and discards the late result', async () => {
    const vm = tileVm();
    const { tile, source } = await mountTile(vm);
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.calls).toHaveLength(2);
    const inFlight = source.pending[0];
    await setVm(tile, { ...vm, gate: PRIVACY_ON });
    expect(inFlight?.request.signal.aborted).toBe(true);
    expect(liveUrls()).toEqual([]);
    expect(picture(tile)).toBeNull();
    inFlight?.resolve(new Blob(['late'], { type: 'image/png' }));
    await flush(tile);
    expect(vi.mocked(URL.createObjectURL)).toHaveBeenCalledTimes(1);
    expect(picture(tile)).toBeNull();
  });

  it('off screen aborts and keeps the picture; back within (interval − 1 s) waits, later refetches at once', async () => {
    const { tile, source } = await mountTile(tileVm());
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    await vi.advanceTimersByTimeAsync(4_000);
    setIntersecting(tile, false);
    expect(revokedUrls()).toEqual([]);
    expect(picture(tile)).not.toBeNull();
    setIntersecting(tile, true);
    expect(source.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(source.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.calls).toHaveLength(2);
    setIntersecting(tile, false);
    expect(source.calls[1]?.request.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    setIntersecting(tile, true);
    expect(source.calls).toHaveLength(3);
  });

  it('unmount aborts, revokes, disconnects the observer and removes its listeners', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const { tile, source } = await mountTile(tileVm());
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const inFlight = source.pending[0];
    tile.remove();
    expect(inFlight?.request.signal.aborted).toBe(true);
    expect(liveUrls()).toEqual([]);
    expect([...FakeIntersectionObserver.instances].every((observer) => observer.targets.size === 0)).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(source.userListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a 403 denies the tile: "No access", no live view and no retries until the user changes', async () => {
    const { tile, source } = await mountTile(tileVm());
    setIntersecting(tile, true);
    source.rejectNext({ code: 'permission-denied', status: 403 });
    await flush(tile);
    expect(shadow(tile).textContent).toContain('No access');
    expect(shadow(tile).querySelector('button')).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(source.calls).toHaveLength(1);
    source.changeUser();
    expect(source.calls).toHaveLength(2);
  });

  it('a denial lifts when the tile is bound to another camera', async () => {
    const vm = tileVm();
    const { tile, source } = await mountTile(vm);
    setIntersecting(tile, true);
    source.rejectNext({ code: 'permission-denied', status: 403 });
    await flush(tile);
    expect(shadow(tile).textContent).toContain('No access');
    await setVm(tile, { ...vm, key: 'camera.demo_side_path' as CameraTileVM['key'], name: 'Side path' });
    expect(source.calls.map((call) => call.id)).toEqual([FRONT_GATE, 'camera.demo_side_path']);
    expect(shadow(tile).textContent).not.toContain('No access');
  });

  it('a "Live view on request" tile shows the camera icon and names live view once', async () => {
    const { tile } = await mountTile(tileVm({ thumbnails: false }));
    const button = shadow(tile).querySelector('button');
    expect(button?.textContent?.match(/live view/gi)).toHaveLength(1);
  });

  it('a denial lifts once on a new socket generation (reconnect), at the next update', async () => {
    const vm = tileVm();
    const { tile, source } = await mountTile(vm);
    setIntersecting(tile, true);
    source.rejectNext({ code: 'permission-denied', status: 401 });
    await flush(tile);
    await setVm(tile, { ...vm });
    expect(source.calls).toHaveLength(1);
    source.currentGeneration = 2;
    await setVm(tile, { ...vm });
    expect(source.calls).toHaveLength(2);
  });

  it('other errors back off (interval, ×2, …, 120 s) and keep the last picture marked "Not updating"', async () => {
    expect([1, 2, 3, 4, 5, 6].map((failures) => backoffDelay(INTERVAL, failures))).toEqual([
      10_000, 20_000, 40_000, 80_000, 120_000, 120_000,
    ]);
    const { tile, source } = await mountTile(tileVm());
    setIntersecting(tile, true);
    source.resolveNext();
    await flush(tile);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    source.rejectNext({ code: 'unavailable', status: 503 });
    await flush(tile);
    expect(picture(tile)).not.toBeNull();
    expect(shadow(tile).querySelector('.badge')?.textContent).toBe('Not updating');
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(source.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.calls).toHaveLength(3);
    source.rejectNext({ code: 'network' });
    await flush(tile);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL - 1);
    expect(source.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.calls).toHaveLength(4);
  });

  it('without a picture an error reads "Picture unavailable" and still offers live view', async () => {
    const { tile, source } = await mountTile(tileVm());
    setIntersecting(tile, true);
    source.rejectNext({ code: 'not-found', status: 404 });
    await flush(tile);
    const button = shadow(tile).querySelector('button');
    expect(button?.textContent).toContain('Picture unavailable');
  });

  it('requests sizes on a 160 px grid, at most 640 wide', () => {
    expect(snapshotSize(190, 0.75, 2)).toEqual({ width: 480, height: 360 });
    expect(snapshotSize(0, 0.75, 1)).toEqual({ width: 160, height: 120 });
    expect(snapshotSize(900, 0.75, 3)).toEqual({ width: 640, height: 480 });
  });
});

describe('agr-camera-tile: live view entry (§9.4)', () => {
  it('an allowed tile opens the camera dialog with itself as the trigger', async () => {
    const { tile } = await mountTile(tileVm());
    const opened = vi.fn();
    document.body.addEventListener('agr-open-drawer', (event) =>
      opened((event as CustomEvent<OpenDrawerDetail>).detail),
    );
    shadow(tile).querySelector('button')?.click();
    expect(opened).toHaveBeenCalledWith({ request: { id: 'camera', entity: FRONT_GATE }, trigger: tile });
    expect(shadow(tile).querySelector('button')?.getAttribute('data-focus-key')).toBe('camera:0:live');
  });

  it('a disabled live view (edit mode) stays focusable, says why, and opens nothing', async () => {
    const reason = 'Live view is off while you edit the dashboard.';
    const { tile } = await mountTile(tileVm({ live: { enabled: false, reason: 'preview', message: reason } }));
    const opened = vi.fn();
    document.body.addEventListener('agr-open-drawer', opened);
    const button = shadow(tile).querySelector('button');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(shadow(tile).getElementById(button?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(reason);
    button?.click();
    expect(opened).not.toHaveBeenCalled();
  });
});

/** The section over a real HassHost: tiles are made visible one by one, as a test would scroll them in. */
async function mountSection(runtime: HassRuntime): Promise<AgrCameras> {
  const section = document.createElement('agr-cameras');
  section.services = runtime.services;
  document.body.append(section);
  await settle();
  return section;
}

function tilesOf(section: AgrCameras): AgrCameraTile[] {
  return [...(section.shadowRoot?.querySelectorAll('agr-camera-tile') ?? [])];
}

function tileFor(section: AgrCameras, name: string): AgrCameraTile {
  const tile = tilesOf(section).find((candidate) => candidate.vm?.name === name);
  if (tile === undefined) throw new Error(`no tile ${name}`);
  return tile;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

describe('cameras over a real HassHost: disconnect and the resync barrier (§9.1, §9.3, R3-B1)', () => {
  let runtime: HassRuntime | undefined;

  afterEach(() => {
    runtime?.stop();
    runtime?.fake.dispose();
    runtime = undefined;
  });

  async function hallVisible(): Promise<{ section: AgrCameras; fake: FakeHass }> {
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    fake.setState(HALL_PRIVACY, 'off');
    runtime = hassRuntime(fake);
    const section = await mountSection(runtime);
    setIntersecting(tileFor(section, 'Hall'), true);
    await advance(200);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    expect(picture(tileFor(section, 'Hall'))).not.toBeNull();
    return { section, fake };
  }

  it('revokes every picture at once on disconnect, with and without a privacy binding', async () => {
    const { section, fake } = await hallVisible();
    setIntersecting(tileFor(section, 'Front gate'), true);
    await advance(200);
    expect(liveUrls()).toHaveLength(2);
    fake.disconnect();
    await settle();
    expect(liveUrls()).toEqual([]);
    for (const name of ['Hall', 'Front gate']) {
      expect(shadow(tileFor(section, name)).textContent).toContain('Paused while disconnected');
    }
  });

  it('privacy turned on during the outage: no fetch and no live start before or after the snapshot', async () => {
    const { section, fake } = await hallVisible();
    fake.disconnect();
    await settle();
    fake.queueOutageChange(HALL_PRIVACY, 'on');
    fake.reconnect({ snapshotDelayMs: 400 });
    await settle();
    expect(shadow(tileFor(section, 'Hall')).textContent).toContain('Reconnecting');
    expect(shadow(tileFor(section, 'Hall')).querySelector('button')).toBeNull();
    await advance(399);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    await advance(1);
    expect(tileFor(section, 'Hall').vm?.gate).toEqual(PRIVACY_ON);
    await advance(30_000);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
  });

  it('a privacy entity the snapshot did not replace stays closed (privacy unknown, no fetch)', async () => {
    const { section, fake } = await hallVisible();
    fake.disconnect();
    fake.deleteDuringOutage(HALL_PRIVACY);
    fake.reconnect({ snapshotDelayMs: 0 });
    await advance(30_000);
    expect(tileFor(section, 'Hall').vm?.gate).toMatchObject({ kind: 'privacy', certainty: 'unknown' });
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
  });

  it('privacy still off in the snapshot: exactly one fetch, and only after it', async () => {
    const { fake } = await hallVisible();
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 400 });
    await advance(399);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    await advance(1 + 200);
    expect(fetchWithAuthCalls(fake)).toHaveLength(2);
  });

  it('hass.connected true with the live getter false is disconnected: zero fetches (§16.10)', async () => {
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    runtime = hassRuntime(fake);
    fake.connection.drop();
    const section = await mountSection(runtime);
    setIntersecting(tileFor(section, 'Front gate'), true);
    await advance(30_000);
    expect(fetchWithAuthCalls(fake)).toEqual([]);
  });
});

describe('cameras over a real HassHost: 401 is session-level, 403 is per tile (§4.4, §9.3)', () => {
  let runtime: HassRuntime | undefined;

  afterEach(() => {
    runtime?.stop();
    runtime?.fake.dispose();
    runtime = undefined;
  });

  async function openFallbackDialog(services: HassRuntime['services']): Promise<AgrCameraDialog> {
    const dialog = document.createElement('agr-camera-dialog');
    dialog.services = services;
    dialog.request = { id: 'camera', entity: FRONT_GATE };
    document.body.append(dialog);
    await settle();
    return dialog;
  }

  it('one 401 denies every tile and the live-view fallback without another request', async () => {
    const fake = new FakeHass('restricted', { latencyMs: [0, 0] });
    runtime = hassRuntime(fake, demoCardInput('restricted'));
    const section = await mountSection(runtime);
    for (const tile of tilesOf(section)) setIntersecting(tile, true);
    await advance(500);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    const visible = tilesOf(section).filter((tile) => tile.vm?.gate.kind === 'allowed');
    expect(visible.length).toBeGreaterThan(1);
    for (const tile of visible) expect(shadow(tile).textContent).toContain('No access');
    const dialog = await openFallbackDialog(runtime.services);
    await advance(10_000);
    expect(dialog.liveState).toBe('fallback');
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    await advance(600_000);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    dialog.remove();
  });

  it('a reconnect allows exactly one new counted attempt', async () => {
    const fake = new FakeHass('restricted', { latencyMs: [0, 0] });
    runtime = hassRuntime(fake, demoCardInput('restricted'));
    const section = await mountSection(runtime);
    for (const tile of tilesOf(section)) setIntersecting(tile, true);
    await advance(500);
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await advance(500);
    expect(fetchWithAuthCalls(fake)).toHaveLength(2);
  });

  it('a 403 denies only that tile; the others keep their pictures', async () => {
    const fake = new FakeHass('dense', { latencyMs: [0, 0] });
    runtime = hassRuntime(fake, demoCardInput('dense'));
    const section = await mountSection(runtime);
    for (const tile of tilesOf(section)) setIntersecting(tile, true);
    await advance(500);
    expect(shadow(tileFor(section, 'Side path')).textContent).toContain('No access');
    expect(picture(tileFor(section, 'Front gate'))).not.toBeNull();
    expect(picture(tileFor(section, 'Courtyard'))).not.toBeNull();
  });

  it('serializes fetches until a still has loaded, then fetches concurrently', async () => {
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    runtime = hassRuntime(fake);
    const section = await mountSection(runtime);
    for (const tile of tilesOf(section)) setIntersecting(tile, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchWithAuthCalls(fake)).toHaveLength(1);
    await advance(150);
    expect(fetchWithAuthCalls(fake)).toHaveLength(3);
    expect(tilesOf(section).filter((tile) => picture(tile) !== null)).toHaveLength(1);
    await advance(150);
    expect(tilesOf(section).filter((tile) => picture(tile) !== null)).toHaveLength(3);
  });
});
