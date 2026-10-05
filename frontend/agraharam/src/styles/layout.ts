/**
 * Frame and column layout (§6.2, D2). Column membership is chosen here from the measured layout mode, so the DOM
 * order always equals the visual order (WCAG 1.3.2, 2.4.3); CSS never reorders sections.
 */
import { css, unsafeCSS } from 'lit';
import type { ResolvedConfig } from '../config/schema.ts';
import { CONTENT_BUDGET, PANEL_HEIGHT_TARGET_PX, type PanelId } from '../model/budget.ts';
import type { LayoutMode } from './breakpoints.ts';

export type SectionId = PanelId;
type Columns = readonly (readonly SectionId[])[];

/** Phone priority flow: urgent status, today and comfort, quick controls, cameras and garage, then the rest. */
export const NARROW_ORDER: readonly SectionId[] = Object.freeze([
  'today',
  'comfort',
  'home',
  'cameras',
  'garage',
  'media',
  'health',
  'upcoming',
]);

/** The reference composition: the home, today and comfort, visibility and arrival. */
export const WIDE_COLUMNS: Columns = Object.freeze([
  Object.freeze<SectionId[]>(['home', 'upcoming', 'health']),
  Object.freeze<SectionId[]>(['today', 'comfort', 'media']),
  Object.freeze<SectionId[]>(['cameras', 'garage']),
]);

/** Quiet panels (a translucent footnote surface) never stretch; hero and raised panels may (§6.2). */
const QUIET_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(['health', 'upcoming']);

/**
 * Panels that take their column's slack, in preference order: Today centres its hero, metrics and strip as one group
 * in the extra height (agr-panel `centered`), and Garage keeps the car under the door with the slack below it. A
 * column without one stretches its last raised panel, as §6.2 describes. No panel distributes slack between its
 * children: the spacing inside a panel is the same at every height.
 */
const ABSORBER_PREFERENCE: readonly SectionId[] = Object.freeze<SectionId[]>(['today', 'garage']);

/** Gap between stacked panels in the medium and wide layouts, used when balancing their columns. */
const COLUMN_GAP_PX = 16;

/**
 * A panel that takes its column's slack grows by at most this much beyond its own content (§16.14). Any further spare
 * height stays below the column, which then ends short: in `dense`, `degraded` or `restricted` a fully stretched
 * Today or Garage opened a void of 100–300 px inside the panel. `normal` at 1440×900 needs less than this, so its
 * columns still align.
 */
export const MAX_ABSORBED_SLACK_PX = 64;
/**
 * Column bottoms within this of each other end together, so they either align or differ by clearly more than a gap:
 * a 15 px near miss (normal at 1440 with the sidebar expanded) reads as a bug. A column this close to the tallest
 * takes the rest of its slack; short columns this close to each other end at the lower bottom.
 */
export const ALIGN_SNAP_PX = 32;

/** One column for slackAllowances(): its content height, and whether it has a panel that may stretch. */
interface ColumnContent {
  readonly naturalHeight: number;
  readonly stretchable: boolean;
}

/**
 * How much of its column's slack each column's stretching panel takes (§16.14), for a grid row `rowHeight` tall:
 *
 * 1. All of it when the slack is at most MAX_ABSORBED_SLACK_PX + ALIGN_SNAP_PX (the column then aligns with the
 *    tallest), otherwise MAX_ABSORBED_SLACK_PX, and the column ends short.
 * 2. Short columns whose bottoms are within ALIGN_SNAP_PX of each other then end at one bottom: the lowest one they
 *    can all reach without any panel exceeding the step-1 limit, so their voids only shrink.
 *
 * Pure, so the rule is unit tested without layout; capStretchedSlack() applies it to the rendered columns.
 */
export function slackAllowances(rowHeight: number, columns: readonly ColumnContent[]): number[] {
  const limit = MAX_ABSORBED_SLACK_PX + ALIGN_SNAP_PX;
  const allowances = columns.map(({ naturalHeight, stretchable }) => {
    const slack = Math.max(0, rowHeight - naturalHeight);
    if (!stretchable) return 0;
    return slack <= limit ? slack : MAX_ABSORBED_SLACK_PX;
  });
  const bottom = (index: number): number => (columns[index]?.naturalHeight ?? 0) + (allowances[index] ?? 0);
  const short = columns
    .map((_, index) => index)
    .filter((index) => bottom(index) < rowHeight - ALIGN_EPSILON_PX)
    .sort((a, b) => bottom(a) - bottom(b));
  let start = 0;
  while (start < short.length) {
    const first = short[start] as number;
    let end = start + 1;
    while (end < short.length && bottom(short[end] as number) - bottom(first) <= ALIGN_SNAP_PX) end += 1;
    const cluster = short.slice(start, end);
    const target = Math.max(bottom(first), ...cluster.map((index) => columns[index]?.naturalHeight ?? 0));
    const reachable = cluster.every((index) => {
      const column = columns[index];
      const needed = target - (column?.naturalHeight ?? 0);
      return column?.stretchable === true ? needed <= limit : needed <= ALIGN_EPSILON_PX;
    });
    if (reachable && cluster.length > 1) {
      for (const index of cluster) {
        if (columns[index]?.stretchable === true) allowances[index] = target - (columns[index]?.naturalHeight ?? 0);
      }
    }
    start = end;
  }
  return allowances;
}
/** The inline custom property the root sets on each stretched section: its content height plus the allowance. */
const SLACK_CAP_PROPERTY = '--agr-slack-cap';
/** Sub-pixel layout noise below which two bottoms count as the same line. */
const ALIGN_EPSILON_PX = 0.5;

/** One more row of comfort tiles (a stacked tile and its 12 px gap), the spare height a second row needs. */
const COMFORT_TILE_ROW_PX = 96;

/**
 * A wide layout leaves the reference composition only when moving the quiet panels lowers its tallest column by more
 * than this. A configuration near the §6.2.1 targets therefore always keeps the reference columns, and estimate noise
 * never moves a panel.
 */
const WIDE_REBALANCE_MIN_GAIN_PX = 64;

/** Optional panels are omitted when nothing they show is configured, and their column rebalances. */
export function visibleSections(config: ResolvedConfig): ReadonlySet<SectionId> {
  const visible = new Set<SectionId>(['today', 'comfort', 'home', 'health']);
  if (config.cameras.length > 0) visible.add('cameras');
  if (config.garage !== undefined || config.vehicle !== undefined) visible.add('garage');
  if (config.media.length > 0) visible.add('media');
  if (config.calendars.length > 0) visible.add('upcoming');
  return visible;
}

/**
 * The columns for a layout mode. A wide layout with an empty column falls back to the medium template. `heights`
 * balances the medium columns, and the wide ones when a column would be far taller than the rest: the budget
 * targets, or panelHeightEstimates(config) from the root.
 */
export function columnsFor(
  mode: LayoutMode,
  visible: ReadonlySet<SectionId>,
  heights: Readonly<Record<SectionId, number>> = PANEL_HEIGHT_TARGET_PX,
): Columns {
  const ordered = NARROW_ORDER.filter((id) => visible.has(id));
  if (mode === 'narrow') return [ordered];
  if (mode === 'wide') {
    const wide = WIDE_COLUMNS.map((column) => column.filter((id) => visible.has(id)));
    if (wide.every((column) => column.length > 0)) return balancedWideColumns(wide, heights);
  }
  return mediumColumns(ordered, heights);
}

/**
 * Wide membership (§6.2, refined in §16.13): the reference columns, unless the configuration makes one column far
 * taller than the others (a large Home in column 1). Then the quiet panels, which never stretch, may move to the
 * foot of a shorter column, so the other columns are not padded out to a tall column 1 with an empty panel. The
 * raised panels never move. Each column keeps its raised panels first and the quiet ones after them, in reference
 * order, so the DOM order still equals the visual order.
 *
 * Among assignments with the same tallest column, the one that leaves Today's column the shortest wins: Today centres
 * its content in any spare height (agr-panel `centered`), where Garage would only gain a blank band under the car.
 */
function balancedWideColumns(reference: Columns, heights: Readonly<Record<SectionId, number>>): Columns {
  const raised = reference.map((column) => column.filter((id) => !QUIET_SECTIONS.has(id)));
  const quiet = reference.flat().filter((id) => QUIET_SECTIONS.has(id));
  const referenceTallest = tallestColumn(reference, heights);
  let best = reference;
  let bestTallest = referenceTallest;
  let bestTodayColumn = todayColumnHeight(reference, heights);
  for (const placement of quietPlacements(quiet.length, reference.length)) {
    const columns = raised.map((column) => [...column]);
    placement.forEach((columnIndex, index) => columns[columnIndex]?.push(quiet[index] as SectionId));
    if (columns.some((column) => column.length === 0)) continue;
    const tallest = tallestColumn(columns, heights);
    const todayColumn = todayColumnHeight(columns, heights);
    if (tallest < bestTallest || (tallest === bestTallest && todayColumn < bestTodayColumn)) {
      best = columns;
      bestTallest = tallest;
      bestTodayColumn = todayColumn;
    }
  }
  return referenceTallest - bestTallest > WIDE_REBALANCE_MIN_GAIN_PX ? best : reference;
}

/** Every way to place `count` quiet panels on `columns` columns, as one column index per panel. */
function quietPlacements(count: number, columns: number): number[][] {
  let placements: number[][] = [[]];
  for (let panel = 0; panel < count; panel += 1) {
    placements = placements.flatMap((placement) =>
      Array.from({ length: columns }, (_, column) => [...placement, column]),
    );
  }
  return placements;
}

function tallestColumn(columns: Columns, heights: Readonly<Record<SectionId, number>>): number {
  return Math.max(...columns.map((column) => stackHeight(column, heights)));
}

function todayColumnHeight(columns: Columns, heights: Readonly<Record<SectionId, number>>): number {
  const column = columns.find((candidate) => candidate.includes('today'));
  return column === undefined ? 0 : stackHeight(column, heights);
}

/**
 * Medium membership from the budget targets (§16.10), keeping each column's internal narrow order, so column 1 then
 * column 2 still reads in phone priority order within each column (DOM order equals visual order):
 *
 * 1. The raised panels split into a prefix (column 1) and the rest (column 2), choosing the split with the lowest
 *    taller column. Near-ties within one gap keep more of the head in column 1, so Today and Climate stay together.
 * 2. The quiet panels, which come last in the narrow order and never stretch, go largest first onto the shorter
 *    column. Splitting all panels as one prefix left column 2 a full panel taller, and column 1's last raised
 *    panel was stretched into a large empty box.
 */
function mediumColumns(ordered: readonly SectionId[], heights: Readonly<Record<SectionId, number>>): Columns {
  const stack = (sections: readonly SectionId[]): number => stackHeight(sections, heights);
  const raised = ordered.filter((id) => !QUIET_SECTIONS.has(id));
  const quiet = ordered.filter((id) => QUIET_SECTIONS.has(id));
  const split = raisedSplit(raised, stack);
  const first = raised.slice(0, split);
  const second = raised.slice(split);
  for (const id of [...quiet].sort((a, b) => heights[b] - heights[a])) {
    (stack(first) <= stack(second) ? first : second).push(id);
  }
  return [first, second].map((column) => ordered.filter((id) => column.includes(id)));
}

/** The prefix length for column 1: the lowest taller column, preferring the longer prefix on a near-tie. */
function raisedSplit(raised: readonly SectionId[], stack: (sections: readonly SectionId[]) => number): number {
  if (raised.length < 2) return raised.length;
  const costs = raised.slice(1).map((_, index) => {
    const split = index + 1;
    return Math.max(stack(raised.slice(0, split)), stack(raised.slice(split)));
  });
  const lowest = Math.min(...costs);
  return costs.reduce((best, cost, index) => (cost <= lowest + COLUMN_GAP_PX ? index + 1 : best), 1);
}

function stackHeight(sections: readonly SectionId[], heights: Readonly<Record<SectionId, number>>): number {
  const panels = sections.reduce((sum, id) => sum + heights[id], 0);
  return panels + Math.max(0, sections.length - 1) * COLUMN_GAP_PX;
}

/** One rendered column as capStretchedSlack() measured it. */
export interface MeasuredColumn {
  /** Section tag names, top to bottom ("agr-today", …). */
  readonly sections: readonly string[];
  /** The column's content height: every panel at its natural height, plus the gaps between them. */
  readonly naturalHeight: number;
}

/**
 * Spare height becomes content where that is simple (§16.14): when more comfort devices are configured than one row
 * shows and the column holding Climate is at least a tile row shorter than its tallest neighbour, Climate shows a
 * second row. It returns to one row only once that column has become the tallest, so the decision never flips back
 * and forth across one measurement (the two thresholds are a full tile row apart). A single column (narrow) has no
 * neighbour to match.
 */
export function nextComfortTileBudget(
  current: number,
  config: ResolvedConfig,
  columns: readonly MeasuredColumn[],
): number {
  const devices = config.climate.length + config.air.length + config.bedComfort.length;
  const index = columns.findIndex((column) => column.sections.includes('agr-comfort'));
  const own = columns[index];
  if (own === undefined || columns.length < 2 || devices <= CONTENT_BUDGET.comfortTiles) {
    return CONTENT_BUDGET.comfortTiles;
  }
  const tallestOther = Math.max(...columns.filter((_, other) => other !== index).map((column) => column.naturalHeight));
  const spare = tallestOther - own.naturalHeight;
  if (current === CONTENT_BUDGET.comfortTilesRoomy) {
    return spare < 0 ? CONTENT_BUDGET.comfortTiles : current;
  }
  return spare >= COMFORT_TILE_ROW_PX ? CONTENT_BUDGET.comfortTilesRoomy : CONTENT_BUDGET.comfortTiles;
}

/**
 * Panels whose configuration gives them nothing to show, so they render their empty state: stretching one would
 * only enlarge a blank box, so such a column ends where its content does.
 */
export function emptySections(config: ResolvedConfig): ReadonlySet<SectionId> {
  const empty = new Set<SectionId>();
  if (config.weather === undefined) empty.add('today');
  if (config.climate.length + config.air.length + config.bedComfort.length === 0) empty.add('comfort');
  const homeDevices = config.rooms.length + config.vacuums.length + config.appliances.length;
  if (homeDevices === 0 && config.studioMonitors === undefined) empty.add('home');
  return empty;
}

/**
 * One panel per column takes the column's slack, so column bottoms align without a stretched quiet box (§6.2): the
 * preferred absorber if the column has one, otherwise the last hero or raised panel. A panel showing its empty state
 * never stretches (`empty`).
 */
export function stretchedSections(columns: Columns, empty: ReadonlySet<SectionId> = new Set()): ReadonlySet<SectionId> {
  const stretched = new Set<SectionId>();
  for (const column of columns) {
    const candidates = column.filter((id) => !QUIET_SECTIONS.has(id) && !empty.has(id));
    const absorber = ABSORBER_PREFERENCE.find((id) => candidates.includes(id)) ?? candidates[candidates.length - 1];
    if (absorber !== undefined) stretched.add(absorber);
  }
  return stretched;
}

/**
 * Measures every column in `scope`, caps each stretched section at its content height plus its slackAllowances()
 * share, and reports each column's content height. A stretched section's content height is read with it briefly
 * unstretched, inside one task, so no frame ever paints the intermediate state. The grid row's height (every column
 * box shares it) does not depend on any cap, because stretching never adds to a column's content size.
 */
export function capStretchedSlack(scope: ParentNode): MeasuredColumn[] {
  const measured = [...scope.querySelectorAll<HTMLElement>('.column')].map((column) => {
    const sections = [...column.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const stretched = sections.find((section) => section.hasAttribute('data-stretch'));
    const heights = sections.map((section) =>
      section === stretched ? naturalHeightOf(section) : section.getBoundingClientRect().height,
    );
    const gap = Number.parseFloat(getComputedStyle(column).rowGap) || 0;
    const naturalHeight = heights.reduce((sum, height) => sum + height, 0) + Math.max(0, sections.length - 1) * gap;
    return {
      sections: sections.map((section) => section.tagName.toLowerCase()),
      naturalHeight,
      stretched,
      stretchedHeight: stretched === undefined ? 0 : (heights[sections.indexOf(stretched)] ?? 0),
      rowHeight: column.getBoundingClientRect().height,
    };
  });
  const rowHeight = Math.max(0, ...measured.map((column) => column.rowHeight));
  const allowances = slackAllowances(
    rowHeight,
    measured.map((column) => ({ naturalHeight: column.naturalHeight, stretchable: column.stretched !== undefined })),
  );
  measured.forEach((column, index) => {
    const slack = rowHeight - column.naturalHeight;
    const allowance = allowances[index] ?? 0;
    // A section that takes all of its column's slack needs no cap; any other stops at its share.
    if (column.stretched !== undefined && column.stretchedHeight > 0 && allowance < slack - ALIGN_EPSILON_PX) {
      column.stretched.style.setProperty(SLACK_CAP_PROPERTY, `${column.stretchedHeight + allowance}px`);
    }
  });
  return measured.map(({ sections, naturalHeight }) => ({ sections, naturalHeight }));
}

/** One stretched section's content height, read with its cap removed and its flex growth briefly off. */
function naturalHeightOf(section: HTMLElement): number {
  const flex = section.style.flex;
  section.style.removeProperty(SLACK_CAP_PROPERTY);
  section.style.flex = '0 0 auto';
  const natural = section.getBoundingClientRect().height;
  section.style.flex = flex;
  return natural;
}

/**
 * Card height model (§6.5): the host paints the canvas and grows with its content (min-block-size, never a fixed
 * height), so HA's view background never shows below the fold. Spacing variables change per layout mode; panel
 * internals read them through inheritance.
 */
export const frameStyles = css`
  :host {
    display: block;
    min-block-size: 100%;
    background: var(--agr-canvas);
  }
  .frame {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--agr-gap);
    min-block-size: 100%;
    max-inline-size: 1680px;
    margin-inline: auto;
    padding-block: var(--agr-frame-pad);
    /* HA pads only the top, right and bottom safe areas, so phones in landscape need the inline insets here. */
    padding-inline: max(var(--agr-frame-pad), env(safe-area-inset-left))
      max(var(--agr-frame-pad), env(safe-area-inset-right));
  }
  .frame[data-layout='wide'] {
    --agr-hero-pad: 24px;
  }
  .frame[data-layout='medium'] {
    --agr-frame-pad: 20px;
    --agr-panel-pad: 18px;
  }
  .frame[data-layout='narrow'] {
    --agr-gap: 12px;
    --agr-frame-pad: 12px;
    --agr-panel-pad: 16px;
  }
  .columns {
    display: grid;
    flex: 1 1 auto;
    gap: var(--agr-gap);
    align-items: stretch;
  }
  .columns[data-columns='1'] {
    grid-template-columns: minmax(0, 1fr);
  }
  .columns[data-columns='2'] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .columns[data-columns='3'] {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: var(--agr-gap);
    min-inline-size: 0;
  }
  /* The cap is measured by capStretchedSlack(); until then the section stretches fully. min-content keeps a section
     whose content just grew from ever being squeezed below it before the cap is measured again. */
  .column > [data-stretch] {
    flex: 1 1 auto;
    min-block-size: min-content;
    max-block-size: var(${unsafeCSS(SLACK_CAP_PROPERTY)}, none);
  }
`;
