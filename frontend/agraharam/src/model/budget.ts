/**
 * Per-panel content budget and height targets (§6.2.1). The overview is curated: selectors cut every list to these
 * limits in every layout mode, and overflow goes to a drawer. If the `normal` scenario misses the 1440×900 hard gate,
 * these constants are tightened here; panels never shrink type to fit.
 */
import type { ResolvedConfig } from '../config/schema.ts';

export type PanelId = 'today' | 'comfort' | 'home' | 'cameras' | 'garage' | 'media' | 'health' | 'upcoming';

export const CONTENT_BUDGET = Object.freeze({
  comfortTiles: 2, // one row of tiles: climate first, then air, then bed; "+N more" opens the climate drawer
  comfortTilesRoomy: 4, // two rows, when the Climate column has a tile row of spare height (§16.14)
  rooms: 6, // rooms with lights on first, then config order
  vacuums: 2, // error, then cleaning or returning, then the rest
  activeAppliances: 3, // idle appliances collapse into one "N idle" row
  cameras: 4,
  healthProblems: 3,
  upcomingEvents: 4, // today and tomorrow only
} as const);

/**
 * Maximum panel heights in CSS px at 1440×900, sidebar collapsed, `normal` scenario. Each column sums to at most
 * 700 px including 16 px gaps, and the root's medium column split is computed from these numbers (§16.10).
 */
export const PANEL_HEIGHT_TARGET_PX: Readonly<Record<PanelId, number>> = Object.freeze({
  home: 352,
  upcoming: 180,
  health: 136,
  today: 360,
  comfort: 140,
  media: 168,
  cameras: 380,
  garage: 304,
});

/**
 * Home rows as agr-home draws them (measured at 1440×900): room chips sit two to a row, 48 px plus an 8 px gap; a vacuum
 * row is 52 px plus 8; an appliance, idle-summary or studio-monitors row is 49 px; "All rooms and devices" is 44 px
 * plus the 12 px body gap. The Home target above already holds two chip rows, one vacuum and two device rows.
 */
const HOME_ROWS = Object.freeze({
  targetChipRows: 2,
  targetVacuums: 1,
  targetDeviceRows: 2,
  chipsPerRow: 2,
  chipRowPx: 56,
  vacuumRowPx: 60,
  deviceRowPx: 49,
  allRoomsPx: 56,
} as const);

/**
 * Expected panel heights for balancing the medium columns (§16.10): the targets, with Home adjusted for the rooms,
 * vacuums and appliances the configuration holds, because Home is the one panel whose size the configuration
 * decides by hundreds of pixels. Only column membership reads these; a miss moves a panel to the other column and
 * never changes content.
 */
export function panelHeightEstimates(config: ResolvedConfig): Readonly<Record<PanelId, number>> {
  return Object.freeze({ ...PANEL_HEIGHT_TARGET_PX, home: homeHeightEstimate(config) });
}

function homeHeightEstimate(config: ResolvedConfig): number {
  const rooms = Math.min(config.rooms.length, CONTENT_BUDGET.rooms);
  const vacuums = Math.min(config.vacuums.length, CONTENT_BUDGET.vacuums);
  const appliances = config.appliances.length;
  // Appliances beyond the active budget collapse into one idle row; activity is runtime state, so assume the most.
  const applianceRows =
    Math.min(appliances, CONTENT_BUDGET.activeAppliances) + (appliances > CONTENT_BUDGET.activeAppliances ? 1 : 0);
  const deviceRows = applianceRows + (config.studioMonitors === undefined ? 0 : 1);
  const overflows =
    config.rooms.length > CONTENT_BUDGET.rooms ||
    config.vacuums.length > CONTENT_BUDGET.vacuums ||
    appliances > CONTENT_BUDGET.activeAppliances;
  const chipRows = Math.ceil(rooms / HOME_ROWS.chipsPerRow);
  return (
    PANEL_HEIGHT_TARGET_PX.home +
    (chipRows - HOME_ROWS.targetChipRows) * HOME_ROWS.chipRowPx +
    (vacuums - HOME_ROWS.targetVacuums) * HOME_ROWS.vacuumRowPx +
    (deviceRows - HOME_ROWS.targetDeviceRows) * HOME_ROWS.deviceRowPx +
    (overflows ? HOME_ROWS.allRoomsPx : 0)
  );
}
