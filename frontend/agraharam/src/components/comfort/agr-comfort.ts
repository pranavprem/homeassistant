/**
 * Climate panel (§5.1, §6.2.1): at most two comfort tiles in one row (climate first, then air, then bed), a
 * "+N more" control into the climate drawer, and a header pill that reports cooling or heating from hvac_action.
 *
 * The section holds the ActionController; tiles are leaves. It subscribes to every comfort entity plus
 * CONTROL_META, because each control's Availability depends on services, user and registry as well as state.
 * Nothing is requested on mount or render: only a power toggle activation makes a request.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { ActionController } from '../../ha/actions/action-controller.ts';
import type { Availability } from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import { parseNumericValue } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { entityActionKey } from '../../model/controls.ts';
import { CONTENT_BUDGET } from '../../model/budget.ts';
import {
  comfortActionKeys,
  comfortEntityIds,
  comfortOverview,
  selectComfortTiles,
  type ComfortTile,
} from '../../model/comfort.ts';
import type { ComfortVM } from '../../model/types.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import {
  focusRingStyles,
  headerActionStyles,
  sectionHostStyles,
  skeletonStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-empty-state.ts';
import '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { applyFanIntent, type FanIntent } from '../shared/agr-fan-controls.ts';
import '../shared/agr-control-notes.ts';
import {
  controlNotes,
  noticeStyles,
  renderNotice,
  sharedNotice,
  dismissNote,
  type ControlNote,
} from '../shared/control-notes.ts';
import { panelPill, pausedByConnection } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import './agr-comfort-tile.ts';

const HEADING_ID = 'agr-comfort-heading';
const FOCUS_PREFIX = 'comfort';
const MORE_ICON_SIZE = 16;
/** A comfort tile's height side by side, and stacked (name, value, status). */
const TILE_PX = 64;
const STACKED_TILE_PX = 84;

/** Overview tiles in panel order (§6.2.1): the VM keeps climate, air and bed apart; the row shows them in turn. */
function overviewTiles(vm: ComfortVM): readonly ComfortTile[] {
  return [
    ...vm.climate.map((tile): ComfortTile => ({ kind: 'climate', vm: tile })),
    ...vm.air.map((tile): ComfortTile => ({ kind: 'air', vm: tile })),
    ...vm.bed.map((tile): ComfortTile => ({ kind: 'bed', vm: tile })),
  ];
}

export class AgrComfort extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    focusRingStyles,
    visuallyHiddenStyles,
    noticeStyles,
    headerActionStyles,
    css`
      .tiles {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--agr-space-3);
      }
      .tiles[data-count='1'] {
        grid-template-columns: minmax(0, 1fr);
      }
      /* In a narrow panel each tile takes the full row, so names and status lines keep whole words. */
      @container panel (width < ${PANEL_CQ.twoUp}px) {
        .tiles {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .tile-skeleton {
        block-size: ${TILE_PX}px;
        margin: 0;
        border-radius: var(--agr-radius-inner);
      }
      /* Two up in a panel under 428 px, a tile is under 208 px and stacks name, value and status (agr-comfort-tile),
         so its placeholder is as tall as that tile. */
      @container panel (width >= ${PANEL_CQ.twoUp}px) and (width < ${PANEL_CQ.comfortPairStacked}px) {
        .tiles:not([data-count='1']) .tile-skeleton {
          block-size: ${STACKED_TILE_PX}px;
        }
      }
      .notice {
        margin-block-start: var(--agr-space-3);
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;
  /** How many tiles the overview shows; the root raises it when the column has spare height (§16.14). */
  @property({ attribute: false }) tileBudget: number = CONTENT_BUDGET.comfortTiles;

  // Registers itself with this host: re-renders on any comfort entity or control-meta change.
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : comfortEntityIds(this.services.config)),
      CONTROL_META,
    );
  }

  readonly #actions = new ActionController(
    this,
    () => this.services,
    () => (this.services?.config === undefined ? [] : comfortActionKeys(this.services.config)),
  );

  readonly #onDismissNote = contained('comfort-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions);
  });

  readonly #onFanIntent = contained('comfort-fan-intent-failed', (event: CustomEvent<FanIntent>) => {
    event.stopPropagation();
    this.#applyFanIntent(event.detail);
  });

  readonly #openAll = contained('comfort-open-all-failed', (event: MouseEvent) => {
    requestDrawer(this, { id: 'climate' }, event.currentTarget as HTMLElement);
  });

  protected override render(): TemplateResult {
    const services = this.services;
    if (services?.store === undefined || services.config === undefined) {
      return this.#renderSkeleton(this.tileBudget);
    }
    const total = comfortEntityIds(services.config).length;
    if (total === 0) return this.#renderEmpty();
    if (!services.store.isReady()) return this.#renderSkeleton(Math.min(total, this.tileBudget));
    try {
      return this.#renderPanel(services, selectComfortTiles(selectorInput(services)));
    } catch {
      log.error('comfort-render-failed');
      return this.#renderSkeleton(1);
    }
  }

  #renderPanel(services: DashboardServices, allTiles: readonly ComfortTile[]): TemplateResult {
    const vm = comfortOverview(allTiles, this.tileBudget);
    const tiles = overviewTiles(vm);
    const toggles: Availability[] = vm.air.filter((tile) => tile.power !== 'unknown').map((tile) => tile.toggle);
    // Every controllable device reports here, so an outcome from the drawer stays visible after it closes.
    const notes = controlNotes(
      allTiles.flatMap((tile) =>
        tile.kind === 'bed' ? [] : [{ key: entityActionKey(tile.vm.key), name: tile.vm.name }],
      ),
      (key) => this.#actions.status(key),
      (key) => this.#actions.draftState(key),
    );
    return html`<agr-panel
      heading="Climate"
      heading-id=${HEADING_ID}
      icon="thermometer"
      surface="raised"
      .pill=${panelPill(services.store, vm.summary)}
    >
      ${vm.overflow > 0 ? this.#renderMore(vm.overflow) : nothing}
      <div class="tiles" data-count=${tiles.length} @agr-fan-intent=${this.#onFanIntent}>
        ${tiles.map(
          (tile) =>
            html`<agr-comfort-tile .tile=${tile} focus-key=${`${FOCUS_PREFIX}:${tile.vm.key}`}></agr-comfort-tile>`,
        )}
      </div>
      ${renderNotice(pausedByConnection(services.store) ? undefined : sharedNotice(toggles))}
      <agr-control-notes
        .notes=${notes}
        focus-key-prefix=${FOCUS_PREFIX}
        @agr-dismiss-note=${this.#onDismissNote}
      ></agr-control-notes>
    </agr-panel>`;
  }

  #renderMore(overflow: number): TemplateResult {
    return html`<button
      type="button"
      slot="actions"
      class="header-action more"
      aria-haspopup="dialog"
      data-focus-key=${`${FOCUS_PREFIX}:more`}
      @click=${this.#openAll}
      @keydown=${suppressKeyRepeat}
    >
      ${renderIcon('plus', MORE_ICON_SIZE)}<span>${overflow} more</span
      ><span class="visually-hidden"> ${overflow === 1 ? 'climate device' : 'climate devices'}</span>
    </button>`;
  }

  #renderSkeleton(count: number): TemplateResult {
    return html`<agr-panel heading="Climate" heading-id=${HEADING_ID} icon="thermometer" surface="raised">
      <div class="tiles" data-count=${count} aria-hidden="true">
        ${Array.from({ length: count }, () => html`<div class="tile-skeleton skeleton" aria-hidden="true"></div>`)}
      </div>
    </agr-panel>`;
  }

  #renderEmpty(): TemplateResult {
    return html`<agr-panel heading="Climate" heading-id=${HEADING_ID} icon="thermometer" surface="raised">
      <agr-empty-state
        icon="thermometer"
        heading="No climate devices here yet"
        message="Climate, air and bed devices will show up here once they're connected."
      ></agr-empty-state>
    </agr-panel>`;
  }

  #applyFanIntent(intent: FanIntent): void {
    const services = this.services;
    if (services === undefined) return;
    applyFanIntent(this.#actions, intent, () => {
      const ref = services.config.air.find((candidate) => candidate.entity === intent.entity);
      return ref === undefined ? null : this.#observedPercentage(services, ref.entity);
    });
  }

  #observedPercentage(services: DashboardServices, entity: EntityId): number | null {
    return parseNumericValue(services.store.get(entity)?.attributes['percentage']);
  }
}

defineOnce('agr-comfort', AgrComfort);

declare global {
  interface HTMLElementTagNameMap {
    'agr-comfort': AgrComfort;
  }
}
