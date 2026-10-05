/**
 * Type scale classes (§6.5). Serif (Newsreader) carries the editorial numbers: hero, titles and tile values (the clock
 * styles its own); sans (Hanken Grotesk) carries labels, controls and body text. Every changing number is tabular and
 * lining.
 */
import { css } from 'lit';
import { PANEL_CQ } from './breakpoints.ts';

/**
 * Today's hero number (§6.5), defined once: 68 px, 80 px from a PANEL_CQ.hero80 panel box, 96 px from
 * PANEL_CQ.hero96. Anything sized like the hero (its loading placeholder) carries `.t-hero` and measures in em.
 */
const HERO_PX = Object.freeze({ base: 68, hero80: 80, hero96: 96 });
/** The hero's line height, so a box `HERO_LINE_HEIGHT` em tall is exactly one hero line at the current size. */
export const HERO_LINE_HEIGHT = 0.9;

export const typographyStyles = css`
  .t-hero,
  .t-title,
  .t-value {
    font-family: var(--agr-font-display);
    font-optical-sizing: auto;
    font-variant-numeric: tabular-nums lining-nums;
  }
  .t-hero {
    font-size: ${HERO_PX.base}px;
    line-height: ${HERO_LINE_HEIGHT};
    font-weight: 380;
  }
  .t-hero .degree {
    font-size: 0.45em;
    vertical-align: top;
  }
  @container panel (width >= ${PANEL_CQ.hero80}px) {
    .t-hero {
      font-size: ${HERO_PX.hero80}px;
    }
  }
  @container panel (width >= ${PANEL_CQ.hero96}px) {
    .t-hero {
      font-size: ${HERO_PX.hero96}px;
    }
  }
  .t-title {
    font: var(--agr-type-title);
    font-variant-numeric: tabular-nums lining-nums;
  }
  .t-value {
    font: var(--agr-type-value);
    font-variant-numeric: tabular-nums lining-nums;
  }
  .t-body {
    font: var(--agr-type-body);
  }
  .t-strong {
    font: var(--agr-type-strong);
  }
  .t-meta {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .t-label {
    margin: 0;
    font: var(--agr-type-label);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--agr-muted);
  }
`;
