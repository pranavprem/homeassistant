/**
 * §12.1 rows 2 and 9 (live view), §16.10: live view starts only through the full open gate, is released on close,
 * unmount, gate change and hidden tab, resumes after hidden only through the gate again, never restarts by itself
 * after a disconnect, and falls back to labelled snapshots (also after a contained ll-rebuild). The embedded card
 * is created once and survives unrelated updates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/cameras/agr-camera-dialog.ts';
import type { AgrCameraDialog } from '../../src/components/cameras/agr-camera-dialog.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { CardConfigInput, EntityId } from '../../src/config/schema.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import type { HostReader, LiveStreamHandle } from '../../src/ha/host.ts';
import { deepActive, settle } from '../helpers/dom.ts';
import { setVisibility } from '../helpers/observers.ts';
import {
  FakeHass,
  fetchWithAuthCalls,
  FRONT_GATE,
  HALL,
  HALL_PRIVACY,
  hassRuntime,
  liveUrls,
  type HassRuntime,
} from './camera-harness.ts';

const UNRELATED_LIGHT = 'light.demo_kitchen';

interface StubHandle {
  readonly handle: Extract<LiveStreamHandle, { kind: 'native' }>;
  readonly dispose: ReturnType<typeof vi.fn>;
  fail(): void;
}

function stubHandle(): StubHandle {
  const element = document.createElement('div');
  element.setAttribute('data-agr-live', '');
  const dispose = vi.fn(() => element.remove());
  let failListener: ((reason: 'helpers-failed') => void) | undefined;
  return {
    handle: {
      kind: 'native',
      element,
      dispose,
      onFail: (listener) => {
        failListener = listener;
        return () => {
          failListener = undefined;
        };
      },
    },
    dispose,
    fail: () => failListener?.('helpers-failed'),
  };
}

interface LiveRig {
  readonly runtime: HassRuntime;
  readonly services: DashboardServices;
  readonly open: ReturnType<typeof vi.fn<(id: EntityId) => Promise<LiveStreamHandle>>>;
  readonly handles: StubHandle[];
}

let rig: LiveRig | undefined;

/** A real HassHost runtime whose reader opens stub native handles (one per call). */
function liveRig(fake = new FakeHass('normal', { latencyMs: [0, 0] }), input?: CardConfigInput): LiveRig {
  const runtime = hassRuntime(fake, input);
  const handles: StubHandle[] = [];
  const open = vi.fn((_id: EntityId): Promise<LiveStreamHandle> => {
    const stub = stubHandle();
    handles.push(stub);
    return Promise.resolve(stub.handle);
  });
  const reader: HostReader = { ...runtime.host.reader, openLiveStream: open };
  rig = { runtime, services: { ...runtime.services, reader }, open, handles };
  return rig;
}

async function mountDialog(services: DashboardServices, entity: EntityId = FRONT_GATE): Promise<AgrCameraDialog> {
  const dialog = document.createElement('agr-camera-dialog');
  dialog.services = services;
  dialog.request = { id: 'camera', entity };
  document.body.append(dialog);
  await settle();
  return dialog;
}

function body(dialog: AgrCameraDialog): string {
  return dialog.shadowRoot?.querySelector('.dialog-body')?.textContent?.replace(/\s+/g, ' ') ?? '';
}

function resumeButton(dialog: AgrCameraDialog): HTMLButtonElement | null {
  return dialog.shadowRoot?.querySelector('agr-button')?.shadowRoot?.querySelector('button') ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  rig?.runtime.stop();
  rig?.runtime.fake.dispose();
  rig = undefined;
  delete window.loadCardHelpers;
});

describe('agr-camera-dialog: opening (§9.4)', () => {
  it('never starts under privacy on, and the frame says why', async () => {
    const { services, open } = liveRig();
    const dialog = await mountDialog(services, HALL);
    expect(open).not.toHaveBeenCalled();
    expect(dialog.liveState).toBe('stopped');
    expect(body(dialog)).toContain('Privacy on');
  });

  it('never starts on an unexpected privacy string', async () => {
    const { services, open, runtime } = liveRig();
    runtime.fake.setState(HALL_PRIVACY, 'enabled');
    const dialog = await mountDialog(services, HALL);
    expect(open).not.toHaveBeenCalled();
    expect(body(dialog)).toContain('Privacy status unavailable');
  });

  it('never starts for a camera whose config turns live view off, and offers no Resume', async () => {
    const input = demoCardInput('normal');
    const cameras = (input.cameras ?? []).map((camera) =>
      camera.entity === FRONT_GATE ? { ...camera, live: false } : camera,
    );
    const { services, open } = liveRig(undefined, { ...input, cameras });
    const dialog = await mountDialog(services);
    expect(open).not.toHaveBeenCalled();
    expect(dialog.liveState).toBe('stopped');
    expect(body(dialog)).toContain('Live view is turned off for this camera.');
    expect(resumeButton(dialog)).toBeNull();
    expect(fetchWithAuthCalls(rig!.runtime.fake)).toEqual([]);
  });

  it('never starts during the resync barrier', async () => {
    const { services, open, runtime } = liveRig();
    runtime.fake.disconnect();
    runtime.fake.reconnect({ snapshotDelayMs: 400 });
    const dialog = await mountDialog(services);
    expect(open).not.toHaveBeenCalled();
    expect(body(dialog)).toContain('Paused while disconnected');
  });

  it('starts once for an allowed camera, mounts the handle in the 16:9 frame and focuses Close', async () => {
    const { services, open, handles } = liveRig();
    const dialog = await mountDialog(services);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(FRONT_GATE);
    expect(dialog.liveState).toBe('streaming');
    expect(dialog.shadowRoot?.querySelector('.frame > [data-agr-live]')).toBe(handles[0]?.handle.element);
    expect(dialog.heading).toBe('Front gate');
    expect(services.status.get('live-view')).toBe('native');
    expect(body(dialog)).toContain('Live view');
    expect(deepActive()?.classList.contains('close')).toBe(true);
  });

  it('disposes a handle that arrives after the dialog closed', async () => {
    const { services, runtime } = liveRig();
    const late = stubHandle();
    let answer: ((handle: LiveStreamHandle) => void) | undefined;
    const reader: HostReader = {
      ...runtime.host.reader,
      openLiveStream: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    };
    const dialog = await mountDialog({ ...services, reader });
    dialog.close();
    await settle();
    answer?.(late.handle);
    await settle();
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(late.handle.element.isConnected).toBe(false);
  });
});

describe('agr-camera-dialog: release (§9.4)', () => {
  it('privacy turning on while open disposes at once and offers no automatic restart', async () => {
    const { services, handles, runtime, open } = liveRig();
    runtime.fake.setState(HALL_PRIVACY, 'off');
    const dialog = await mountDialog(services, HALL);
    expect(dialog.liveState).toBe('streaming');
    runtime.fake.setState(HALL_PRIVACY, 'on');
    await settle();
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(body(dialog)).toContain('Privacy on');
    expect(resumeButton(dialog)?.getAttribute('aria-disabled')).toBe('true');
    runtime.fake.setState(HALL_PRIVACY, 'off');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(resumeButton(dialog)?.getAttribute('aria-disabled')).toBeNull();
  });

  it.each([
    [
      'the dialog close event alone',
      (dialog: AgrCameraDialog) => dialog.shadowRoot?.querySelector('dialog')?.dispatchEvent(new Event('close')),
    ],
    ['Close / Escape (dialog.close())', (dialog: AgrCameraDialog) => dialog.close()],
    ['unmount', (dialog: AgrCameraDialog) => dialog.remove()],
    ['card detach (an ancestor removed)', (dialog: AgrCameraDialog) => dialog.parentElement?.remove()],
    ['a hidden tab', () => setVisibility('hidden')],
  ])('%s disposes the live handle', async (_name, release) => {
    const { services, handles } = liveRig();
    const wrapper = document.createElement('div');
    document.body.append(wrapper);
    const dialog = document.createElement('agr-camera-dialog');
    dialog.services = services;
    dialog.request = { id: 'camera', entity: FRONT_GATE };
    wrapper.append(dialog);
    await settle();
    expect(dialog.liveState).toBe('streaming');
    release(dialog);
    await settle();
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('reopening creates a new handle', async () => {
    const { services, open, handles } = liveRig();
    const first = await mountDialog(services);
    first.remove();
    await mountDialog(services);
    expect(open).toHaveBeenCalledTimes(2);
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(handles[1]?.dispose).not.toHaveBeenCalled();
  });
});

describe('agr-camera-dialog: hidden tab and reconnect (§9.4, §16.10)', () => {
  it('back from hidden with the gate still allowed: a new stream through the gate', async () => {
    const { services, open } = liveRig();
    const dialog = await mountDialog(services);
    setVisibility('hidden');
    await settle();
    expect(body(dialog)).toContain('Paused while this tab is hidden');
    setVisibility('visible');
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(dialog.liveState).toBe('streaming');
  });

  it('privacy turned on while hidden: nothing starts on visible and the reason shows', async () => {
    const { services, open, runtime } = liveRig();
    runtime.fake.setState(HALL_PRIVACY, 'off');
    const dialog = await mountDialog(services, HALL);
    setVisibility('hidden');
    runtime.fake.setState(HALL_PRIVACY, 'on');
    setVisibility('visible');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(body(dialog)).toContain('Privacy on');
  });

  it('edit mode turned on while hidden: nothing starts on visible', async () => {
    const { services, open } = liveRig();
    const dialog = await mountDialog(services);
    setVisibility('hidden');
    dialog.services = { ...services, preview: true };
    await settle();
    setVisibility('visible');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(body(dialog)).toContain('Live view is off while you edit the dashboard.');
  });

  it('a disconnect pauses; it never restarts by itself, and "Resume live view" re-runs the gate', async () => {
    const { services, open, handles, runtime } = liveRig();
    const dialog = await mountDialog(services);
    runtime.fake.disconnect();
    await settle();
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(body(dialog)).toContain('Paused while disconnected');
    expect(resumeButton(dialog)?.textContent).toContain('Resume live view');
    expect(resumeButton(dialog)?.getAttribute('aria-disabled')).toBe('true');
    resumeButton(dialog)?.click();
    expect(open).toHaveBeenCalledTimes(1);
    runtime.fake.reconnect({ snapshotDelayMs: 400 });
    await settle();
    expect(resumeButton(dialog)?.getAttribute('aria-disabled')).toBe('true');
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(resumeButton(dialog)?.getAttribute('aria-disabled')).toBeNull();
    resumeButton(dialog)?.click();
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(dialog.liveState).toBe('streaming');
  });

  it('a full reconnect while hidden: visible asks for "Resume live view" and starts nothing by itself', async () => {
    const { services, open, runtime } = liveRig();
    const dialog = await mountDialog(services);
    setVisibility('hidden');
    await settle();
    runtime.fake.disconnect();
    runtime.fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    setVisibility('visible');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(dialog.liveState).toBe('stopped');
    expect(body(dialog)).toContain('Paused while disconnected');
    expect(resumeButton(dialog)?.getAttribute('aria-disabled')).toBeNull();
    resumeButton(dialog)?.click();
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('never starts while the tab is hidden, even when the open runs then', async () => {
    const { services, open } = liveRig();
    setVisibility('hidden');
    const dialog = await mountDialog(services);
    expect(open).not.toHaveBeenCalled();
    expect(body(dialog)).toContain('Paused while this tab is hidden');
    setVisibility('visible');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a camera still loading while HA starts says it is waiting, not disconnected', async () => {
    const attic = 'camera.demo_attic' as EntityId; // configured, but HA has not set it up yet
    const input = demoCardInput('starting');
    const cameras = [...(input.cameras ?? []), { entity: attic, name: 'Attic' }];
    const { services, open } = liveRig(new FakeHass('starting', { latencyMs: [0, 0] }), { ...input, cameras });
    const dialog = await mountDialog(services, attic);
    expect(open).not.toHaveBeenCalled();
    expect(body(dialog)).toContain('Waiting for Home Assistant.');
    expect(body(dialog)).not.toContain('Paused while disconnected');
  });

  it('a connection dropped while hidden: visible shows the pause, starts nothing', async () => {
    const { services, open, runtime } = liveRig();
    const dialog = await mountDialog(services);
    setVisibility('hidden');
    runtime.fake.disconnect();
    setVisibility('visible');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(body(dialog)).toContain('Paused while disconnected');
  });
});

describe('agr-camera-dialog: snapshot fallback (§9.4)', () => {
  it('without card helpers: a labelled 2-second snapshot view that stops and revokes on close', async () => {
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const runtime = hassRuntime(fake);
    rig = { runtime, services: runtime.services, open: vi.fn(), handles: [] };
    const dialog = await mountDialog(runtime.services);
    await vi.advanceTimersByTimeAsync(150);
    await settle();
    expect(dialog.liveState).toBe('fallback');
    expect(runtime.services.status.get('live-view')).toBe('fallback');
    expect(body(dialog)).toContain('Snapshot view. Refreshes every 2 seconds.');
    expect(dialog.shadowRoot?.querySelector('img.still')?.getAttribute('alt')).toBe('Latest picture from Front gate');
    // One still every 2 s, measured from the previous still's arrival (100 ms fake latency).
    await vi.advanceTimersByTimeAsync(4_100);
    expect(fetchWithAuthCalls(fake)).toHaveLength(3);
    dialog.close();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchWithAuthCalls(fake)).toHaveLength(3);
    expect(liveUrls()).toEqual([]);
  });

  it('sizes the dialog and frame to a snapshot still of a usual aspect, and keeps 16:9 for an extreme one (§16.13)', async () => {
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const runtime = hassRuntime(fake);
    rig = { runtime, services: runtime.services, open: vi.fn(), handles: [] };
    const dialog = await mountDialog(runtime.services);
    await vi.advanceTimersByTimeAsync(150);
    await settle();
    const root = dialog.shadowRoot as ShadowRoot;
    // The aspect sits on the host, where both the dialog width and the frame read it (§16.14).
    const ratio = (): string => dialog.style.getPropertyValue('--agr-frame-ratio').trim();
    const loadStill = async (width: number, height: number): Promise<void> => {
      const still = root.querySelector('img.still') as HTMLImageElement;
      Object.defineProperty(still, 'naturalWidth', { configurable: true, value: width });
      Object.defineProperty(still, 'naturalHeight', { configurable: true, value: height });
      still.dispatchEvent(new Event('load'));
      await settle();
    };
    expect(ratio()).toBe('');

    await loadStill(640, 480);
    expect(ratio()).toBe('1.333');

    await loadStill(1200, 300);
    expect(ratio()).toBe('');
    dialog.close();
    await settle();
  });

  it('a contained ll-rebuild disposes the stream and falls back after a fresh gate check', async () => {
    const { services, handles } = liveRig();
    const dialog = await mountDialog(services);
    handles[0]?.fail();
    await settle();
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(dialog.liveState).toBe('fallback');
    expect(services.status.get('live-view')).toBe('fallback (helpers-failed)');
  });

  it('a contained ll-rebuild while privacy is back on starts no fallback', async () => {
    const { services, handles, runtime } = liveRig();
    runtime.fake.setState(HALL_PRIVACY, 'off');
    const dialog = await mountDialog(services, HALL);
    runtime.fake.setState(HALL_PRIVACY, 'on');
    handles[0]?.fail();
    await settle();
    expect(dialog.liveState).toBe('stopped');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchWithAuthCalls(runtime.fake)).toEqual([]);
  });
});

describe('agr-camera-dialog: the real embedded card (§12.1 row 2, D1)', () => {
  class EmbeddedCard extends HTMLElement {
    hass: unknown;
  }
  if (customElements.get('fake-picture-entity') === undefined)
    customElements.define('fake-picture-entity', EmbeddedCard);

  it('creates the card once; 50 unrelated updates keep the same element and forward hass', async () => {
    const createCardElement = vi.fn(() => document.createElement('fake-picture-entity'));
    window.loadCardHelpers = () => Promise.resolve({ createCardElement });
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const runtime = hassRuntime(fake);
    rig = { runtime, services: runtime.services, open: vi.fn(), handles: [] };
    const dialog = await mountDialog(runtime.services);
    expect(createCardElement).toHaveBeenCalledTimes(1);
    const card = dialog.shadowRoot?.querySelector('fake-picture-entity') as EmbeddedCard;
    expect(card.isConnected).toBe(true);
    for (let i = 0; i < 50; i += 1) fake.setState(UNRELATED_LIGHT, i % 2 === 0 ? 'on' : 'off');
    await settle();
    expect(createCardElement).toHaveBeenCalledTimes(1);
    expect(dialog.shadowRoot?.querySelector('fake-picture-entity')).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(card.hass).toBe(fake.hass);
    expect(dialog.liveState).toBe('streaming');
  });

  it('a real contained ll-rebuild switches to the fallback', async () => {
    window.loadCardHelpers = () =>
      Promise.resolve({ createCardElement: () => document.createElement('fake-picture-entity') });
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const runtime = hassRuntime(fake);
    rig = { runtime, services: runtime.services, open: vi.fn(), handles: [] };
    const dialog = await mountDialog(runtime.services);
    const card = dialog.shadowRoot?.querySelector('fake-picture-entity');
    const escaped = vi.fn();
    document.body.addEventListener('ll-rebuild', escaped);
    card?.dispatchEvent(new CustomEvent('ll-rebuild', { bubbles: true, composed: true }));
    await settle();
    expect(escaped).not.toHaveBeenCalled();
    expect(card?.isConnected).toBe(false);
    expect(dialog.liveState).toBe('fallback');
    expect(runtime.services.status.get('live-view')).toBe('fallback (helpers-failed)');
  });
});
