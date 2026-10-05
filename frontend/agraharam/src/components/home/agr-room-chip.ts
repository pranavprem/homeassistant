/**
 * A room chip (§5.1): two SIBLING native buttons, never nested. The first opens the room drawer (it dispatches
 * 'agr-open-drawer' itself, so the inner button is the focus-restore trigger); the second is the explicit quick
 * toggle, whose name says exactly what it will do ("Turn off Courtyard lights") and which emits
 * 'agr-home-room-quick' ({ room, next }) for the element holding the ActionController.
 *
 * The quick toggle follows the agr-button rules (§7.2): aria-disabled plus a click guard, its reason and status
 * as static text inside this shadow root behind aria-describedby, held-key repeats suppressed, and the brass
 * pending sweep while a ticket is open.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { isTicketInFlight } from '../../ha/actions/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { HomeRoomVM } from '../../model/home.ts';
import {
  disabledControlDeclarations,
  focusRingStyles,
  hyphenationDeclarations,
  pendingSweepStyles,
  skeletonStyles,
  staleStyles,
  toneStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { emit, rowStatusText, type RoomQuickDetail } from './home-actions.ts';
import { textBlockStyles } from './home-styles.ts';

/** Room names and summaries may wrap to two lines in a narrow chip before they truncate. */
const TEXT_MAX_LINES = 2;

class AgrRoomChip extends LitElement {
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    typographyStyles,
    toneStyles,
    skeletonStyles,
    textBlockStyles,
    pendingSweepStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
        block-size: 100%;
      }
      .chip {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: var(--agr-space-1);
        block-size: 100%;
        min-block-size: 48px;
        padding: 2px;
        border-radius: var(--agr-radius-inner);
        background: var(--agr-surface-inset);
        transition: background var(--agr-dur-2) var(--agr-ease);
      }
      .chip[data-lit] {
        background: var(--agr-brass-tint);
        box-shadow: inset 0 0 0 1px var(--agr-lit-ring);
      }
      .open {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        justify-content: center;
        align-self: stretch;
        min-inline-size: 0;
        min-block-size: var(--agr-target);
        margin: 0;
        padding: 2px var(--agr-space-1) 2px var(--agr-space-2);
        border: none;
        border-radius: 11px;
        font: inherit;
        text-align: start;
        color: var(--agr-ink);
        background: transparent;
        cursor: pointer;
      }
      /* Names and summaries break between words; only a single word wider than the chip is broken, hyphenated
         where the language allows (long words only), never split at any letter. */
      .name {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: ${TEXT_MAX_LINES};
        overflow-wrap: break-word;
        ${hyphenationDeclarations}
      }
      /* A summary such as "1 on, 1 unavailable" may take a second line in a narrow chip rather than lose words. */
      .summary {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: ${TEXT_MAX_LINES};
        overflow-wrap: break-word;
        ${hyphenationDeclarations}
        white-space: normal;
      }
      .summary .skeleton {
        inline-size: 64px;
        margin-block: 3px;
      }
      /* The hit area stays 44 px (§5.4 rule 10); the visible disc is 36 px, so it never crowds the chip's edges. */
      /* The sweep sits under the 36 px disc inside the 44 px target. */
      .quick {
        --agr-sweep-inset: var(--agr-space-3);
        --agr-sweep-offset: 7px;
        position: relative;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        inline-size: var(--agr-target);
        block-size: var(--agr-target);
        padding: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
      }
      .disc {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 36px;
        block-size: 36px;
        border-radius: 50%;
        color: var(--agr-muted);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-raised);
        transition:
          color var(--agr-dur-1) var(--agr-ease),
          background var(--agr-dur-1) var(--agr-ease),
          box-shadow var(--agr-dur-1) var(--agr-ease);
      }
      /* On: the toggle itself shows the state (a lit bulb on a brass disc), not only the chip tint. */
      .quick[data-lit] .disc {
        color: var(--agr-brass-ink);
        background: var(--agr-brass-tint);
        box-shadow: inset 0 0 0 1px var(--agr-brass);
      }
      .quick:active:not([aria-disabled='true']) .disc {
        box-shadow: var(--agr-shadow-pressed);
      }
      .quick[aria-disabled='true'] {
        cursor: not-allowed;
      }
      .quick[aria-disabled='true'] .disc {
        ${disabledControlDeclarations}
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) room!: HomeRoomVM;
  /** Prefix for the buttons' data-focus-key ("room" in the panel, "home-drawer:room" in the drawer). */
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = 'room';

  readonly #onOpen = contained('room-chip-open-failed', (event: MouseEvent) => {
    requestDrawer(this, { id: 'room', room: this.room.index }, event.currentTarget as HTMLElement);
  });

  readonly #onQuick = contained('room-chip-quick-failed', (event: MouseEvent) => {
    const quick = this.room.quickToggle;
    if (quick === undefined || !this.#canToggle()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    emit<RoomQuickDetail>(this, 'agr-home-room-quick', { room: this.room.index, next: quick.next });
  });

  protected override render(): TemplateResult {
    const room = this.room;
    // Stale or loading rooms never glow: a last known "on" is not a lit room.
    const lit = room.lightsOn > 0 && room.freshness === 'live';
    const prefix = `${this.focusKeyPrefix}:${room.index}`;
    return html`<div class="chip" ?data-lit=${lit}>
      <button
        class="open"
        type="button"
        aria-haspopup="dialog"
        data-focus-key="${prefix}:open"
        @click=${this.#onOpen}
        @keydown=${suppressKeyRepeat}
      >
        <span class="name t-strong">${room.name}</span>
        ${this.#renderSummary()}
      </button>
      ${this.#renderQuick(prefix, lit)}
    </div>`;
  }

  #renderSummary(): TemplateResult {
    const room = this.room;
    if (room.freshness === 'loading') {
      return html`<span class="summary"
        ><span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span></span
      >`;
    }
    const pendingText = isTicketInFlight(room.pending) ? rowStatusText(room.pending) : undefined;
    return html`<span
      class="summary t-meta ellipsis ${room.freshness === 'stale' ? 'stale' : ''}"
      data-tone=${room.tone}
      >${pendingText ?? room.summary}${
        room.freshness === 'stale' ? html`<span class="visually-hidden">, last known</span>` : nothing
      }</span
    >`;
  }

  #renderQuick(prefix: string, lit: boolean): TemplateResult | typeof nothing {
    const quick = this.room.quickToggle;
    if (quick === undefined) return nothing;
    const label = `Turn ${quick.next} ${this.room.name} lights`;
    const reason = quick.availability.enabled ? undefined : quick.availability.message;
    const statusText = rowStatusText(this.room.pending);
    const describedBy = [reason ? 'quick-reason' : '', statusText ? 'quick-status' : ''].filter(Boolean).join(' ');
    return html`<button
        class="quick sweep"
        type="button"
        data-focus-key="${prefix}:toggle"
        data-phase=${this.room.pending?.phase ?? nothing}
        ?data-lit=${lit}
        aria-disabled=${this.#canToggle() ? nothing : 'true'}
        aria-describedby=${describedBy || nothing}
        @click=${this.#onQuick}
        @keydown=${suppressKeyRepeat}
      >
        <span class="disc" aria-hidden="true"
          >${renderIcon(this.room.lightsOn > 0 ? 'lightbulb' : 'lightbulb-off')}</span
        ><span class="visually-hidden">${label}</span>
      </button>
      ${reason ? html`<span id="quick-reason" class="visually-hidden">${reason}</span>` : nothing}
      ${statusText ? html`<span id="quick-status" class="visually-hidden">${statusText}</span>` : nothing}`;
  }

  #canToggle(): boolean {
    const quick = this.room.quickToggle;
    return quick?.availability.enabled === true && !isTicketInFlight(this.room.pending);
  }
}

defineOnce('agr-room-chip', AgrRoomChip);

declare global {
  interface HTMLElementTagNameMap {
    'agr-room-chip': AgrRoomChip;
  }
}
