/**
 * Media drawer (§5.3), opened from the Media panel's player chip. A player picker (local view state in the same
 * agr-choice-group as the sources: choosing a player only changes what this drawer shows and sends nothing), the
 * chosen player's block
 * with transport, volume and mute, and its exact `source_list` as a vertical choice group: one activation of a
 * non-current source is exactly one request, and arrow keys never act (§7.2).
 */
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { ActionController } from '../../ha/actions/action-controller.ts';
import { ENABLED } from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import { choiceReason, currentOptionAvailability } from '../../model/choice.ts';
import { entityActionKey } from '../../model/controls.ts';
import { mediaActionKeys, mediaEntityIds, selectMedia } from '../../model/media.ts';
import type { ChoiceOptionVM, MediaPlayerVM, MediaVM } from '../../model/types.ts';
import { focusRingStyles, skeletonStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../shared/agr-control-notes.ts';
import {
  controlNotes,
  noticeStyles,
  dismissNote,
  type ControlNote,
  choiceControls,
  renderNotice,
  sharedNotice,
} from '../shared/control-notes.ts';
import { selectorInput } from '../shared/selector-input.ts';
import '../primitives/agr-choice-group.ts';
import type { ChooseDetail } from '../primitives/agr-choice-group.ts';
import '../primitives/agr-drawer.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import {
  applyMediaIntent,
  isFullPlayer,
  observedVolumePercent,
  playerControls,
  type MediaIntent,
} from './agr-media-player.ts';
import './agr-media-player.ts';

type AgrMediaDrawerRequest = Extract<DrawerRequest, { id: 'media' }>;

const DRAWER_HEADING = 'Media';
const FOCUS_PREFIX = 'media-drawer';

export class AgrMediaDrawer extends LitElement implements DrawerElement<AgrMediaDrawerRequest> {
  static override styles = [
    focusRingStyles,
    skeletonStyles,
    typographyStyles,
    noticeStyles,
    css`
      .group {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-3);
        padding-block: var(--agr-space-5);
      }
      .group + .group {
        border-block-start: 1px solid var(--agr-line);
      }
      .group:first-of-type {
        padding-block-start: var(--agr-space-3);
      }
      h3 {
        margin: 0;
      }
      p {
        margin: 0;
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrMediaDrawerRequest;
  /** The player this drawer shows: view state only, never an action. */
  @state() private selected: EntityId | undefined;

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

  readonly #onDismissNote = contained('media-drawer-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions);
  });

  readonly #onIntent = contained('media-drawer-intent-failed', (event: CustomEvent<MediaIntent>) => {
    event.stopPropagation();
    const entity = event.detail.entity;
    applyMediaIntent(this.#actions, event.detail, () => observedVolumePercent(this.services?.store, entity));
  });

  readonly #onSource = contained('media-source-failed', (player: MediaPlayerVM, event: CustomEvent<ChooseDetail>) => {
    event.stopPropagation();
    this.#actions.request({ kind: 'media.select_source', entity: player.key, source: event.detail.value });
  });

  readonly #onPick = contained('media-pick-failed', (event: CustomEvent<ChooseDetail>) => {
    event.stopPropagation();
    this.selected = event.detail.value as EntityId;
  });

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('request')) this.selected = this.request?.entity;
  }

  protected override render(): TemplateResult {
    const services = this.services;
    if (services?.store === undefined || services.config === undefined) return this.#renderShell();
    let vm: MediaVM;
    try {
      vm = selectMedia(selectorInput(services));
    } catch {
      log.error('media-drawer-render-failed');
      return this.#renderShell();
    }
    const player =
      vm.players.find((candidate) => candidate.key === this.selected) ??
      vm.players.find((candidate) => candidate.key === vm.activeKey);
    if (player === undefined) return this.#renderShell();
    const notes = controlNotes(
      vm.players.map((candidate) => ({ key: entityActionKey(candidate.key), name: candidate.name })),
      (key) => this.#actions.status(key),
      (key) => this.#actions.draftState(key),
    );
    // One notice when every control of the shown player is paused for the same reason (controls off, editing,
    // disconnected), instead of the same line under the transport and again under the sources (§16.10).
    const notice = sharedNotice([...playerControls(player), ...choiceControls(player.sources)]);
    return html`<agr-drawer heading=${DRAWER_HEADING} .demo=${services.mode === 'demo'} .theme=${services.theme}>
      ${renderNotice(notice)}
      <agr-control-notes
        .notes=${notes}
        focus-key-prefix=${FOCUS_PREFIX}
        @agr-dismiss-note=${this.#onDismissNote}
      ></agr-control-notes>
      ${vm.players.length > 1 ? this.#renderPicker(vm.players, player.key) : nothing}
      <section class="group">
        <h3 class="t-strong">${player.name}</h3>
        <agr-media-player
          ?show-reason=${notice === undefined}
          .player=${player}
          .volumeDraft=${this.#actions.draftState(entityActionKey(player.key))}
          focus-key-prefix=${`${FOCUS_PREFIX}:${player.key}`}
          @agr-media-intent=${this.#onIntent}
        ></agr-media-player>
      </section>
      ${this.#renderSources(player, notice === undefined)}
    </agr-drawer>`;
  }

  #renderShell(): TemplateResult {
    return html`<agr-drawer
      heading=${DRAWER_HEADING}
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme}
    >
      <span class="skeleton" aria-hidden="true"></span>
    </agr-drawer>`;
  }

  /**
   * Which player the drawer shows: view state only, so choosing sends nothing. Like every choice group, the pressed
   * option is disabled as "Current player" and the others are enabled.
   */
  #renderPicker(players: readonly MediaPlayerVM[], selected: EntityId): TemplateResult {
    const options: ChoiceOptionVM[] = players.map((player) => {
      const pressed = player.key === selected;
      return {
        value: player.key,
        label: player.name,
        detail: player.playbackLabel,
        pressed,
        availability: pressed ? currentOptionAvailability('player') : ENABLED,
      };
    });
    return html`<section class="group">
      <h3 class="t-label" aria-hidden="true">Players</h3>
      <agr-choice-group
        orientation="vertical"
        tone="media"
        label="Players"
        focus-key-prefix=${`${FOCUS_PREFIX}:pick`}
        .options=${options}
        @agr-choose=${this.#onPick}
      ></agr-choice-group>
    </section>`;
  }

  /** Sources stay offered while a player is off: many players switch on to the chosen source. */
  #renderSources(player: MediaPlayerVM, showReason: boolean): TemplateResult | typeof nothing {
    const sources = player.sources;
    if (sources === undefined) {
      if (!isFullPlayer(player)) return nothing;
      return html`<section class="group">
        <h3 class="t-label">Source</h3>
        <p class="t-meta">This player doesn't offer sources to choose from.</p>
      </section>`;
    }
    const reason = showReason ? choiceReason(sources) : undefined;
    return html`<section class="group">
      <h3 class="t-label">${sources.label}</h3>
      <agr-choice-group
        orientation="vertical"
        tone="media"
        label=${`${sources.label} for ${player.name}`}
        focus-key-prefix=${`${FOCUS_PREFIX}:${player.key}:source`}
        .options=${sources.options}
        @agr-choose=${(event: CustomEvent<ChooseDetail>) => this.#onSource(player, event)}
      ></agr-choice-group>
      ${reason === undefined ? nothing : html`<p class="t-meta">${reason}</p>`}
    </section>`;
  }
}

defineOnce('agr-media-drawer', AgrMediaDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-media-drawer': AgrMediaDrawer;
  }
}
