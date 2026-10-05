/**
 * Camera live-view lifecycle (§9.4, §16.10): the state machine behind agr-camera-dialog, which only renders it.
 *
 *   idle ─start─► opening ─handle─► streaming (native | demo) ─embedded card failed─► fallback
 *                         └unsupported───────────────────────────────────────────────► fallback (2 s stills)
 *   any running state ─gate closed | disconnect | edit mode | hidden tab | dialog closed─► stopped(cause)
 *
 * Open (and every resume) requires the FULL gate, read fresh: the camera configured with live view allowed, not
 * editing, the phase connected and the privacy and availability gate allowed. Release disposes the handle (or stops
 * the fallback, which aborts, revokes and clears its timer) on close, unmount, a closed gate and a hidden tab.
 * Coming back from a hidden tab on the same socket re-runs the full gate; after a reconnect it waits for "Resume live
 * view" instead of restarting by itself. Each start is numbered, so a late openLiveStream result is never mounted.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { DashboardServices } from '../components/services.ts';
import { liveAvailability, LIVE_REASONS } from '../domain/live-view.ts';
import { contained, log } from '../util/log.ts';
import { isDocumentVisible } from '../util/time.ts';
import type { Availability } from './actions/types.ts';
import { cameraBindingKey, cameraGateFor, type CameraBinding, type CameraGate } from './camera-gate.ts';
import type { LiveStreamHandle, Unsubscribe } from './host.ts';
import {
  SnapshotController,
  snapshotSourceFor,
  type SnapshotTarget,
  type SnapshotView,
} from './snapshot-controller.ts';
import { LIVE_FALLBACK_INTERVAL_MS } from '../timing.ts';

type StreamHandle = Extract<LiveStreamHandle, { kind: 'native' | 'demo' }>;
type FallbackCause = Extract<LiveStreamHandle, { kind: 'unsupported' }>['reason'];
export type LiveStopCause = 'gate' | 'disconnected' | 'hidden' | 'preview';

/** What the frame is doing. `run` numbers each start, so a late openLiveStream result is never mounted. */
export type LiveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening'; readonly run: number }
  | { readonly kind: 'streaming'; readonly run: number; readonly handle: StreamHandle }
  | { readonly kind: 'fallback'; readonly run: number; readonly cause: FallbackCause }
  | { readonly kind: 'stopped'; readonly cause: LiveStopCause };

/** Values written to services.status 'live-view' for diagnostics (§5.1): never a URL or entity ID. */
const LIVE_VIEW_STATUS = Object.freeze({
  native: 'native',
  demo: 'demo',
  fallback: 'fallback',
  helpersFailed: 'fallback (helpers-failed)',
} as const);

/** The snapshot fallback requests 16:9 stills. */
const FALLBACK_ASPECT = 9 / 16;

const MISSING_CAMERA: Availability = Object.freeze({
  enabled: false,
  reason: 'missing-entity',
  message: LIVE_REASONS.missing,
});

interface LiveViewOptions {
  readonly services: () => DashboardServices | undefined;
  readonly camera: () => CameraBinding | undefined;
  /** The dialog is open (a stream starts only into an open modal). */
  readonly isOpen: () => boolean;
  /** The box the fallback still fills, for the requested size. */
  readonly box: () => Element | null;
}

export class LiveViewController implements ReactiveController {
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #options: LiveViewOptions;
  readonly #fallback: SnapshotController;
  #state: LiveState = { kind: 'idle' };
  #run = 0;
  #failUnsubscribe: Unsubscribe | undefined;
  /** The socket generation when the view paused for a hidden tab; a different one on return means a reconnect. */
  #hiddenGeneration: number | undefined;

  constructor(host: ReactiveControllerHost & HTMLElement, options: LiveViewOptions) {
    this.#host = host;
    this.#options = options;
    // Registered first, so a reconcile in hostUpdate runs before the fallback reads the state.
    host.addController(this);
    this.#fallback = new SnapshotController(host, {
      observeIntersection: false,
      box: options.box,
      target: () => this.#fallbackTarget(),
    });
  }

  get state(): LiveState {
    return this.#state;
  }

  /** The fallback still (only meaningful while the state is 'fallback'). */
  fallbackView(): SnapshotView {
    return this.#fallback.view();
  }

  /** The camera's current gate, read fresh; undefined when the camera or services are missing. */
  gate(): CameraGate | undefined {
    const services = this.#options.services();
    const camera = this.#options.camera();
    return services === undefined || camera === undefined ? undefined : gateFor(services, camera);
  }

  /** The full open gate (§9.4), read fresh: what a start or the "Resume live view" button would meet. */
  openCheck(): Availability {
    const services = this.#options.services();
    const camera = this.#options.camera();
    if (services === undefined || camera === undefined) return MISSING_CAMERA;
    return liveAvailability(camera, gateFor(services, camera), services.preview);
  }

  /** Starts (or resumes) through the full gate; a closed gate shows its reason and starts nothing. */
  start(): void {
    if (!this.#host.isConnected || !this.#options.isOpen()) return;
    this.#release();
    if (!isDocumentVisible()) {
      this.#pauseForHiddenTab();
      return;
    }
    const check = this.openCheck();
    const services = this.#options.services();
    const camera = this.#options.camera();
    if (!check.enabled || services === undefined || camera === undefined) {
      this.#setState({ kind: 'stopped', cause: this.#stopCause(check) });
      return;
    }
    const run = ++this.#run;
    this.#setState({ kind: 'opening', run });
    services.reader
      .openLiveStream(camera.entity)
      .catch((): LiveStreamHandle => ({ kind: 'unsupported', reason: 'helpers-failed' }))
      .then((handle) => this.#onHandle(run, handle))
      .catch(() => log.error('camera-live-open-failed'));
  }

  /** The dialog closed (Close, Escape, backdrop or closeAll): release everything. */
  stop(): void {
    this.#stopFor('gate');
  }

  hostConnected(): void {
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
  }

  hostDisconnected(): void {
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    this.#release();
    if (this.#state.kind !== 'stopped') this.#state = { kind: 'idle' };
  }

  /** Before every render: a running view stops at once when the gate, phase or edit mode no longer allow it. */
  hostUpdate(): void {
    try {
      if (!isRunning(this.#state)) return;
      const check = this.openCheck();
      if (!check.enabled) this.#stopFor(this.#stopCause(check));
    } catch {
      log.error('camera-live-reconcile-failed');
    }
  }

  readonly #onVisibilityChange = contained('camera-visibility-failed', () => {
    const state = this.#state;
    if (!isDocumentVisible()) {
      if (isRunning(state)) this.#pauseForHiddenTab();
      return;
    }
    if (state.kind !== 'stopped' || state.cause !== 'hidden') return;
    // A reconnect while the tab was hidden needs a "Resume live view" tap, never an automatic restart (§16.10).
    if (this.#hiddenGeneration !== this.#options.services()?.reader.connectionGeneration()) {
      this.#setState({ kind: 'stopped', cause: 'disconnected' });
      return;
    }
    // Back from hidden on the same socket: start again only through the full gate (privacy may have turned on).
    this.start();
  });

  #pauseForHiddenTab(): void {
    this.#hiddenGeneration = this.#options.services()?.reader.connectionGeneration();
    this.#stopFor('hidden');
  }

  #onHandle(run: number, handle: LiveStreamHandle): void {
    const services = this.#options.services();
    if (run !== this.#run || this.#state.kind !== 'opening' || !this.#host.isConnected || services === undefined) {
      disposeHandle(handle);
      return;
    }
    // The gate may have closed while the helpers loaded: never mount a stream it no longer allows.
    const check = this.openCheck();
    if (!check.enabled) {
      disposeHandle(handle);
      this.#setState({ kind: 'stopped', cause: this.#stopCause(check) });
      return;
    }
    if (handle.kind === 'unsupported') {
      this.#startFallback(run, handle.reason);
      return;
    }
    this.#setState({ kind: 'streaming', run, handle });
    services.status.set('live-view', handle.kind === 'demo' ? LIVE_VIEW_STATUS.demo : LIVE_VIEW_STATUS.native);
    if (handle.kind === 'native') {
      this.#failUnsubscribe = handle.onFail(contained('camera-live-fail-failed', () => this.#onLiveFailed(run)));
    }
  }

  /** A contained ll-rebuild: the embedded card failed after mounting (§9.4). Fall back after a fresh gate check. */
  #onLiveFailed(run: number): void {
    if (run !== this.#run || this.#state.kind !== 'streaming') return;
    this.#release();
    const check = this.openCheck();
    if (!check.enabled) {
      this.#setState({ kind: 'stopped', cause: this.#stopCause(check) });
      return;
    }
    this.#startFallback(++this.#run, 'helpers-failed');
  }

  #startFallback(run: number, cause: FallbackCause): void {
    this.#setState({ kind: 'fallback', run, cause });
    this.#options
      .services()
      ?.status.set(
        'live-view',
        cause === 'helpers-failed' ? LIVE_VIEW_STATUS.helpersFailed : LIVE_VIEW_STATUS.fallback,
      );
  }

  #stopFor(cause: LiveStopCause): void {
    this.#release();
    this.#setState({ kind: 'stopped', cause });
  }

  /** Disposes the native or demo handle and invalidates any open in flight. The fallback stops with the state. */
  #release(): void {
    this.#run += 1;
    this.#failUnsubscribe?.();
    this.#failUnsubscribe = undefined;
    const state = this.#state;
    if (state.kind === 'streaming') disposeHandle(state.handle);
  }

  #setState(state: LiveState): void {
    this.#state = state;
    this.#host.requestUpdate();
  }

  #fallbackTarget(): SnapshotTarget | undefined {
    const services = this.#options.services();
    const camera = this.#options.camera();
    if (services === undefined || camera === undefined) return undefined;
    const state = this.#state;
    const gate = gateFor(services, camera);
    const run = state.kind === 'fallback' ? state.run : 0;
    return {
      source: snapshotSourceFor(services.reader),
      camera: camera.entity,
      key: `${cameraBindingKey(camera)}|${gate.kind}|${run}`,
      // The same full open gate a start meets (§9.4), so the stills can never outlive what live view allows.
      allowed: state.kind === 'fallback' && this.#host.isConnected && this.openCheck().enabled,
      intervalMs: LIVE_FALLBACK_INTERVAL_MS,
      aspect: FALLBACK_ASPECT,
    };
  }

  #stopCause(check: Availability): LiveStopCause {
    if (check.enabled) return 'gate';
    // A loading gate (HA starting) shares the 'disconnected' reason code but is not an outage: show the gate notice.
    if (check.reason === 'disconnected') return this.gate()?.kind === 'loading' ? 'gate' : 'disconnected';
    if (check.reason === 'preview') return 'preview';
    return 'gate';
  }
}

function gateFor(services: DashboardServices, camera: CameraBinding): CameraGate {
  return cameraGateFor(services.store, camera, services.reader.connection().phase === 'connected');
}

function isRunning(state: LiveState): boolean {
  return state.kind === 'opening' || state.kind === 'streaming' || state.kind === 'fallback';
}

function disposeHandle(handle: LiveStreamHandle): void {
  if (handle.kind === 'unsupported') return;
  try {
    handle.dispose();
  } catch {
    log.error('camera-live-dispose-failed');
  }
}
