/**
 * Vehicle telemetry leaf (§4.8 VehicleVM, DESIGN "Right column"). Read-only by construction: it renders values
 * and emits nothing. The battery bar draws the charge limit as a tick and an empty hatched track when the battery
 * reading is absent, never a 0 % fill (§4.6).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { Display } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { VehicleVM } from '../../model/types.ts';
import {
  hyphenationDeclarations,
  numStyles,
  skeletonStyles,
  staleStyles,
  toneStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { renderVehicleArt } from './vehicle-art.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';

const CHARGER_ICON_SIZE = 16;
/** "No data" reads as a sentence fragment after a field name, so it is worded "unknown" there. */
const NO_DATA_WORD = 'unknown';

export class AgrVehicle extends LitElement {
  static override styles = [
    typographyStyles,
    numStyles,
    toneStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .vehicle {
        display: grid;
        grid-template-columns: 124px minmax(0, 1fr);
        column-gap: var(--agr-space-4);
        row-gap: var(--agr-space-3);
        align-items: center;
      }
      .art {
        display: flex;
        align-items: flex-end;
        color: var(--agr-muted);
      }
      .vehicle-art {
        inline-size: 100%;
        block-size: auto;
        overflow: visible;
      }
      .vehicle-art .glass {
        fill: var(--agr-surface-inset);
      }
      .vehicle-art .detail {
        stroke-width: 1.2;
        opacity: 0.8;
      }
      .vehicle-art .ground {
        stroke: var(--agr-line);
        stroke-width: 1.2;
      }
      .readings {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-1);
        min-inline-size: 0;
      }
      /* Long names wrap to two lines before truncating, so most of a name stays readable. */
      .name {
        display: -webkit-box;
        margin: 0;
        overflow: hidden;
        overflow-wrap: break-word;
        ${hyphenationDeclarations}
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      .levels {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        column-gap: var(--agr-space-3);
        row-gap: 0;
      }
      .levels .skeleton {
        display: inline-block;
        inline-size: 3em;
        margin-block: 0;
      }
      .absent {
        display: inline-flex;
        align-items: baseline;
        gap: var(--agr-space-2);
      }
      .absent .glyph {
        color: var(--agr-muted);
      }
      .range {
        color: var(--agr-ink);
      }
      .meter {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        column-gap: var(--agr-space-3);
      }
      .track {
        position: relative;
        block-size: 8px;
        border-radius: var(--agr-radius-control);
        background: var(--agr-surface-inset);
      }
      .fill {
        position: absolute;
        inset-block: 0;
        inset-inline-start: 0;
        border-radius: inherit;
        background: var(--agr-olive);
      }
      /* §4.6: an absent reading is an empty hatched track, never a 0 % bar. */
      .track[data-absent] {
        background: repeating-linear-gradient(135deg, var(--agr-surface-inset) 0 5px, var(--agr-line) 5px 6px);
      }
      .tick {
        position: absolute;
        inset-block: -4px;
        inline-size: 2px;
        margin-inline-start: -1px;
        border-radius: 1px;
        background: var(--agr-ink);
        opacity: 0.55;
      }
      .limit {
        white-space: nowrap;
      }
      /* Hairline separators instead of middle dots between the charger readings (§6.5). Every reading carries a
         leading hairline; the list is pulled one separator-width out of the clipping line, so the hairline of
         whichever reading starts a line (including after a wrap) is clipped away. */
      .charger {
        grid-column: 1 / -1;
        margin: 0;
        overflow: hidden;
        color: var(--agr-muted);
      }
      .charger-items {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        row-gap: var(--agr-space-1);
        margin-inline-start: calc(-1 * (var(--agr-space-3) + 1px));
      }
      .charger-items > * {
        padding-inline: var(--agr-space-3) 0;
        margin-inline-end: var(--agr-space-3);
        border-inline-start: 1px solid var(--agr-line);
      }
      .charger-status {
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-1);
        color: var(--agr-ink);
        font-weight: 600;
      }
      /* An icon, not text: plain olive meets the 3:1 non-text contrast, and "Charging" carries the meaning. */
      .charger-status[data-charging] svg {
        stroke: var(--agr-olive);
      }
      @container panel (width < ${PANEL_CQ.vehicleArtCompact}px) {
        .vehicle {
          grid-template-columns: 92px minmax(0, 1fr);
          column-gap: var(--agr-space-3);
        }
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) vm?: VehicleVM;

  protected override render(): TemplateResult | typeof nothing {
    const vm = this.vm;
    if (vm === undefined) return nothing;
    return html`<div class="vehicle">
      <div class="art">${renderVehicleArt()}</div>
      <div class="readings">
        <p class="name t-strong">${vm.name}</p>
        <div class="levels">
          ${this.#renderLevel('Battery', vm.battery, 't-title')} ${this.#renderLevel('Range', vm.range, 't-body range')}
        </div>
      </div>
      ${this.#renderMeter(vm)} ${vm.charger ? this.#renderCharger(vm.charger) : nothing}
    </div>`;
  }

  /** One reading with honest absent states: a value (dimmed and marked when stale), a dash plus its label, or a
   *  skeleton while loading. The field name is visually hidden text (§16.10). */
  #renderReading(field: string, display: Display, valueClass: string): TemplateResult {
    // Spaces between the parts keep "Battery 62%" apart for screen readers; layout ignores them (flex items and a
    // collapsed line-start space after the visually hidden name).
    const name = html`<span class="visually-hidden">${field}</span>`;
    if (display.kind === 'value') {
      return html`<span
        >${name}
        <span class="num ${valueClass} ${display.stale ? 'stale' : ''}">${display.text}</span
        >${display.stale ? html`<span class="visually-hidden"> last known</span>` : nothing}</span
      >`;
    }
    if (display.reason === 'loading') {
      return html`<span>${name}<span class="skeleton" aria-hidden="true"></span></span>`;
    }
    return html`<span class="absent"
      >${name} <span class="glyph ${valueClass}" aria-hidden="true">${ABSENT_GLYPH}</span>
      <span class="t-meta">${display.label}</span></span
    >`;
  }

  /**
   * Battery and range: a value as #renderReading draws it, but an absent one is a short muted phrase ("Range
   * unavailable", "Battery not found") instead of a dash beside a bare status word, which read like a reading.
   */
  #renderLevel(field: string, display: Display, valueClass: string): TemplateResult {
    if (display.kind !== 'absent' || display.reason === 'loading')
      return this.#renderReading(field, display, valueClass);
    const word = display.reason === 'no-data' ? NO_DATA_WORD : display.label.toLocaleLowerCase();
    return html`<span class="t-meta">${field} ${word}</span>`;
  }

  #renderMeter(vm: VehicleVM): TemplateResult {
    const pct = vm.batteryPct;
    const limit = vm.chargeLimitPct;
    // The bar repeats the readings beside it, so it is decorative; the numbers carry the meaning.
    return html`<div class="meter">
      <div class="track" ?data-absent=${pct === null} aria-hidden="true">
        ${pct === null ? nothing : html`<span class="fill" style=${styleMap({ inlineSize: `${pct}%` })}></span>`}
        ${limit === undefined ? nothing : html`<span class="tick" style=${styleMap({ insetInlineStart: `${limit}%` })}></span>`}
      </div>
      ${limit === undefined ? nothing : html`<span class="limit t-meta num">Limit ${limit}%</span>`}
    </div>`;
  }

  #renderCharger(charger: NonNullable<VehicleVM['charger']>): TemplateResult {
    const status = charger.status;
    return html`<p class="charger t-meta">
      <span class="charger-items">
        <span class="charger-status" ?data-charging=${charger.charging}
          >${renderIcon(charger.charging ? 'zap' : 'plug', CHARGER_ICON_SIZE)}${
            status.kind === 'value'
              ? html`<span class=${status.stale ? 'stale' : ''}>${status.text}</span>`
              : html`<span>Charger</span> <span class="t-meta">${status.label}</span>`
          }</span
        >
        ${charger.power ? this.#renderReading('Charging power', charger.power, 'num') : nothing}
        ${charger.session ? this.#renderSession(charger.session) : nothing}
      </span>
    </p>`;
  }

  #renderSession(session: Display): TemplateResult {
    if (session.kind !== 'value') return this.#renderReading('Energy this session', session, 'num');
    return html`<span
      ><span class="num ${session.stale ? 'stale' : ''}">${session.text}</span> this
      session${session.stale ? html`<span class="visually-hidden"> last known</span>` : nothing}</span
    >`;
  }
}

defineOnce('agr-vehicle', AgrVehicle);

declare global {
  interface HTMLElementTagNameMap {
    'agr-vehicle': AgrVehicle;
  }
}
