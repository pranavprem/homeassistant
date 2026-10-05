/**
 * The §6.1 viewport matrix: every row of both tables (card widths with HA's 256 px expanded and 56 px collapsed
 * sidebar, and the HA-narrow rows where the sidebar is hidden), with the layout each must produce. layout.spec
 * asserts these; screenshots.spec captures every row.
 */
import type { Sidebar } from './harness.ts';

export type LayoutMode = 'wide' | 'medium' | 'narrow';
/** `compact-no-kolam`: the compact header below HEADER_CQ.kolam (380 px header box), where the mark is hidden. */
export type HeaderVariant = 'full' | 'medium' | 'compact' | 'compact-no-kolam';

export interface ViewportRow {
  /** File-name and title fragment, for example `1440x900-collapsed`. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** `hidden` rows are below HA's 870 px narrow breakpoint, where the sidebar is not shown at all. */
  readonly sidebar: Sidebar | 'hidden';
  readonly cardWidth: number;
  readonly mode: LayoutMode;
  readonly header: HeaderVariant;
  /** Today hero number size in px (PANEL_CQ hero96 / hero80 / 68). */
  readonly heroPx: 96 | 80 | 68;
  /** Hourly forecast cells shown (PANEL_CQ forecast8 / forecast6 / 4). */
  readonly forecastCells: 8 | 6 | 4;
}

/**
 * Forecast cells follow PANEL_CQ.forecast8 (360): the 328 px box at 1440 expanded and the 334 px phone box show 6
 * roomier cells. 640 is below BREAKPOINTS.medium (700), so it is one column with a 584 px panel content box.
 */
export const VIEWPORT_ROWS: readonly ViewportRow[] = Object.freeze([
  row(1440, 900, 'collapsed', 1384, 'wide', 'full', 96, 8),
  row(1440, 900, 'expanded', 1184, 'wide', 'full', 80, 6),
  row(1194, 834, 'collapsed', 1138, 'wide', 'full', 80, 6),
  row(1136, 800, 'collapsed', 1080, 'wide', 'medium', 68, 6),
  row(1194, 834, 'expanded', 938, 'medium', 'medium', 96, 8),
  row(720, 900, 'hidden', 720, 'medium', 'compact', 68, 6),
  row(640, 900, 'hidden', 640, 'narrow', 'compact', 96, 8),
  row(390, 844, 'hidden', 390, 'narrow', 'compact-no-kolam', 80, 6),
]);

/** The three viewports ACCEPTANCE.md names for visual review. */
export const PRIMARY_ROW_IDS: readonly string[] = Object.freeze([
  '1440x900-collapsed',
  '1194x834-expanded',
  '390x844-hidden',
]);

export function viewportRow(id: string): ViewportRow {
  const found = VIEWPORT_ROWS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no viewport row ${id}`);
  return found;
}

/** The shell's `sidebar` query value for a row (hidden rows ignore it). */
export function shellSidebar(viewport: ViewportRow): Sidebar {
  return viewport.sidebar === 'collapsed' ? 'collapsed' : 'expanded';
}

function row(
  width: number,
  height: number,
  sidebar: ViewportRow['sidebar'],
  cardWidth: number,
  mode: LayoutMode,
  header: HeaderVariant,
  heroPx: ViewportRow['heroPx'],
  forecastCells: ViewportRow['forecastCells'],
): ViewportRow {
  return {
    id: `${width}x${height}-${sidebar}`,
    width,
    height,
    sidebar,
    cardWidth,
    mode,
    header,
    heroPx,
    forecastCells,
  };
}
