/**
 * One player's now-playing block (§6.3), shared by the Media panel and the media drawer: an icon tile (never
 * artwork), title and subtitle, transport buttons for exactly the supported features with the primary play/pause in
 * plum, and a volume row with mute. Switched-off and absent players collapse to one compact row.
 *
 * A leaf: it renders the VM it is given, owns no timers and never calls the gateway. Every gesture leaves as one
 * 'agr-media-intent' event ({ bubbles: true, composed: false }) for the section or drawer that rendered it, which
 * applies it with applyMediaIntent().
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import type { ActionController, DraftState } from '../../ha/actions/action-controller.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS, type Availability } from '../../ha/actions/types.ts';
import type { StoreView } from '../../ha/entity-store.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { entityActionKey } from '../../model/controls.ts';
import { OFF_PLAYBACK, volumeLevel } from '../../model/media.ts';
import type { IconName, MediaPlayerVM } from '../../model/types.ts';
import { numStyles, skeletonStyles, staleStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-icon-button.ts';
import '../primitives/agr-slider.ts';
import { draftBase, type DraftDetail } from '../primitives/control-helpers.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';

export type MediaIntent =
  | { readonly kind: 'play' | 'pause' | 'next' | 'previous'; readonly entity: EntityId }
  | { readonly kind: 'mute'; readonly entity: EntityId; readonly muted: boolean }
  | { readonly kind: 'volume'; readonly entity: EntityId; readonly percent: number };

const MEDIA_INTENT_EVENT = 'agr-media-intent';

const PERCENT = 100;
const ART_ICON_SIZE = 22;
const TV_HINT = /\btv\b/i;

/** Copy for the compact row, keyed by playback or normalized status. */
const COMPACT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  off: 'Nothing is playing.',
  standby: 'Nothing is playing.',
  unavailable: "The player isn't reachable right now.",
  unknown: "The player hasn't reported its state.",
  'missing-binding': "The player wasn't found in Home Assistant.",
  disconnected: 'Waiting for Home Assistant.',
});

/** Turns one intent into exactly one request, or one debounced volume draft (§7.2). */
export function applyMediaIntent(
  actions: ActionController,
  intent: MediaIntent,
  observedPercent: () => number | null,
): void {
  const entity = intent.entity;
  switch (intent.kind) {
    case 'play':
      actions.request({ kind: 'media.play', entity });
      return;
    case 'pause':
      actions.request({ kind: 'media.pause', entity });
      return;
    case 'next':
      actions.request({ kind: 'media.next', entity });
      return;
    case 'previous':
      actions.request({ kind: 'media.previous', entity });
      return;
    case 'mute':
      actions.request({ kind: 'media.volume_mute', entity, muted: intent.muted });
      return;
    case 'volume':
      actions.draft(
        entityActionKey(entity),
        intent.percent,
        (percent) => ({ kind: 'media.volume_set', entity, level: percent / PERCENT }),
        SLIDER_COMMIT_DEBOUNCE_MS,
        observedPercent,
      );
      return;
  }
}

/** The observed volume of `entity` in whole percent, read fresh from the store when a held draft decides. */
export function observedVolumePercent(store: StoreView | undefined, entity: EntityId): number | null {
  const state = store?.get(entity);
  const level = state === undefined ? null : volumeLevel(state);
  return level === null ? null : Math.round(level * PERCENT);
}

/** The observed volume in whole percent, the unit the slider and its drafts use. */
function volumePercent(player: MediaPlayerVM): number | null {
  const level = player.volume?.level;
  return level === undefined || level === null ? null : Math.round(level * PERCENT);
}

/** Whether the player shows the full block (transport and volume) rather than the compact row. */
export function isFullPlayer(player: MediaPlayerVM): boolean {
  // A disconnected player keeps its last known playback (shown stale); without one its playback is the status.
  const readable =
    player.status === 'available' || (player.status === 'disconnected' && player.playback !== 'disconnected');
  return readable && !OFF_PLAYBACK.has(player.playback);
}

interface PrimaryControl {
  readonly kind: 'play' | 'pause';
  readonly icon: IconName;
  readonly label: string;
  readonly availability: Availability;
}

/** The plum center button: Pause while playing or buffering, Play otherwise, each only with its feature bit. */
function primaryControl(player: MediaPlayerVM): PrimaryControl | undefined {
  const playing = player.playback === 'playing' || player.playback === 'buffering';
  if (playing) return player.pause && { kind: 'pause', icon: 'pause', label: 'Pause', availability: player.pause };
  return player.play && { kind: 'play', icon: 'play', label: 'Play', availability: player.play };
}

/** Every rendered control's Availability, in display order (for a section's shared notice). */
export function playerControls(player: MediaPlayerVM): readonly Availability[] {
  if (!isFullPlayer(player)) return [];
  const controls = [
    player.previous,
    primaryControl(player)?.availability,
    player.next,
    player.mute?.availability,
    player.volume?.availability,
  ];
  return controls.filter(isDefined);
}

function artIcon(player: MediaPlayerVM): IconName {
  if (TV_HINT.test(`${player.app ?? ''} ${player.source ?? ''}`)) return 'tv';
  return player.title === undefined ? 'speaker' : 'music';
}

export class AgrMediaPlayer extends LitElement {
  static override styles = [
    numStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
        container: player / inline-size;
      }
      .player {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-1);
      }
      .now {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
        min-block-size: var(--agr-target);
      }
      .art {
        flex: none;
        display: grid;
        place-items: center;
        inline-size: var(--agr-target);
        block-size: var(--agr-target);
        border-radius: 12px;
        color: var(--agr-plum);
        background: var(--agr-plum-tint);
      }
      .art[data-muted] {
        color: var(--agr-muted);
        background: var(--agr-surface-inset);
      }
      .text {
        flex: 1 1 auto;
        min-inline-size: 0;
      }
      .title,
      .sub {
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title {
        font: var(--agr-type-strong);
        color: var(--agr-ink);
      }
      .sub {
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .transport {
        flex: none;
        display: flex;
        align-items: center;
        gap: var(--agr-space-1);
      }
      .volume {
        display: flex;
        align-items: center;
        gap: var(--agr-space-2);
      }
      .volume-icon {
        flex: none;
        display: grid;
        place-items: center;
        inline-size: var(--agr-target);
        color: var(--agr-muted);
      }
      .slider {
        flex: 1 1 auto;
      }
      .level {
        flex: none;
        min-inline-size: 3ch;
        text-align: end;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .reason {
        margin: var(--agr-space-1) 0 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .skeleton {
        flex: 1 1 auto;
      }
      /* A narrow player gives the title the icon tile's room. */
      @container player (width < ${PANEL_CQ.mediaPlayerArt}px) {
        .art {
          display: none;
        }
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) player!: MediaPlayerVM;
  /** The volume draft of this player's action key. */
  @property({ attribute: false }) volumeDraft: DraftState = { phase: 'idle' };
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = '';
  /** The drawer shows a visible reason line; the panel relies on its section-level notice instead. */
  @property({ type: Boolean, attribute: 'show-reason' }) showReason = false;

  readonly #emit = contained('media-intent-failed', (intent: MediaIntent) => {
    this.dispatchEvent(
      new CustomEvent<MediaIntent>(MEDIA_INTENT_EVENT, { bubbles: true, composed: false, detail: intent }),
    );
  });

  readonly #onVolume = (event: CustomEvent<DraftDetail>): void => {
    event.stopPropagation();
    this.#emit({ kind: 'volume', entity: this.player.key, percent: event.detail.value });
  };

  protected override render(): TemplateResult | typeof nothing {
    const player = this.player;
    if (player === undefined) return nothing;
    if (player.status === 'loading') {
      return html`<div class="now">
        <span class="art" data-muted></span><span class="skeleton" aria-hidden="true"></span>
      </div>`;
    }
    return isFullPlayer(player) ? this.#renderFull(player) : this.#renderCompact(player);
  }

  #renderCompact(player: MediaPlayerVM): TemplateResult {
    const message = COMPACT_MESSAGES[player.playback] ?? COMPACT_MESSAGES[player.status] ?? '';
    return html`<div class="player">
      <div class="now">
        <span class="art" data-muted aria-hidden="true">${renderIcon('tv', ART_ICON_SIZE)}</span>
        <div class="text">
          <p class="title">${player.playbackLabel}</p>
          ${message === '' ? nothing : html`<p class="sub">${message}</p>`}
        </div>
      </div>
    </div>`;
  }

  #renderFull(player: MediaPlayerVM): TemplateResult {
    const stale = player.status === 'disconnected';
    const title = player.title ?? player.app ?? player.source ?? 'Nothing playing';
    const subtitle =
      player.title === undefined ? player.playbackLabel : (player.subtitle ?? player.app ?? player.playbackLabel);
    return html`<div class="player">
      <div class="now">
        <span class="art" ?data-muted=${stale} aria-hidden="true">${renderIcon(artIcon(player), ART_ICON_SIZE)}</span>
        <div class="text ${stale ? 'stale' : ''}">
          <p class="title">${title}</p>
          <p class="sub">${subtitle}${stale ? html`<span class="visually-hidden">, last known</span>` : nothing}</p>
        </div>
        ${this.#renderTransport(player)}
      </div>
      ${this.#renderVolume(player)} ${this.showReason ? this.#renderReason(player) : nothing}
    </div>`;
  }

  #renderTransport(player: MediaPlayerVM): TemplateResult | typeof nothing {
    const primary = primaryControl(player);
    if (player.previous === undefined && primary === undefined && player.next === undefined) return nothing;
    const prefix = this.focusKeyPrefix;
    return html`<div class="transport" role="group" aria-label=${`Playback on ${player.name}`}>
      ${
        player.previous === undefined
          ? nothing
          : this.#transportButton('previous', 'skip-back', 'Previous track', player.previous, `${prefix}:previous`)
      }
      ${
        primary === undefined
          ? nothing
          : html`<agr-icon-button
              variant="primary"
              icon=${primary.icon}
              label=${primary.label}
              reason-display="hidden"
              focus-key=${`${prefix}:play-pause`}
              .availability=${primary.availability}
              @agr-activate=${() => this.#emit({ kind: primary.kind, entity: player.key })}
            ></agr-icon-button>`
      }
      ${
        player.next === undefined
          ? nothing
          : this.#transportButton('next', 'skip-forward', 'Next track', player.next, `${prefix}:next`)
      }
    </div>`;
  }

  #transportButton(
    kind: 'previous' | 'next',
    icon: IconName,
    label: string,
    availability: Availability,
    focusKey: string,
  ): TemplateResult {
    return html`<agr-icon-button
      icon=${icon}
      label=${label}
      reason-display="hidden"
      focus-key=${focusKey}
      .availability=${availability}
      @agr-activate=${() => this.#emit({ kind, entity: this.player.key })}
    ></agr-icon-button>`;
  }

  #renderVolume(player: MediaPlayerVM): TemplateResult | typeof nothing {
    const { volume, mute } = player;
    if (volume === undefined && mute === undefined) return nothing;
    const observed = volumePercent(player);
    const shown = draftBase(this.volumeDraft, observed);
    const muted = mute?.muted === true;
    return html`<div class="volume">
      ${
        mute === undefined
          ? html`<span class="volume-icon" aria-hidden="true">${renderIcon('volume-1')}</span>`
          : html`<agr-icon-button
              icon=${muted ? 'volume-x' : 'volume-2'}
              label=${muted ? `Unmute ${player.name}` : `Mute ${player.name}`}
              reason-display="hidden"
              focus-key=${`${this.focusKeyPrefix}:mute`}
              .availability=${mute.availability}
              @agr-activate=${() => this.#emit({ kind: 'mute', entity: player.key, muted: !muted })}
            ></agr-icon-button>`
      }
      ${
        volume === undefined
          ? nothing
          : html`<agr-slider
                class="slider"
                tone="media"
                label=${`Volume for ${player.name}`}
                label-display="hidden"
                status-display="hidden"
                reason-display="hidden"
                focus-key=${`${this.focusKeyPrefix}:volume`}
                .value=${observed}
                .min=${0}
                .max=${PERCENT}
                .step=${1}
                .valueText=${(value: number) => `Volume ${Math.round(value)} percent`}
                .availability=${volume.availability}
                .draft=${this.volumeDraft}
                @agr-draft=${this.#onVolume}
              ></agr-slider
              ><span class="level num" aria-hidden="true">${shown === null ? ABSENT_GLYPH : shown}</span>`
      }
    </div>`;
  }

  /** One visible reason when the controls cannot act: the reason they all share, or the primary button's own. */
  #renderReason(player: MediaPlayerVM): TemplateResult | typeof nothing {
    const controls = playerControls(player);
    const first = controls[0];
    const shared =
      first !== undefined && !first.enabled && controls.every((item) => !item.enabled && item.message === first.message)
        ? first.message
        : undefined;
    const primary = primaryControl(player)?.availability;
    const reason = shared ?? (primary !== undefined && !primary.enabled ? primary.message : undefined);
    return reason === undefined ? nothing : html`<p class="reason">${reason}</p>`;
  }
}

defineOnce('agr-media-player', AgrMediaPlayer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-media-player': AgrMediaPlayer;
  }
  interface HTMLElementEventMap {
    'agr-media-intent': CustomEvent<MediaIntent>;
  }
}
