/**
 * Choice control (§5.5, §7.2): role="group" aria-label=label, with one native <button aria-pressed> per option, each
 * in the tab order. Activation is the only trigger: one click, Enter or Space on an ENABLED option emits one
 * 'agr-choose' ({ bubbles: true, composed: false }). The group handles no navigation keys (arrows, Home, End,
 * PageUp and PageDown do nothing) and its only key handler suppresses key repeat, so browsing options with a
 * keyboard or screen reader can never send an action. Never radios, selects or listboxes.
 *
 * `tone="media"` marks the current option the way the media drawer marks its chosen player (plum tint, plum ring and
 * a check), so one drawer never shows two selection styles; every other group uses the olive fill.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { ChoiceOptionVM } from '../../model/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { focusRingStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { suppressKeyRepeat } from './control-helpers.ts';

export interface ChooseDetail {
  readonly value: string;
}

type ChoiceTone = 'device' | 'media';
const CHECK_ICON_SIZE = 16;

export class AgrChoiceGroup extends LitElement {
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .group {
        display: flex;
        flex-wrap: wrap;
        gap: var(--agr-space-2);
      }
      :host([orientation='vertical']) .group {
        flex-direction: column;
        flex-wrap: nowrap;
      }
      button {
        box-sizing: border-box;
        min-inline-size: var(--agr-target);
        min-block-size: var(--agr-target);
        padding: 0 var(--agr-space-4);
        border: none;
        border-radius: var(--agr-radius-control);
        font: var(--agr-type-control);
        text-align: start;
        color: var(--agr-ink);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-raised);
        cursor: pointer;
      }
      button[aria-pressed='true'] {
        color: var(--agr-surface);
        background: var(--agr-olive-ink);
        box-shadow: var(--agr-shadow-pressed);
      }
      :host([tone='media']) button {
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-2);
      }
      :host([tone='media']) button[aria-pressed='true'] {
        color: var(--agr-ink);
        background: var(--agr-plum-tint);
        box-shadow: inset 0 0 0 1.5px var(--agr-plum);
      }
      .check {
        display: inline-flex;
        flex: none;
        color: var(--agr-plum);
      }
      .text {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      button[data-detail] {
        padding-block: var(--agr-space-1);
        border-radius: var(--agr-radius-inner);
      }
      .detail {
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      button[aria-disabled='true'] {
        cursor: not-allowed;
      }
      button[aria-disabled='true'][aria-pressed='false'] {
        color: var(--agr-muted);
        background: var(--agr-surface-inset);
        box-shadow: none;
      }
    `,
  ];

  @property() label = '';
  /** Prefix of each option's stable data-focus-key (§5.1). */
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = '';
  @property({ attribute: false }) options: readonly ChoiceOptionVM[] = [];
  /** Vertical for long lists (media sources), which scroll inside the drawer. */
  @property({ reflect: true }) orientation: 'horizontal' | 'vertical' = 'horizontal';
  @property({ reflect: true }) tone: ChoiceTone = 'device';

  readonly #choose = contained('choice-click-failed', (event: MouseEvent, option: ChoiceOptionVM) => {
    if (!option.availability.enabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const detail: ChooseDetail = { value: option.value };
    this.dispatchEvent(new CustomEvent('agr-choose', { bubbles: true, composed: false, detail }));
  });

  protected override render(): TemplateResult {
    return html`<div class="group" role="group" aria-label=${this.label}>
      ${this.options.map((option, index) => this.#renderOption(option, index))}
    </div>`;
  }

  #renderOption(option: ChoiceOptionVM, index: number): TemplateResult {
    const reasonId = `reason-${index}`;
    const reason = option.availability.enabled ? undefined : option.availability.message;
    return html`<button
        type="button"
        aria-pressed=${option.pressed ? 'true' : 'false'}
        aria-disabled=${reason === undefined ? nothing : 'true'}
        aria-describedby=${reason === undefined ? nothing : reasonId}
        data-focus-key=${`${this.focusKeyPrefix}:${option.value}`}
        ?data-detail=${option.detail !== undefined}
        @click=${(event: MouseEvent) => this.#choose(event, option)}
        @keydown=${suppressKeyRepeat}
      >
        ${
          this.tone === 'media' && option.pressed
            ? html`<span class="check" aria-hidden="true">${renderIcon('check', CHECK_ICON_SIZE)}</span>`
            : nothing
        }${
          option.detail === undefined
            ? option.label
            : html`<span class="text"><span>${option.label}</span><span class="detail">${option.detail}</span></span>`
        }</button
      >${reason === undefined ? nothing : html`<span id=${reasonId} class="visually-hidden">${reason}</span>`}`;
  }
}

defineOnce('agr-choice-group', AgrChoiceGroup);

declare global {
  interface HTMLElementTagNameMap {
    'agr-choice-group': AgrChoiceGroup;
  }
  interface HTMLElementEventMap {
    'agr-choose': CustomEvent<ChooseDetail>;
  }
}
