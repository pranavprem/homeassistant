/**
 * Stepper (§5.5, §7.2). Two buttons. Each tap emits 'agr-draft' ({ value }, { bubbles: true, composed: false }) with
 * value = stepValue(base, ±1, { min, max, step }), where base is the draft value while drafting or held and the
 * observed value otherwise. It renders the DraftState it is given (including "Not sent" with the observed value),
 * owns no timers and uses aria-disabled rather than native `disabled` (§16.10), so both buttons stay reachable.
 * `reason-display="hidden"` keeps the reason for aria-describedby but hides it, for a drawer that states a shared
 * reason once in its own notice.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { DraftState } from '../../ha/actions/action-controller.ts';
import type { Availability } from '../../ha/actions/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { stepValue } from '../../domain/steps.ts';
import { disabledControlDeclarations, focusRingStyles, numStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import {
  degreeScale,
  draftBase,
  draftStatusText,
  stepperSpokenText,
  stepperValueText,
  suppressKeyRepeat,
  textClass,
  type DraftDetail,
  type ReasonDisplay,
} from './control-helpers.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';

const BOUND_REASONS = Object.freeze({
  down: 'Already at the lowest setting.',
  up: 'Already at the highest setting.',
});

type Direction = 'down' | 'up';

export class AgrStepper extends LitElement {
  static override styles = [
    focusRingStyles,
    numStyles,
    visuallyHiddenStyles,
    typographyStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-1);
        min-inline-size: 0;
      }
      .stepper {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
      }
      .value {
        min-inline-size: 3ch;
        text-align: center;
      }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: var(--agr-target);
        block-size: var(--agr-target);
        padding: 0;
        border: none;
        border-radius: var(--agr-radius-control);
        color: var(--agr-ink);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-raised);
        cursor: pointer;
      }
      button[aria-disabled='true'] {
        ${disabledControlDeclarations}
      }
      .status[data-phase='not-sent'] {
        color: var(--agr-brass-ink);
      }
    `,
  ];

  @property() label = '';
  @property({ attribute: 'focus-key' }) focusKey = '';
  /** Observed value; null (unknown target) disables the stepper with 'state-unknown'. */
  @property({ attribute: false }) value: number | null = null;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Number }) step = 1;
  @property() unit = '';
  @property({ attribute: false }) availability!: Availability;
  @property({ attribute: false }) draft: DraftState = { phase: 'idle' };
  @property({ attribute: 'reason-display' }) reasonDisplay: ReasonDisplay = 'visible';

  readonly #tap = contained('stepper-tap-failed', (event: MouseEvent, direction: Direction) => {
    const next = this.#nextValue(direction);
    if (next === undefined) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const detail: DraftDetail = { value: next };
    this.dispatchEvent(new CustomEvent('agr-draft', { bubbles: true, composed: false, detail }));
  });

  protected override render(): TemplateResult {
    const reason =
      this.availability !== undefined && !this.availability.enabled ? this.availability.message : undefined;
    const shown = this.draft.phase === 'not-sent' ? this.value : draftBase(this.draft, this.value);
    const statusText = draftStatusText(this.draft, (v) => this.#format(v));
    return html`<div class="stepper" role="group" aria-labelledby="label">
        <span id="label" class="t-meta">${this.label}</span>
        ${this.#renderButton('down', reason, statusText)}
        <span class="value t-value num">${shown === null ? ABSENT_GLYPH : this.#renderValue(shown)}</span>
        ${this.#renderButton('up', reason, statusText)}
      </div>
      ${statusText ? html`<span id="status" class="status t-meta" data-phase=${this.draft.phase}>${statusText}</span>` : nothing}
      ${reason ? html`<span id="reason" class=${textClass(this.reasonDisplay)}>${reason}</span>` : nothing}`;
  }

  #renderButton(direction: Direction, reason: string | undefined, statusText: string | undefined): TemplateResult {
    const disabled = this.#nextValue(direction) === undefined;
    const atBound = disabled && reason === undefined && this.#base() !== null;
    const boundId = `${direction}-bound`;
    const describedBy = [reason ? 'reason' : '', atBound ? boundId : '', statusText ? 'status' : '']
      .filter(Boolean)
      .join(' ');
    return html`<button
        type="button"
        data-focus-key=${`${this.focusKey}:${direction}`}
        aria-disabled=${disabled ? 'true' : nothing}
        aria-describedby=${describedBy || nothing}
        @click=${(event: MouseEvent) => this.#tap(event, direction)}
        @keydown=${suppressKeyRepeat}
      >
        ${renderIcon(direction === 'down' ? 'minus' : 'plus')}
        <span class="visually-hidden">${direction === 'down' ? 'Decrease' : 'Increase'} ${this.label}</span>
      </button>
      ${atBound ? html`<span id=${boundId} class="visually-hidden">${BOUND_REASONS[direction]}</span>` : nothing}`;
  }

  #base(): number | null {
    return draftBase(this.draft, this.value);
  }

  /** The value one tap would draft, or undefined when the tap must do nothing (disabled, unknown or at a bound). */
  #nextValue(direction: Direction): number | undefined {
    const base = this.#base();
    if (this.availability?.enabled !== true || base === null) return undefined;
    try {
      const next = stepValue(base, direction === 'up' ? 1 : -1, { min: this.min, max: this.max, step: this.step });
      return next === base ? undefined : next;
    } catch {
      log.error('stepper-grid-invalid');
      return undefined;
    }
  }

  #format(value: number): string {
    return stepperSpokenText(value, this.unit);
  }

  /** The visible value, "72°"; the scale letter stays for assistive technology, so "72°F" is still what is read. */
  #renderValue(value: number): TemplateResult {
    const visible = stepperValueText(value, this.unit);
    const scale = degreeScale(this.unit);
    return html`${visible}${scale === '' ? nothing : html`<span class="visually-hidden">${scale}</span>`}`;
  }
}

defineOnce('agr-stepper', AgrStepper);

declare global {
  interface HTMLElementTagNameMap {
    'agr-stepper': AgrStepper;
  }
}
