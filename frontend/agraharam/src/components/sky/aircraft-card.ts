/**
 * The aircraft card shared by the Sky panel's nearest-aircraft inset and the drawer's list rows (ARCHITECTURE.md
 * §19): an inset block with the label in tabular sans ink, the type muted, a brass-tint "Overhead" chip with ink text
 * (never red, never "now"), and a meta line of distance with its compass point as text, barometric altitude and
 * trend. An overhead aircraft also gets a brass-ink rule on its leading edge, so the emphasis never relies on the
 * chip alone.
 * The visible card is a picture of the aircraft's accessible name, which the panel and drawer give it instead.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { renderIcon } from '../../icons/render-icon.ts';
import { SKY_LABELS, type AircraftVM } from '../../model/sky.ts';
import type { IconName } from '../../model/types.ts';

type TrendKind = NonNullable<AircraftVM['trend']>['kind'];

const TREND_ICON_PX = 14;

/** Level reuses the minus glyph: a horizontal arrow would read as a heading. */
const TREND_ICONS: Readonly<Record<TrendKind, IconName>> = Object.freeze({
  climbing: 'arrow-up-right',
  descending: 'arrow-down-right',
  level: 'minus',
});

/** The label (callsign, registration or ICAO address), the type, and the Overhead chip while live. */
export function renderAircraftHead(aircraft: AircraftVM): TemplateResult {
  return html`<span class="card-head">
    <span class="callsign">${aircraft.label}</span>
    ${aircraft.type === undefined ? nothing : html`<span class="type">${aircraft.type}</span>`}
    ${aircraft.overhead ? html`<span class="chip">${SKY_LABELS.overhead}</span>` : nothing}
  </span>`;
}

/**
 * Distance with the compass point, barometric altitude ("4,800 ft baro") and the trend glyph with its short word; the
 * drawer detail shows the full "Descending · 500 ft/min".
 */
export function renderAircraftMeta(aircraft: AircraftVM): TemplateResult {
  const trend = aircraft.trend;
  return html`<span class="card-meta"
    ><span class="meta-items">
      <span class="meta-item">${aircraft.distance} ${aircraft.bearing.compass}</span>
      ${aircraft.altitude === undefined ? nothing : html`<span class="meta-item">${aircraft.altitude}</span>`}
      ${
        trend === undefined
          ? nothing
          : html`<span class="meta-item trend"
              >${renderIcon(TREND_ICONS[trend.kind], TREND_ICON_PX)}${trend.word}</span
            >`
      }
    </span></span
  >`;
}

export const aircraftCardStyles = css`
  :host {
    --agr-sky-sep: 14px;
  }
  .aircraft-card {
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    padding: var(--agr-space-2) var(--agr-space-4);
    border-radius: var(--agr-radius-inner);
    background: var(--agr-surface-inset);
  }
  /* A straight rule inset from the rounded corners, rather than an edge shadow that would follow the curve. */
  .aircraft-card[data-overhead]::before {
    content: '';
    position: absolute;
    inset-block: 10px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-start-end-radius: 2px;
    border-end-end-radius: 2px;
    background: var(--agr-brass-ink);
  }
  .card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--agr-space-2);
    min-inline-size: 0;
  }
  .callsign {
    font: var(--agr-type-control);
    font-variant-numeric: tabular-nums lining-nums;
    letter-spacing: 0.03em;
    color: var(--agr-ink);
    overflow-wrap: anywhere;
  }
  .type {
    font: var(--agr-type-meta);
    letter-spacing: 0.03em;
    color: var(--agr-muted);
  }
  .chip {
    align-self: center;
    margin-inline-start: auto;
    padding: 1px var(--agr-space-2);
    border-radius: var(--agr-radius-control);
    font: var(--agr-type-label);
    color: var(--agr-ink);
    background: var(--agr-brass-tint);
    white-space: nowrap;
  }
  /* The meta line's parts each carry a leading separator; the list is pulled back by one separator's width and
     clipped, so the separator that would start a line (the first part, or one that wrapped) is never shown. */
  .card-meta {
    display: block;
    margin: 0;
    overflow: hidden;
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .meta-items {
    display: flex;
    flex-wrap: wrap;
    margin-inline-start: calc(-1 * var(--agr-sky-sep));
  }
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums lining-nums;
  }
  .meta-item::before {
    content: '·';
    content: '·' / '';
    display: inline-block;
    inline-size: var(--agr-sky-sep);
    margin-inline-end: -3px;
    text-align: center;
  }
  .meta-item svg {
    flex: none;
  }
`;
