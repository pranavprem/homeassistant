/**
 * Media panel (§5.1, §6.2.1): the active player only (first playing, else paused, else available, else first
 * configured), with plum transport and volume controls for exactly the features it supports, or a compact row when
 * it is off or absent. The player chip in the panel header opens the media drawer for players and sources.
 *
 * The section holds the ActionController; the player block is a leaf. Nothing is requested on mount or render.
 */
import { css, html, LitElement, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { ActionController } from '../../ha/actions/action-controller.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { entityActionKey } from '../../model/controls.ts';
import { mediaActionKeys, mediaEntityIds, selectMedia } from '../../model/media.ts';
import type { MediaPlayerVM, MediaVM } from '../../model/types.ts';
import { focusRingStyles, sectionHostStyles, skeletonStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../shared/agr-control-notes.ts';
import {
  controlNotes,
  noticeStyles,
  renderNotice,
  sharedNotice,
  dismissNote,
  type ControlNote,
} from '../shared/control-notes.ts';
import { selectorInput } from '../shared/selector-input.ts';
import '../primitives/agr-empty-state.ts';
import '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { panelPill, pausedByConnection } from '../shared/paused.ts';
import { applyMediaIntent, observedVolumePercent, playerControls, type MediaIntent } from './agr-media-player.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import './agr-media-player.ts';

const HEADING_ID = 'agr-media-heading';
const FOCUS_PREFIX = 'media';
const CHIP_ICON_SIZE = 16;

export class AgrMedia extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    focusRingStyles,
    visuallyHiddenStyles,
    noticeStyles,
    css`
      .notice {
        margin-block-start: var(--agr-space-2);
      }
      /* The chip's 44 px hit area overlaps the header padding; the visible face stays a slim pill. */
      .chip {
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        min-inline-size: var(--agr-target);
        max-inline-size: 60cqi;
        min-block-size: var(--agr-target);
        margin-block: -10px;
        margin-inline-end: -6px;
        padding: 0 6px;
        border: none;
        border-radius: var(--agr-radius-control);
        background: transparent;
        cursor: pointer;
      }
      .chip-face {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-inline-size: 0;
        padding: 3px 10px 3px 8px;
        border-radius: var(--agr-radius-control);
        font: var(--agr-type-meta-strong);
        color: var(--agr-plum);
        background: var(--agr-plum-tint);
      }
      .chip-face svg {
        flex: none;
      }
      .chip-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chip:hover .chip-face {
        box-shadow: inset 0 0 0 1px var(--agr-plum);
      }
      .player-ghost {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-3);
      }
      .player-ghost .row {
        block-size: 52px;
      }
      .player-ghost .bar {
        block-size: 28px;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  // Registers itself with this host: re-renders on any media entity or control-meta change.
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : mediaEntityIds(this.services.config)),
      CONTROL_META,
    );
  }

  readonly #actions = new ActionController(
    this,
    () => this.services,
    () => (this.services?.config === undefined ? [] : mediaActionKeys(this.services.config)),
  );

  readonly #onDismissNote = contained('media-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions);
  });

  readonly #onIntent = contained('media-intent-failed', (event: CustomEvent<MediaIntent>) => {
    event.stopPropagation();
    const entity = event.detail.entity;
    applyMediaIntent(this.#actions, event.detail, () => observedVolumePercent(this.services?.store, entity));
  });

  readonly #openDrawer = contained('media-open-failed', (event: MouseEvent, entity: EntityId) => {
    requestDrawer(this, { id: 'media', entity }, event.currentTarget as HTMLElement);
  });

  protected override render(): TemplateResult {
    const services = this.services;
    if (services?.store === undefined || services.config === undefined) return this.#renderSkeleton();
    if (services.config.media.length === 0) return this.#renderEmpty();
    if (!services.store.isReady()) return this.#renderSkeleton();
    try {
      return this.#renderPanel(services, selectMedia(selectorInput(services)));
    } catch {
      log.error('media-render-failed');
      return this.#renderSkeleton();
    }
  }

  #renderPanel(services: DashboardServices, vm: MediaVM): TemplateResult {
    const active = vm.players.find((player) => player.key === vm.activeKey);
    if (active === undefined) return this.#renderSkeleton();
    const notes = controlNotes(
      vm.players.map((player) => ({ key: entityActionKey(player.key), name: player.name })),
      (key) => this.#actions.status(key),
      (key) => this.#actions.draftState(key),
    );
    return html`<agr-panel
      heading="Media"
      heading-id=${HEADING_ID}
      icon="music"
      surface="raised"
      .pill=${panelPill(services.store)}
    >
      ${this.#renderChip(active)}
      <agr-media-player
        .player=${active}
        .volumeDraft=${this.#actions.draftState(entityActionKey(active.key))}
        focus-key-prefix=${`${FOCUS_PREFIX}:${active.key}`}
        @agr-media-intent=${this.#onIntent}
      ></agr-media-player>
      ${renderNotice(pausedByConnection(services.store) ? undefined : sharedNotice(playerControls(active)))}
      <agr-control-notes
        .notes=${notes}
        focus-key-prefix=${FOCUS_PREFIX}
        @agr-dismiss-note=${this.#onDismissNote}
      ></agr-control-notes>
    </agr-panel>`;
  }

  /** The player chip: names the shown player and opens the drawer to pick another player or a source. */
  #renderChip(active: MediaPlayerVM): TemplateResult {
    return html`<button
      type="button"
      slot="actions"
      class="chip"
      aria-haspopup="dialog"
      data-focus-key=${`${FOCUS_PREFIX}:players`}
      @click=${(event: MouseEvent) => this.#openDrawer(event, active.key)}
      @keydown=${suppressKeyRepeat}
    >
      <span class="chip-face"
        >${renderIcon('speaker', CHIP_ICON_SIZE)}<span class="chip-name">${active.name}</span></span
      ><span class="visually-hidden">, players and sources</span>
    </button>`;
  }

  #renderSkeleton(): TemplateResult {
    return html`<agr-panel heading="Media" heading-id=${HEADING_ID} icon="music" surface="raised">
      <span class="player-ghost" aria-hidden="true"
        ><span class="ghost row"></span><span class="ghost bar"></span
      ></span>
    </agr-panel>`;
  }

  #renderEmpty(): TemplateResult {
    return html`<agr-panel heading="Media" heading-id=${HEADING_ID} icon="music" surface="raised">
      <agr-empty-state icon="speaker" heading="No media players here yet"></agr-empty-state>
    </agr-panel>`;
  }
}

defineOnce('agr-media', AgrMedia);

declare global {
  interface HTMLElementTagNameMap {
    'agr-media': AgrMedia;
  }
}
