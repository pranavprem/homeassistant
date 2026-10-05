/**
 * §12.1 row 9 (live containment, D1): the embedded picture-entity card is wrapped so EXACTLY six event types are
 * stopped, ll-upgrade re-assigns hass, a contained ll-rebuild reports helpers-failed, and context-request (plus any
 * unrelated event) still reaches the card host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import {
  CONTAINED_EVENTS,
  LETTERBOX_COLOR,
  LIVE_HELPERS_TIMEOUT_MS,
  openLiveStream,
  type LiveStreamContext,
} from '../../src/ha/hass/camera.ts';
import type { LiveStreamHandle } from '../../src/ha/host.ts';
import type { HassLike } from '../../src/ha/types.ts';

const CAMERA = 'camera.demo_front_gate' as EntityId;

class FakeLiveCard extends HTMLElement {
  hassAssignments: unknown[] = [];
  set hass(value: unknown) {
    this.hassAssignments.push(value);
  }
  get hass(): unknown {
    return this.hassAssignments.at(-1);
  }
}
customElements.define('fake-live-card', FakeLiveCard);

interface Harness {
  readonly ctx: LiveStreamContext;
  readonly untrack: ReturnType<typeof vi.fn>;
  readonly tracked: HTMLElement[];
  readonly createCardElement: ReturnType<typeof vi.fn>;
  hassVersion: number;
}

function harness(): Harness {
  const untrack = vi.fn();
  const tracked: HTMLElement[] = [];
  const createCardElement = vi.fn(() => document.createElement('fake-live-card'));
  const state: Harness = {
    ctx: {
      hass: () => ({ version: state.hassVersion }) as unknown as HassLike,
      track: (element) => {
        tracked.push(element);
        return untrack;
      },
    },
    untrack,
    tracked,
    createCardElement,
    hassVersion: 1,
  };
  window.loadCardHelpers = () => Promise.resolve({ createCardElement });
  return state;
}

function nativeHandle(handle: LiveStreamHandle): Extract<LiveStreamHandle, { kind: 'native' }> {
  if (handle.kind !== 'native') throw new Error(`expected a native handle, got ${handle.kind}`);
  return handle;
}

/** Mounts the wrapper inside a stand-in card host and records what reaches the host. */
function mountInHost(handle: Extract<LiveStreamHandle, { kind: 'native' }>) {
  const cardHost = document.createElement('div');
  document.body.append(cardHost);
  cardHost.append(handle.element);
  const reached: string[] = [];
  for (const type of [...CONTAINED_EVENTS, 'context-request', 'agr-unrelated']) {
    cardHost.addEventListener(type, () => reached.push(type));
  }
  const card = handle.element.querySelector('fake-live-card') as FakeLiveCard;
  return { cardHost, reached, card };
}

afterEach(() => {
  delete window.loadCardHelpers;
});

describe('openLiveStream containment (D1, §9.4)', () => {
  it('creates picture-entity once with live view, 16:9 contain, no name or state, and every action none', async () => {
    const h = harness();
    nativeHandle(await openLiveStream(h.ctx, CAMERA));
    expect(h.createCardElement).toHaveBeenCalledTimes(1);
    expect(h.createCardElement).toHaveBeenCalledWith({
      type: 'picture-entity',
      entity: CAMERA,
      camera_view: 'live',
      aspect_ratio: '16:9',
      fit_mode: 'contain',
      show_name: false,
      show_state: false,
      tap_action: { action: 'none' },
      hold_action: { action: 'none' },
      double_tap_action: { action: 'none' },
    });
  });

  it('assigns hass before mounting and registers the card for forwarding', async () => {
    const h = harness();
    const handle = nativeHandle(await openLiveStream(h.ctx, CAMERA));
    const card = handle.element.querySelector('fake-live-card') as FakeLiveCard;
    expect(card.hassAssignments).toEqual([{ version: 1 }]);
    expect(h.tracked).toEqual([card]);
  });

  it('never lets the six contained events reach the card host', async () => {
    const handle = nativeHandle(await openLiveStream(harness().ctx, CAMERA));
    const { reached, card } = mountInHost(handle);
    for (const type of CONTAINED_EVENTS) {
      card.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: {} }));
    }
    expect(reached).toEqual([]);
  });

  it('lets context-request and unrelated events propagate past the wrapper', async () => {
    const handle = nativeHandle(await openLiveStream(harness().ctx, CAMERA));
    const { reached, card } = mountInHost(handle);
    card.dispatchEvent(new CustomEvent('context-request', { bubbles: true, composed: true }));
    card.dispatchEvent(new CustomEvent('agr-unrelated', { bubbles: true, composed: true }));
    expect(reached).toEqual(['context-request', 'agr-unrelated']);
  });

  it('handles ll-upgrade by re-assigning the current hass', async () => {
    const h = harness();
    const handle = nativeHandle(await openLiveStream(h.ctx, CAMERA));
    const { card } = mountInHost(handle);
    h.hassVersion = 2;
    card.dispatchEvent(new CustomEvent('ll-upgrade', { bubbles: true, composed: true }));
    expect(card.hassAssignments.at(-1)).toEqual({ version: 2 });
  });

  it('reports a contained ll-rebuild once as helpers-failed', async () => {
    const handle = nativeHandle(await openLiveStream(harness().ctx, CAMERA));
    const { card } = mountInHost(handle);
    const listener = vi.fn();
    handle.onFail(listener);
    card.dispatchEvent(new CustomEvent('ll-rebuild', { bubbles: true, composed: true }));
    card.dispatchEvent(new CustomEvent('ll-rebuild', { bubbles: true, composed: true }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('helpers-failed');
  });

  it('sets the near-black letterbox variables on the wrapper', async () => {
    const handle = nativeHandle(await openLiveStream(harness().ctx, CAMERA));
    expect(handle.element.style.getPropertyValue('--ha-card-background')).toBe(LETTERBOX_COLOR);
    expect(handle.element.style.getPropertyValue('--card-background-color')).toBe(LETTERBOX_COLOR);
  });

  it('dispose untracks, detaches the card and stops reporting', async () => {
    const h = harness();
    const handle = nativeHandle(await openLiveStream(h.ctx, CAMERA));
    const { card, cardHost } = mountInHost(handle);
    const listener = vi.fn();
    handle.onFail(listener);
    handle.dispose();
    handle.dispose();
    expect(h.untrack).toHaveBeenCalledTimes(1);
    expect(card.isConnected).toBe(false);
    expect(cardHost.contains(handle.element)).toBe(false);
    card.dispatchEvent(new CustomEvent('ll-rebuild', { bubbles: true, composed: true }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('openLiveStream feature detection (D1)', () => {
  it('reports no-helpers without card helpers', async () => {
    delete window.loadCardHelpers;
    const track = vi.fn();
    await expect(openLiveStream({ hass: () => ({}) as HassLike, track }, CAMERA)).resolves.toEqual({
      kind: 'unsupported',
      reason: 'no-helpers',
    });
    expect(track).not.toHaveBeenCalled();
  });

  it('reports helpers-failed when loading rejects or the card cannot be created', async () => {
    window.loadCardHelpers = () => Promise.reject(new Error('chunk failed'));
    const ctx: LiveStreamContext = { hass: () => ({}) as HassLike, track: vi.fn() };
    await expect(openLiveStream(ctx, CAMERA)).resolves.toEqual({ kind: 'unsupported', reason: 'helpers-failed' });
    window.loadCardHelpers = () =>
      Promise.resolve({
        createCardElement: () => {
          throw new Error('bad config');
        },
      });
    await expect(openLiveStream(ctx, CAMERA)).resolves.toEqual({ kind: 'unsupported', reason: 'helpers-failed' });
    expect(ctx.track).not.toHaveBeenCalled();
  });

  it('times out after 3 s and leaves no timer behind; a late answer creates nothing', async () => {
    vi.useFakeTimers();
    let answer: ((helpers: LovelaceCardHelpers) => void) | undefined;
    window.loadCardHelpers = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const createCardElement = vi.fn(() => document.createElement('fake-live-card'));
    const opened = openLiveStream({ hass: () => ({}) as HassLike, track: vi.fn() }, CAMERA);
    await vi.advanceTimersByTimeAsync(LIVE_HELPERS_TIMEOUT_MS);
    await expect(opened).resolves.toEqual({ kind: 'unsupported', reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
    answer?.({ createCardElement });
    await vi.advanceTimersByTimeAsync(0);
    expect(createCardElement).not.toHaveBeenCalled();
  });
});
