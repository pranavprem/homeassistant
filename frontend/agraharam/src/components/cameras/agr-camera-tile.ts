/**
 * One camera tile (§6.5, §9.3): a 4:3 box in EVERY state, so the panel never jumps. An allowed camera is a single
 * button that opens live view; the picture is an authenticated still shown through an object URL owned by the
 * SnapshotController. Privacy, offline, missing, disconnected and "No access" tiles are calm inset surfaces with a
 * line icon, the name and the reason, and offer no live view. Neither does a camera whose config turns live view off
 * (`live: false`, §4.1): its tile is a picture (or "Live view off") and nothing more.
 *
 * Leaf element: it receives a CameraTileVM and a narrow SnapshotSource (never DashboardServices) and emits
 * 'agr-open-drawer' { id: 'camera' } with itself as the trigger; its shadow root delegates focus to the button.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { GATE_LABELS } from '../../ha/camera-gate.ts';
import { SnapshotController, type SnapshotSource, type SnapshotTarget } from '../../ha/snapshot-controller.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { CameraGate } from '../../ha/camera-gate.ts';
import type { CameraTileVM, IconName } from '../../model/types.ts';
import { focusRingStyles, skeletonStyles, toneStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import { requestDrawer } from '../shell/overlay-types.ts';

/** Height over width of every tile (§6.5: 4:3). */
const TILE_ASPECT = 3 / 4;

/** Copy for tile states that are not gate results. */
const TILE_COPY = Object.freeze({
  liveOnRequest: 'Live view on request',
  liveOff: 'Live view off',
  pictureUnavailable: 'Picture unavailable',
  loadingPicture: 'Loading picture',
  notUpdating: 'Not updating',
  openLive: 'live view',
  loading: 'Loading',
  paused: 'Paused',
} as const);

type ClosedGate = Exclude<CameraGate, { kind: 'allowed' } | { kind: 'loading' }>;

const GATE_ICONS: Readonly<Record<ClosedGate['kind'], IconName>> = Object.freeze({
  privacy: 'eye-off',
  offline: 'unplug',
  missing: 'camera-off',
  disconnected: 'wifi-off',
  denied: 'lock',
});

const STATE_ICON_SIZE = 20;

export class AgrCameraTile extends LitElement {
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    skeletonStyles,
    toneStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .tile {
        position: relative;
        box-sizing: border-box;
        display: block;
        inline-size: 100%;
        aspect-ratio: 4 / 3;
        margin: 0;
        padding: 0;
        border: none;
        overflow: hidden;
        border-radius: var(--agr-radius-inner);
        color: var(--agr-ink);
        background: var(--agr-surface-inset);
        font: inherit;
        text-align: start;
      }
      button.tile {
        cursor: pointer;
        transition: box-shadow var(--agr-dur-1) var(--agr-ease);
      }
      button.tile:hover:not([aria-disabled='true']) {
        box-shadow: inset 0 0 0 1px var(--agr-line);
      }
      button.tile[aria-disabled='true'] {
        cursor: not-allowed;
      }
      .picture {
        position: absolute;
        inset: 0;
        display: block;
        inline-size: 100%;
        block-size: 100%;
        object-fit: cover;
        /* Dims pictures in the dark theme (a token), so a bright feed never outweighs the weather anchor. */
        filter: var(--agr-media-filter);
      }
      .name-pill,
      .badge {
        position: absolute;
        box-sizing: border-box;
        max-inline-size: calc(100% - 16px);
        padding: 3px 10px;
        border-radius: var(--agr-radius-control);
        background: var(--agr-surface);
        font: var(--agr-type-meta);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .name-pill {
        inset-inline-start: 8px;
        inset-block-end: 8px;
        color: var(--agr-ink);
      }
      .badge {
        inset-inline-end: 8px;
        inset-block-start: 8px;
        color: var(--agr-brass-ink);
      }
      .state {
        position: absolute;
        inset: 0;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: var(--agr-space-2);
        padding: var(--agr-space-3);
      }
      .icon {
        display: inline-flex;
        color: var(--agr-muted);
      }
      .text {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: var(--agr-type-control);
        color: var(--agr-ink);
      }
      /* Reasons wrap (up to two lines) rather than truncate: a clipped reason would hide why a camera is closed. */
      .reason {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .reason[data-tone='attention'] {
        color: var(--agr-brass-ink);
      }
      .skeleton {
        margin: 0;
        background: var(--agr-line);
      }
      .skeleton.short {
        inline-size: 38%;
        margin-block-start: var(--agr-space-2);
      }
      .skeleton.long {
        inline-size: 56%;
      }
      /* While the first picture loads, a placeholder fill stands where it will appear (no motion), under the
         visible "Loading picture" line, so the tile never reads as empty or broken. */
      .fill {
        position: absolute;
        inset: 0;
        background: var(--agr-line);
        opacity: 0.5;
      }
    `,
  ];

  @property({ attribute: false }) vm?: CameraTileVM;
  @property({ attribute: false }) source?: SnapshotSource;
  /** Stable data-focus-key of the live button (§5.1). */
  @property({ attribute: 'focus-key' }) focusKey = '';

  readonly #snapshots = new SnapshotController(this, {
    observeIntersection: true,
    target: () => this.#snapshotTarget(),
  });

  #snapshotTarget(): SnapshotTarget | undefined {
    const vm = this.vm;
    const source = this.source;
    if (vm === undefined || source === undefined) return undefined;
    return {
      source,
      camera: vm.key,
      key: `${vm.binding}|${vm.gate.kind}`,
      allowed: vm.gate.kind === 'allowed' && vm.thumbnails,
      intervalMs: vm.intervalMs,
      aspect: TILE_ASPECT,
    };
  }

  readonly #onActivate = contained('camera-tile-activate-failed', (event: MouseEvent) => {
    const vm = this.vm;
    if (vm?.live?.enabled !== true) {
      event.preventDefault();
      return;
    }
    requestDrawer(this, { id: 'camera', entity: vm.key }, this);
  });

  protected override render(): TemplateResult {
    const vm = this.vm;
    if (vm === undefined || vm.gate.kind === 'loading') return this.#renderLoading(vm?.name);
    const gate = vm.gate;
    if (gate.kind !== 'allowed') return this.#renderClosed(vm.name, gate);
    const snapshot = this.#snapshots.view();
    if (snapshot.phase === 'denied') return this.#renderClosed(vm.name, { kind: 'denied', label: GATE_LABELS.denied });
    // §9.3: the camera line icon; the visible reason already says "Live view", so it is not announced twice.
    if (!vm.thumbnails) {
      const reason = vm.live === undefined ? TILE_COPY.liveOff : TILE_COPY.liveOnRequest;
      return this.#renderTile(vm, this.#stateContent(vm.name, 'camera', reason), false);
    }
    if (snapshot.url !== undefined) {
      return this.#renderTile(
        vm,
        html`<img class="picture" src=${snapshot.url} alt="" decoding="async" />
          ${snapshot.stale ? html`<span class="badge">${TILE_COPY.notUpdating}</span>` : nothing}
          <span class="name-pill">${vm.name}</span>`,
      );
    }
    return snapshot.phase === 'error'
      ? this.#renderTile(vm, this.#stateContent(vm.name, 'camera-off', TILE_COPY.pictureUnavailable))
      : this.#renderTile(
          vm,
          html`<span class="fill" aria-hidden="true"></span>${this.#stateContent(
              vm.name,
              'camera',
              TILE_COPY.loadingPicture,
            )}`,
        );
  }

  #renderLoading(name: string | undefined): TemplateResult {
    return html`<div class="tile">
      <div class="state">
        <span></span>
        <span class="text" aria-hidden="true">
          <span class="skeleton long"></span>
          <span class="skeleton short"></span>
        </span>
        <span class="visually-hidden">${name ?? ''} ${TILE_COPY.loading}</span>
      </div>
    </div>`;
  }

  /**
   * Privacy, offline, missing, disconnected and denied: not interactive, so not focusable. While disconnected the
   * banner carries the full sentence, so each tile shows only "Paused" and keeps the full reason for assistive
   * technology.
   */
  #renderClosed(name: string, gate: ClosedGate): TemplateResult {
    const tone = gate.kind === 'privacy' && gate.certainty === 'unknown' ? 'attention' : 'muted';
    if (gate.kind === 'disconnected' && gate.label === GATE_LABELS.disconnected) {
      return html`<div class="tile" data-gate=${gate.kind}>
        <span class="state">
          <span class="icon">${renderIcon(GATE_ICONS[gate.kind], STATE_ICON_SIZE)}</span>
          <span class="text">
            <span class="name">${name}</span>
            <span class="reason" aria-hidden="true">${TILE_COPY.paused}</span>
            <span class="visually-hidden">${gate.label}</span>
          </span>
        </span>
      </div>`;
    }
    return html`<div class="tile" data-gate=${gate.kind}>
      ${this.#stateContent(name, GATE_ICONS[gate.kind], gate.label, undefined, tone)}
    </div>`;
  }

  #stateContent(
    name: string,
    icon: IconName,
    reason: string | undefined,
    hiddenReason?: string,
    tone: 'muted' | 'attention' = 'muted',
  ): TemplateResult {
    return html`<span class="state">
      <span class="icon">${renderIcon(icon, STATE_ICON_SIZE)}</span>
      <span class="text">
        <span class="name">${name}</span>
        ${reason === undefined ? nothing : html`<span class="reason" data-tone=${tone}>${reason}</span>`}
        ${hiddenReason === undefined ? nothing : html`<span class="visually-hidden">${hiddenReason}</span>`}
      </span>
    </span>`;
  }

  /**
   * The whole tile is the live-view button; a disabled one stays focusable and announces why (§7.2). `announceLive`
   * adds "live view" to the accessible name unless the visible content already says it. A camera without live view
   * is a plain box.
   */
  #renderTile(vm: CameraTileVM, content: TemplateResult, announceLive = true): TemplateResult {
    const live = vm.live;
    if (live === undefined) return html`<div class="tile">${content}</div>`;
    const reason = live.enabled ? undefined : live.message;
    return html`<button
        type="button"
        class="tile"
        aria-haspopup="dialog"
        data-focus-key=${this.focusKey || nothing}
        aria-disabled=${reason === undefined ? nothing : 'true'}
        aria-describedby=${reason === undefined ? nothing : 'reason'}
        @click=${this.#onActivate}
        @keydown=${suppressKeyRepeat}
      >
        ${content}${announceLive ? html`<span class="visually-hidden">${TILE_COPY.openLive}</span>` : nothing}
      </button>
      ${reason === undefined ? nothing : html`<span id="reason" class="visually-hidden">${reason}</span>`}`;
  }
}

defineOnce('agr-camera-tile', AgrCameraTile);

declare global {
  interface HTMLElementTagNameMap {
    'agr-camera-tile': AgrCameraTile;
  }
}
