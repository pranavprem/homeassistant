/**
 * Range slider (§5.5, §7.2). A display-and-gesture leaf over a native input[type=range] with aria-valuetext from
 * `valueText`. It emits 'agr-draft' ({ value }, { bubbles: true, composed: false }) on 'change' only, renders the
 * DraftState it is given, owns no timers and never calls the gateway; the section passes each gesture to
 * ActionController.draft(). Range inputs are the one place native `disabled` is used, with the reason rendered
 * next to the control.
 *
 * The label, draft status and reason always stay in this shadow root for aria-describedby (§5.5); `label-display`,
 * `status-display` and `reason-display` only choose whether they are visible, for compact rows (the media volume
 * row) and for panels or drawers that state a shared reason once in their own notice (§16.10).
 *
 * `tone` picks the track accent so color keeps its meaning (§6.5): plum identifies media only, brass is light, and
 * everything else (fan speed, purifier) uses the household olive.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { DraftState } from '../../ha/actions/action-controller.ts';
import type { Availability } from '../../ha/actions/types.ts';
import { focusRingStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { draftBase, draftStatusText, textClass, type DraftDetail, type TextDisplay } from './control-helpers.ts';

/** media: plum (the media transport accent); light: brass; device: olive. */
type SliderTone = 'device' | 'light' | 'media';

const NO_DATA_TEXT = 'No data';

export class AgrSlider extends LitElement {
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override styles = [
    focusRingStyles,
    typographyStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-1);
        min-inline-size: 0;
      }
      input {
        inline-size: 100%;
        min-block-size: var(--agr-target);
        margin: 0;
        accent-color: var(--agr-olive);
        cursor: pointer;
      }
      /* Brass-ink rather than brass: plain brass is 2.99:1 on the surface, under the 3:1 a control part needs. */
      :host([tone='light']) input {
        accent-color: var(--agr-brass-ink);
      }
      :host([tone='media']) input {
        accent-color: var(--agr-plum);
      }
      input:disabled {
        cursor: not-allowed;
      }
      input[data-empty] {
        opacity: 0.5;
      }
      .status[data-phase='not-sent'] {
        color: var(--agr-brass-ink);
      }
    `,
  ];

  @property() label = '';
  @property({ attribute: 'focus-key' }) focusKey = '';
  /** Observed value; null renders an empty track, never 0. */
  @property({ attribute: false }) value: number | null = null;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Number }) step = 1;
  /** aria-valuetext with units: "40 percent", "Volume 35 percent". */
  @property({ attribute: false }) valueText!: (v: number) => string;
  @property({ attribute: false }) availability!: Availability;
  @property({ attribute: false }) draft: DraftState = { phase: 'idle' };
  @property({ attribute: 'label-display' }) labelDisplay: TextDisplay = 'visible';
  @property({ attribute: 'status-display' }) statusDisplay: TextDisplay = 'visible';
  @property({ attribute: 'reason-display' }) reasonDisplay: TextDisplay = 'visible';
  @property({ reflect: true }) tone: SliderTone = 'device';
  /** The thumb position while the user drags, before 'change' commits it. */
  @state() private dragValue: number | undefined;

  readonly #onInput = contained('slider-input-failed', (event: Event) => {
    this.dragValue = Number((event.target as HTMLInputElement).value);
  });

  readonly #onChange = contained('slider-change-failed', (event: Event) => {
    const value = Number((event.target as HTMLInputElement).value);
    this.dragValue = undefined;
    if (this.availability?.enabled !== true || !Number.isFinite(value)) return;
    const detail: DraftDetail = { value };
    this.dispatchEvent(new CustomEvent('agr-draft', { bubbles: true, composed: false, detail }));
  });

  protected override render(): TemplateResult {
    const enabled = this.availability?.enabled === true;
    const shown = this.dragValue ?? draftBase(this.draft, this.value);
    const reason =
      this.availability !== undefined && !this.availability.enabled ? this.availability.message : undefined;
    const statusText = draftStatusText(this.draft, (v) => this.#describe(v));
    const describedBy = [statusText ? 'status' : '', reason ? 'reason' : ''].filter(Boolean).join(' ');
    return html`<label class=${textClass(this.labelDisplay)} for="input">${this.label}</label>
      <input
        id="input"
        type="range"
        min=${this.min}
        max=${this.max}
        step=${this.step}
        .value=${String(shown ?? this.min)}
        ?disabled=${!enabled}
        ?data-empty=${shown === null}
        data-focus-key=${this.focusKey || nothing}
        aria-valuetext=${shown === null ? NO_DATA_TEXT : this.#describe(shown)}
        aria-describedby=${describedBy || nothing}
        @input=${this.#onInput}
        @change=${this.#onChange}
      />
      ${
        statusText
          ? html`<span id="status" class="status ${textClass(this.statusDisplay)}" data-phase=${this.draft.phase}
              >${statusText}</span
            >`
          : nothing
      }
      ${reason ? html`<span id="reason" class=${textClass(this.reasonDisplay)}>${reason}</span>` : nothing}`;
  }

  #describe(value: number): string {
    return this.valueText ? this.valueText(value) : String(value);
  }
}

defineOnce('agr-slider', AgrSlider);

declare global {
  interface HTMLElementTagNameMap {
    'agr-slider': AgrSlider;
  }
  interface HTMLElementEventMap {
    'agr-draft': CustomEvent<DraftDetail>;
  }
}
