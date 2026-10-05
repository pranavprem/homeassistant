/**
 * One light in the room drawer (§5.3, §7.2): name and observed state, a toggle that names exactly what it will do
 * ("Turn off Lantern"), and a brightness slider when the light supports it. With an unknown state the toggle becomes
 * two explicit buttons. Emits 'agr-home-light' ({ entity, command }) and 'agr-home-brightness' ({ entity, value })
 * for the drawer holding the ActionController; the slider's draft is rendered from the `draft` it is given.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { DraftState } from '../../ha/actions/action-controller.ts';
import { ABSENT_LABELS } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { HomeLightVM } from '../../model/home.ts';
import { skeletonStyles, staleStyles, toneStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import '../primitives/agr-icon-button.ts';
import '../primitives/agr-slider.ts';
import type { DraftDetail } from '../primitives/control-helpers.ts';
import { emit, rowReason, rowStatusText, type BrightnessDraftDetail, type LightCommandDetail } from './home-actions.ts';
import { insetStyles, textBlockStyles, wellStyles } from './home-styles.ts';

const BRIGHTNESS_MIN = 1;
const BRIGHTNESS_MAX = 100;

let rowCount = 0;

class AgrLightRow extends LitElement {
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
        padding: var(--agr-space-2) var(--agr-space-2) var(--agr-space-3) var(--agr-space-3);
      }
      .row[data-compact] {
        padding-block-end: var(--agr-space-2);
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
      agr-slider {
        padding-inline-end: var(--agr-space-2);
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

  @property({ attribute: false }) light!: HomeLightVM;
  @property({ attribute: false }) draft: DraftState = { phase: 'idle' };
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = 'light';

  readonly #nameId = `agr-light-name-${(rowCount += 1)}`;

  readonly #onCommand = contained('light-command-failed', (command: 'on' | 'off') => {
    emit<LightCommandDetail>(this, 'agr-home-light', { entity: this.light.key, command });
  });

  readonly #onBrightness = contained('light-brightness-failed', (event: CustomEvent<DraftDetail>) => {
    event.stopPropagation();
    emit<BrightnessDraftDetail>(this, 'agr-home-brightness', { entity: this.light.key, value: event.detail.value });
  });

  protected override render(): TemplateResult {
    const light = this.light;
    const brightness = light.brightness;
    return html`<div class="row inset" role="group" aria-labelledby=${this.#nameId} ?data-compact=${!brightness}>
      <div class="top">
        <span class="well" data-tone=${light.on === true ? 'ok' : 'muted'} aria-hidden="true"
          >${renderIcon(light.on === true ? 'lightbulb' : 'lightbulb-off')}</span
        >
        <div class="text">
          <span id=${this.#nameId} class="t-strong ellipsis">${light.name}</span>
          ${this.#renderState()}
        </div>
        ${this.#renderToggle()}
      </div>
      ${
        brightness === undefined
          ? nothing
          : html`<agr-slider
              tone="light"
              label="Brightness"
              focus-key=${`${this.#prefix()}:brightness`}
              .value=${light.brightnessPct}
              .min=${BRIGHTNESS_MIN}
              .max=${BRIGHTNESS_MAX}
              .step=${1}
              .valueText=${(value: number) => `${Math.round(value)} percent`}
              .availability=${brightness.availability}
              .draft=${this.draft}
              @agr-draft=${this.#onBrightness}
            ></agr-slider>`
      }
      ${this.#renderReason()}
    </div>`;
  }

  /** The toggle's reason, when it says something the state line does not (the slider shows its own). */
  #renderReason(): TemplateResult | typeof nothing {
    const light = this.light;
    const reason = rowReason([light.toggle, light.explicit?.on, light.explicit?.off]);
    return reason === undefined ? nothing : html`<p class="reason t-meta">${reason}</p>`;
  }

  #renderState(): TemplateResult {
    const light = this.light;
    if (light.status === 'loading') {
      return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;
    }
    const stale = light.status === 'disconnected';
    return html`<span class="t-meta ellipsis ${stale ? 'stale' : ''}"
      >${rowStatusText(light.pending) ?? stateText(light)}${
        stale ? html`<span class="visually-hidden">, last known</span>` : nothing
      }</span
    >`;
  }

  #renderToggle(): TemplateResult {
    const light = this.light;
    const prefix = this.#prefix();
    if (light.explicit !== undefined) {
      return html`<div class="explicit">
        <agr-button
          label="On"
          focus-key=${`${prefix}:on`}
          reason-display="hidden"
          .availability=${light.explicit.on}
          @agr-activate=${() => this.#onCommand('on')}
        ></agr-button>
        <agr-button
          label="Off"
          focus-key=${`${prefix}:off`}
          reason-display="hidden"
          .availability=${light.explicit.off}
          @agr-activate=${() => this.#onCommand('off')}
        ></agr-button>
      </div>`;
    }
    const next = light.on === true ? 'off' : 'on';
    return html`<agr-icon-button
      icon=${light.on === true ? 'lightbulb' : 'lightbulb-off'}
      label=${`Turn ${next} ${light.name}`}
      powered=${light.on === true && light.status === 'available' ? 'light' : nothing}
      focus-key=${`${prefix}:toggle`}
      reason-display="hidden"
      .availability=${light.toggle}
      @agr-activate=${() => this.#onCommand(next)}
    ></agr-icon-button>`;
  }

  #prefix(): string {
    return `${this.focusKeyPrefix}:${this.light.key}`;
  }
}

/** "On, 71%", "Off", or the honest absent label ("Unavailable", "Not found", "Offline"). */
function stateText(light: HomeLightVM): string {
  if (light.status === 'unknown') return 'State unknown';
  if (light.on === true) return light.brightnessPct === null ? 'On' : `On, ${light.brightnessPct}%`;
  if (light.on === false) return 'Off';
  return light.status === 'available' ? 'State unknown' : ABSENT_LABELS[light.status];
}

defineOnce('agr-light-row', AgrLightRow);

declare global {
  interface HTMLElementTagNameMap {
    'agr-light-row': AgrLightRow;
  }
}
