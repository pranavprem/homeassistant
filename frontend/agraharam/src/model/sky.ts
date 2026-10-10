/**
 * Sky view models (AIRSPACE.md §3, §4, §6): the overview panel, the drawer's views, sorts and filter, unit, compass
 * and trend wording, and the single copy table. Pure. The status comes from `airspaceState` on every render; only the
 * list and radar view models are memoized, keyed on everything they read, so a 10 s tick re-renders cheaply.
 *
 * Label precision (AIRSPACE.md §2, §3): altitude is barometric ("ft baro"), track is ground track, a route is a
 * community-reported route ("Reported route · unverified"), never a schedule, an ETA or a flight number.
 */
import type { EntityId, ResolvedConfig } from '../config/schema.ts';
import type { Formatter, LengthUnit } from '../ha/host.ts';
import type { Tone } from '../ha/normalize.ts';
import {
  aircraftLink,
  airspaceState,
  RECENT_MAX,
  type Aircraft,
  type AirspaceSnapshot,
  type SkyState,
  type SkyStatus,
} from './airspace.ts';
import { SEARCH_MIN_ROWS } from './budget.ts';
import { MILES_PER_KM, radarMarks, radarRings, type RadarVM } from './radar.ts';
import type { IconName, SelectorInput } from './types.ts';
import { compassPoint } from './weather-details.ts';

export type SkyView = 'nearby' | 'overhead' | 'recent';
/** 'latest' is offered only in Recent, where it is the default. */
export type SkySort = 'distance' | 'altitude' | 'name' | 'latest';

/** Structurally a PanelPill: components pass it through panelPill(store, own), so offline shows PAUSED_PILL. */
interface SkyPill {
  readonly label: string;
  readonly tone: Tone;
  readonly icon?: IconName;
}

interface SkyFreshnessVM {
  readonly status: SkyStatus;
  readonly live: boolean; // live || empty
  /** No permanent "Live" pill; "Not live" (attention) only while stale. */
  readonly pill?: SkyPill;
  /** "Updated just now" while live; "Last update 7 min ago" otherwise. Never inside a live region. */
  readonly ageText?: string;
  /** The AIRSPACE.md §4 sentence for a non-live state: the panel line in the panel VM, the banner in the drawer VM. */
  readonly sentence?: string;
}

export interface AircraftVM {
  readonly key: string; // validated hex: lit repeat keys, DOM ids, focus keys
  readonly label: string;
  readonly labelKind: 'callsign' | 'registration' | 'hex';
  readonly icao: string; // upper-case hex, captioned "ICAO address"
  readonly registration?: string;
  readonly type?: string;
  readonly altitude?: string; // "12,000 ft"
  readonly speed?: string; // "230 kn"
  readonly track?: { readonly deg: string; readonly compass: string };
  /** `word` is the bare trend ("Descending") for the card's chip; `text` adds the rate ("Descending · 500 ft/min"). */
  readonly trend?: { readonly kind: TrendKind; readonly word: TrendWord; readonly text: string };
  readonly distance: string; // "2.1 km"
  readonly bearing: { readonly deg: string; readonly compass: string };
  readonly overhead: boolean; // nearby only, and only while live
  readonly seen: string; // "seen just now"
  readonly closest?: string; // recent: "Closest 1.2 km at last overhead pass"
  readonly route?: {
    readonly codes: string; // "XAAA → XBBB"
    readonly names?: string;
    readonly airline?: string;
    readonly source: string;
  };
  readonly accessibleName: string;
  readonly link?: string; // the tracking-site link (AIRSPACE.md §9), live HA mode only
}

type TrendKind = 'climbing' | 'descending' | 'level';
type TrendWord = 'Climbing' | 'Descending' | 'Level';

export interface SkyPanelVM {
  readonly freshness: SkyFreshnessVM;
  readonly count?: number; // live and empty only
  /** Beside the count: "aircraft within 25 km" or "Quiet skies within 25 km". */
  readonly countLabel?: string;
  readonly overheadCount?: number; // live only
  readonly radiusText?: string; // "within 25 km"
  readonly nearest?: AircraftVM; // live only: the closest overhead aircraft, else the nearest
  /** "2 entries not shown": nearby entries only, because it sits beside the nearby count. */
  readonly droppedText?: string;
}

interface SkyViewOption {
  readonly id: SkyView;
  readonly label: string;
  readonly count?: number | string; // Recent: "12+" when the collector's list is full
}

export interface SkyDrawerVM {
  readonly freshness: SkyFreshnessVM;
  readonly views: readonly SkyViewOption[];
  readonly view: SkyView;
  readonly sorts: readonly SkySort[];
  readonly sort: SkySort; // the requested sort, or the view's default when the view does not offer it
  readonly rows: readonly AircraftVM[]; // filtered and sorted; empty when not drawable
  readonly total: number; // rows in the view before the text filter
  /** total >= SEARCH_MIN_ROWS, or a filter is typed: the count changes with every publish, and a field that
   *  disappeared at 15 rows would silently discard what the user typed. */
  readonly searchable: boolean;
  readonly emptyText?: string;
  readonly expanded?: string; // the expanded row's key, if it is still listed
  /** Nearby aircraft only; undefined unless drawable. In Recent no mark is ever `expanded`: the radar shows where
   *  aircraft are now, and an expanded recent row describes a past pass. */
  readonly radar?: RadarVM;
  readonly radiusText?: string; // "Within 25 km"
  readonly overheadText?: string; // "Dashed ring: overhead within 3 km"; the radar caption joins the two with " · "
  readonly footnote?: string; // dropped nearby and recent entries
  readonly recentNote: string;
  readonly attribution?: string;
}

/** The drawer's local UI state. */
export interface SkyDrawerUi {
  readonly view: SkyView;
  readonly sort: SkySort;
  readonly filter: string;
  readonly expanded?: string;
}

interface SkySelector {
  state(input: SelectorInput): SkyState; // cheap, every render
  panel(input: SelectorInput, state: SkyState): SkyPanelVM;
  drawer(input: SelectorInput, state: SkyState, ui: SkyDrawerUi): SkyDrawerVM;
}

const SKY_VIEWS: readonly SkyView[] = Object.freeze(['nearby', 'overhead', 'recent']);
export const SKY_VIEW_LABELS: Readonly<Record<SkyView, string>> = Object.freeze({
  nearby: 'Nearby',
  overhead: 'Overhead',
  recent: 'Recent',
});
const SKY_SORTS_BY_VIEW: Readonly<Record<SkyView, readonly SkySort[]>> = Object.freeze({
  nearby: Object.freeze(['distance', 'altitude', 'name'] as const),
  overhead: Object.freeze(['distance', 'altitude', 'name'] as const),
  recent: Object.freeze(['latest', 'distance', 'altitude', 'name'] as const),
});
export const SKY_SORT_LABELS: Readonly<Record<SkySort, string>> = Object.freeze({
  distance: 'Distance',
  altitude: 'Altitude',
  name: 'Name',
  latest: 'Latest',
});
/** The search filter is trimmed and cut to this many characters before it is applied. */
export const SKY_FILTER_MAX_CHARS = 40;

/** Fixed captions and labels, so the panel, drawer and tests word them the same way (AIRSPACE.md §3, §4). */
export const SKY_LABELS = Object.freeze({
  heading: 'Sky',
  details: 'Sky details',
  notLive: 'Not live',
  overhead: 'Overhead',
  icao: 'ICAO address',
  altitude: 'Barometric altitude',
  speed: 'Ground speed',
  track: 'Ground track',
  vertical: 'Vertical speed',
  fromHome: 'From home',
  recentPass: 'At last overhead pass',
  lastKnown: 'Last known',
  route: 'Reported route · unverified',
  search: 'Find aircraft',
  show: 'Show',
  sort: 'Sort',
  sources: 'Sources',
  conditions: 'Conditions',
  newTab: ', opens in a new tab',
  aircraftLink: 'Track on ADSB.lol',
  /** The panel and the drawer when their selector throws. */
  failed: "The sky couldn't be shown.",
} as const);

/** One status's wording: the panel line and the drawer banner (AIRSPACE.md §4). */
interface StatusCopy {
  readonly panel: string;
  readonly banner: string;
}

/** Non-live statuses whose copy does not depend on the data. */
const SKY_STATUS_COPY: Readonly<
  Record<'loading' | 'missing' | 'waiting' | 'unavailable' | 'unsupported' | 'malformed', StatusCopy>
> = Object.freeze({
  loading: { panel: 'Loading the sky.', banner: 'Loading the sky.' },
  missing: {
    panel: 'Sky sensor not found',
    banner: "The configured sky sensor is not in Home Assistant. Check the collector and the card's airspace entity.",
  },
  waiting: {
    panel: 'Waiting for aircraft data',
    banner: "Home Assistant has the sky sensor but no aircraft data yet. It appears with the collector's next update.",
  },
  unavailable: {
    panel: 'Aircraft data unavailable',
    banner: 'The aircraft feed is not reporting. It returns when the collector publishes fresh data.',
  },
  unsupported: {
    panel: 'Unsupported sky data',
    banner: 'The sky sensor uses a newer data format than this dashboard understands. Update the dashboard.',
  },
  malformed: {
    panel: 'Sky data could not be read',
    banner: 'The latest sky data was incomplete or invalid, so nothing is shown.',
  },
});

/** Malformed variants with a specific cause. */
const SKY_MALFORMED_COPY: Readonly<Record<'skewAhead' | 'noData', StatusCopy>> = Object.freeze({
  skewAhead: {
    panel: "Sky data is ahead of this device's clock",
    banner: "The sky data is timestamped ahead of this device's clock. Check the device time.",
  },
  noData: {
    panel: 'No aircraft data from the sky sensor',
    banner: "The sky sensor reports a value but no aircraft data. Check the collector and the card's airspace entity.",
  },
});

/** Not-live wording by cause and by what can still be drawn. */
const SKY_NOT_LIVE_COPY = Object.freeze({
  offline: {
    panel: 'Not live while Home Assistant is offline',
    withAircraft: 'Not live. Showing the last aircraft received.',
    noAircraft: 'Not live. No aircraft were reported in the last update.',
    notDrawable: 'Not live. Aircraft return when Home Assistant reconnects.',
  },
  stale: {
    panel: 'No fresh aircraft data',
    withAircraft: 'Not live. Positions have changed since the last update.',
    noAircraft: 'Not live. The last update reported no aircraft.',
    notDrawable: 'No fresh aircraft data.',
  },
} as const);

/** The stale pill: an own warning, never a permanent "Live" pill (AIRSPACE.md §4). */
const NOT_LIVE_PILL: SkyPill = Object.freeze({ label: SKY_LABELS.notLive, tone: 'attention' });
/** Vertical rates below this magnitude read as level flight. */
const LEVEL_FPM = 250;
/** Distances below this many display units keep one decimal; at or above it they are whole numbers. */
const ONE_DECIMAL_BELOW = 10;
const MS_PER_MINUTE = 60_000;
const DEGREE = '°';
const DEGREE_DIGITS = 3;
const FULL_TURN_DEG = 360;
const ROUTE_ARROW = '→';
const UNIT_WORDS: Readonly<Record<LengthUnit, string>> = Object.freeze({ km: 'kilometres', mi: 'miles' });
const TREND_WORDS: Readonly<Record<TrendKind, TrendWord>> = Object.freeze({
  climbing: 'Climbing',
  descending: 'Descending',
  level: 'Level',
});
const RECENT_WINDOW_TEXT = 'in the last 30 minutes';
const NO_MATCH_TEXT = 'No aircraft match this search.';

type Place = 'panel' | 'banner';

/** Every AircraftVM of one snapshot, by hex; rebuilt only when what they read changes. */
interface AircraftVMs {
  readonly nearby: ReadonlyMap<string, AircraftVM>;
  readonly recent: ReadonlyMap<string, AircraftVM>;
}

/**
 * The sky selector (AIRSPACE.md §6). One per component instance: it memoizes the aircraft VMs (keyed on the snapshot,
 * liveness, formatter, host kind and the minute bucket of the "seen" ages), the drawer rows and the radar VM.
 */
export function createSkySelector(): SkySelector {
  const vmsMemo = memoLast<AircraftVMs>();
  const rowsMemo = memoLast<{ readonly items: readonly Aircraft[]; readonly rows: readonly AircraftVM[] }>();
  const radarMemo = memoLast<RadarVM>();

  function aircraftVMs(input: SelectorInput, parse: AirspaceSnapshot, live: boolean): AircraftVMs {
    const formatter = input.reader.formatter();
    const minute = Math.floor(input.now.getTime() / MS_PER_MINUTE);
    const linked = input.reader.kind === 'hass';
    return vmsMemo([parse, live, formatter, minute, linked], () => {
      const context: VMContext = { formatter, nowMs: minute * MS_PER_MINUTE, live, linked };
      return {
        nearby: new Map(parse.aircraft.map((item) => [item.hex, aircraftVM(item, 'nearby', context)])),
        recent: new Map(parse.recent.map((item) => [item.hex, aircraftVM(item, 'recent', context)])),
      };
    });
  }

  return Object.freeze({
    state: (input: SelectorInput) => airspaceState(input),

    panel(input: SelectorInput, state: SkyState): SkyPanelVM {
      const formatter = input.reader.formatter();
      const freshness = freshnessVM(state, formatter, 'panel');
      const parse = state.parse;
      if (parse === undefined) return { freshness };
      const radius = withinText(parse.radiusKm, formatter);
      if (state.status !== 'live' && state.status !== 'empty') return { freshness, radiusText: radius };
      const live = state.status === 'live';
      const vms = aircraftVMs(input, parse, true);
      const overhead = parse.aircraft.filter((item) => item.overhead);
      const nearest = live ? (nearestOf(overhead) ?? nearestOf(parse.aircraft)) : undefined;
      const nearestVM = nearest === undefined ? undefined : vms.nearby.get(nearest.hex);
      return {
        freshness,
        count: parse.aircraft.length,
        countLabel: live ? `aircraft ${radius}` : `Quiet skies ${radius}`,
        ...(live && { overheadCount: overhead.length }),
        radiusText: radius,
        ...(nearestVM !== undefined && { nearest: nearestVM }),
        ...(parse.droppedNearby > 0 && { droppedText: `${entries(parse.droppedNearby)} not shown` }),
      };
    },

    drawer(input: SelectorInput, state: SkyState, ui: SkyDrawerUi): SkyDrawerVM {
      const formatter = input.reader.formatter();
      const freshness = freshnessVM(state, formatter, 'banner');
      const view = SKY_VIEWS.includes(ui.view) ? ui.view : 'nearby';
      const sorts = SKY_SORTS_BY_VIEW[view];
      const sort = sorts.includes(ui.sort) ? ui.sort : defaultSkySort(view);
      const parse = state.parse;
      const base = {
        freshness,
        view,
        sorts,
        sort,
        recentNote: recentNote(parse, formatter),
        ...(parse?.attribution !== undefined && { attribution: parse.attribution }),
        // The radar caption joins these two with " · " (AIRSPACE.md §6).
        ...(parse !== undefined && {
          radiusText: capitalize(withinText(parse.radiusKm, formatter)),
          overheadText: `Dashed ring: overhead ${withinText(parse.overheadKm, formatter)}`,
        }),
      };
      if (parse === undefined || !state.drawable) {
        return { ...base, views: viewOptions(), rows: [], total: 0, searchable: false };
      }
      const live = state.status === 'live' || state.status === 'empty';
      const vms = aircraftVMs(input, parse, live);
      const filter = normalizeFilter(ui.filter);
      const { items, rows } = rowsMemo([vms, parse, view, sort, filter], () => {
        const inView = viewItems(parse, view);
        const byHex = view === 'recent' ? vms.recent : vms.nearby;
        return {
          items: inView,
          rows: sortAircraft(inView, sort)
            .filter((item) => matchesFilter(item, filter))
            .map((item) => byHex.get(item.hex))
            .filter((vm): vm is AircraftVM => vm !== undefined),
        };
      });
      const expanded =
        ui.expanded !== undefined && rows.some((row) => row.key === ui.expanded) ? ui.expanded : undefined;
      // Marks are current positions: a recent row (a past pass) never highlights the same aircraft's live mark.
      const markExpanded = view === 'recent' ? undefined : expanded;
      const radar = radarMemo([parse, live, markExpanded, formatter], () =>
        radarVM(parse, live, markExpanded, formatter, vms.nearby),
      );
      const footnote = droppedFootnote(parse);
      const emptyText =
        rows.length > 0 ? undefined : items.length > 0 ? NO_MATCH_TEXT : emptyViewText(view, live, parse, formatter);
      return {
        ...base,
        views: viewOptions(parse),
        rows,
        total: items.length,
        searchable: items.length >= SEARCH_MIN_ROWS || filter !== '',
        ...(emptyText !== undefined && { emptyText }),
        ...(expanded !== undefined && { expanded }),
        radar,
        ...(footnote !== undefined && { footnote }),
      };
    },
  });
}

/** The entity the Sky panel subscribes to: [] when airspace is not configured. */
export function airspaceEntityIds(config: ResolvedConfig): EntityId[] {
  return config.airspace === undefined ? [] : [config.airspace.entity];
}

/** The view's default sort: 'latest' in Recent, else 'distance'. */
export function defaultSkySort(view: SkyView): SkySort {
  return view === 'recent' ? 'latest' : 'distance';
}

// ---------------------------------------------------------------------------------------------------------------
// Freshness and copy (AIRSPACE.md §4)

function freshnessVM(state: SkyState, formatter: Formatter, place: Place): SkyFreshnessVM {
  const live = state.status === 'live' || state.status === 'empty';
  const ageText = state.parse === undefined ? undefined : ageLine(state, live, formatter);
  const sentence = statusSentence(state, place);
  return {
    status: state.status,
    live,
    ...(state.status === 'stale' && { pill: NOT_LIVE_PILL }),
    ...(ageText !== undefined && { ageText }),
    ...(sentence !== undefined && { sentence }),
  };
}

/** "Updated just now" while live; "Last update 7 min ago" otherwise; minute granularity, never negative. */
function ageLine(state: SkyState, live: boolean, formatter: Formatter): string {
  const prefix = live ? 'Updated' : 'Last update';
  return `${prefix} ${agoText(state.ageMs ?? 0, formatter)}`;
}

/** "just now" under a minute (and for clock skew), else "4 min ago" / "1 h 5 min ago". */
function agoText(ageMs: number, formatter: Formatter): string {
  return ageMs < MS_PER_MINUTE
    ? 'just now'
    : `${formatter.duration(Math.floor(ageMs / MS_PER_MINUTE) * MS_PER_MINUTE)} ago`;
}

/** The sentence for a non-live state (AIRSPACE.md §4); an exhaustive switch, so a new status is a compile error. */
function statusSentence(state: SkyState, place: Place): string | undefined {
  switch (state.status) {
    case 'live':
    case 'empty':
      return undefined;
    case 'loading':
    case 'missing':
    case 'waiting':
    case 'unavailable':
    case 'unsupported':
      return SKY_STATUS_COPY[state.status][place];
    case 'malformed':
      if (state.skewAhead) return SKY_MALFORMED_COPY.skewAhead[place];
      if (state.noData) return SKY_MALFORMED_COPY.noData[place];
      return SKY_STATUS_COPY.malformed[place];
    case 'offline':
    case 'stale': {
      const copy = SKY_NOT_LIVE_COPY[state.status];
      if (place === 'panel') return copy.panel;
      if (!state.drawable) return copy.notDrawable;
      return (state.parse?.aircraft.length ?? 0) > 0 ? copy.withAircraft : copy.noAircraft;
    }
    default:
      return unreachable(state.status);
  }
}

function unreachable(status: never): never {
  throw new Error(`Unhandled sky status ${String(status)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Aircraft view models (AIRSPACE.md §3)

interface VMContext {
  readonly formatter: Formatter;
  readonly nowMs: number; // the minute bucket's start, so "seen" ages change once a minute
  readonly live: boolean;
  readonly linked: boolean; // live HA mode: the tracking-site link is offered
}

function aircraftVM(item: Aircraft, list: 'nearby' | 'recent', context: VMContext): AircraftVM {
  const { formatter } = context;
  const unit = formatter.lengthUnit;
  const bearing = compassPoint(item.bearingDeg);
  const altitude = item.altitudeFt === undefined ? undefined : altitudeText(item.altitudeFt, formatter);
  const trend = item.verticalFpm === undefined ? undefined : trendOf(item.verticalFpm, formatter);
  const overhead = list === 'nearby' && context.live && item.overhead;
  const distance = distanceText(item.distanceKm, formatter);
  const closest =
    item.closestKm === undefined
      ? undefined
      : `Closest ${distanceText(item.closestKm, formatter)} at last overhead pass`;
  const link = context.linked ? aircraftLink(item.hex) : undefined;
  const when = list === 'recent' ? ' at last overhead pass' : '';
  const spoken = [
    item.labelKind === 'hex' ? `${SKY_LABELS.icao} ${item.label}` : item.label,
    item.type,
    item.altitudeFt === undefined ? undefined : `${formatter.number(Math.round(item.altitudeFt))} feet barometric`,
    `${distanceNumber(item.distanceKm, formatter)} ${UNIT_WORDS[unit]} ${bearing.name}${when}`,
    trend?.kind,
    overhead ? 'overhead' : undefined,
  ];
  return Object.freeze({
    key: item.hex,
    label: item.label,
    labelKind: item.labelKind,
    icao: item.hex.toUpperCase(),
    ...(item.registration !== undefined && { registration: item.registration }),
    ...(item.type !== undefined && { type: item.type }),
    ...(altitude !== undefined && { altitude }),
    ...(item.speedKts !== undefined && {
      speed: formatter.withUnit(formatter.number(Math.round(item.speedKts)), 'kn'),
    }),
    ...(item.trackDeg !== undefined && {
      track: { deg: degreesText(item.trackDeg), compass: compassPoint(item.trackDeg).abbr },
    }),
    ...(trend !== undefined && { trend }),
    distance,
    bearing: { deg: degreesText(item.bearingDeg), compass: bearing.abbr },
    overhead,
    seen: `seen ${agoText(Math.max(0, context.nowMs - item.lastSeenMs), formatter)}`,
    ...(closest !== undefined && { closest }),
    ...(item.route !== undefined && { route: routeVM(item.route) }),
    accessibleName: spoken.filter((part): part is string => part !== undefined).join(', '),
    ...(link !== undefined && { link }),
  });
}

/** "12,000 ft baro": barometric pressure altitude, never "MSL" or height above the house (AIRSPACE.md §3). */
function altitudeText(feet: number, formatter: Formatter): string {
  return `${formatter.withUnit(formatter.number(Math.round(feet)), 'ft')} baro`;
}

/** |fpm| below LEVEL_FPM is level; otherwise climbing or descending with the rate. */
function trendOf(fpm: number, formatter: Formatter): NonNullable<AircraftVM['trend']> {
  if (Math.abs(fpm) < LEVEL_FPM) return { kind: 'level', word: TREND_WORDS.level, text: TREND_WORDS.level };
  const kind = fpm > 0 ? 'climbing' : 'descending';
  const word = TREND_WORDS[kind];
  const rate = formatter.withUnit(formatter.number(Math.abs(Math.round(fpm))), 'ft/min');
  return { kind, word, text: `${word} · ${rate}` };
}

function routeVM(route: NonNullable<Aircraft['route']>): NonNullable<AircraftVM['route']> {
  const named = route.originName !== undefined || route.destinationName !== undefined;
  return {
    codes: `${route.origin} ${ROUTE_ARROW} ${route.destination}`,
    ...(named && {
      names: `${route.originName ?? route.origin} ${ROUTE_ARROW} ${route.destinationName ?? route.destination}`,
    }),
    ...(route.airline !== undefined && { airline: route.airline }),
    source: route.source,
  };
}

/** "045°": whole degrees, three digits. */
function degreesText(deg: number): string {
  return `${String(Math.round(deg) % FULL_TURN_DEG).padStart(DEGREE_DIGITS, '0')}${DEGREE}`;
}

/** A distance in the HA length unit: one decimal below 10 units, whole at or above ("2.1 km", "12 mi"). */
function distanceText(km: number, formatter: Formatter): string {
  return formatter.withUnit(distanceNumber(km, formatter), formatter.lengthUnit);
}

function distanceNumber(km: number, formatter: Formatter): string {
  const value = toDisplayUnit(km, formatter.lengthUnit);
  const digits = Math.round(value * 10) / 10 < ONE_DECIMAL_BELOW ? 1 : 0;
  return formatter.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "within 25 km", "within 15.5 mi": one decimal unless the value is whole at that precision. */
function withinText(km: number, formatter: Formatter): string {
  const value = Math.round(toDisplayUnit(km, formatter.lengthUnit) * 10) / 10;
  const digits = Number.isInteger(value) ? 0 : 1;
  const text = formatter.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `within ${formatter.withUnit(text, formatter.lengthUnit)}`;
}

function toDisplayUnit(km: number, unit: LengthUnit): number {
  return unit === 'mi' ? km * MILES_PER_KM : km;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "1 entry", "2 entries"; with a qualifier, "2 nearby entries". */
function entries(count: number, qualifier?: 'nearby' | 'recent'): string {
  const noun = count === 1 ? 'entry' : 'entries';
  return qualifier === undefined ? `${count} ${noun}` : `${count} ${qualifier} ${noun}`;
}

/** The drawer footnote for dropped rows of both lists: "2 nearby entries and 1 recent entry in the latest …". */
function droppedFootnote(parse: AirspaceSnapshot): string | undefined {
  const parts = [
    parse.droppedNearby > 0 ? entries(parse.droppedNearby, 'nearby') : undefined,
    parse.droppedRecent > 0 ? entries(parse.droppedRecent, 'recent') : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : `${parts.join(' and ')} in the latest sky data could not be shown.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Drawer views, sorting, filtering and the radar (AIRSPACE.md §6)

/**
 * The aircraft a view lists. Overhead filters by the snapshot's distance rule whether or not it is live: stale rows
 * are listed (under the "Not live" banner) but never emphasised, because AircraftVM.overhead needs liveness too.
 */
function viewItems(parse: AirspaceSnapshot, view: SkyView): readonly Aircraft[] {
  switch (view) {
    case 'nearby':
      return parse.aircraft;
    case 'overhead':
      return parse.aircraft.filter((item) => item.overhead);
    case 'recent':
      return parse.recent;
  }
}

function viewOptions(parse?: AirspaceSnapshot): readonly SkyViewOption[] {
  return SKY_VIEWS.map((id) => {
    if (parse === undefined) return { id, label: SKY_VIEW_LABELS[id] };
    const count = id === 'recent' && parse.recentFull ? `${RECENT_MAX}+` : viewItems(parse, id).length;
    return { id, label: SKY_VIEW_LABELS[id], count };
  });
}

/** A new sorted array; ties fall back to the label, then the hex, so the order is total and stable. */
function sortAircraft(items: readonly Aircraft[], sort: SkySort): Aircraft[] {
  const byName = (a: Aircraft, b: Aircraft): number =>
    a.label.localeCompare(b.label, undefined, { numeric: true }) || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0);
  const compare: Readonly<Record<SkySort, (a: Aircraft, b: Aircraft) => number>> = {
    distance: (a, b) => a.distanceKm - b.distanceKm || byName(a, b),
    altitude: (a, b) =>
      (b.altitudeFt ?? Number.NEGATIVE_INFINITY) - (a.altitudeFt ?? Number.NEGATIVE_INFINITY) || byName(a, b),
    name: byName,
    latest: (a, b) => b.lastSeenMs - a.lastSeenMs || a.distanceKm - b.distanceKm || byName(a, b),
  };
  return [...items].sort(compare[sort]);
}

/** Trimmed, at most SKY_FILTER_MAX_CHARS code points, lower-cased. */
function normalizeFilter(filter: string): string {
  return Array.from(filter.trim()).slice(0, SKY_FILTER_MAX_CHARS).join('').toLowerCase();
}

function matchesFilter(item: Aircraft, filter: string): boolean {
  if (filter === '') return true;
  return [
    item.label,
    item.callsign,
    item.registration,
    item.type,
    item.route?.airline,
    item.route?.origin,
    item.route?.destination,
  ].some((field) => field !== undefined && field.toLowerCase().includes(filter));
}

function emptyViewText(view: SkyView, live: boolean, parse: AirspaceSnapshot, formatter: Formatter): string {
  switch (view) {
    case 'nearby':
      return live
        ? `No aircraft ${withinText(parse.radiusKm, formatter)} right now.`
        : 'No aircraft were reported in the last update.';
    case 'overhead':
      return live ? 'Nothing overhead right now.' : 'Nothing was overhead in the last update.';
    case 'recent':
      return live
        ? `No aircraft passed overhead ${RECENT_WINDOW_TEXT}.`
        : 'No overhead passes were reported in the last update.';
  }
}

function recentNote(parse: AirspaceSnapshot | undefined, formatter: Formatter): string {
  const where = parse === undefined ? 'overhead' : withinText(parse.overheadKm, formatter);
  return `Aircraft seen ${where} ${RECENT_WINDOW_TEXT}, newest ${RECENT_MAX} kept. Fast flyovers can be missed.`;
}

function nearestOf(items: readonly Aircraft[]): Aircraft | undefined {
  return items.reduce<Aircraft | undefined>(
    (nearest, item) => (nearest === undefined || item.distanceKm < nearest.distanceKm ? item : nearest),
    undefined,
  );
}

function radarVM(
  parse: AirspaceSnapshot,
  live: boolean,
  expanded: string | undefined,
  formatter: Formatter,
  vms: ReadonlyMap<string, AircraftVM>,
): RadarVM {
  return Object.freeze({
    rings: radarRings(parse.radiusKm, parse.overheadKm, formatter.lengthUnit, formatter.number),
    marks: radarMarks(parse.aircraft, parse.radiusKm, { live, ...(expanded !== undefined && { expanded }) }),
    live,
    summary: radarSummary(parse, live, formatter, vms),
  });
}

/** "7 aircraft within 25 km, 1 overhead. Nearest DEMO214, 2.1 km north-west." */
function radarSummary(
  parse: AirspaceSnapshot,
  live: boolean,
  formatter: Formatter,
  vms: ReadonlyMap<string, AircraftVM>,
): string {
  const radius = withinText(parse.radiusKm, formatter);
  const prefix = live ? '' : 'Last update: ';
  if (parse.aircraft.length === 0) return `${prefix}No aircraft ${radius}.`;
  const overhead = parse.aircraft.filter((item) => item.overhead).length;
  const counts = `${parse.aircraft.length} aircraft ${radius}${live ? `, ${overhead} overhead` : ''}.`;
  const nearest = nearestOf(parse.aircraft);
  const vm = nearest === undefined ? undefined : vms.get(nearest.hex);
  const nearestText =
    nearest === undefined || vm === undefined
      ? ''
      : ` Nearest ${vm.label}, ${vm.distance} ${compassPoint(nearest.bearingDeg).name}.`;
  return `${prefix}${counts}${nearestText}`;
}

/**
 * A one-entry memo: the last value, recomputed whenever any key part changes identity (Object.is). Enough here,
 * because each component instance owns its own selector and renders one view at a time.
 */
function memoLast<T>(): (key: readonly unknown[], compute: () => T) => T {
  let last: { readonly key: readonly unknown[]; readonly value: T } | undefined;
  return (key, compute) => {
    if (
      last === undefined ||
      last.key.length !== key.length ||
      key.some((part, index) => !Object.is(part, last?.key[index]))
    ) {
      last = { key, value: compute() };
    }
    return last.value;
  };
}
