/**
 * "All cameras" drawer (§5.3): every configured camera as the same 4:3 tile the panel uses. Tiles fetch only while
 * they are visible inside the drawer's scroll area, and each opens the live-view dialog, which stacks above the
 * drawer and returns focus to its tile.
 */
import { css, html, LitElement, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { EntityController } from '../../ha/entity-controller.ts';
import { snapshotSourceFor } from '../../ha/snapshot-controller.ts';
import { countPrivate, selectAllCameraTiles } from '../../model/cameras.ts';
import type { CameraTileVM } from '../../model/types.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { log } from '../../util/log.ts';
import '../primitives/agr-drawer.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { cameraWatchIds } from './agr-cameras.ts';
import './agr-camera-tile.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrCamerasDrawerRequest = Extract<DrawerRequest, { id: 'cameras' }>;

const CAMERAS_DRAWER_COPY = Object.freeze({
  heading: 'All cameras',
  note: 'Pictures refresh only while they are on screen. Live view starts when you choose a camera.',
} as const);

/** "8 cameras", "8 cameras, 2 private". */
function camerasSummary(tiles: readonly CameraTileVM[]): string {
  const total = `${tiles.length} ${tiles.length === 1 ? 'camera' : 'cameras'}`;
  const privateCount = countPrivate(tiles);
  return privateCount > 0 ? `${total}, ${privateCount} private` : total;
}

export class AgrCamerasDrawer extends LitElement implements DrawerElement<AgrCamerasDrawerRequest> {
  static override styles = [
    typographyStyles,
    css`
      .summary {
        margin: 0 0 var(--agr-space-4);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--agr-space-3);
      }
      .note {
        margin: var(--agr-space-5) 0 0;
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrCamerasDrawerRequest;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => cameraWatchIds(this.services?.config),
      ['connection'],
    );
  }

  protected override render(): TemplateResult {
    const services = this.services;
    const tiles = this.#tiles(services);
    return html`<agr-drawer
      heading=${CAMERAS_DRAWER_COPY.heading}
      .demo=${services?.mode === 'demo'}
      .theme=${services?.theme ?? 'light'}
    >
      <p class="summary t-meta">${camerasSummary(tiles)}</p>
      <div class="grid">
        ${repeat(
          tiles,
          (tile) => tile.key,
          (tile, index) =>
            html`<agr-camera-tile
              .vm=${tile}
              .source=${services === undefined ? undefined : snapshotSourceFor(services.reader)}
              focus-key=${`cameras-drawer:${index}:live`}
            ></agr-camera-tile>`,
        )}
      </div>
      <p class="note t-meta">${CAMERAS_DRAWER_COPY.note}</p>
    </agr-drawer>`;
  }

  /** Contained (§4.9): a drawer whose services are incomplete or whose selector throws lists nothing. */
  #tiles(services: DashboardServices | undefined): readonly CameraTileVM[] {
    if (services?.config === undefined || services.store === undefined || services.reader === undefined) return [];
    try {
      return selectAllCameraTiles(selectorInput(services), { preview: services.preview });
    } catch {
      log.error('cameras-drawer-select-failed');
      return [];
    }
  }
}

defineOnce('agr-cameras-drawer', AgrCamerasDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-cameras-drawer': AgrCamerasDrawer;
  }
}
