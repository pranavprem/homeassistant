/**
 * Cameras section (§6.2.1, §9.3): at most four 4:3 tiles in a 2×2 grid (one column below PANEL_CQ.cameraGrid),
 * a "N private" header pill, and "All cameras (n)" opening the cameras drawer when more are configured.
 *
 * It subscribes only to its camera and privacy entities and the connection meta, so unrelated entity updates never
 * re-render it, and a camera's rotating access_token only re-renders it without touching any picture (§9.3).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { EntityId, ResolvedConfig } from '../../config/schema.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import { snapshotSourceFor } from '../../ha/snapshot-controller.ts';
import { selectCameras } from '../../model/cameras.ts';
import type { CamerasVM } from '../../model/types.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { focusRingStyles, sectionHostStyles, skeletonStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-panel.ts';
import type { PanelPill } from '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { panelPill } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import './agr-camera-tile.ts';

const CAMERAS_HEADING = 'Cameras';
const CAMERAS_HEADING_ID = 'agr-cameras-heading';

/** Every camera and privacy entity, so the private count covers cameras beyond the overview too. */
export function cameraWatchIds(config: ResolvedConfig | undefined): EntityId[] {
  if (config === undefined) return [];
  return config.cameras.flatMap((camera) =>
    camera.privacy === undefined ? [camera.entity] : [camera.entity, camera.privacy.entity],
  );
}

function allCamerasLabel(total: number): string {
  return `All cameras (${total})`;
}

const GHOST_TILES: readonly number[] = Object.freeze([0, 1, 2, 3]);

function privatePill(vm: CamerasVM): PanelPill | undefined {
  return vm.privateCount > 0 ? { label: `${vm.privateCount} private`, tone: 'neutral' } : undefined;
}

export class AgrCameras extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    focusRingStyles,
    css`
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: var(--agr-space-3);
      }
      @container panel (width >= ${PANEL_CQ.cameraGrid}px) {
        .grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .grid[data-count='1'] {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      /* A 44 px target that keeps the 24 px header line: the extra height is taken from negative margins. */
      .all {
        box-sizing: border-box;
        min-inline-size: var(--agr-target);
        min-block-size: var(--agr-target);
        margin-block: -10px;
        margin-inline-end: -8px;
        padding: 0 var(--agr-space-3);
        border: none;
        border-radius: var(--agr-radius-control);
        color: var(--agr-ink);
        background: transparent;
        font: var(--agr-type-meta-strong);
        white-space: nowrap;
        cursor: pointer;
      }
      .all:hover {
        background: var(--agr-surface-inset);
      }
      .tile-ghost {
        aspect-ratio: 4 / 3;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => cameraWatchIds(this.services?.config),
      ['connection'],
    );
  }

  readonly #openAll = contained('cameras-open-all-failed', (event: MouseEvent) => {
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) return;
    requestDrawer(this, { id: 'cameras' }, trigger);
  });

  protected override render(): TemplateResult {
    const services = this.services;
    const vm = services === undefined ? undefined : this.#select(services);
    if (services === undefined || vm === undefined) {
      // The §6.2.1 overview's shape before anything is known: a 2×2 grid of 4:3 tiles (one column when narrow).
      return html`<agr-panel heading=${CAMERAS_HEADING} heading-id=${CAMERAS_HEADING_ID} icon="video" surface="raised">
        <div class="grid" aria-hidden="true">
          ${GHOST_TILES.map(() => html`<span class="ghost tile-ghost"></span>`)}
        </div>
      </agr-panel>`;
    }
    const source = snapshotSourceFor(services.reader);
    const total = vm.tiles.length + vm.overflow;
    return html`<agr-panel
      heading=${CAMERAS_HEADING}
      heading-id=${CAMERAS_HEADING_ID}
      icon="video"
      surface="raised"
      .pill=${panelPill(services.store, privatePill(vm))}
    >
      ${
        vm.overflow > 0
          ? html`<button
              slot="actions"
              type="button"
              class="all"
              aria-haspopup="dialog"
              data-focus-key="cameras:all"
              @click=${this.#openAll}
              @keydown=${suppressKeyRepeat}
            >
              ${allCamerasLabel(total)}
            </button>`
          : nothing
      }
      <div class="grid" data-count=${vm.tiles.length}>
        ${repeat(
          vm.tiles,
          (tile) => tile.key,
          (tile, index) =>
            html`<agr-camera-tile .vm=${tile} .source=${source} focus-key=${`camera:${index}:live`}></agr-camera-tile>`,
        )}
      </div>
    </agr-panel>`;
  }

  /** A selector failure is contained (§4.9): the panel shows its loading frame instead of escaping. */
  #select(services: DashboardServices): CamerasVM | undefined {
    try {
      return selectCameras(selectorInput(services), { preview: services.preview });
    } catch {
      log.error('cameras-select-failed');
      return undefined;
    }
  }
}

defineOnce('agr-cameras', AgrCameras);

declare global {
  interface HTMLElementTagNameMap {
    'agr-cameras': AgrCameras;
  }
}
