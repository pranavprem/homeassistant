/**
 * Camera live view (§9.4, §16.10). A centered agr-dialog, min(960px, 94vw), with a 16:9 frame. A snapshot still
 * takes its own aspect instead (§16.13), so a 4:3 picture is never letterboxed inside the wider frame.
 *
 * The element only renders: LiveViewController owns the lifecycle (the full open gate, the stream or the labelled
 * 2-second snapshot fallback, and every release path). The dialog starts it once the modal is open, stops it when
 * the dialog closes, and offers "Resume live view" after a stop that a tap can undo. At most one live stream exists:
 * the overlay host mounts a single camera dialog.
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { GATE_LABELS, type CameraBinding } from '../../ha/camera-gate.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import { LiveViewController, type LiveState, type LiveStopCause } from '../../ha/live-view-controller.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { LIVE_REASONS } from '../../domain/live-view.ts';
import type { CameraGate } from '../../ha/camera-gate.ts';
import type { IconName } from '../../model/types.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import { AgrDialog } from '../primitives/agr-dialog.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';

type CameraDialogRequest = Extract<DrawerRequest, { id: 'camera' }>;

/** Host custom property carrying the still's aspect to the dialog width and the frame. */
const FRAME_RATIO_PROPERTY = '--agr-frame-ratio';
const NOTICE_ICON_SIZE = 24;
/**
 * Still aspects (width / height) the frame adopts. A picture outside this range (a panorama, a portrait doorbell)
 * keeps the 16:9 frame with themed bars, so the dialog never grows taller than it is wide or turns into a strip.
 */
const STILL_RATIO_MIN = 1;
const STILL_RATIO_MAX = 2.4;

const LIVE_COPY = Object.freeze({
  heading: 'Camera',
  starting: 'Starting live view',
  native: 'Live view',
  demo: 'Demo live view of a fictional scene',
  fallback: 'Snapshot view. Refreshes every 2 seconds.',
  pausedDisconnected: 'Paused while disconnected',
  pausedDisconnectedDetail: 'Live view needs a connection to Home Assistant. Resume it once the connection is back.',
  pausedHidden: 'Paused while this tab is hidden',
  pausedHiddenDetail: 'Live view resumes when you come back.',
  stopped: 'Live view stopped',
  preview: 'Live view is off while you edit the dashboard.',
  turnedOff: 'Live view is off',
  resume: 'Resume live view',
  pictureUnavailable: 'Picture unavailable',
  pictureUnavailableDetail: "The latest picture couldn't be loaded. Trying again shortly.",
  stillAlt: 'Latest picture from',
} as const);

const CLOSED_GATE_ICONS: Readonly<Record<Exclude<CameraGate['kind'], 'allowed'>, IconName>> = Object.freeze({
  loading: 'camera',
  privacy: 'eye-off',
  offline: 'unplug',
  missing: 'camera-off',
  disconnected: 'wifi-off',
  denied: 'lock',
});

interface Notice {
  readonly icon: IconName;
  readonly title: string;
  readonly detail?: string;
}

export class AgrCameraDialog extends AgrDialog implements DrawerElement<CameraDialogRequest> {
  static override styles = [
    ...AgrDialog.styles,
    css`
      /* --agr-frame-ratio (set on the host) is the still's own aspect while a snapshot shows; the live card stays
         16:9 (§9.4). The dialog narrows to the widest frame that fits the viewport height at that aspect (the
         chrome above and below the frame takes about 200 px, the body's side padding 48 px), so the frame always
         fills the content width, starts at the title's left edge and never exceeds the height. */
      :host {
        --agr-dialog-width: min(960px, 94vw, calc((92dvh - 200px) * var(--agr-frame-ratio, 1.7778) + 48px));
      }
      .stage {
        inline-size: 100%;
      }
      .frame {
        position: relative;
        box-sizing: border-box;
        inline-size: 100%;
        aspect-ratio: var(--agr-frame-ratio, 16 / 9);
        overflow: hidden;
        border-radius: var(--agr-radius-inner);
        background: var(--agr-surface-inset);
        --ha-card-border-radius: 0;
        --ha-card-border-width: 0;
        --ha-card-box-shadow: none;
      }
      /* Bars around a still whose aspect differs from the frame take the theme's quiet surface, not near-black,
         which looked harsh against cream. HA's own live card paints its near-black letterbox itself (§9.4). */
      .frame[data-media] {
        background: var(--agr-letterbox);
      }
      .frame > [data-agr-live],
      .frame > agr-demo-stream,
      .frame > .still {
        position: absolute;
        inset: 0;
        display: block;
        inline-size: 100%;
        block-size: 100%;
      }
      .still {
        object-fit: contain;
        filter: var(--agr-media-filter);
      }
      .notice {
        position: absolute;
        inset: 0;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--agr-space-2);
        padding: var(--agr-space-6);
        text-align: center;
        color: var(--agr-muted);
      }
      .notice-title {
        margin: 0;
        font: var(--agr-type-strong);
        color: var(--agr-ink);
      }
      .notice-detail {
        max-inline-size: 40ch;
        margin: 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .status-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--agr-space-3);
        min-block-size: var(--agr-target);
        margin-block-start: var(--agr-space-3);
      }
      .status {
        display: flex;
        align-items: center;
        gap: var(--agr-space-2);
        margin: 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .dot {
        flex: none;
        inline-size: 8px;
        block-size: 8px;
        border-radius: 50%;
        background: var(--agr-line);
      }
      .status[data-tone='ok'] .dot {
        background: var(--agr-olive);
      }
      .status[data-tone='attention'] .dot {
        background: var(--agr-brass);
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: CameraDialogRequest;

  override heading: string = LIVE_COPY.heading;

  /** The aspect of the camera's snapshot still once one has loaded, so the frame fits it (§16.13). */
  #stillRatio: number | undefined;
  #stillRatioCamera: EntityId | undefined;

  readonly #live = new LiveViewController(this, {
    services: () => this.services,
    camera: () => this.#camera(),
    isOpen: () => this.dialogElement()?.open === true,
    box: () => this.renderRoot?.querySelector('.frame') ?? null,
  });

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => this.#watchIds(),
      ['connection'],
    );
  }

  /** What the dialog is doing now (tests and diagnostics). */
  get liveState(): LiveState['kind'] {
    return this.#live.state.kind;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    this.heading = this.#camera()?.name ?? LIVE_COPY.heading;
  }

  /** After the controller reconciled and the frame rendered: the frame takes the still's aspect while one shows. */
  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    const ratio = this.#frameRatio();
    if (ratio === undefined) this.style.removeProperty(FRAME_RATIO_PROPERTY);
    else this.style.setProperty(FRAME_RATIO_PROPERTY, String(ratio));
  }

  /** The stream starts once the modal is open; deferred a microtask so the start schedules a fresh update. */
  protected override firstUpdated(): void {
    super.firstUpdated();
    queueMicrotask(contained('camera-live-start-failed', () => this.#live.start()));
  }

  protected override onDialogClosed(): void {
    this.#live.stop();
    super.onDialogClosed();
  }

  protected override renderBody(): TemplateResult {
    const state = this.#live.state;
    const media = state.kind === 'streaming' || this.#showsStill();
    return html`<div class="stage">
      <div class="frame" ?data-media=${media}>${this.#renderFrame(state)}</div>
      <div class="status-row">
        ${this.#renderStatus(state)} ${this.#offersResume(state) ? this.#renderResume() : nothing}
      </div>
    </div>`;
  }

  #renderFrame(state: LiveState): TemplateResult | HTMLElement {
    switch (state.kind) {
      case 'streaming':
        return state.handle.element;
      case 'fallback':
        return this.#renderFallback();
      case 'stopped':
        return this.#renderNotice(this.#stoppedNotice(state.cause));
      default:
        return this.#renderNotice({ icon: 'video', title: LIVE_COPY.starting });
    }
  }

  #renderFallback(): TemplateResult {
    const view = this.#live.fallbackView();
    const name = this.#camera()?.name ?? '';
    if (view.url !== undefined)
      return html`<img
        class="still"
        src=${view.url}
        alt=${`${LIVE_COPY.stillAlt} ${name}`}
        @load=${this.#onStillLoad}
      />`;
    if (view.phase === 'denied') return this.#renderNotice({ icon: 'lock', title: GATE_LABELS.denied });
    if (view.phase === 'error') {
      return this.#renderNotice({
        icon: 'camera-off',
        title: LIVE_COPY.pictureUnavailable,
        detail: LIVE_COPY.pictureUnavailableDetail,
      });
    }
    return this.#renderNotice({ icon: 'camera', title: LIVE_COPY.starting });
  }

  #showsStill(): boolean {
    return this.#live.state.kind === 'fallback' && this.#live.fallbackView().url !== undefined;
  }

  /** The frame's aspect: the still's own while a snapshot shows, else undefined (the 16:9 default). */
  #frameRatio(): number | undefined {
    return this.#showsStill() ? this.#currentStillRatio() : undefined;
  }

  /** The ratio learned for the camera the dialog shows now; another camera's ratio never carries over. */
  #currentStillRatio(): number | undefined {
    return this.#stillRatioCamera === this.request?.entity ? this.#stillRatio : undefined;
  }

  readonly #onStillLoad = contained('camera-still-ratio-failed', (event: Event) => {
    const image = event.target as HTMLImageElement;
    const ratio = image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : Number.NaN;
    const usable = Number.isFinite(ratio) && ratio >= STILL_RATIO_MIN && ratio <= STILL_RATIO_MAX;
    const next = usable ? Math.round(ratio * 1000) / 1000 : undefined;
    if (next === this.#currentStillRatio()) return;
    this.#stillRatio = next;
    this.#stillRatioCamera = this.request?.entity;
    this.requestUpdate();
  });

  #renderNotice(notice: Notice): TemplateResult {
    return html`<div class="notice">
      ${renderIcon(notice.icon, NOTICE_ICON_SIZE)}
      <p class="notice-title">${notice.title}</p>
      ${notice.detail === undefined ? nothing : html`<p class="notice-detail">${notice.detail}</p>`}
    </div>`;
  }

  /** The one polite live region of the dialog; a stopped state is described by the frame, so it is visually hidden. */
  #renderStatus(state: LiveState): TemplateResult {
    const { text, tone } = this.#statusLine(state);
    const hidden = state.kind === 'stopped';
    return html`<p class=${hidden ? 'status visually-hidden' : 'status'} role="status" data-tone=${tone}>
      ${hidden ? nothing : html`<span class="dot" aria-hidden="true"></span>`}<span>${text}</span>
    </p>`;
  }

  /** A stop a tap can undo: not a hidden tab (it resumes by itself) and not a camera whose config turns live off. */
  #offersResume(state: LiveState): boolean {
    return state.kind === 'stopped' && state.cause !== 'hidden' && this.#camera()?.live === true;
  }

  #renderResume(): TemplateResult {
    return html`<agr-button
      label=${LIVE_COPY.resume}
      icon="play"
      focus-key="camera-dialog:resume"
      reason-display="hidden"
      .availability=${this.#live.openCheck()}
      @agr-activate=${this.#onResume}
    ></agr-button>`;
  }

  readonly #onResume = contained('camera-resume-failed', () => this.#live.start());

  #statusLine(state: LiveState): { readonly text: string; readonly tone: 'ok' | 'attention' | 'muted' } {
    switch (state.kind) {
      case 'streaming':
        return { text: state.handle.kind === 'demo' ? LIVE_COPY.demo : LIVE_COPY.native, tone: 'ok' };
      case 'fallback':
        return { text: LIVE_COPY.fallback, tone: 'attention' };
      case 'stopped':
        return { text: this.#stoppedNotice(state.cause).title, tone: 'muted' };
      default:
        return { text: LIVE_COPY.starting, tone: 'muted' };
    }
  }

  #stoppedNotice(cause: LiveStopCause): Notice {
    switch (cause) {
      case 'disconnected':
        return { icon: 'wifi-off', title: LIVE_COPY.pausedDisconnected, detail: LIVE_COPY.pausedDisconnectedDetail };
      case 'hidden':
        return { icon: 'video', title: LIVE_COPY.pausedHidden, detail: LIVE_COPY.pausedHiddenDetail };
      case 'preview':
        return { icon: 'video', title: LIVE_COPY.stopped, detail: LIVE_COPY.preview };
      default:
        return this.#gateNotice();
    }
  }

  /** Why live view cannot run, read fresh: the camera's config, or the gate's reason (privacy, offline, …). */
  #gateNotice(): Notice {
    const camera = this.#camera();
    const gate = this.#live.gate();
    if (camera === undefined || gate === undefined) {
      return { icon: 'camera-off', title: GATE_LABELS.missing, detail: LIVE_REASONS.missing };
    }
    if (!camera.live) return { icon: 'camera-off', title: LIVE_COPY.turnedOff, detail: LIVE_REASONS.turnedOff };
    if (gate.kind === 'allowed') return { icon: 'video', title: LIVE_COPY.stopped };
    const check = this.#live.openCheck();
    const title = gate.kind === 'loading' ? LIVE_REASONS.loading : gate.label;
    return {
      icon: CLOSED_GATE_ICONS[gate.kind],
      title,
      ...(!check.enabled && check.message !== title && { detail: check.message }),
    };
  }

  #camera(): CameraBinding | undefined {
    const entity = this.request?.entity;
    return entity === undefined ? undefined : this.services?.config?.cameras.find((camera) => camera.entity === entity);
  }

  #watchIds(): EntityId[] {
    const camera = this.#camera();
    if (camera === undefined) return [];
    return camera.privacy === undefined ? [camera.entity] : [camera.entity, camera.privacy.entity];
  }
}

defineOnce('agr-camera-dialog', AgrCameraDialog);

declare global {
  interface HTMLElementTagNameMap {
    'agr-camera-dialog': AgrCameraDialog;
  }
}
