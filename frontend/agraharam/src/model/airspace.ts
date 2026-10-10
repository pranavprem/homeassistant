/**
 * Sky contract (AIRSPACE.md §2, §4, §5, §9): the collector sensor's attributes parsed into frozen, validated aircraft
 * lists, the panel's honest freshness status, and the only outbound URLs the feature may render.
 *
 * Attributes are untrusted. The parser reads named fields only (never spreads or iterates raw keys), checks every
 * number for finiteness and range and every string for length and charset, caps arrays before heavy work and never
 * reads position-like keys. It is pure and clock-independent, so a result memoized on the entity object's identity
 * is always correct; everything that depends on the clock lives in `airspaceState`, computed on every render.
 */
import type { EntityId } from '../config/schema.ts';
import type { StoreView } from '../ha/entity-store.ts';
import { normalizeEntity, type NormalizedEntity } from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { isoInstantMs } from './reading-value.ts';
import type { SelectorInput } from './types.ts';

interface ReportedRoute {
  readonly origin: string;
  readonly destination: string;
  readonly originName?: string;
  readonly destinationName?: string;
  readonly airline?: string;
  readonly source: string;
}

export interface Aircraft {
  readonly hex: string; // lower-case 6-hex ICAO address: the key for lists, ids and focus
  readonly label: string; // callsign ?? registration ?? upper-case hex
  readonly labelKind: 'callsign' | 'registration' | 'hex';
  readonly callsign?: string;
  readonly registration?: string;
  readonly type?: string;
  readonly altitudeFt?: number; // barometric
  readonly speedKts?: number; // ground speed
  readonly trackDeg?: number; // ground track, [0, 360)
  readonly verticalFpm?: number;
  readonly distanceKm: number;
  readonly bearingDeg: number; // [0, 360)
  /** Nearby: distanceKm <= overheadKm. Recent: always false (a past pass is never drawn as current). */
  readonly overhead: boolean;
  readonly lastSeenMs: number;
  readonly closestKm?: number; // recent only
  readonly route?: ReportedRoute;
}

type AirspaceParse =
  | {
      readonly kind: 'ok';
      readonly updatedMs: number;
      readonly radiusKm: number;
      readonly overheadKm: number;
      readonly provider?: string;
      readonly attribution?: string;
      readonly aircraft: readonly Aircraft[];
      readonly recent: readonly Aircraft[];
      /** RECENT_MAX valid passes are shown and the raw list held at least that many, so the label reads "12+".
       *  A full raw list with invalid rows never reads "12+" above fewer rows. */
      readonly recentFull: boolean;
      /** Raw nearby entries not shown: invalid, duplicate, beyond the examined rows or over the cap. */
      readonly droppedNearby: number;
      /** Raw recent entries not shown, counted the same way. */
      readonly droppedRecent: number;
    }
  | { readonly kind: 'absent' } // no envelope keys at all (HA restored a numeric state without attributes)
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'malformed' };

export type AirspaceSnapshot = Extract<AirspaceParse, { kind: 'ok' }>;

export type SkyStatus =
  | 'loading'
  | 'missing'
  | 'waiting'
  | 'unavailable'
  | 'unsupported'
  | 'malformed'
  | 'offline'
  | 'stale'
  | 'empty'
  | 'live';

export interface SkyState {
  readonly status: SkyStatus;
  /** Present only for offline, stale, empty and live, when the entity holds a valid snapshot. */
  readonly parse?: AirspaceSnapshot;
  readonly ageMs?: number; // now − updatedMs, clamped at ≥ 0
  readonly skewAhead: boolean; // malformed because updated_at is ahead of this device's clock
  readonly noData: boolean; // malformed because the sensor reports a value but never any aircraft data
  /** The list and radar may be shown: live or empty, or stale/offline data at most DRAWABLE_MAX_AGE_MS old. */
  readonly drawable: boolean;
}

/** The only contract version this card reads; any other present value is 'unsupported'. */
const AIRSPACE_SCHEMA_VERSION = 1;
/** Collector caps (AIRSPACE.md §2): nearby aircraft and the recent overhead passes it keeps. */
const AIRCRAFT_MAX = 50;
export const RECENT_MAX = 12;
/** Data older than this is not live (the collector's MQTT expire_after is 180 s as well). */
const STALE_AFTER_MS = 180_000;
/** Stale or offline data older than this is no longer drawn at all, only described. */
const DRAWABLE_MAX_AGE_MS = 15 * 60_000;
/** A timestamp further ahead of this device's clock than this is blamed on the device clock, never shown. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
/** How long a sensor without aircraft data may read "Waiting" before it is reported as having no data. */
const WAITING_MAX_MS = 180_000;

/** The tracking-site link prefix; `aircraftLink` appends only a validated 6-hex address (AIRSPACE.md §9). */
const AIRCRAFT_LINK_PREFIX = 'https://globe.adsb.lol/?icao=';

interface SkySource {
  readonly key: 'positions' | 'routes';
  readonly href: string;
  readonly label: string;
}

/** The two source links shown under the drawer (AIRSPACE.md §9), each a constant reviewed URL. */
export const SKY_SOURCES: readonly SkySource[] = Object.freeze([
  Object.freeze({
    key: 'positions',
    href: 'https://www.adsb.lol/',
    label: 'ADSB.lol · aircraft positions (ODbL 1.0)',
  } as const),
  Object.freeze({
    key: 'routes',
    href: 'https://github.com/vradarserver/standing-data',
    label: 'VRS standing data · reported routes (CC0)',
  } as const),
]);

// ---------------------------------------------------------------------------------------------------------------
// Parsing (AIRSPACE.md §2): pure, clock-independent, memoized on the entity object

/** Validation bounds, never stricter than what the collector emits and never looser than finite and plausible. */
const BOUNDS = Object.freeze({
  radiusKm: { min: 1, max: 100 },
  overheadMinKm: 0.1,
  /** Rounding slack on distances measured against the radius or the overhead radius. */
  distanceSlack: 1.05,
  bearingDeg: { min: 0, max: 360 },
  altitudeFt: { min: -2000, max: 100_000 },
  speedKts: { min: 0, max: 2000 },
  verticalFpm: { min: -20_000, max: 20_000 },
} as const);
/** Only this many raw rows are examined, before any per-row work (hostile payloads can be long). */
const AIRCRAFT_EXAMINED = 64;
const RECENT_EXAMINED = 24;
/** `last_seen` windows relative to `updated_at` (never to this device's clock): positions are at most 60 s old at
 *  the source and recent passes at most 30 minutes, each with tolerance for the collector's own clock. */
const SEEN_WINDOW_MS = Object.freeze({
  nearby: { before: 120_000, after: 5_000 },
  recent: { before: 35 * 60_000, after: 5_000 },
} as const);
/** Bounded label lengths in code points (AIRSPACE.md §2). */
const LABEL_MAX_CHARS = Object.freeze({ provider: 40, attribution: 160, source: 40, name: 80 } as const);
/** Raw strings longer than this many times their limit are rejected before any trimming or scanning. */
const RAW_LENGTH_FACTOR = 4;

const HEX_RE = /^[0-9A-Fa-f]{6}$/;
const KEY_HEX_RE = /^[0-9a-f]{6}$/;
const CALLSIGN_RE = /^[A-Za-z0-9]{2,8}$/;
const CALLSIGN_MAX_CHARS = 8;
const REGISTRATION_RE = /^[A-Za-z0-9-]{2,16}$/;
const REGISTRATION_MAX_CHARS = 16;
const TYPE_RE = /^[A-Za-z0-9]{2,8}$/;
const TYPE_MAX_CHARS = 8;
const AIRPORT_CODE_RE = /^[A-Za-z0-9]{3,4}$/;
const AIRPORT_CODE_MAX_CHARS = 4;
/** The sensor state is only a hint: a plain non-negative integer, else ignored. */
const STATE_HINT_RE = /^\d+$/;
/**
 * Characters a bounded label may never contain: controls, format characters (bidi overrides, zero-width), private
 * use, lone surrogates, line and paragraph separators, non-ASCII spaces, and the collector's banned symbols.
 */
const LABEL_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000<>"{}\\]/u;
/** The only route status the card shows; anything else (and a route without a source) is dropped. */
const REPORTED_STATUS = 'reported';

const ABSENT: AirspaceParse = Object.freeze({ kind: 'absent' });
const UNSUPPORTED: AirspaceParse = Object.freeze({ kind: 'unsupported' });
const MALFORMED: AirspaceParse = Object.freeze({ kind: 'malformed' });

type RawRecord = Readonly<Record<string, unknown>>;
type ListKind = keyof typeof SEEN_WINDOW_MS;

interface RowContext {
  readonly updatedMs: number;
  readonly radiusKm: number;
  readonly overheadKm: number;
}

const parseCache = new WeakMap<HassEntityLike, AirspaceParse>();

/** Pure and clock-independent; memoized on the entity object's identity. */
export function parseAirspace(entity: HassEntityLike): AirspaceParse {
  let parsed = parseCache.get(entity);
  if (parsed === undefined) {
    parsed = parseEntity(entity);
    parseCache.set(entity, parsed);
  }
  return parsed;
}

function parseEntity(entity: HassEntityLike): AirspaceParse {
  const attributes: unknown = entity.attributes;
  if (!isRecord(attributes)) return ABSENT;
  if (!['schema_version', 'updated_at', 'aircraft'].some((key) => Object.hasOwn(attributes, key))) return ABSENT;
  const version = own(attributes, 'schema_version');
  if (version === undefined) return MALFORMED;
  if (version !== AIRSPACE_SCHEMA_VERSION) return UNSUPPORTED;

  const updatedMs = isoInstantMs(own(attributes, 'updated_at'));
  const radiusKm = finiteIn(own(attributes, 'radius_km'), BOUNDS.radiusKm.min, BOUNDS.radiusKm.max);
  const overheadKm =
    radiusKm === undefined
      ? undefined
      : finiteIn(own(attributes, 'overhead_radius_km'), BOUNDS.overheadMinKm, radiusKm);
  const rawAircraft = own(attributes, 'aircraft');
  const rawRecent = own(attributes, 'recent');
  if (
    updatedMs === undefined ||
    radiusKm === undefined ||
    overheadKm === undefined ||
    !Array.isArray(rawAircraft) ||
    !Array.isArray(rawRecent)
  ) {
    return MALFORMED;
  }

  const context: RowContext = { updatedMs, radiusKm, overheadKm };
  const aircraft = parseRows(rawAircraft, AIRCRAFT_EXAMINED, AIRCRAFT_MAX, context, 'nearby');
  const recent = parseRows(rawRecent, RECENT_EXAMINED, RECENT_MAX, context, 'recent');
  // All-invalid rule (AIRSPACE.md §2): rows that were sent but none of which could be read, or a count with no rows,
  // are never "quiet skies".
  const hint = STATE_HINT_RE.test(entity.state) ? Number(entity.state) : 0;
  if ((rawAircraft.length > 0 && aircraft.length === 0) || (hint > 0 && rawAircraft.length === 0)) return MALFORMED;

  const provider = boundedLabel(own(attributes, 'provider'), LABEL_MAX_CHARS.provider);
  const attribution = boundedLabel(own(attributes, 'attribution'), LABEL_MAX_CHARS.attribution);
  return Object.freeze({
    kind: 'ok',
    updatedMs,
    radiusKm,
    overheadKm,
    ...(provider !== undefined && { provider }),
    ...(attribution !== undefined && { attribution }),
    aircraft,
    recent,
    recentFull: recent.length === RECENT_MAX && rawRecent.length >= RECENT_MAX,
    droppedNearby: rawAircraft.length - aircraft.length,
    droppedRecent: rawRecent.length - recent.length,
  });
}

/** The first `examined` raw rows, valid ones kept in order, the first of each hex only, at most `max`. */
function parseRows(
  raw: readonly unknown[],
  examined: number,
  max: number,
  context: RowContext,
  list: ListKind,
): readonly Aircraft[] {
  const rows: Aircraft[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, examined)) {
    const row = parseAircraft(item, context, list);
    if (row === undefined || seen.has(row.hex)) continue;
    seen.add(row.hex);
    rows.push(row);
    if (rows.length === max) break;
  }
  return Object.freeze(rows);
}

/** One aircraft row; undefined when any required field fails its rule. Optional fields that fail are omitted. */
function parseAircraft(raw: unknown, context: RowContext, list: ListKind): Aircraft | undefined {
  if (!isRecord(raw)) return undefined;
  const rawHex = own(raw, 'hex');
  const hex = typeof rawHex === 'string' && HEX_RE.test(rawHex) ? rawHex.toLowerCase() : undefined;
  const distanceKm = finiteIn(own(raw, 'distance_km'), 0, context.radiusKm * BOUNDS.distanceSlack);
  const bearingDeg = finiteIn(own(raw, 'bearing_deg'), BOUNDS.bearingDeg.min, BOUNDS.bearingDeg.max);
  const overhead = own(raw, 'overhead');
  const lastSeenMs = isoInstantMs(own(raw, 'last_seen'));
  if (
    hex === undefined ||
    distanceKm === undefined ||
    bearingDeg === undefined ||
    typeof overhead !== 'boolean' ||
    lastSeenMs === undefined ||
    !withinSeenWindow(lastSeenMs, context.updatedMs, list)
  ) {
    return undefined;
  }
  const callsign = code(own(raw, 'callsign'), CALLSIGN_RE, CALLSIGN_MAX_CHARS);
  const registration = code(own(raw, 'registration'), REGISTRATION_RE, REGISTRATION_MAX_CHARS);
  const type = code(own(raw, 'aircraft_type'), TYPE_RE, TYPE_MAX_CHARS);
  const altitudeFt = finiteIn(own(raw, 'altitude_ft'), BOUNDS.altitudeFt.min, BOUNDS.altitudeFt.max);
  const speedKts = finiteIn(own(raw, 'speed_kts'), BOUNDS.speedKts.min, BOUNDS.speedKts.max);
  const trackDeg = finiteIn(own(raw, 'track_deg'), BOUNDS.bearingDeg.min, BOUNDS.bearingDeg.max);
  const verticalFpm = finiteIn(own(raw, 'vertical_rate_fpm'), BOUNDS.verticalFpm.min, BOUNDS.verticalFpm.max);
  const closestKm =
    list === 'recent'
      ? finiteIn(own(raw, 'closest_distance_km'), 0, context.overheadKm * BOUNDS.distanceSlack)
      : undefined;
  const route = parseRoute(own(raw, 'route'));
  const label = callsign ?? registration ?? hex.toUpperCase();
  const labelKind = callsign !== undefined ? 'callsign' : registration !== undefined ? 'registration' : 'hex';
  return Object.freeze({
    hex,
    label,
    labelKind,
    ...(callsign !== undefined && { callsign }),
    ...(registration !== undefined && { registration }),
    ...(type !== undefined && { type }),
    ...(altitudeFt !== undefined && { altitudeFt }),
    ...(speedKts !== undefined && { speedKts }),
    ...(trackDeg !== undefined && { trackDeg: trackDeg % 360 }),
    ...(verticalFpm !== undefined && { verticalFpm }),
    distanceKm,
    bearingDeg: bearingDeg % 360,
    // The UI's single source of truth for "overhead" is the distance; the row's own flag is only required to be a
    // boolean. A recent pass is history, never drawn as overhead now.
    overhead: list === 'nearby' && distanceKm <= context.overheadKm,
    lastSeenMs,
    ...(closestKm !== undefined && { closestKm }),
    ...(route !== undefined && { route }),
  });
}

function withinSeenWindow(lastSeenMs: number, updatedMs: number, list: ListKind): boolean {
  const window = SEEN_WINDOW_MS[list];
  return lastSeenMs >= updatedMs - window.before && lastSeenMs <= updatedMs + window.after;
}

/**
 * A community-reported route (AIRSPACE.md §2, Routes): kept only with status 'reported', a bounded source label and two
 * different airport codes. Round trips are dropped by design; `flight_number` is never read (the collector copies
 * the callsign into it, and a flight number would read as a schedule).
 */
function parseRoute(raw: unknown): ReportedRoute | undefined {
  if (!isRecord(raw) || own(raw, 'status') !== REPORTED_STATUS) return undefined;
  const source = boundedLabel(own(raw, 'source'), LABEL_MAX_CHARS.source);
  const origin = code(own(raw, 'origin'), AIRPORT_CODE_RE, AIRPORT_CODE_MAX_CHARS);
  const destination = code(own(raw, 'destination'), AIRPORT_CODE_RE, AIRPORT_CODE_MAX_CHARS);
  if (source === undefined || origin === undefined || destination === undefined || origin === destination) {
    return undefined;
  }
  const originName = boundedLabel(own(raw, 'origin_name'), LABEL_MAX_CHARS.name);
  const destinationName = boundedLabel(own(raw, 'destination_name'), LABEL_MAX_CHARS.name);
  const airline = boundedLabel(own(raw, 'airline'), LABEL_MAX_CHARS.name);
  return Object.freeze({
    origin,
    destination,
    ...(originName !== undefined && { originName }),
    ...(destinationName !== undefined && { destinationName }),
    ...(airline !== undefined && { airline }),
    source,
  });
}

/** A plain object: not null, not an array. Prototype keys are never read because every read goes through `own`. */
function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A named own field, or undefined: inherited and unknown keys are never read, spread or iterated. */
function own(record: RawRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A finite number in [min, max]; numeric strings, booleans, NaN and ±Infinity are rejected, never coerced. */
function finiteIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** An identifier code: trimmed, ASCII-checked by `pattern`, then upper-cased. */
function code(value: unknown, pattern: RegExp, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxChars * RAW_LENGTH_FACTOR) return undefined;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

/** A display label (AIRSPACE.md §2): raw length pre-checked, trimmed, 1 to `maxChars` code points, no forbidden
 *  characters. */
function boundedLabel(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxChars * RAW_LENGTH_FACTOR) return undefined;
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length === 0 || length > maxChars || LABEL_FORBIDDEN_RE.test(trimmed)) return undefined;
  return trimmed;
}

// ---------------------------------------------------------------------------------------------------------------
// Status (AIRSPACE.md §4, §5): computed on every render, never cached

/**
 * When the card first saw each sensor without aircraft data, per store. Shared by the panel and the drawer so both
 * agree on the waiting bound; it stores a time, never data. Any other observation of the sensor (an envelope,
 * unavailable, unknown or missing) clears it, so a sensor restored later without attributes gets a fresh window.
 */
const absentSince = new WeakMap<StoreView, Map<EntityId, number>>();
/** States HA uses for "no value" (normalize reads '' as unknown too). */
const UNAVAILABLE_STATES: ReadonlySet<string> = new Set(['unavailable', 'unknown', '']);

/** The sky status for this render (AIRSPACE.md §4). Never cached: it reads the clock. */
export function airspaceState(input: SelectorInput): SkyState {
  const binding = input.config.airspace;
  if (binding === undefined) return bare('missing');
  const normalized = normalizeEntity(input.store, binding.entity);
  if (normalized.status === 'loading') return bare('loading');
  const nowMs = input.now.getTime();
  const base = entityState(input.store, normalized, nowMs);
  // Offline is a layer over data only, and only while HA is disconnected or resyncing (isConnected covers both).
  // normalize also reads 'disconnected' for an entity the reconnect snapshot did not replace while HA is connected;
  // that entity is judged by its own updated_at instead, so it turns stale and then undrawable by age.
  // An unavailable, missing or malformed entity keeps its own status.
  const offline = !input.store.isConnected();
  const status =
    offline && (base.status === 'live' || base.status === 'empty' || base.status === 'stale') ? 'offline' : base.status;
  return Object.freeze({ ...base, status, drawable: isDrawable(status, base.ageMs) });
}

/** The entity's own status, from the last-known entity object normalize hands back. */
function entityState(store: StoreView, normalized: NormalizedEntity, nowMs: number): SkyState {
  switch (normalized.status) {
    case 'loading':
      return bare('loading'); // not an observation of the sensor: the waiting window is left as it is
    case 'missing-binding':
      return withoutData(store, normalized.id, 'missing');
    case 'unavailable':
    case 'unknown':
    case 'privacy':
    case 'permission-denied':
      return withoutData(store, normalized.id, 'unavailable');
    case 'available':
    case 'disconnected':
      return normalized.entity === undefined
        ? withoutData(store, normalized.id, 'missing')
        : snapshotState(store, normalized.id, normalized.entity, nowMs);
  }
}

/** A sensor observed with no data to judge; like an envelope, it ends any waiting window. */
function withoutData(store: StoreView, id: EntityId, status: 'missing' | 'unavailable'): SkyState {
  absentSince.get(store)?.delete(id);
  return bare(status);
}

/** The last-known entity's own state: disconnected entities are judged by their last-delivered object too. */
function snapshotState(store: StoreView, id: EntityId, entity: HassEntityLike, nowMs: number): SkyState {
  if (UNAVAILABLE_STATES.has(entity.state)) return withoutData(store, id, 'unavailable');
  const parse = parseAirspace(entity);
  if (parse.kind === 'absent') return waitingState(store, id, entity, nowMs);
  absentSince.get(store)?.delete(id);
  switch (parse.kind) {
    case 'unsupported':
      return bare('unsupported');
    case 'malformed':
      return bare('malformed');
    case 'ok':
      return dataState(parse, nowMs);
  }
}

/**
 * HA restored the sensor without attributes. "Waiting" holds only while the card first saw it so ≤ WAITING_MAX_MS
 * ago AND HA's own last_updated is recent and not in the future; otherwise the sensor reports a value but no aircraft
 * data, which is malformed. A count that keeps changing without attributes therefore cannot hold "Waiting" forever.
 */
function waitingState(store: StoreView, id: EntityId, entity: HassEntityLike, nowMs: number): SkyState {
  let seen = absentSince.get(store);
  if (seen === undefined) {
    seen = new Map();
    absentSince.set(store, seen);
  }
  const since = seen.get(id) ?? nowMs;
  seen.set(id, since);
  const lastUpdated = isoInstantMs(entity.last_updated);
  const waiting =
    nowMs - since <= WAITING_MAX_MS &&
    lastUpdated !== undefined &&
    lastUpdated >= nowMs - WAITING_MAX_MS &&
    lastUpdated <= nowMs + CLOCK_SKEW_TOLERANCE_MS;
  return waiting ? bare('waiting') : Object.freeze({ ...bare('malformed'), noData: true });
}

function dataState(parse: AirspaceSnapshot, nowMs: number): SkyState {
  if (parse.updatedMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return Object.freeze({ ...bare('malformed'), skewAhead: true });
  }
  const ageMs = Math.max(0, nowMs - parse.updatedMs);
  const status = ageMs > STALE_AFTER_MS ? 'stale' : parse.aircraft.length === 0 ? 'empty' : 'live';
  return Object.freeze({ status, parse, ageMs, skewAhead: false, noData: false, drawable: false });
}

function isDrawable(status: SkyStatus, ageMs: number | undefined): boolean {
  if (status === 'live' || status === 'empty') return true;
  return (status === 'stale' || status === 'offline') && ageMs !== undefined && ageMs <= DRAWABLE_MAX_AGE_MS;
}

function bare(status: SkyStatus): SkyState {
  return Object.freeze({ status, skewAhead: false, noData: false, drawable: false });
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound links (AIRSPACE.md §9)

/** `AIRCRAFT_LINK_PREFIX` + the hex, or undefined unless `hex` is exactly six lower-case hex digits. */
export function aircraftLink(hex: string): string | undefined {
  return typeof hex === 'string' && KEY_HEX_RE.test(hex) ? `${AIRCRAFT_LINK_PREFIX}${hex}` : undefined;
}
