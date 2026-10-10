/**
 * Sky fixture (AIRSPACE.md §10). Only the `sky` scenario configures airspace; every other scenario is unchanged and
 * gets no config, no state. The other sky states come from the exported builders, used by unit and component tests
 * (and the clock and the shell's Disconnect in e2e).
 *
 * Fictional by construction, and enforced by tests/sky/airspace.test.ts: ICAO addresses in the unallocated block
 * 000001–003FFF (/^00[0-3][0-9a-f]{3}$/), callsigns starting DEMO or TEST, registrations starting N0 (US N-numbers
 * never start with 0), route codes starting X (no ICAO region uses it), generic airport names, the one airline
 * "Example Air" and generic type designators. No coordinates and no places; times come from the fixture clock. The
 * hostile payload's latitude/longitude keys hold 0 or out-of-range values only, never a plausible position.
 *
 * Dev-boundary note (§10.3): FakeHass reaches this file, so it imports only fixture types.
 */
import type { DemoScenarioId } from '../../config/schema.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

export const DEMO_SKY_AIRSPACE = 'sensor.demo_sky_airspace';

export const SKY_FIXTURE_KINDS = Object.freeze(['normal', 'dense', 'degraded', 'empty', 'hostile'] as const);
export type SkyFixtureKind = (typeof SKY_FIXTURE_KINDS)[number];

/** The collector's defaults: 25 km nearby radius, 3 km overhead radius. */
const RADIUS_KM = 25;
const OVERHEAD_KM = 3;
const SOURCE = 'VRS via ADSB.lol';
const ATTRIBUTION = 'Aircraft positions: ADSB.lol (ODbL 1.0); reported routes: VRS via ADSB.lol (CC0)';
/** Minutes between the collector's snapshot and now: fresh, or the degraded payload's 7-minute-old one. */
const FRESH_UPDATE_MIN = 0.25;
const STALE_UPDATE_MIN = 7;
const SECONDS_PER_MINUTE = 60;
const TYPES = Object.freeze(['B738', 'A320', 'E75L', 'C172', 'B77W', 'A21N'] as const);
const DENSE_NEARBY = 50;
const DENSE_OVERHEAD = 3;
const DENSE_RECENT = 12;
const HOSTILE_ROWS = 200;
/** Generated hex addresses start here, inside the unallocated 000001–003FFF block. */
const GENERATED_HEX_BASE = 0x1000;
const GOLDEN_ANGLE_DEG = 137.5;

/** One fictional aircraft row as the collector emits it; `seenSec` is seconds before the snapshot. */
interface RowSpec {
  readonly hex: string;
  readonly callsign?: string;
  readonly registration?: string;
  readonly type?: string;
  readonly km: number;
  readonly bearing: number;
  readonly altitude?: number;
  readonly speed?: number;
  readonly track?: number;
  readonly vertical?: number;
  readonly seenSec: number;
  readonly closestKm?: number;
  readonly route?: Readonly<Record<string, unknown>>;
}

const REPORTED_ROUTE = Object.freeze({
  origin: 'XAAA',
  destination: 'XBBB',
  origin_name: 'Example International',
  destination_name: 'Sample Regional',
  airline: 'Example Air',
  flight_number: 'DEMO214',
  source: SOURCE,
  status: 'reported',
});

/** Normal: eight nearby (one overhead with a reported route, one registration-only, one hex-only, one without a
 *  track; climbing, descending and level), nearest first, and three recent overhead passes. */
const NORMAL_NEARBY: readonly RowSpec[] = Object.freeze([
  {
    hex: '001a2b',
    callsign: 'DEMO214',
    registration: 'N0214D',
    type: 'B738',
    km: 1.4,
    bearing: 315,
    altitude: 4800,
    speed: 212,
    track: 135,
    vertical: -640,
    seenSec: 2,
    route: REPORTED_ROUTE,
  },
  {
    hex: '002c3d',
    callsign: 'TEST88',
    type: 'A320',
    km: 6.2,
    bearing: 45,
    altitude: 9200,
    speed: 268,
    track: 60,
    vertical: 1800,
    seenSec: 4,
  },
  {
    hex: '003e4f',
    callsign: 'DEMO7',
    type: 'E75L',
    km: 9.8,
    bearing: 92,
    altitude: 17_000,
    speed: 341,
    track: 270,
    vertical: 0,
    seenSec: 3,
  },
  {
    hex: '000f12',
    registration: 'N0482Q',
    type: 'C172',
    km: 11.3,
    bearing: 180,
    altitude: 2500,
    speed: 96,
    track: 10,
    vertical: 64,
    seenSec: 9,
  },
  { hex: '001234', type: 'B77W', km: 14.6, bearing: 270, altitude: 33_000, speed: 472, track: 95, seenSec: 6 },
  {
    hex: '002468',
    callsign: 'TEST451',
    type: 'A21N',
    km: 17.9,
    bearing: 225,
    altitude: 24_000,
    speed: 405,
    seenSec: 12,
  },
  {
    hex: '0013ac',
    callsign: 'DEMO66',
    type: 'B738',
    km: 21.2,
    bearing: 22,
    altitude: 36_000,
    speed: 455,
    track: 200,
    vertical: -120,
    seenSec: 5,
  },
  {
    hex: '003bd5',
    callsign: 'TEST302',
    type: 'A320',
    km: 23.7,
    bearing: 158,
    altitude: 28_000,
    speed: 430,
    track: 330,
    vertical: -1200,
    seenSec: 8,
  },
]);

const NORMAL_RECENT: readonly RowSpec[] = Object.freeze([
  { ...(NORMAL_NEARBY[0] as RowSpec), seenSec: 2, closestKm: 1.1 },
  {
    hex: '00217e',
    callsign: 'TEST910',
    type: 'E75L',
    km: 2.6,
    bearing: 120,
    altitude: 6200,
    speed: 240,
    track: 300,
    vertical: 900,
    seenSec: 11 * SECONDS_PER_MINUTE,
    closestKm: 2.2,
  },
  {
    hex: '0031f0',
    registration: 'N0733K',
    type: 'C172',
    km: 1.9,
    bearing: 300,
    altitude: 1800,
    speed: 88,
    track: 15,
    seenSec: 23 * SECONDS_PER_MINUTE,
    closestKm: 0.9,
  },
]);

export const skyFixture: SectionFixture = {
  config: (scenario: DemoScenarioId) => (scenario === 'sky' ? { airspace: { entity: DEMO_SKY_AIRSPACE } } : {}),
  states: (scenario: DemoScenarioId, clock: FixtureClock) => (scenario === 'sky' ? [skyEntity('normal', clock)] : []),
};

/** The sky sensor as HA holds it: state = the nearby count, attributes = one fixture payload. */
export function skyEntity(kind: SkyFixtureKind, clock: FixtureClock): HassEntityLike {
  const attributes = skyAttributes(kind, clock);
  const aircraft = attributes['aircraft'];
  const count = Array.isArray(aircraft) ? aircraft.length : 0;
  return demoEntity(clock, DEMO_SKY_AIRSPACE, String(count), attributes, updateMinutesAgo(kind));
}

/** One fixture payload, every time relative to the fixture clock. */
export function skyAttributes(kind: SkyFixtureKind, clock: FixtureClock): Readonly<Record<string, unknown>> {
  switch (kind) {
    case 'normal':
      return envelope(clock, kind, NORMAL_NEARBY, NORMAL_RECENT);
    case 'dense':
      return envelope(clock, kind, denseNearby(), denseRecent());
    case 'degraded':
      return degraded(clock);
    case 'empty':
      return envelope(clock, kind, [], NORMAL_RECENT.slice(1));
    case 'hostile':
      return hostile(clock);
  }
}

function updateMinutesAgo(kind: SkyFixtureKind): number {
  return kind === 'degraded' ? STALE_UPDATE_MIN : FRESH_UPDATE_MIN;
}

function envelope(
  clock: FixtureClock,
  kind: SkyFixtureKind,
  nearby: readonly RowSpec[],
  recent: readonly RowSpec[],
): Readonly<Record<string, unknown>> {
  const updatedMin = updateMinutesAgo(kind);
  return Object.freeze({
    schema_version: 1,
    provider: 'ADSB.lol',
    attribution: ATTRIBUTION,
    updated_at: clock.at(-updatedMin),
    radius_km: RADIUS_KM,
    overhead_radius_km: OVERHEAD_KM,
    aircraft: Object.freeze(nearby.map((row) => rowPayload(clock, updatedMin, row))),
    recent: Object.freeze(recent.map((row) => rowPayload(clock, updatedMin, row))),
  });
}

function rowPayload(clock: FixtureClock, updatedMin: number, row: RowSpec): Readonly<Record<string, unknown>> {
  return Object.freeze({
    hex: row.hex,
    distance_km: row.km,
    bearing_deg: row.bearing,
    overhead: row.km <= OVERHEAD_KM,
    last_seen: clock.at(-updatedMin - row.seenSec / SECONDS_PER_MINUTE),
    ...(row.callsign !== undefined && { callsign: row.callsign }),
    ...(row.registration !== undefined && { registration: row.registration }),
    ...(row.type !== undefined && { aircraft_type: row.type }),
    ...(row.altitude !== undefined && { altitude_ft: row.altitude }),
    ...(row.speed !== undefined && { speed_kts: row.speed }),
    ...(row.track !== undefined && { track_deg: row.track }),
    ...(row.vertical !== undefined && { vertical_rate_fpm: row.vertical }),
    ...(row.closestKm !== undefined && { closest_distance_km: row.closestKm }),
    ...(row.route !== undefined && { route: row.route }),
  });
}

/** A generated fictional address: 001000, 001001, … */
function generatedHex(index: number): string {
  return `00${(GENERATED_HEX_BASE + index).toString(16)}`;
}

/** Fifty nearby, nearest first; the first three overhead. Alternating DEMO/TEST callsigns, every fifth N0-only. */
function denseNearby(): RowSpec[] {
  return Array.from({ length: DENSE_NEARBY }, (_, index) => {
    const overhead = index < DENSE_OVERHEAD;
    const named = index % 5 !== 4;
    return {
      hex: generatedHex(index),
      ...(named && { callsign: `${index % 2 === 0 ? 'DEMO' : 'TEST'}${100 + index}` }),
      registration: `N0${200 + index}X`,
      type: TYPES[index % TYPES.length] as string,
      km: overhead ? 0.8 + index * 0.9 : 3.4 + (index - DENSE_OVERHEAD) * 0.45,
      bearing: Math.round((index * GOLDEN_ANGLE_DEG) % 360),
      altitude: 3000 + index * 650,
      speed: 140 + index * 7,
      ...(index % 7 !== 6 && { track: (index * 53) % 360 }),
      vertical: ((index % 3) - 1) * 900,
      seenSec: index % 30,
    };
  });
}

/** Twelve recent passes (a full list: the view label reads "12+"), newest first. */
function denseRecent(): RowSpec[] {
  return Array.from({ length: DENSE_RECENT }, (_, index) => ({
    hex: generatedHex(DENSE_NEARBY + index),
    callsign: `TEST${600 + index}`,
    type: TYPES[(index + 2) % TYPES.length] as string,
    km: 0.5 + (index % 5) * 0.5,
    bearing: (index * 29) % 360,
    altitude: 2000 + index * 400,
    seenSec: (1 + index * 2) * SECONDS_PER_MINUTE,
    closestKm: 0.3 + (index % 5) * 0.4,
  }));
}

/** A 7-minute-old snapshot (stale, still drawable) with two rows the parser must drop. */
function degraded(clock: FixtureClock): Readonly<Record<string, unknown>> {
  const base = envelope(clock, 'degraded', NORMAL_NEARBY.slice(0, 4), NORMAL_RECENT.slice(0, 1));
  const rows = base['aircraft'] as readonly unknown[];
  const updatedAt = clock.at(-STALE_UPDATE_MIN);
  return Object.freeze({
    ...base,
    aircraft: Object.freeze([
      ...rows,
      { hex: 'not-hex', distance_km: 4, bearing_deg: 10, overhead: false, last_seen: updatedAt },
      { hex: '002f00', distance_km: '5.5', bearing_deg: 400, overhead: 'no', last_seen: 'yesterday' },
    ]),
  });
}

/**
 * Hostile payload: bidi and zero-width text, markup, prototype keys, position-like keys (0 or out of range only),
 * out-of-range and mistyped numbers, and 200 rows of which the parser may examine 64 and keep 50. Some rows are
 * valid, so the escaping of what survives can be tested too.
 */
function hostile(clock: FixtureClock): Readonly<Record<string, unknown>> {
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const zeroWidthSpace = String.fromCharCode(0x200b);
  const lineSeparator = String.fromCharCode(0x2028);
  const noBreakSpace = String.fromCharCode(0x00a0);
  const updatedAt = clock.at(-FRESH_UPDATE_MIN);
  const lastSeen = clock.at(-FRESH_UPDATE_MIN - 0.05);
  const rows = Array.from({ length: HOSTILE_ROWS }, (_, index): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      hex: generatedHex(index),
      distance_km: 1 + (index % 24),
      bearing_deg: (index * 17) % 360,
      overhead: index % 24 < 2,
      last_seen: lastSeen,
      lat: 0,
      lon: 999,
    };
    switch (index % 8) {
      case 0:
        return { ...row, callsign: '<script>', registration: `N0${index}${rightToLeftOverride}` };
      case 1:
        return { ...row, callsign: `DEMO${index}`, altitude_ft: 1e9, speed_kts: -5, track_deg: 720 };
      case 2:
        return { ...row, distance_km: Number.POSITIVE_INFINITY };
      case 3:
        return { ...row, bearing_deg: Number.NaN, callsign: `TEST${index}` };
      case 4:
        return { ...row, distance_km: String(row['distance_km']), latitude: -1000, longitude: 0 };
      case 5:
        return {
          ...row,
          callsign: `TEST${index}`,
          route: {
            origin: 'XAAA',
            destination: 'XBBB',
            origin_name: `Example${zeroWidthSpace} International`,
            destination_name: `Sample${lineSeparator}Regional`,
            airline: `Example${noBreakSpace}Air`,
            source: SOURCE,
            status: 'reported',
          },
        };
      case 6:
        return { ...row, overhead: 'yes', vertical_rate_fpm: '900' };
      default:
        return { ...row, callsign: `DEMO${index}`, route: { ...REPORTED_ROUTE, origin: 'XAAA', destination: 'XAAA' } };
    }
  });
  return Object.freeze({
    schema_version: 1,
    provider: '<script>alert(1)</script>',
    // Valid, so the escaping of '&' and quotes is exercised; the markup and bidi above are dropped by the parser.
    attribution: "Example positions & 'routes'",
    updated_at: updatedAt,
    radius_km: RADIUS_KM,
    overhead_radius_km: OVERHEAD_KM,
    aircraft: rows,
    recent: [{ ['__proto__']: { polluted: true }, hex: '003fff', distance_km: 1, bearing_deg: 0, overhead: true }],
    ['__proto__']: { polluted: true },
    constructor: 'not a function',
    home_lat: 0,
    home_lon: -999,
  });
}
