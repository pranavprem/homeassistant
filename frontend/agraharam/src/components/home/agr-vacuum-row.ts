/**
 * One robot vacuum (§5.1, §7.1): name, battery (a slim track that stays hatched and empty when absent, never a 0 %
 * fill), activity in plain words, and only the actions its state and feature bits allow, as round icon buttons.
 * Emits 'agr-home-vacuum' ({ entity, command }) for the element holding the ActionController; it never calls the
 * gateway. Ticket text shows in place of the activity while a request is open; the holder's live region announces.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { Availability } from '../../ha/actions/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { HomeVacuumVM } from '../../model/home.ts';
import type { IconName } from '../../model/types.ts';
import { numStyles, skeletonStyles, staleStyles, toneStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import '../primitives/agr-icon-button.ts';
import { emit, rowReason, rowStatusText, type VacuumCommand, type VacuumCommandDetail } from './home-actions.ts';
import { batteryStyles, deviceRowStyles, textBlockStyles, wellStyles } from './home-styles.ts';

/** Below this the battery fill turns brass, so a low robot reads as needing a charge without relying on color. */
const LOW_BATTERY_PCT = 20;

interface VacuumAction {
  readonly command: VacuumCommand;
  readonly icon: IconName;
  readonly label: string;
  readonly availability: Availability;
}

class AgrVacuumRow extends LitElement {
  static override styles = [
    typographyStyles,
    numStyles,
    toneStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    wellStyles,
    deviceRowStyles,
    textBlockStyles,
    batteryStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .name {
        flex: 0 1 auto;
      }
      .battery {
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .actions {
        display: flex;
        flex: none;
        gap: var(--agr-space-1);
      }
      .skeleton {
        inline-size: 96px;
        margin-block: 3px;
      }
      .wrap {
        display: -webkit-box;
        overflow: hidden;
        overflow-wrap: break-word;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) vacuum!: HomeVacuumVM;
  /** Prefix for data-focus-key ("vacuum" in the panel, "home-drawer:vacuum" in the drawer). */
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = 'vacuum';

  readonly #onCommand = contained('vacuum-command-failed', (command: VacuumCommand) => {
    emit<VacuumCommandDetail>(this, 'agr-home-vacuum', { entity: this.vacuum.key, command });
  });

  protected override render(): TemplateResult {
    const vacuum = this.vacuum;
    return html`<div class="device-row">
      <span class="well" data-tone=${vacuum.tone} aria-hidden="true">${renderIcon('robot-vacuum')}</span>
      <div class="text">
        <span class="line">
          <span class="name t-strong ellipsis">${vacuum.name}</span>
          ${this.#renderBattery()}
        </span>
        ${this.#renderActivity()}
      </div>
      <div class="actions">${this.#actions().map((action) => this.#renderAction(action))}</div>
    </div>`;
  }

  #renderActivity(): TemplateResult {
    const vacuum = this.vacuum;
    if (vacuum.status === 'loading') {
      return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;
    }
    const pendingText = rowStatusText(vacuum.pending);
    const reason = rowReason([vacuum.start, vacuum.pause, vacuum.returnHome]);
    // A device's own error text wraps (up to two lines) instead of truncating: it says what to fix.
    const lineClass = vacuum.activity === 'error' && pendingText === undefined ? 'wrap' : 'ellipsis';
    return html`<span class="t-meta ${lineClass} ${vacuum.stale ? 'stale' : ''}" data-tone=${vacuum.tone}
        >${pendingText ?? vacuum.activityLabel}${
          vacuum.stale ? html`<span class="visually-hidden">, last known</span>` : nothing
        }</span
      >${reason === undefined ? nothing : html`<span class="t-meta reason">${reason}</span>`}`;
  }

  /** Nothing when no battery source exists; a hatched empty track plus its label when the value is absent. */
  #renderBattery(): TemplateResult | typeof nothing {
    const vacuum = this.vacuum;
    const battery = vacuum.battery;
    if (battery === undefined || (battery.kind === 'absent' && battery.reason === 'loading')) return nothing;
    const pct = vacuum.batteryPct;
    const text = battery.kind === 'value' ? battery.text : battery.label;
    return html`<span class="battery">
      <span class="track" ?data-absent=${pct === null} aria-hidden="true"
        >${
          pct === null
            ? nothing
            : html`<span class="fill" ?data-low=${pct < LOW_BATTERY_PCT} style="inline-size: ${pct}%"></span>`
        }</span
      ><span class="num ${battery.kind === 'value' && battery.stale ? 'stale' : ''}"
        ><span class="visually-hidden">Battery </span>${text}</span
      >
    </span>`;
  }

  #actions(): VacuumAction[] {
    const vacuum = this.vacuum;
    const actions: VacuumAction[] = [];
    if (vacuum.start !== undefined) {
      actions.push({
        command: 'start',
        icon: 'play',
        label: `${vacuum.startLabel} ${vacuum.name}`,
        availability: vacuum.start,
      });
    }
    if (vacuum.pause !== undefined) {
      actions.push({ command: 'pause', icon: 'pause', label: `Pause ${vacuum.name}`, availability: vacuum.pause });
    }
    if (vacuum.returnHome !== undefined) {
      actions.push({
        command: 'return',
        icon: 'house',
        label: `Send ${vacuum.name} to its dock`,
        availability: vacuum.returnHome,
      });
    }
    return actions;
  }

  #renderAction(action: VacuumAction): TemplateResult {
    return html`<agr-icon-button
      icon=${action.icon}
      label=${action.label}
      reason-display="hidden"
      focus-key=${`${this.focusKeyPrefix}:${this.vacuum.key}:${action.command}`}
      .availability=${action.availability}
      @agr-activate=${() => this.#onCommand(action.command)}
    ></agr-icon-button>`;
  }
}

defineOnce('agr-vacuum-row', AgrVacuumRow);

declare global {
  interface HTMLElementTagNameMap {
    'agr-vacuum-row': AgrVacuumRow;
  }
}
