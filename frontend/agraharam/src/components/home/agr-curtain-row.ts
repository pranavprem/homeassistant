/**
 * One curtain or blind in the room drawer (§5.3, §7.1): its position in words and explicit Open and Close buttons,
 * never a toggle. A garage, gate or door cover listed in a room is read-only here and says why: it can only move
 * from the Garage panel, behind that panel's confirmation (§4.7 step 5a). Emits 'agr-home-curtain'
 * ({ entity, command }) for the drawer holding the ActionController.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import type { HomeCurtainVM } from '../../model/home.ts';
import { skeletonStyles, staleStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import { emit, rowReason, rowStatusText, type CurtainCommandDetail } from './home-actions.ts';
import { insetStyles, textBlockStyles, wellStyles } from './home-styles.ts';

let rowCount = 0;

class AgrCurtainRow extends LitElement {
  static override styles = [
    typographyStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    insetStyles,
    wellStyles,
    textBlockStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--agr-space-2) var(--agr-space-3);
        padding: var(--agr-space-2) var(--agr-space-2) var(--agr-space-2) var(--agr-space-3);
      }
      .identity {
        display: flex;
        flex: 1 1 160px;
        align-items: center;
        gap: var(--agr-space-3);
        min-inline-size: 0;
        min-block-size: var(--agr-target);
      }
      .buttons {
        display: flex;
        flex: none;
        gap: var(--agr-space-1);
        margin-inline-start: auto;
      }
      .reason {
        flex: 1 1 100%;
        margin: 0;
        padding-inline-start: 48px;
      }
      .skeleton {
        inline-size: 64px;
        margin-block: 3px;
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) curtain!: HomeCurtainVM;
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = 'curtain';

  readonly #nameId = `agr-curtain-name-${(rowCount += 1)}`;
  readonly #reasonId = `agr-curtain-reason-${rowCount}`;

  readonly #onCommand = contained('curtain-command-failed', (command: 'open' | 'close') => {
    emit<CurtainCommandDetail>(this, 'agr-home-curtain', { entity: this.curtain.key, command });
  });

  protected override render(): TemplateResult {
    const curtain = this.curtain;
    // A read-only cover has no buttons to carry the reason, so the row itself is described by it (§7.2).
    return html`<div
      class="row inset"
      role="group"
      aria-labelledby=${this.#nameId}
      aria-describedby=${curtain.readOnly ? this.#reasonId : nothing}
    >
      <div class="identity">
        <span class="well" aria-hidden="true">${renderIcon(curtain.readOnly ? 'garage-door' : 'blinds')}</span>
        <div class="text">
          <span id=${this.#nameId} class="t-strong ellipsis">${curtain.name}</span>
          ${this.#renderState()}
        </div>
      </div>
      ${curtain.readOnly ? nothing : this.#renderButtons()} ${this.#renderReason()}
    </div>`;
  }

  /** Read-only covers always say why; otherwise a control reason the position text does not explain. */
  #renderReason(): TemplateResult | typeof nothing {
    const curtain = this.curtain;
    const reason = curtain.reason ?? rowReason([curtain.open, curtain.close]);
    return reason === undefined ? nothing : html`<p id=${this.#reasonId} class="reason t-meta">${reason}</p>`;
  }

  #renderState(): TemplateResult {
    const curtain = this.curtain;
    if (curtain.status === 'loading') {
      return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;
    }
    const stale = curtain.status === 'disconnected';
    return html`<span class="t-meta ellipsis ${stale ? 'stale' : ''}"
      >${rowStatusText(curtain.pending) ?? curtain.label}${
        stale ? html`<span class="visually-hidden">, last known</span>` : nothing
      }</span
    >`;
  }

  #renderButtons(): TemplateResult {
    const curtain = this.curtain;
    const prefix = `${this.focusKeyPrefix}:${curtain.key}`;
    return html`<div class="buttons">
      <agr-button
        label="Open"
        focus-key=${`${prefix}:open`}
        reason-display="hidden"
        .availability=${curtain.open}
        @agr-activate=${() => this.#onCommand('open')}
      ></agr-button>
      <agr-button
        label="Close"
        focus-key=${`${prefix}:close`}
        reason-display="hidden"
        .availability=${curtain.close}
        @agr-activate=${() => this.#onCommand('close')}
      ></agr-button>
    </div>`;
  }
}

defineOnce('agr-curtain-row', AgrCurtainRow);

declare global {
  interface HTMLElementTagNameMap {
    'agr-curtain-row': AgrCurtainRow;
  }
}
