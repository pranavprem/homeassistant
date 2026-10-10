/**
 * The sky drawer's stylesheet (AIRSPACE.md §6, ARCHITECTURE.md §19), kept beside the element so the element file
 * holds behaviour: the banner and its inset notice, the radar block, the Show and Sort controls, the search field, the
 * disclosure rows and their attached detail (one 150 ms fade, none with reduced motion), the Conditions strip,
 * footnotes and sources.
 */
import { css } from 'lit';
import { SIDE_SHEET_MIN_PX } from '../../styles/breakpoints.ts';
import { RADAR_TEXT_SCALE_MAX } from './radar-labels.ts';

/** The radar's side on a side sheet. */
const RADAR_PX = 240;
/**
 * The radar's side on a bottom sheet (160 px), so the list starts within a phone's first screen: at 390×844 a 240 px
 * radar left room for one to three rows on open (e2e/sky.spec.ts asserts what this size shows). Its labels scale up
 * by the same factor, so they read at the side sheet's size.
 */
const RADAR_SHEET_PX = RADAR_PX / RADAR_TEXT_SCALE_MAX;

export const skyDrawerStyles = css`
  p,
  dl,
  dd {
    margin: 0;
  }
  .banner {
    display: flex;
    align-items: flex-start;
    gap: var(--agr-space-3);
    margin: 0 0 var(--agr-space-5);
  }
  /* Not live: the sentence sits in an inset notice with its muted glyph. */
  .banner[data-notice] {
    padding: var(--agr-space-3) var(--agr-space-4);
    border-radius: var(--agr-radius-inner);
    background: var(--agr-surface-inset);
  }
  .notice-glyph {
    display: inline-flex;
    flex: none;
    padding-block-start: 2px;
    color: var(--agr-muted);
  }
  .banner-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }
  .sentence {
    font: var(--agr-type-strong);
    color: var(--agr-ink);
  }
  .age {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .radar-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--agr-space-2);
    margin: 0 0 var(--agr-space-5);
  }
  agr-sky-radar {
    inline-size: min(${RADAR_PX}px, 100%);
  }
  /* The same viewport query agr-drawer uses for its bottom sheet, so the radar shrinks exactly when the sheet does. */
  @media (width < ${SIDE_SHEET_MIN_PX}px) {
    agr-sky-radar {
      inline-size: min(${RADAR_SHEET_PX}px, 100%);
      --agr-sky-radar-text-scale: ${RADAR_TEXT_SCALE_MAX};
    }
  }
  .radar-caption {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
    text-align: center;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--agr-space-3);
    margin: 0 0 var(--agr-space-4);
  }
  .control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--agr-space-2) var(--agr-space-3);
  }
  .control-label {
    flex: none;
    inline-size: 3.5em;
    font: var(--agr-type-label);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--agr-muted);
  }
  .control agr-choice-group {
    flex: 1 1 auto;
  }
  .search {
    display: flex;
    flex-direction: column;
    gap: var(--agr-space-1);
  }
  .search label {
    font: var(--agr-type-label);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--agr-muted);
  }
  .search input {
    box-sizing: border-box;
    inline-size: 100%;
    min-block-size: var(--agr-target);
    padding: 0 var(--agr-space-4);
    border: 1px solid var(--agr-line);
    border-radius: var(--agr-radius-control);
    font: var(--agr-type-body);
    color: var(--agr-ink);
    background: var(--agr-surface-inset);
  }
  .matches {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .aircraft-list {
    display: flex;
    flex-direction: column;
    gap: var(--agr-space-2);
    margin: 0 0 var(--agr-space-6);
    padding: 0;
    list-style: none;
  }
  .aircraft-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--agr-space-3);
    align-items: center;
    inline-size: 100%;
    min-block-size: var(--agr-target);
    border: none;
    font: inherit;
    color: inherit;
    text-align: start;
    cursor: pointer;
  }
  .aircraft-row .card-head,
  .aircraft-row .card-meta {
    grid-column: 1;
  }
  .aircraft-row .chevron {
    display: inline-flex;
    grid-row: 1 / span 2;
    grid-column: 2;
    color: var(--agr-muted);
    transition: transform var(--agr-dur-1) var(--agr-ease);
  }
  .aircraft-row[aria-expanded='true'] .chevron {
    transform: rotate(180deg);
  }
  .aircraft-row[aria-expanded='true'] {
    border-end-start-radius: 0;
    border-end-end-radius: 0;
  }
  .aircraft-row[data-muted] .callsign {
    color: var(--agr-muted);
  }
  .detail {
    padding: var(--agr-space-3) var(--agr-space-4) var(--agr-space-4);
    border-block-start: 1px solid var(--agr-line);
    border-end-start-radius: var(--agr-radius-inner);
    border-end-end-radius: var(--agr-radius-inner);
    background: var(--agr-surface-inset);
    animation: agr-sky-fade 150ms var(--agr-ease);
  }
  .detail[hidden] {
    display: none;
  }
  @keyframes agr-sky-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .detail {
      animation: none;
    }
  }
  .detail-note {
    margin: 0 0 var(--agr-space-2);
    font: var(--agr-type-label);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--agr-muted);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--agr-space-3) var(--agr-space-4);
  }
  .fact {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }
  .fact dt {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .fact dd {
    font: var(--agr-type-meta-strong);
    font-variant-numeric: tabular-nums lining-nums;
    color: var(--agr-ink);
    overflow-wrap: anywhere;
  }
  .route {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-block-start: var(--agr-space-4);
    padding-block-start: var(--agr-space-3);
    border-block-start: 1px solid var(--agr-line);
  }
  .route-codes {
    font: var(--agr-type-value);
    font-optical-sizing: auto;
    font-variant-numeric: tabular-nums lining-nums;
    letter-spacing: 0.02em;
    color: var(--agr-ink);
  }
  .route-names,
  .route-airline {
    font: var(--agr-type-meta);
    color: var(--agr-ink);
    overflow-wrap: break-word;
  }
  .route-caption,
  .seen {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
    overflow-wrap: break-word;
  }
  .seen {
    margin-block-start: var(--agr-space-3);
  }
  .external {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: var(--agr-space-1);
    min-block-size: var(--agr-target);
    padding-block: var(--agr-space-1);
    font: var(--agr-type-meta-strong);
    color: var(--agr-olive-ink);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
    overflow-wrap: anywhere;
  }
  .external svg {
    flex: none;
  }
  .empty {
    margin: 0 0 var(--agr-space-6);
    padding: var(--agr-space-4);
    border-radius: var(--agr-radius-inner);
    font: var(--agr-type-body);
    color: var(--agr-muted);
    background: var(--agr-surface-inset);
  }
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--agr-space-2) var(--agr-space-5);
    padding: var(--agr-space-3) var(--agr-space-4);
    border-radius: var(--agr-radius-inner);
    background: var(--agr-surface-inset);
  }
  .strip-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .strip-item dt {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .strip-item dd {
    font: var(--agr-type-meta-strong);
    font-variant-numeric: tabular-nums lining-nums;
    color: var(--agr-ink);
    white-space: nowrap;
  }
  .strip-item dd.absent {
    color: var(--agr-muted);
  }
  .footnotes {
    display: flex;
    flex-direction: column;
    gap: var(--agr-space-2);
    margin: 0 0 var(--agr-space-5);
  }
  .footnotes .footnote {
    margin: 0;
  }
  .source-links {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .attribution {
    margin: var(--agr-space-1) 0 0;
    font: var(--agr-type-meta);
    color: var(--agr-muted);
    overflow-wrap: break-word;
  }
`;
