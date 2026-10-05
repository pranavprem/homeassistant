/**
 * Shared styles for the Home leaves and drawers (§6.5): inset tiles with a round icon well, round 44 px controls
 * and hairline-separated device rows. Colors come only from the design tokens; text uses
 * the six text tokens, never plain olive or brass.
 */
import { css } from 'lit';

/** A round icon well inside an inset tile, as in the reference composition. */
export const wellStyles = css`
  .well {
    box-sizing: border-box;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    inline-size: 36px;
    block-size: 36px;
    border-radius: 50%;
    color: var(--agr-muted);
    background: var(--agr-surface);
  }
  .well[data-tone='ok'] {
    color: var(--agr-olive-ink);
  }
  .well[data-tone='attention'] {
    color: var(--agr-brass-ink);
  }
`;

/**
 * The one flat device row (vacuums, appliances, studio monitors) on a panel or drawer surface: a 36 px well on the
 * inset surface, a 12 px gap, then the text, so every device name in a list starts on the same x. Room chips are the
 * only inset tiles in the Home panel, as in the reference composition.
 */
export const deviceRowStyles = css`
  .device-row {
    display: flex;
    align-items: center;
    gap: var(--agr-space-3);
    min-block-size: 48px;
    padding-block: 2px;
  }
  .device-row .well {
    background: var(--agr-surface-inset);
  }
`;

/** Inset tiles: the surface for rows and chips inside a panel (no border, no shadow). */
export const insetStyles = css`
  .inset {
    box-sizing: border-box;
    border-radius: var(--agr-radius-inner);
    background: var(--agr-surface-inset);
  }
`;

/** Two-line text block that can shrink and truncate inside a flex row. */
export const textBlockStyles = css`
  .text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-inline-size: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: var(--agr-space-2);
    min-inline-size: 0;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

/** Device rows separated by hairlines (appliances, studio monitors). */
export const rowListStyles = css`
  .rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows > li + li {
    border-block-start: 1px solid var(--agr-line);
  }
`;

/** Drawer groups: an h3 label above each list (§5.1 headings). */
export const drawerGroupStyles = css`
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--agr-space-2);
    margin-block-start: var(--agr-space-6);
  }
  .group:first-child {
    margin-block-start: 0;
  }
  .group h3 {
    margin: 0;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--agr-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .notice {
    margin: 0 0 var(--agr-space-4);
  }
`;

/** Battery as a slim track: a fill for a value, a hatched empty track when absent, never a 0 % fill (§4.6). */
export const batteryStyles = css`
  .battery {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .track {
    position: relative;
    display: inline-block;
    flex: none;
    inline-size: 26px;
    block-size: 8px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--agr-surface);
    box-shadow: inset 0 0 0 1px var(--agr-line);
  }
  .track[data-size='wide'] {
    inline-size: 72px;
  }
  .fill {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    border-radius: 4px;
    background: var(--agr-olive);
  }
  .fill[data-low] {
    background: var(--agr-brass);
  }
  .track[data-absent] {
    background: repeating-linear-gradient(135deg, var(--agr-surface) 0 3px, var(--agr-line) 3px 4px);
  }
`;
