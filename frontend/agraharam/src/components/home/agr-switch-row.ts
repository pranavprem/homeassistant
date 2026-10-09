/**
 * One lighting switch in the room drawer (§18): a lamp on a smart plug, so it reads like a light without brightness.
 * The name and observed state, and a toggle that names exactly what it will do ("Turn off Desk lamp"); with an unknown
 * state the toggle becomes two explicit buttons. A settings switch, or any switch while Home Assistant's device list
 * has not arrived, keeps its toggle disabled with the reason as a visible line. Emits 'agr-home-switch'
 * ({ entity, command }) for the drawer holding the ActionController.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ABSENT_LABELS } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { HomeSwitchVM } from '../../model/home.ts';
import { skeletonStyles, staleStyles, toneStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import '../primitives/agr-icon-button.ts';
import { emit, rowReason, rowStatusText, type SwitchCommandDetail } from './home-actions.ts';
import { insetStyles, textBlockStyles, wellStyles } from './home-styles.ts';

let rowCount = 0;

class AgrSwitchRow extends LitElement {
  static override styles = [
    typographyStyles,
    toneStyles,
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
        flex-direction: column;
        gap: var(--agr-space-2);
        padding: var(--agr-space-2) var(--agr-space-2) var(--agr-space-2) var(--agr-space-3);
      }
      .top {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
        min-block-size: var(--agr-target);
      }
      .explicit {
        display: flex;
        flex: none;
        gap: var(--agr-space-1);
      }
      .reason {
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

  @property({ attribute: false }) item!: HomeSwitchVM;
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = 'switch';

  readonly #nameId = `agr-switch-name-${(rowCount += 1)}`;

  readonly #onCommand = contained('switch-command-failed', (command: 'on' | 'off') => {
    emit<SwitchCommandDetail>(this, 'agr-home-switch', { entity: this.item.key, command });
  });

  protected override render(): TemplateResult {
    const item = this.item;
    return html`<div class="row inset" role="group" aria-labelledby=${this.#nameId}>
      <div class="top">
        <span class="well" data-tone=${item.on === true ? 'ok' : 'muted'} aria-hidden="true"
          >${renderIcon(item.on === true ? 'lightbulb' : 'lightbulb-off')}</span
        >
        <div class="text">
          <span id=${this.#nameId} class="t-strong ellipsis">${item.name}</span>
          ${this.#renderState()}
        </div>
        ${this.#renderToggle()}
      </div>
      ${this.#renderReason()}
    </div>`;
  }

  /** Why the toggle is disabled, when the state line does not already say it (settings switch, device list). */
  #renderReason(): TemplateResult | typeof nothing {
    const item = this.item;
    const reason = rowReason([item.toggle, item.explicit?.on, item.explicit?.off]);
    return reason === undefined ? nothing : html`<p class="reason t-meta">${reason}</p>`;
  }

  #renderState(): TemplateResult {
    const item = this.item;
    if (item.status === 'loading') {
      return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;
    }
    const stale = item.status === 'disconnected';
    return html`<span class="t-meta ellipsis ${stale ? 'stale' : ''}"
      >${rowStatusText(item.pending) ?? stateText(item)}${
        stale ? html`<span class="visually-hidden">, last known</span>` : nothing
      }</span
    >`;
  }

  #renderToggle(): TemplateResult {
    const item = this.item;
    const prefix = `${this.focusKeyPrefix}:${item.key}`;
    if (item.explicit !== undefined) {
      return html`<div class="explicit">
        <agr-button
          label="On"
          focus-key=${`${prefix}:on`}
          reason-display="hidden"
          .availability=${item.explicit.on}
          @agr-activate=${() => this.#onCommand('on')}
        ></agr-button>
        <agr-button
          label="Off"
          focus-key=${`${prefix}:off`}
          reason-display="hidden"
          .availability=${item.explicit.off}
          @agr-activate=${() => this.#onCommand('off')}
        ></agr-button>
      </div>`;
    }
    const next = item.on === true ? 'off' : 'on';
    return html`<agr-icon-button
      icon=${item.on === true ? 'lightbulb' : 'lightbulb-off'}
      label=${`Turn ${next} ${item.name}`}
      powered=${item.on === true && item.status === 'available' && !item.readOnly ? 'light' : nothing}
      focus-key=${`${prefix}:toggle`}
      reason-display="hidden"
      .availability=${item.toggle}
      @agr-activate=${() => this.#onCommand(next)}
    ></agr-icon-button>`;
  }
}

/** "On", "Off", or the honest absent label ("Unavailable", "Not found", "Offline"). */
function stateText(item: HomeSwitchVM): string {
  if (item.status === 'unknown') return 'State unknown';
  if (item.on === true) return 'On';
  if (item.on === false) return 'Off';
  return item.status === 'available' ? 'State unknown' : ABSENT_LABELS[item.status];
}

defineOnce('agr-switch-row', AgrSwitchRow);

declare global {
  interface HTMLElementTagNameMap {
    'agr-switch-row': AgrSwitchRow;
  }
}
