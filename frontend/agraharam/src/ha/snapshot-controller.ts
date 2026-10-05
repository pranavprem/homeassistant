/**
 * Camera still lifecycle (§9.3): a ReactiveController that fetches an authenticated still as a Blob, shows it as an
 * object URL, refreshes it on the camera's cadence while the picture is on screen and the tab is visible, and
 * ALWAYS revokes the URL it created.
 *
 *   idle ─fetchAllowed─► loading ─ok─► showing ─interval─► (refresh) …
 *                                └err─► error (backoff interval → ×2 → … → 120 s) | denied (401/403: stop)
 *
 * - fetchAllowed = target allowed (gate allowed, plus thumbnails or an active fallback) ∧ on screen (optional
 *   IntersectionObserver, threshold 0.1) ∧ document visible ∧ not denied ∧ host connected.
 * - Off screen or hidden: abort, clear the timer, KEEP the picture. Coming back refetches at once only when the
 *   picture is at least (interval − 1 s) old.
 * - Not allowed any more, or the target's key changed (camera, privacy binding or gate result; never a new state
 *   object, because a camera's access_token rotates every 5 minutes): abort, clear the timer, REVOKE at once.
 * - A result for an older request is discarded without creating a URL. Unmount releases everything.
 * - A denial resets on a camera change, a new socket generation (reconnect) or a 'user' meta change.
 * URLs and Blobs are never logged or stored anywhere but the controller.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { EntityId } from '../config/schema.ts';
import { log } from '../util/log.ts';
import { isDocumentVisible } from '../util/time.ts';
import { isHostError } from './errors.ts';
import type { CameraSnapshotRequest, HostError, HostReader, Unsubscribe } from './host.ts';

/** The reads a picture needs, narrowed from the HostReader so leaf elements never hold the reader itself. */
export interface SnapshotSource {
  fetch(id: EntityId, request: CameraSnapshotRequest): Promise<Blob>;
  /** HostReader.connectionGeneration(): a change means a new socket, which lifts a denial. */
  generation(): number;
  /** Fires when HA's user changes ('user' meta), which lifts a denial. */
  onUserChange(listener: () => void): Unsubscribe;
}

export interface SnapshotTarget {
  readonly source: SnapshotSource;
  readonly camera: EntityId;
  /** What the picture is allowed under: binding and gate result. A change drops the picture at once. */
  readonly key: string;
  /** False drops the picture at once (gate closed, thumbnails off, fallback stopped). */
  readonly allowed: boolean;
  readonly intervalMs: number;
  /** Height over width of the box the picture fills (0.75 for 4:3 tiles, 0.5625 for 16:9). */
  readonly aspect: number;
}

type SnapshotPhase = 'idle' | 'loading' | 'showing' | 'error' | 'denied';
export interface SnapshotView {
  readonly phase: SnapshotPhase;
  /** blob: URL of the current picture. */
  readonly url?: string;
  /** The last refresh failed and the previous picture is still shown. */
  readonly stale: boolean;
}

interface SnapshotControllerOptions {
  readonly target: () => SnapshotTarget | undefined;
  /** Tiles fetch only while on screen; the live-view fallback is always on screen while its dialog is open. */
  readonly observeIntersection: boolean;
  /** The box the picture fills, for the requested size; defaults to the host element. */
  readonly box?: () => Element | null;
  /** Monotonic clock; defaults to performance.now(). */
  readonly now?: () => number;
}

/** A picture this much younger than its interval is not refetched when it comes back on screen. */
const REFETCH_SLACK_MS = 1_000;
const MAX_BACKOFF_MS = 120_000;
/** Requested sizes snap up to this step so the proxy can cache resized stills (§9.3). */
const SIZE_STEP_PX = 160;
const MAX_WIDTH_PX = 640;
const INTERSECTION_THRESHOLD = 0.1;

const ABORTED: HostError = Object.freeze({ code: 'aborted' });
const sources = new WeakMap<HostReader, SnapshotSource>();

/** One stable SnapshotSource per reader, so passing it to a tile does not change its identity on re-render. */
export function snapshotSourceFor(reader: HostReader): SnapshotSource {
  let source = sources.get(reader);
  if (source === undefined) {
    source = Object.freeze({
      fetch: sessionProbedFetch(reader),
      generation: () => reader.connectionGeneration(),
      onUserChange: (listener: () => void) => reader.store.subscribe([], ['user'], () => listener()),
    });
    sources.set(reader, source);
  }
  return source;
}

/**
 * Session probe. Until one still has loaded in the current session, at most one camera request is in flight; the
 * others wait for it. A broken session therefore costs ONE 401 (one http.ban count), after which HassHost's
 * session denial rejects every waiting request without sending it (§4.4, §9.3). Once a still has loaded, tiles
 * fetch concurrently. A waiting request whose signal aborts rejects as 'aborted' at once.
 *
 * A session is a socket generation and a user: a 'user' meta change lifts HassHost's 401 denial just as a
 * reconnect does, so it must also start a new probe instead of trusting the previous user's proof.
 */
function sessionProbedFetch(reader: HostReader): SnapshotSource['fetch'] {
  let userChanges = 0;
  // Lives as long as the reader's store; both belong to one runtime.
  reader.store.subscribe([], ['user'], () => {
    userChanges += 1;
  });
  const sessionKey = (): string => `${reader.connectionGeneration()}:${userChanges}`;
  let proven: string | undefined;
  let probe: { readonly session: string; readonly done: Promise<void> } | undefined;
  const fetch = (id: EntityId, request: CameraSnapshotRequest): Promise<Blob> => {
    const session = sessionKey();
    if (proven === session) return reader.fetchCameraSnapshot(id, request);
    if (probe !== undefined && probe.session === session) {
      return waitFor(probe.done, request.signal).then(() =>
        request.signal.aborted ? Promise.reject(ABORTED) : fetch(id, request),
      );
    }
    const pending = reader.fetchCameraSnapshot(id, request);
    const current = {
      session,
      done: pending
        .then(
          () => {
            if (sessionKey() === session) proven = session;
          },
          () => undefined,
        )
        .then(() => {
          if (probe === current) probe = undefined;
        }),
    };
    probe = current;
    return pending;
  };
  return fetch;
}

function waitFor(done: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    done
      .then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      })
      .catch(() => log.error('snapshot-probe-wait-failed'));
  });
}

/** Box width × devicePixelRatio, rounded up to a 160 px step, at most 640 wide (§9.3). */
export function snapshotSize(boxWidth: number, aspect: number, pixelRatio: number): { width: number; height: number } {
  const device = Math.max(boxWidth, 1) * (pixelRatio > 0 ? pixelRatio : 1);
  const width = Math.min(MAX_WIDTH_PX, Math.ceil(device / SIZE_STEP_PX) * SIZE_STEP_PX);
  return { width, height: Math.round(width * aspect) };
}

/** Retry delay after `failures` consecutive errors: interval, then doubling, capped at 120 s. */
export function backoffDelay(intervalMs: number, failures: number): number {
  return Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.max(failures - 1, 0));
}

export class SnapshotController implements ReactiveController {
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #options: SnapshotControllerOptions;
  readonly #now: () => number;
  #target: SnapshotTarget | undefined;
  #key: string | undefined;
  #camera: EntityId | undefined;
  #url: string | undefined;
  #phase: SnapshotPhase = 'idle';
  #stale = false;
  #connected = false;
  #intersecting: boolean;
  #observer: IntersectionObserver | undefined;
  /** Incremented on every fetch and every stop, so a late result from an earlier request is discarded. */
  #request = 0;
  #abort: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextDueAt: number | undefined;
  /** The picture went off screen or hidden since the last fetch (enables the interval − 1 s rule). */
  #resumed = false;
  #failures = 0;
  #denied: { readonly generation: number } | undefined;
  #userSource: SnapshotSource | undefined;
  #userUnsubscribe: Unsubscribe | undefined;

  constructor(host: ReactiveControllerHost & HTMLElement, options: SnapshotControllerOptions) {
    this.#host = host;
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#intersecting = !options.observeIntersection;
    host.addController(this);
  }

  view(): SnapshotView {
    return this.#url === undefined
      ? { phase: this.#phase, stale: false }
      : { phase: this.#phase, url: this.#url, stale: this.#stale };
  }

  hostConnected(): void {
    this.#connected = true;
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
    if (this.#options.observeIntersection && typeof IntersectionObserver === 'function') {
      this.#observer = new IntersectionObserver(this.#onIntersection, { threshold: INTERSECTION_THRESHOLD });
      this.#observer.observe(this.#host);
    } else {
      this.#intersecting = true;
    }
    this.#sync();
  }

  hostDisconnected(): void {
    this.#connected = false;
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#intersecting = !this.#options.observeIntersection;
    this.#userUnsubscribe?.();
    this.#userUnsubscribe = undefined;
    this.#userSource = undefined;
    this.#drop();
    // The camera is kept, so a denial survives a detach and re-attach of the same element.
    this.#key = undefined;
  }

  /** Runs before every host render, so the render already reflects a dropped or newly loading picture. */
  hostUpdate(): void {
    this.#sync();
  }

  /** Reconciles with the host's current target; idempotent, so it runs before every host render. */
  #sync(): void {
    if (!this.#connected) return;
    try {
      const target = this.#options.target();
      this.#target = target;
      this.#followUserChanges(target?.source);
      const key = target === undefined ? undefined : `${target.camera}#${target.key}`;
      if (key !== this.#key) {
        if (target?.camera !== this.#camera) this.#denied = undefined;
        this.#key = key;
        this.#camera = target?.camera;
        this.#drop();
      }
      if (target === undefined || !target.allowed) {
        this.#drop();
        return;
      }
      if (this.#denied !== undefined && this.#denied.generation !== target.source.generation()) this.#lift();
      this.#schedule();
    } catch {
      log.error('snapshot-sync-failed');
    }
  }

  #fetchAllowed(): boolean {
    const target = this.#target;
    return (
      this.#connected &&
      target !== undefined &&
      target.allowed &&
      this.#intersecting &&
      isDocumentVisible() &&
      this.#denied === undefined
    );
  }

  #schedule(): void {
    if (!this.#fetchAllowed()) {
      this.#pause();
      return;
    }
    if (this.#abort !== undefined || this.#timer !== undefined) return;
    const wait = this.#nextDelay();
    if (wait <= 0) {
      this.#fetch();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.#schedule();
      } catch {
        log.error('snapshot-timer-failed');
      }
    }, wait);
  }

  #nextDelay(): number {
    if (this.#nextDueAt === undefined) return 0;
    const remaining = this.#nextDueAt - this.#now();
    return this.#resumed && this.#failures === 0 ? remaining - REFETCH_SLACK_MS : remaining;
  }

  #fetch(): void {
    const target = this.#target;
    if (target === undefined) return;
    const request = ++this.#request;
    const abort = new AbortController();
    this.#abort = abort;
    this.#resumed = false;
    if (this.#url === undefined && this.#phase !== 'loading') {
      this.#phase = 'loading';
      this.#host.requestUpdate();
    }
    const box = this.#options.box?.() ?? this.#host;
    const size = snapshotSize(box.getBoundingClientRect().width, target.aspect, window.devicePixelRatio);
    let pending: Promise<Blob>;
    try {
      pending = target.source.fetch(target.camera, { ...size, signal: abort.signal });
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .then(
        (blob) => this.#onSnapshot(request, blob),
        (error: unknown) => this.#onFailure(request, error),
      )
      .catch(() => log.error('snapshot-result-failed'));
  }

  #onSnapshot(request: number, blob: Blob): void {
    if (request !== this.#request) return;
    // This request is finished either way; a lingering controller would block #schedule() until the next pause.
    this.#abort = undefined;
    if (!this.#fetchAllowed()) return;
    const previous = this.#url;
    this.#url = URL.createObjectURL(blob);
    if (previous !== undefined) URL.revokeObjectURL(previous);
    this.#phase = 'showing';
    this.#stale = false;
    this.#failures = 0;
    this.#nextDueAt = this.#now() + (this.#target?.intervalMs ?? 0);
    this.#host.requestUpdate();
    this.#schedule();
  }

  #onFailure(request: number, error: unknown): void {
    if (request !== this.#request) return;
    this.#abort = undefined;
    const target = this.#target;
    if (isHostError(error) && error.code === 'permission-denied' && target !== undefined) {
      // 401 or 403: stop. Each attempt can count toward HA's http.ban, so nothing retries until a reset.
      this.#denied = { generation: target.source.generation() };
      this.#release();
      this.#phase = 'denied';
      this.#host.requestUpdate();
      return;
    }
    this.#failures += 1;
    this.#stale = this.#url !== undefined;
    this.#phase = this.#url === undefined ? 'error' : 'showing';
    this.#nextDueAt = this.#now() + backoffDelay(target?.intervalMs ?? 0, this.#failures);
    this.#host.requestUpdate();
    this.#schedule();
  }

  /** Off screen or hidden: stop work, keep the picture. */
  #pause(): void {
    const wasWorking = this.#abort !== undefined || this.#timer !== undefined;
    this.#cancelWork();
    if (wasWorking) this.#resumed = true;
    if (this.#phase === 'loading' && this.#url === undefined) {
      this.#phase = 'idle';
      this.#host.requestUpdate();
    }
  }

  /** Gate closed, key changed or unmounted: stop work and revoke the picture at once. */
  #drop(): void {
    this.#cancelWork();
    this.#nextDueAt = undefined;
    this.#failures = 0;
    this.#resumed = false;
    const hadPicture = this.#url !== undefined;
    this.#release();
    const phase: SnapshotPhase = this.#denied === undefined ? 'idle' : 'denied';
    if (hadPicture || this.#phase !== phase) {
      this.#phase = phase;
      this.#host.requestUpdate();
    }
  }

  #lift(): void {
    this.#denied = undefined;
    if (this.#phase === 'denied') {
      this.#phase = 'idle';
      this.#host.requestUpdate();
    }
  }

  #cancelWork(): void {
    this.#request += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #release(): void {
    const url = this.#url;
    this.#url = undefined;
    this.#stale = false;
    if (url !== undefined) URL.revokeObjectURL(url);
  }

  #followUserChanges(source: SnapshotSource | undefined): void {
    if (source === this.#userSource) return;
    this.#userUnsubscribe?.();
    this.#userSource = source;
    this.#userUnsubscribe = source?.onUserChange(this.#onUserChange);
  }

  readonly #onUserChange = (): void => {
    try {
      if (this.#denied === undefined) return;
      this.#lift();
      this.#schedule();
    } catch {
      log.error('snapshot-user-change-failed');
    }
  };

  readonly #onVisibilityChange = (): void => {
    try {
      this.#schedule();
    } catch {
      log.error('snapshot-visibility-failed');
    }
  };

  readonly #onIntersection = (entries: IntersectionObserverEntry[]): void => {
    try {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      this.#intersecting = entry.isIntersecting;
      this.#schedule();
    } catch {
      log.error('snapshot-intersection-failed');
    }
  };
}
