/**
 * Camera seam (§4.4, §9.3, §9.4), the only module that calls hass.fetchWithAuth.
 *
 * Stills: fetchWithAuth → Blob, so a capability URL never reaches the DOM, diagnostics or history; the caller turns
 * the Blob into an object URL and revokes it. Errors carry codes only; URLs are never logged.
 *
 * Live view: HA's own picture-entity card from window.loadCardHelpers(), inside a containment wrapper that stops
 * EXACTLY six event types (D1). Every other event passes untouched; in particular `context-request` must keep
 * bubbling, because on 2026.7+ ha-camera-stream receives hassConnection, hassApi and hassConfig only through it.
 * Our code never reads the embedded card's attributes, children or network activity.
 */
import type { EntityId } from '../../config/schema.ts';
import { log } from '../../util/log.ts';
import { hostErrorFromFetchFailure, hostErrorFromStatus } from '../errors.ts';
import type { CameraSnapshotRequest, HostError, LiveStreamHandle, Unsubscribe } from '../host.ts';
import type { HassLike } from '../types.ts';

export interface LiveStreamContext {
  hass(): HassLike; // current hass at call time
  track(el: HTMLElement): Unsubscribe; // HassHost assigns el.hass on every update until unsubscribed
}

const CAMERA_PROXY_PATH = '/api/camera_proxy/';
const IMAGE_TYPE_PREFIX = 'image/';
const BAD_RESPONSE: HostError = Object.freeze({ code: 'bad-response' });

/** Feature detection window for HA's card helpers (D1). */
export const LIVE_HELPERS_TIMEOUT_MS = 3_000;

/**
 * The embedded card's config (§9.4): live view, filling a 16:9 box with letterboxing, and no tap, hold or
 * double-tap action, so the card can never open HA's more-info controls.
 */
const LIVE_CARD_CONFIG = Object.freeze({
  type: 'picture-entity',
  camera_view: 'live',
  aspect_ratio: '16:9',
  fit_mode: 'contain',
  show_name: false,
  show_state: false,
  tap_action: Object.freeze({ action: 'none' }),
  hold_action: Object.freeze({ action: 'none' }),
  double_tap_action: Object.freeze({ action: 'none' }),
});

/**
 * The only events stopped at the wrapper (D1). An escaped ll-rebuild makes hui-card rebuild the whole dashboard,
 * hass-more-info and hass-action would open HA's raw controls. Nothing else is stopped.
 */
export const CONTAINED_EVENTS = Object.freeze([
  'll-upgrade',
  'll-rebuild',
  'll-custom',
  'card-visibility-changed',
  'hass-more-info',
  'hass-action',
] as const);

/** Near-black letterbox, so fit_mode 'contain' bars match the video rather than HA's theme card color. */
export const LETTERBOX_COLOR = 'rgb(17 18 16)';

const NO_HELPERS: LiveStreamHandle = Object.freeze({ kind: 'unsupported', reason: 'no-helpers' });
const HELPERS_FAILED: LiveStreamHandle = Object.freeze({ kind: 'unsupported', reason: 'helpers-failed' });
const HELPERS_TIMEOUT: LiveStreamHandle = Object.freeze({ kind: 'unsupported', reason: 'timeout' });

type HassElement = HTMLElement & { hass?: unknown };

/**
 * GET /api/camera_proxy/<id>?width&height with the session's own authentication. Non-2xx responses map through
 * errors.ts (401/403 permission-denied, 404 not-found, 503 unavailable); a body that is not an image is
 * bad-response. Rejects with a HostError only.
 */
export function fetchSnapshot(hass: HassLike, id: EntityId, req: CameraSnapshotRequest): Promise<Blob> {
  const query = new URLSearchParams({ width: String(Math.round(req.width)), height: String(Math.round(req.height)) });
  const path = `${CAMERA_PROXY_PATH}${encodeURIComponent(id)}?${query.toString()}`;
  let response: Promise<Response>;
  try {
    response = hass.fetchWithAuth(path, { signal: req.signal, cache: 'no-store' });
  } catch (error) {
    return Promise.reject(hostErrorFromFetchFailure(error));
  }
  return response.then(readImage).catch((error: unknown) => {
    throw hostErrorFromFetchFailure(error);
  });
}

async function readImage(response: Response): Promise<Blob> {
  if (!response.ok) {
    discardBody(response);
    throw hostErrorFromStatus(response.status);
  }
  const blob = await response.blob();
  const type = blob.type || response.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith(IMAGE_TYPE_PREFIX)) throw BAD_RESPONSE;
  return blob;
}

/** An error body is never read; cancelling it releases the connection early. */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => log.warn('snapshot-body-cancel-failed'));
}

/**
 * Opens HA's live view for `id`, or reports why it cannot: no card helpers, helpers that failed to load or to
 * create the card, or helpers that did not answer within LIVE_HELPERS_TIMEOUT_MS. Never rejects.
 */
export async function openLiveStream(ctx: LiveStreamContext, id: EntityId): Promise<LiveStreamHandle> {
  const load = window.loadCardHelpers;
  if (typeof load !== 'function') return NO_HELPERS;
  const helpers = await withTimeout(() => load.call(window), LIVE_HELPERS_TIMEOUT_MS);
  if (helpers === 'timeout') return HELPERS_TIMEOUT;
  if (helpers === undefined) return HELPERS_FAILED;
  let card: HassElement;
  try {
    card = helpers.createCardElement({ ...LIVE_CARD_CONFIG, entity: id });
    card.hass = ctx.hass();
  } catch {
    log.warn('live-card-create-failed');
    return HELPERS_FAILED;
  }
  return containedLiveHandle(ctx, card);
}

/** Resolves with the helpers, 'timeout', or undefined when loading failed; the timer never outlives the race. */
function withTimeout(
  load: () => Promise<LovelaceCardHelpers>,
  timeoutMs: number,
): Promise<LovelaceCardHelpers | 'timeout' | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    const settle = (value: LovelaceCardHelpers | undefined): void => {
      clearTimeout(timer);
      resolve(value);
    };
    let pending: Promise<LovelaceCardHelpers>;
    try {
      pending = Promise.resolve(load());
    } catch {
      settle(undefined);
      return;
    }
    pending.then(
      (helpers) => settle(helpers),
      () => {
        log.warn('live-helpers-failed');
        settle(undefined);
      },
    );
  });
}

/**
 * Mounts `card` in the containment wrapper and returns the native handle. The wrapper is handle.element.
 * ll-upgrade re-assigns hass (the lazily defined card just upgraded); a contained ll-rebuild means the card's
 * setConfig threw and the box is empty, so the handle fires onFail('helpers-failed') once.
 */
function containedLiveHandle(ctx: LiveStreamContext, card: HassElement): LiveStreamHandle {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-agr-live', '');
  wrapper.style.setProperty('display', 'block');
  wrapper.style.setProperty('inline-size', '100%');
  wrapper.style.setProperty('block-size', '100%');
  wrapper.style.setProperty('background', LETTERBOX_COLOR);
  wrapper.style.setProperty('--ha-card-background', LETTERBOX_COLOR);
  wrapper.style.setProperty('--card-background-color', LETTERBOX_COLOR);

  const failListeners = new Set<(reason: 'helpers-failed') => void>();
  let failed = false;
  let disposed = false;

  const fail = (): void => {
    if (failed || disposed) return;
    failed = true;
    for (const listener of [...failListeners]) {
      try {
        listener('helpers-failed');
      } catch {
        log.error('live-fail-listener-failed');
      }
    }
  };

  const onContained = (event: Event): void => {
    event.stopPropagation();
    if (disposed) return;
    try {
      if (event.type === 'll-upgrade') card.hass = ctx.hass();
      else if (event.type === 'll-rebuild') fail();
    } catch {
      log.error('live-event-failed');
    }
  };

  for (const type of CONTAINED_EVENTS) wrapper.addEventListener(type, onContained);
  wrapper.append(card);
  const untrack = ctx.track(card);

  return {
    kind: 'native',
    element: wrapper,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      untrack();
      failListeners.clear();
      for (const type of CONTAINED_EVENTS) wrapper.removeEventListener(type, onContained);
      card.remove();
      wrapper.remove();
    },
    onFail(listener: (reason: 'helpers-failed') => void): Unsubscribe {
      if (disposed) return () => undefined;
      if (failed) {
        // A failure before anyone listened (for example during mounting) is still reported, once.
        queueMicrotask(() => {
          if (disposed) return;
          try {
            listener('helpers-failed');
          } catch {
            log.error('live-fail-listener-failed');
          }
        });
        return () => undefined;
      }
      failListeners.add(listener);
      return () => {
        failListeners.delete(listener);
      };
    },
  };
}
