/**
 * Layout thresholds (§6.1). Column mode follows the card HOST's measured inline size (D2), not the viewport, so HA's
 * sidebar and toolbar are accounted for. Panel internals use container queries with PANEL_CQ.
 */

/**
 * Card HOST inline-size, CSS px (D2). Medium starts at 700 rather than 640: two columns at a 640 px card left a
 * 256 px panel content box, where room chips split words and the panels turned into tall, thin columns.
 */
export const BREAKPOINTS = { wide: 1080, medium: 700 } as const;
/** Step down only below (bp − 16), so a scrollbar appearing or a sidebar animating cannot make the layout flap. */
export const HYSTERESIS_PX = 16;
export type LayoutMode = 'wide' | 'medium' | 'narrow';

/** Header variant thresholds on agr-header's own content box (`container: header / inline-size`), §6.4. Independent
 *  of LayoutMode, so the header compacts before it overflows (for example medium at 700–799). Below `medium` the
 *  header is compact; below `kolam` it is compact without the mark. */
export const HEADER_CQ = { full: 1040, medium: 760, kolam: 380 } as const;

/** Thresholds on the PANEL CONTENT BOX (container size queries measure the content box, after the panel's own
 *  padding), derived from the §6.1 column table, and on the two containers inside panels (a comfort tile, the media
 *  player). Every query uses range syntax with only `(width < N)` and `(width >= N)`, so each threshold N means "from
 *  N up" or "below N" and no fractional width falls between two queries (the fitness suite rejects `<=` and `>`). */
export const PANEL_CQ = {
  hero96: 360, // Today hero number 96 px (typography.ts HERO_SIZES)
  hero80: 300, // 80 px; below this 68 px
  // 8 forecast cells of ≥ 45 px. The 328–334 px boxes (1440 with the sidebar expanded, phones) show 6 roomier
  // cells instead of 8 cramped ones.
  forecast8: 360,
  forecast6: 240, // 6 cells; below this 4
  cameraGrid: 240, // 2×2 tiles; below this 1 column (a 240 px box still gives 114 px wide 4:3 tiles)
  // Room chips and comfort tiles sit two to a row; below this each takes the full row, so a name never breaks
  // mid-word beside a 44 px control. The medium layout's narrowest boxes (about 278–286 px, near its threshold) go
  // one-up; the 293 px box at the wide threshold and the 296 px one at 720 stay two-up.
  twoUp: 288,
  // Two comfort tiles side by side stack their values below this: each tile is then under comfortTileStacked.
  comfortPairStacked: 428,
  metricsShortLabels: 320, // below this Today's metrics use their short labels, so the row never wraps
  // Below this "4 of 4 monitored entry points closed" no longer fits beside House health's well and Details button
  // (1440×900 with the sidebar collapsed is 388), so every label sits under its count.
  healthFactsStacked: 388,
  vehicleArtCompact: 321, // below this the car art shrinks so the readings keep a comfortable measure
  garageDoorStacked: 301, // below this even one door button moves under the state, so its label never truncates
  comfortTileStacked: 208, // a comfort tile's own box: below this the value moves under the name
  comfortTileIcon: 173, // a comfort tile's own box: below this its round icon gives the text its room
  mediaPlayerArt: 301, // the media player's own box: below this the art tile gives the title its room
} as const;

/**
 * The column mode for a card host `width`. With a `previous` mode, a step DOWN happens only below the threshold
 * minus HYSTERESIS_PX, while a step up happens at the threshold itself.
 */
export function layoutFor(width: number, previous?: LayoutMode): LayoutMode {
  const wideAt = previous === 'wide' ? BREAKPOINTS.wide - HYSTERESIS_PX : BREAKPOINTS.wide;
  const mediumAt =
    previous === 'narrow' || previous === undefined ? BREAKPOINTS.medium : BREAKPOINTS.medium - HYSTERESIS_PX;
  if (width >= wideAt) return 'wide';
  if (width >= mediumAt) return 'medium';
  return 'narrow';
}
