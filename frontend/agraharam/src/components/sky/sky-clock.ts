/**
 * The sky clock (AIRSPACE.md §5): re-renders its host every SKY_TICK_MS while the host is connected and an airspace
 * entity is configured, and once whenever the document becomes visible again. The sky's freshness gates (live →
 * stale, drawable → not drawable, a future timestamp becoming valid) are computed on every render and never cached,
 * so each one clears within one tick even when no entity update ever arrives. The clock only calls requestUpdate():
 * it reads nothing and holds no data.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { startIntervalTicker, type StopTicker } from '../../util/time.ts';

/** The liveness bound the gates add to their thresholds: stale shows at most this long past 180 s (AIRSPACE.md §5). */
export const SKY_TICK_MS = 10_000;

export class SkyClock implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  /** Whether the card configures an airspace entity; read on connect and after every host update. */
  readonly #configured: () => boolean;
  #connected = false;
  #stop: StopTicker | undefined;

  constructor(host: ReactiveControllerHost, configured: () => boolean) {
    this.#host = host;
    this.#configured = configured;
    host.addController(this);
  }

  hostConnected(): void {
    this.#connected = true;
    this.#sync();
  }

  /** Services can arrive (or the configuration change) after connect; each update re-checks. */
  hostUpdated(): void {
    this.#sync();
  }

  hostDisconnected(): void {
    this.#connected = false;
    this.#sync();
  }

  #sync(): void {
    const wanted = this.#connected && this.#configured();
    if (wanted && this.#stop === undefined) {
      this.#stop = startIntervalTicker(() => this.#host.requestUpdate(), SKY_TICK_MS);
    } else if (!wanted && this.#stop !== undefined) {
      this.#stop();
      this.#stop = undefined;
    }
  }
}
