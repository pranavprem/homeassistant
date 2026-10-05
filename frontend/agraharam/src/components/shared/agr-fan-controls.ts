/**
 * Shared fan controls (power, speed, presets) for the climate drawer and the room drawer, with the
 * API of §16.10: `{ tile: AirTileVM; draft: DraftState; focusKeyPrefix: string }`.
 *
 * A display-and-gesture leaf: it never calls the gateway and owns no timers. Every gesture is re-dispatched from
 * the host as ONE composed 'agr-fan-intent' event, so it reaches the drawer that holds the ActionController through
 * any number of shadow roots. The holder applies it with applyFanIntent() and lists fanActionKey(tile.key) among
 * its ActionController keys, so ticket updates re-render it:
 *
 *   html`<agr-fan-controls .tile=${tile} .draft=${actions.draftState(fanActionKey(tile.key))}
 *          focus-key-prefix="room:2:purifier"
 *          @agr-fan-intent=${(e: CustomEvent<FanIntent>) =>
 *            applyFanIntent(actions, e.detail, () => tile.percentage?.value ?? null)}></agr-fan-controls>`
 *
 * Power and preset are immediate requests (one activation, one request); speed is a debounced draft (§7.2).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import type { ActionController, DraftState } from '../../ha/actions/action-controller.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS, type ActionKey, type ActionRequest } from '../../ha/actions/types.ts';
import { speedPercentage } from '../../model/air.ts';
import { choiceReason } from '../../model/choice.ts';
import { entityActionKey } from '../../model/controls.ts';
import type { AirTileVM } from '../../model/types.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import type { ReasonDisplay } from '../primitives/control-helpers.ts';
import '../primitives/agr-choice-group.ts';
import type { ChooseDetail } from '../primitives/agr-choice-group.ts';
import '../primitives/agr-slider.ts';
import type { DraftDetail } from '../primitives/control-helpers.ts';

/**
 * What the user asked for; the holder turns it into a gateway request or draft with applyFanIntent(). A speed is the
 * whole percentage HA uses for the chosen position (speedPercentage), so it compares equal to the observed value.
 */
export type FanIntent =
  | { readonly kind: 'power'; readonly entity: EntityId; readonly next: 'on' | 'off' }
  | { readonly kind: 'speed'; readonly entity: EntityId; readonly percentage: number }
  | { readonly kind: 'preset'; readonly entity: EntityId; readonly preset: string };

export const FAN_INTENT_EVENT = 'agr-fan-intent';

const POWER_KIND = Object.freeze({ on: 'fan.turn_on', off: 'fan.turn_off' } as const);

/** The ticket and draft key every fan action of `entity` shares. */
export function fanActionKey(entity: EntityId): ActionKey {
  return entityActionKey(entity);
}

/** Speed 0 is off; any other position becomes HA's whole percentage for it (set_percentage takes 1–100, §7.1). */
export function fanSpeedRequest(entity: EntityId, percentage: number): ActionRequest {
  const whole = speedPercentage(percentage);
  return whole === 0 ? { kind: 'fan.turn_off', entity } : { kind: 'fan.set_percentage', entity, percentage: whole };
}

function speedText(value: number): string {
  return `${speedPercentage(value)} percent`;
}

/** Applies one intent through the holder's ActionController: never more than one request per gesture. */
export function applyFanIntent(
  actions: ActionController,
  intent: FanIntent,
  observedPercentage: () => number | null,
): void {
  switch (intent.kind) {
    case 'power':
      actions.request({ kind: intent.next === 'on' ? 'fan.turn_on' : 'fan.turn_off', entity: intent.entity });
      return;
    case 'preset':
      actions.request({ kind: 'fan.set_preset_mode', entity: intent.entity, preset: intent.preset });
      return;
    case 'speed':
      actions.draft(
        fanActionKey(intent.entity),
        intent.percentage,
        (value) => fanSpeedRequest(intent.entity, value),
        SLIDER_COMMIT_DEBOUNCE_MS,
        observedPercentage,
      );
      return;
  }
}

export class AgrFanControls extends LitElement {
  static override styles = [
    typographyStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .controls {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-5);
      }
      .power {
        display: flex;
        flex-wrap: wrap;
        gap: var(--agr-space-2);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-2);
      }
      .field p {
        margin: 0;
      }
    `,
  ];

  @property({ attribute: false }) tile!: AirTileVM;
  /** The speed draft of this fan's action key. */
  @property({ attribute: false }) draft: DraftState = { phase: 'idle' };
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = '';
  /** 'hidden' when the holder states the shared reason (controls off, disconnected) once in its own notice. */
  @property({ attribute: 'reason-display' }) reasonDisplay: ReasonDisplay = 'visible';

  readonly #emit = (intent: FanIntent): void => {
    this.dispatchEvent(new CustomEvent<FanIntent>(FAN_INTENT_EVENT, { bubbles: true, composed: true, detail: intent }));
  };

  readonly #onPower = contained('fan-power-failed', (next: 'on' | 'off') => {
    this.#emit({ kind: 'power', entity: this.tile.key, next });
  });

  readonly #onSpeed = contained('fan-speed-failed', (event: CustomEvent<DraftDetail>) => {
    event.stopPropagation();
    this.#emit({ kind: 'speed', entity: this.tile.key, percentage: speedPercentage(event.detail.value) });
  });

  readonly #onPreset = contained('fan-preset-failed', (event: CustomEvent<ChooseDetail>) => {
    event.stopPropagation();
    this.#emit({ kind: 'preset', entity: this.tile.key, preset: event.detail.value });
  });

  protected override render(): TemplateResult | typeof nothing {
    const tile = this.tile;
    if (tile === undefined) return nothing;
    return html`<div class="controls">
      <div class="power">${this.#renderPower(tile)}</div>
      ${
        tile.percentage === undefined
          ? nothing
          : html`<agr-slider
              label="Speed"
              focus-key=${`${this.focusKeyPrefix}:speed`}
              .value=${tile.percentage.value}
              .min=${tile.percentage.min}
              .max=${tile.percentage.max}
              .step=${tile.percentage.step}
              .valueText=${speedText}
              .availability=${tile.percentage.availability}
              .draft=${this.draft}
              reason-display=${this.reasonDisplay}
              @agr-draft=${this.#onSpeed}
            ></agr-slider>`
      }
      ${tile.presets === undefined ? nothing : this.#renderPresets(tile, tile.presets)}
    </div>`;
  }

  #renderPower(tile: AirTileVM): TemplateResult {
    const prefix = this.focusKeyPrefix;
    // Each power button shows only the ticket of its own request.
    const statusFor = (next: 'on' | 'off') => (tile.pending?.kind === POWER_KIND[next] ? tile.pending : undefined);
    if (tile.power === 'unknown' && tile.status === 'unknown') {
      // §7.2: with an unknown state the toggle becomes two explicit buttons, both evaluated by the selector.
      return html`<agr-button
          label="On"
          icon="power"
          focus-key=${`${prefix}:on`}
          reason-display=${this.reasonDisplay}
          .availability=${tile.toggle}
          .status=${statusFor('on')}
          @agr-activate=${() => this.#onPower('on')}
        ></agr-button>
        <agr-button
          label="Off"
          focus-key=${`${prefix}:off`}
          reason-display=${this.reasonDisplay}
          .availability=${tile.toggle}
          .status=${statusFor('off')}
          @agr-activate=${() => this.#onPower('off')}
        ></agr-button>`;
    }
    // One "Power" toggle whose pressed state is the observed power, rather than a solid "Turn off" button that read
    // like a state of its own (§16.14).
    const next = tile.power === 'on' ? 'off' : 'on';
    return html`<agr-button
      label="Power"
      icon="power"
      .pressed=${tile.power === 'on'}
      focus-key=${`${prefix}:power`}
      reason-display=${this.reasonDisplay}
      .availability=${tile.toggle}
      .status=${statusFor(next)}
      @agr-activate=${() => this.#onPower(next)}
    ></agr-button>`;
  }

  #renderPresets(tile: AirTileVM, presets: NonNullable<AirTileVM['presets']>): TemplateResult {
    const reason = this.reasonDisplay === 'visible' ? choiceReason(presets) : undefined;
    return html`<div class="field">
      <span class="t-label" aria-hidden="true">${presets.label}</span>
      <agr-choice-group
        label=${`${presets.label} for ${tile.name}`}
        focus-key-prefix=${`${this.focusKeyPrefix}:preset`}
        .options=${presets.options}
        @agr-choose=${this.#onPreset}
      ></agr-choice-group>
      ${reason === undefined ? nothing : html`<p class="t-meta">${reason}</p>`}
    </div>`;
  }
}

defineOnce('agr-fan-controls', AgrFanControls);

declare global {
  interface HTMLElementTagNameMap {
    'agr-fan-controls': AgrFanControls;
  }
  interface HTMLElementEventMap {
    'agr-fan-intent': CustomEvent<FanIntent>;
  }
}
