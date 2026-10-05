/**
 * Forecast strip (§4.8, §9.2): a modest row of hourly cells, an honestly labelled daily fallback, or a note saying
 * why there is no forecast. Cells are display only (not interactive), so 40 px cells are acceptable.
 *
 * The strip is its own inline-size container with no horizontal padding, so its width IS the panel content box
 * and the cell count follows PANEL_CQ: 8 cells at forecast8 and wider, 6 at forecast6, else 4. Hidden cells use
 * display: none, so they also leave the accessibility tree.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import { NOW_LABEL } from '../../model/today.ts';
import type { ForecastItemVM, ForecastVM } from '../../model/types.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { numStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';

const CELL_ICON_SIZE = 20;
const NOTE_ICON_SIZE = 18;
/** "7 PM" → "7" + "PM": the period is set a little smaller than the hour, so "10 PM" fits a 40 px cell. */
const HOUR_LABEL_RE = /^(\d{1,2})\s*(\S.*)$/;

const LOADING: ForecastVM = Object.freeze({ kind: 'loading' });
/** As many placeholder cells as the widest strip shows; the container queries hide the extra ones. */
const GHOST_CELLS: readonly number[] = Object.freeze(Array.from({ length: 8 }, (_, index) => index));

class AgrForecastStrip extends LitElement {
  static override styles = [
    typographyStyles,
    numStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: block;
        container: forecast / inline-size;
        min-inline-size: 0;
      }
      ol {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(0, 1fr);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .cell {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        min-inline-size: 0;
        text-align: center;
      }
      .cell:nth-child(n + 5),
      .ghost:nth-child(n + 5) {
        display: none;
      }
      @container forecast (width >= ${PANEL_CQ.forecast6}px) {
        .cell:nth-child(n + 5),
        .ghost:nth-child(n + 5) {
          display: flex;
        }
        .cell:nth-child(n + 7),
        .ghost:nth-child(n + 7) {
          display: none;
        }
      }
      @container forecast (width >= ${PANEL_CQ.forecast8}px) {
        .cell:nth-child(n + 7),
        .ghost:nth-child(n + 7) {
          display: flex;
        }
      }
      .label {
        white-space: nowrap;
      }
      /* 0.85 em capitals stay legible (small caps at this size drew 9 px letters) and still fit "10 PM". */
      .label .period {
        font-size: 0.85em;
        letter-spacing: 0.02em;
      }
      .label.now {
        color: var(--agr-ink);
        font-weight: 650;
      }
      .glyph {
        display: inline-flex;
        color: var(--agr-muted);
      }
      .temp {
        white-space: nowrap;
      }
      .temp.absent {
        color: var(--agr-muted);
      }
      .low {
        margin-block-start: -4px;
        white-space: nowrap;
      }
      .note {
        display: flex;
        align-items: flex-start;
        gap: var(--agr-space-2);
        margin: 0;
        text-wrap: pretty;
      }
      .note svg {
        flex: none;
        margin-block-start: 1px;
      }
      ol + .note {
        margin-block-start: var(--agr-space-3);
      }
      .unavailable {
        padding: var(--agr-space-3) var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        background: var(--agr-surface-inset);
      }
      /* Loading: the strip's own cells, each a label, glyph and value placeholder, so nothing moves when it fills. */
      .ghost {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding-block: 4px;
      }
      .ghost span {
        display: block;
        border-radius: var(--agr-radius-control);
        background: var(--agr-surface-inset);
      }
      .ghost .bar {
        inline-size: 24px;
        block-size: 10px;
      }
      .ghost .dot {
        inline-size: 20px;
        block-size: 20px;
        border-radius: 50%;
      }
      .ghost .value {
        inline-size: 28px;
        block-size: 18px;
      }
    `,
  ];

  @property({ attribute: false }) forecast: ForecastVM = LOADING;

  protected override render(): TemplateResult {
    const forecast = this.forecast;
    switch (forecast.kind) {
      case 'loading':
        return html`<ol aria-hidden="true">
            ${GHOST_CELLS.map(
              () =>
                html`<li class="ghost">
                  <span class="bar"></span><span class="dot"></span><span class="value"></span>
                </li>`,
            )}
          </ol>
          <span class="visually-hidden">Forecast loading</span>`;
      case 'hourly':
        return this.#renderCells(forecast.items, 'Hourly forecast');
      case 'daily-fallback':
        return html`${this.#renderCells(forecast.items, 'Daily forecast')}
          <p class="note t-meta">${renderIcon('info', NOTE_ICON_SIZE)}<span>${forecast.note}</span></p>`;
      case 'unavailable':
        return html`<p class="note unavailable t-meta" data-reason=${forecast.reason}>
          ${renderIcon('info', NOTE_ICON_SIZE)}<span>${forecast.note}</span>
        </p>`;
    }
  }

  #renderCells(items: readonly ForecastItemVM[], label: string): TemplateResult {
    return html`<ol aria-label=${label}>
      ${items.map((item) => this.#renderCell(item))}
    </ol>`;
  }

  #renderCell(item: ForecastItemVM): TemplateResult {
    const temperature = item.temperature;
    const precipitation = item.precipitation ? `, ${item.precipitation} chance of precipitation` : '';
    return html`<li class="cell">
      ${renderLabel(item.label)}
      <span class="visually-hidden">, ${item.conditionLabel}${precipitation}, </span>
      <span class="glyph">${renderIcon(item.icon, CELL_ICON_SIZE)}</span>
      ${
        temperature.kind === 'value'
          ? html`<span class="temp t-value num">${temperature.text}</span>`
          : html`<span class="temp absent t-value" aria-hidden="true">${ABSENT_GLYPH}</span
              ><span class="visually-hidden">${temperature.label}</span>`
      }
      ${
        item.low?.kind === 'value'
          ? html`<span class="low t-meta num"><span class="visually-hidden">, low </span>${item.low.text}</span>`
          : nothing
      }
    </li>`;
  }
}

function renderLabel(label: string): TemplateResult {
  if (label === NOW_LABEL) return html`<span class="label now t-meta">${label}</span>`;
  const parts = HOUR_LABEL_RE.exec(label);
  if (parts === null) return html`<span class="label t-meta">${label}</span>`;
  return html`<span class="label t-meta num">${parts[1]}&nbsp;<span class="period">${parts[2]}</span></span>`;
}

defineOnce('agr-forecast-strip', AgrForecastStrip);

declare global {
  interface HTMLElementTagNameMap {
    'agr-forecast-strip': AgrForecastStrip;
  }
}
