/**
 * One appliance (§5.1, §4.8): read-only status text and remaining time ("35 min left", "Done 7:40 PM"). Absent
 * values keep their honest label ("Not found", "No data"), never a blank or 0; an unknown remaining time reads "Time
 * left unknown" rather than a bare "Unknown" where the time should be. With `idle` set, the row instead summarizes the
 * idle appliances the overview collapsed ("2 appliances idle"). Every row is the shared flat device row: a 36 px well
 * with the appliance's own glyph, so its name lines up with the vacuum and studio monitors above and below it.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import { displayText, type Display } from '../../model/display.ts';
import { applianceIcon } from '../../model/home.ts';
import type { ApplianceVM } from '../../model/types.ts';
import { numStyles, skeletonStyles, staleStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { deviceRowStyles, textBlockStyles, wellStyles } from './home-styles.ts';

const TIME_LEFT_UNKNOWN = 'Time left unknown';

class AgrApplianceRow extends LitElement {
  static override styles = [
    typographyStyles,
    numStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    textBlockStyles,
    wellStyles,
    deviceRowStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .remaining {
        flex: none;
        max-inline-size: 45%;
        text-align: end;
        color: var(--agr-ink);
      }
      .remaining[data-absent] {
        color: var(--agr-muted);
      }
      .skeleton {
        inline-size: 72px;
        margin-block: 3px;
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) appliance?: ApplianceVM;
  /** When set, the row summarizes this many idle appliances instead of showing one. */
  @property({ type: Number }) idle = 0;

  protected override render(): TemplateResult {
    const appliance = this.appliance;
    if (appliance === undefined) return this.#renderIdle();
    return html`<div class="device-row">
      <span class="well" data-tone=${appliance.active ? 'ok' : nothing} aria-hidden="true"
        >${renderIcon(applianceIcon(appliance.name))}</span
      >
      <div class="text">
        <span class="t-body ellipsis">${appliance.name}</span>
        ${this.#renderStatus(appliance.statusText)}
      </div>
      ${appliance.remaining === undefined ? nothing : this.#renderRemaining(appliance.remaining)}
    </div>`;
  }

  #renderStatus(display: Display): TemplateResult {
    if (display.kind === 'absent' && display.reason === 'loading') {
      return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;
    }
    const stale = display.kind === 'value' && display.stale;
    return html`<span class="t-meta ellipsis ${stale ? 'stale' : ''}"
      >${displayText(display)}${stale ? html`<span class="visually-hidden">, last known</span>` : nothing}</span
    >`;
  }

  #renderRemaining(display: Display): TemplateResult | typeof nothing {
    if (display.kind === 'absent' && display.reason === 'loading') return nothing;
    const stale = display.kind === 'value' && display.stale;
    const unknown = display.kind === 'absent' && display.reason === 'unknown';
    return html`<span
      class="remaining t-meta num ellipsis ${stale ? 'stale' : ''}"
      ?data-absent=${display.kind === 'absent'}
      >${unknown ? TIME_LEFT_UNKNOWN : html`<span class="visually-hidden">Remaining: </span>${displayText(display)}`}</span
    >`;
  }

  #renderIdle(): TemplateResult {
    const label = this.idle === 1 ? '1 appliance idle' : `${this.idle} appliances idle`;
    return html`<div class="device-row">
      <span class="well" aria-hidden="true">${renderIcon('timer')}</span>
      <span class="t-meta">${label}</span>
    </div>`;
  }
}

defineOnce('agr-appliance-row', AgrApplianceRow);

declare global {
  interface HTMLElementTagNameMap {
    'agr-appliance-row': AgrApplianceRow;
  }
}
