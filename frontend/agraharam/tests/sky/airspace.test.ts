/**
 * Sky parser and contract (AIRSPACE.md §2, §9, §10): every field rule, the bounded-label filter, routes,
 * duplicates and caps, the all-invalid rule, clock independence, the link builder, and the fictional patterns of the
 * fixtures and of every inline aircraft payload in the public tree. Unusual characters are built with
 * String.fromCharCode so this source stays plain ASCII.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { skyAttributes, skyEntity, SKY_FIXTURE_KINDS } from '../../src/demo/fixtures/sky.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import {
  aircraftLink,
  parseAirspace,
  SKY_SOURCES,
  type Aircraft,
  type AirspaceSnapshot,
} from '../../src/model/airspace.ts';

const SKY = 'sensor.demo_sky_airspace';
const UPDATED_MS = Date.parse('2026-10-09T18:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const NBSP = String.fromCharCode(0x00a0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const PRIVATE_USE = String.fromCharCode(0xe000);

/** The tracking-site prefix, spelled out: the test checks what the builder appends to it (AIRSPACE.md §9). */
const AIRCRAFT_LINK_PREFIX = 'https://globe.adsb.lol/?icao=';

type AirspaceParse = ReturnType<typeof parseAirspace>;

const iso = (ms: number): string => new Date(ms).toISOString();

function entity(attributes: unknown, state = '1'): HassEntityLike {
  return {
    entity_id: SKY,
    state,
    attributes: attributes as Readonly<Record<string, unknown>>,
    last_changed: iso(UPDATED_MS),
    last_updated: iso(UPDATED_MS),
    context: { id: 'test-context', parent_id: null, user_id: null },
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hex: '001a2b',
    distance_km: 1.4,
    bearing_deg: 315,
    overhead: true,
    last_seen: iso(UPDATED_MS - 2 * SECOND),
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    provider: 'ADSB.lol',
    attribution: 'Example attribution',
    updated_at: iso(UPDATED_MS),
    radius_km: 25,
    overhead_radius_km: 3,
    aircraft: [row()],
    recent: [],
    ...overrides,
  };
}

function parse(attributes: unknown, state?: string): AirspaceParse {
  return parseAirspace(entity(attributes, state));
}

function ok(attributes: unknown, state?: string): AirspaceSnapshot {
  const parsed = parse(attributes, state);
  if (parsed.kind !== 'ok') throw new Error(`expected ok, got ${parsed.kind}`);
  return parsed;
}

/** The parsed first nearby row after `overrides`, beside a valid second row so the all-invalid rule stays out. */
function firstRow(overrides: Record<string, unknown>): Aircraft | undefined {
  const parsed = ok(payload({ aircraft: [row(overrides), row({ hex: '003fff', distance_km: 9 })] }));
  return parsed.aircraft.find((item) => item.hex !== '003fff');
}

/** A route on the first row; undefined when the parser dropped it. */
function routeOf(route: unknown): Aircraft['route'] {
  return firstRow({ route })?.route;
}

const ROUTE = {
  origin: 'XAAA',
  destination: 'XBBB',
  origin_name: 'Example International',
  destination_name: 'Sample Regional',
  airline: 'Example Air',
  flight_number: 'DEMO214',
  source: 'VRS via ADSB.lol',
  status: 'reported',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('parseAirspace: envelope (AIRSPACE.md §2)', () => {
  it('parses a valid payload into a frozen snapshot', () => {
    const parsed = ok(payload());
    expect(parsed).toMatchObject({
      kind: 'ok',
      updatedMs: UPDATED_MS,
      radiusKm: 25,
      overheadKm: 3,
      provider: 'ADSB.lol',
      attribution: 'Example attribution',
      recentFull: false,
      droppedNearby: 0,
      droppedRecent: 0,
    });
    expect(parsed.aircraft).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.aircraft)).toBe(true);
    expect(Object.isFrozen(parsed.aircraft[0])).toBe(true);
  });

  it('is absent when no envelope key exists (HA restored a state without attributes)', () => {
    expect(parse({}).kind).toBe('absent');
    expect(parse({ friendly_name: 'Sky', unit_of_measurement: 'aircraft' }).kind).toBe('absent');
    expect(parse(null).kind).toBe('absent');
  });

  it('is unsupported for any other present schema_version, malformed when it is missing beside other keys', () => {
    expect(parse(payload({ schema_version: 2 })).kind).toBe('unsupported');
    expect(parse(payload({ schema_version: '1' })).kind).toBe('unsupported');
    expect(parse(payload({ schema_version: undefined })).kind).toBe('malformed');
  });

  it.each([
    ['a Date.parse-able non-ISO string', 'Oct 9, 2026 18:00:00 GMT'],
    ['a zone-less time', '2026-10-09T18:00:00'],
    ['a space separator', '2026-10-09 18:00:00Z'],
    ['an epoch number', UPDATED_MS],
    ['an impossible time', '2026-10-09T99:00:00Z'],
  ])('is malformed when updated_at is %s', (_label, updatedAt) => {
    expect(parse(payload({ updated_at: updatedAt })).kind).toBe('malformed');
  });

  it.each([
    ['radius below 1 km', { radius_km: 0.9 }],
    ['radius above 100 km', { radius_km: 100.5 }],
    ['a numeric-string radius', { radius_km: '25' }],
    ['a NaN radius', { radius_km: Number.NaN }],
    ['an infinite radius', { radius_km: Number.POSITIVE_INFINITY }],
    ['an overhead radius below 0.1 km', { overhead_radius_km: 0.05 }],
    ['an overhead radius beyond the radius', { overhead_radius_km: 26 }],
    ['aircraft that is not an array', { aircraft: { 0: row() } }],
    ['recent that is not an array', { recent: 'none' }],
    ['a missing recent list', { recent: undefined }],
  ])('is malformed with %s', (_label, overrides) => {
    expect(parse(payload(overrides)).kind).toBe('malformed');
  });

  it('accepts the radius bounds themselves', () => {
    expect(ok(payload({ radius_km: 1, overhead_radius_km: 1, aircraft: [] }), '0').radiusKm).toBe(1);
    expect(ok(payload({ radius_km: 100, overhead_radius_km: 0.1 })).overheadKm).toBe(0.1);
  });

  it('is malformed, never quiet skies, when rows were sent but none could be read (all-invalid rule)', () => {
    expect(parse(payload({ aircraft: [row({ hex: 'zz1a2b' }), 'not a row', null, [row()]] })).kind).toBe('malformed');
  });

  it('is malformed when the state reports aircraft but the list is empty, and quiet with a zero count', () => {
    expect(parse(payload({ aircraft: [] }), '3').kind).toBe('malformed');
    expect(ok(payload({ aircraft: [] }), '0').aircraft).toEqual([]);
    // The state is only a hint: anything but a plain non-negative integer is ignored.
    expect(ok(payload({ aircraft: [] }), '3.5').aircraft).toEqual([]);
    expect(ok(payload({ aircraft: [] }), 'many').aircraft).toEqual([]);
  });

  it('omits an over-long or unsafe provider and attribution, keeping the snapshot', () => {
    const parsed = ok(payload({ provider: 'P'.repeat(41), attribution: `Example <script>` }));
    expect(Object.hasOwn(parsed, 'provider')).toBe(false);
    expect(Object.hasOwn(parsed, 'attribution')).toBe(false);
    expect(ok(payload({ attribution: 'A'.repeat(160) })).attribution).toHaveLength(160);
  });
});

describe('parseAirspace: aircraft rows (AIRSPACE.md §2)', () => {
  it.each([
    ['a five-digit hex', { hex: '001a2' }],
    ['a seven-digit hex', { hex: '001a2bc' }],
    ['a non-hex address', { hex: 'zz1a2b' }],
    ['a padded hex', { hex: ' 001a2b' }],
    ['a numeric hex', { hex: 1234 }],
    ['a NaN distance', { distance_km: Number.NaN }],
    ['an infinite distance', { distance_km: Number.POSITIVE_INFINITY }],
    ['a negative distance', { distance_km: -0.1 }],
    ['a distance beyond 1.05 × the radius', { distance_km: 26.3 }],
    ['a numeric-string distance', { distance_km: '1.4' }],
    ['a boolean distance', { distance_km: true }],
    ['a negative bearing', { bearing_deg: -1 }],
    ['a bearing above 360', { bearing_deg: 360.5 }],
    ['a string overhead flag', { overhead: 'true' }],
    ['a numeric overhead flag', { overhead: 1 }],
    ['a missing overhead flag', { overhead: undefined }],
    ['a non-ISO last_seen', { last_seen: 'just now' }],
    ['a last_seen 121 s before updated_at', { last_seen: iso(UPDATED_MS - 121 * SECOND) }],
    ['a last_seen 6 s after updated_at', { last_seen: iso(UPDATED_MS + 6 * SECOND) }],
  ])('drops a row with %s and counts it', (_label, overrides) => {
    const parsed = ok(payload({ aircraft: [row(overrides), row({ hex: '003fff', distance_km: 9 })] }));
    expect(parsed.aircraft.map((item) => item.hex)).toEqual(['003fff']);
    expect([parsed.droppedNearby, parsed.droppedRecent]).toEqual([1, 0]);
  });

  it('keeps the window and range edges', () => {
    expect(firstRow({ last_seen: iso(UPDATED_MS - 120 * SECOND) })).toBeDefined();
    expect(firstRow({ last_seen: iso(UPDATED_MS + 5 * SECOND) })).toBeDefined();
    expect(firstRow({ distance_km: 26.25 })?.distanceKm).toBe(26.25);
    expect(firstRow({ distance_km: 0 })?.distanceKm).toBe(0);
    expect(firstRow({ bearing_deg: 360 })?.bearingDeg).toBe(0);
    expect(firstRow({ hex: '001A2B' })?.hex).toBe('001a2b');
  });

  it('applies the 35-minute window to recent passes, relative to updated_at', () => {
    const recent = (seenMsBefore: number) =>
      ok(payload({ recent: [row({ last_seen: iso(UPDATED_MS - seenMsBefore) })] })).recent.length;
    expect(recent(35 * MINUTE)).toBe(1);
    expect(recent(35 * MINUTE + SECOND)).toBe(0);
  });

  it('normalizes the identifier codes and omits invalid ones without dropping the row', () => {
    expect(firstRow({ callsign: ' demo214 ', registration: 'n0-214d', aircraft_type: 'b738' })).toMatchObject({
      callsign: 'DEMO214',
      registration: 'N0-214D',
      type: 'B738',
    });
    for (const callsign of ['DEMO-214', 'D', 'DEMO21456', '<script>', `DEMO${ZWSP}1`, 214]) {
      const item = firstRow({ callsign });
      expect(item, String(callsign)).toBeDefined();
      expect(Object.hasOwn(item as object, 'callsign'), String(callsign)).toBe(false);
    }
    expect(Object.hasOwn(firstRow({ registration: 'N0'.repeat(9) }) as object, 'registration')).toBe(false);
    expect(Object.hasOwn(firstRow({ aircraft_type: 'B7 38' }) as object, 'type')).toBe(false);
  });

  it('keeps finite numbers within range only, and wraps the ground track', () => {
    expect(firstRow({ altitude_ft: -2000, speed_kts: 2000, track_deg: 360, vertical_rate_fpm: -20_000 })).toMatchObject(
      { altitudeFt: -2000, speedKts: 2000, trackDeg: 0, verticalFpm: -20_000 },
    );
    const rejected = firstRow({
      altitude_ft: 100_001,
      speed_kts: -1,
      track_deg: 361,
      vertical_rate_fpm: '900',
    }) as object;
    for (const key of ['altitudeFt', 'speedKts', 'trackDeg', 'verticalFpm'])
      expect(Object.hasOwn(rejected, key)).toBe(false);
    expect(Object.hasOwn(firstRow({ altitude_ft: true, speed_kts: Number.NaN }) as object, 'altitudeFt')).toBe(false);
  });

  it('labels by callsign, then registration, then the upper-case hex', () => {
    expect(firstRow({ callsign: 'DEMO214', registration: 'N0214D' })).toMatchObject({
      label: 'DEMO214',
      labelKind: 'callsign',
    });
    expect(firstRow({ registration: 'N0214D' })).toMatchObject({ label: 'N0214D', labelKind: 'registration' });
    expect(firstRow({})).toMatchObject({ label: '001A2B', labelKind: 'hex' });
  });

  it('decides overhead by distance alone; a recent pass is never overhead', () => {
    expect(firstRow({ distance_km: 3, overhead: false })?.overhead).toBe(true);
    expect(firstRow({ distance_km: 3.1, overhead: true })?.overhead).toBe(false);
    const recent = ok(payload({ recent: [row({ distance_km: 0.5, closest_distance_km: 0.4 })] })).recent[0];
    expect(recent).toMatchObject({ overhead: false, closestKm: 0.4 });
  });

  it('keeps closest approach for recent passes only, within 1.05 × the overhead radius', () => {
    expect(Object.hasOwn(firstRow({ closest_distance_km: 1 }) as object, 'closestKm')).toBe(false);
    const recent = (closest: unknown) =>
      ok(payload({ recent: [row({ closest_distance_km: closest })] })).recent[0] as object;
    expect(Object.hasOwn(recent(3.15), 'closestKm')).toBe(true);
    expect(Object.hasOwn(recent(3.2), 'closestKm')).toBe(false);
  });

  it('keeps the first of duplicate addresses; recent may repeat a nearby address', () => {
    const parsed = ok(
      payload({
        aircraft: [row({ callsign: 'DEMO1' }), row({ callsign: 'DEMO2', distance_km: 2 })],
        recent: [row()],
      }),
    );
    expect(parsed.aircraft.map((item) => item.label)).toEqual(['DEMO1']);
    expect(parsed.recent.map((item) => item.hex)).toEqual(['001a2b']);
    expect([parsed.droppedNearby, parsed.droppedRecent]).toEqual([1, 0]);
  });

  it('examines only the first 64 rows, keeps at most 50, and counts every raw entry not shown', () => {
    const many = (count: number, start = 0) =>
      Array.from({ length: count }, (_, index) => row({ hex: `00${(0x1000 + start + index).toString(16)}` }));
    const capped = ok(payload({ aircraft: many(200) }));
    expect(capped.aircraft).toHaveLength(50);
    expect([capped.droppedNearby, capped.droppedRecent]).toEqual([150, 0]);
    const late = [...Array.from({ length: 64 }, () => row({ hex: 'bad' })), ...many(10)];
    expect(parse(payload({ aircraft: late })).kind).toBe('malformed');
  });

  it('examines 24 recent rows, keeps 12, and marks a full list', () => {
    const recent = Array.from({ length: 30 }, (_, index) => row({ hex: `00${(0x2000 + index).toString(16)}` }));
    const parsed = ok(payload({ recent }));
    expect(parsed.recent).toHaveLength(12);
    expect(parsed.recentFull).toBe(true);
    expect([parsed.droppedNearby, parsed.droppedRecent]).toEqual([0, 18]);
    expect(ok(payload({ recent: recent.slice(0, 11) })).recentFull).toBe(false);
    expect(ok(payload({ recent: recent.slice(0, 12) })).recentFull).toBe(true);
  });

  it('reads "12+" only above twelve valid passes, never above fewer rows padded with invalid ones', () => {
    const valid = (count: number) =>
      Array.from({ length: count }, (_, index) => row({ hex: `00${(0x2000 + index).toString(16)}` }));
    const invalid = (count: number) => Array.from({ length: count }, () => row({ hex: 'bad' }));
    const padded = ok(payload({ recent: [...valid(3), ...invalid(9)] }));
    expect([padded.recent.length, padded.recentFull, padded.droppedRecent]).toEqual([3, false, 9]);
    expect(ok(payload({ recent: [...valid(11), ...invalid(1)] })).recentFull).toBe(false);
    expect(ok(payload({ recent: [...invalid(4), ...valid(12)] })).recentFull).toBe(true);
  });
});

describe('parseAirspace: bounded labels and routes (AIRSPACE.md §2)', () => {
  it('keeps a valid reported route, without its flight number', () => {
    expect(routeOf(ROUTE)).toEqual({
      origin: 'XAAA',
      destination: 'XBBB',
      originName: 'Example International',
      destinationName: 'Sample Regional',
      airline: 'Example Air',
      source: 'VRS via ADSB.lol',
    });
    expect(routeOf({ ...ROUTE, origin: 'xaaa' })?.origin).toBe('XAAA');
    expect(routeOf({ origin: 'XAAA', destination: 'XBB', source: 'VRS via ADSB.lol', status: 'reported' })).toEqual({
      origin: 'XAAA',
      destination: 'XBB',
      source: 'VRS via ADSB.lol',
    });
  });

  it.each([
    ['another status', { status: 'scheduled' }],
    ['no status', { status: undefined }],
    ['no source', { source: undefined }],
    ['an over-long source', { source: 'S'.repeat(41) }],
    ['a short code', { origin: 'XA' }],
    ['a long code', { destination: 'XAAAA' }],
    ['a round trip', { destination: 'XAAA' }],
    ['a non-string code', { origin: 1234 }],
  ])('drops a route with %s but keeps the row', (_label, overrides) => {
    const item = firstRow({ route: { ...ROUTE, ...overrides } });
    expect(item).toBeDefined();
    expect(Object.hasOwn(item as object, 'route')).toBe(false);
  });

  it.each([
    ['a right-to-left override', `Example${RLO} International`],
    ['a zero-width space', `Example${ZWSP} International`],
    ['a line separator', `Example${LINE_SEPARATOR}International`],
    ['a no-break space', `Example${NBSP}International`],
    ['a lone surrogate', `Example ${LONE_SURROGATE}`],
    ['a private-use character', `Example ${PRIVATE_USE}`],
    ['a tab', 'Example\tInternational'],
    ['markup', '<script>alert(1)</script>'],
    ['braces and a backslash', 'Example {x} \\ y'],
    ['a double quote', 'Example "International"'],
    ['81 characters', 'E'.repeat(81)],
    ['a raw string over 4 × the limit', `${' '.repeat(320)}Example`],
    ['only spaces', '   '],
  ])('omits an airport name with %s', (_label, name) => {
    const route = routeOf({ ...ROUTE, origin_name: name });
    expect(route?.origin).toBe('XAAA');
    expect(Object.hasOwn(route as object, 'originName')).toBe(false);
  });

  it('trims labels and counts code points, not UTF-16 units', () => {
    const plane = String.fromCodePoint(0x2708);
    expect(routeOf({ ...ROUTE, airline: '  Example Air  ' })?.airline).toBe('Example Air');
    expect(routeOf({ ...ROUTE, origin_name: `${'E'.repeat(79)}${plane}` })?.originName).toHaveLength(80);
    expect(routeOf({ ...ROUTE, destination_name: "Sample & Regional's" })?.destinationName).toBe("Sample & Regional's");
  });
});

describe('parseAirspace: untrusted keys and purity (AIRSPACE.md §2, §9)', () => {
  it('never reads prototype or position-like keys, and builds output from named fields only', () => {
    const clock = fixtureClock(UPDATED_MS);
    const parsed = parseAirspace(skyEntity('hostile', clock));
    if (parsed.kind !== 'ok') throw new Error('expected the hostile payload to parse');
    const allowed = new Set([
      'hex',
      'label',
      'labelKind',
      'callsign',
      'registration',
      'type',
      'altitudeFt',
      'speedKts',
      'trackDeg',
      'verticalFpm',
      'distanceKm',
      'bearingDeg',
      'overhead',
      'lastSeenMs',
      'closestKm',
      'route',
    ]);
    for (const item of [...parsed.aircraft, ...parsed.recent]) {
      for (const key of Object.keys(item)) expect(allowed.has(key), key).toBe(true);
      expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    }
    expect(Object.keys(parsed).every((key) => !/lat|lon|proto|constructor/i.test(key))).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parsed.aircraft.length).toBeLessThanOrEqual(50);
    expect(parsed.droppedNearby).toBeGreaterThan(0);
    expect(parsed.droppedRecent).toBe(1);
    expect(Object.hasOwn(parsed, 'provider')).toBe(false);
  });

  it('is clock-independent: the same entity object gives the same result at any time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(UPDATED_MS);
    const subject = entity(payload());
    const first = parseAirspace(subject);
    vi.setSystemTime(UPDATED_MS + 24 * 60 * MINUTE);
    expect(parseAirspace(subject)).toBe(first);
    expect(parseAirspace({ ...subject })).toEqual(first);
    vi.setSystemTime(UPDATED_MS - 24 * 60 * MINUTE);
    expect(parseAirspace({ ...subject })).toEqual(first);
  });
});

describe('outbound links (AIRSPACE.md §9)', () => {
  it('builds the tracking-site link from a validated address only, with nothing after the address', () => {
    const link = aircraftLink('001a2b');
    expect(link).toBe('https://globe.adsb.lol/?icao=001a2b');
    expect(link?.startsWith(AIRCRAFT_LINK_PREFIX)).toBe(true);
    expect(link?.slice(AIRCRAFT_LINK_PREFIX.length)).toMatch(/^[0-9a-f]{6}$/);
  });

  it.each(['001A2B', '001a2', '001a2b0', '001a2b&lat=1', '', '../001a2b', ' 001a2b'])('rejects %j', (hex) => {
    expect(aircraftLink(hex)).toBeUndefined();
  });

  it('names exactly the two reviewed source links', () => {
    expect(SKY_SOURCES.map((source) => source.href)).toEqual([
      'https://www.adsb.lol/',
      'https://github.com/vradarserver/standing-data',
    ]);
    expect(SKY_SOURCES.map((source) => source.label)).toEqual([
      'ADSB.lol · aircraft positions (ODbL 1.0)',
      'VRS standing data · reported routes (CC0)',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fictional identifiers (AIRSPACE.md §9, §10)

const FICTIONAL = Object.freeze({
  hex: /^00[0-3][0-9a-f]{3}$/i,
  callsign: /^(?:DEMO|TEST)/i,
  registration: /^N0/i,
  routeCode: /^X[A-Z0-9]{3}$/,
});
const AIRPORT_NAMES = new Set(['Example International', 'Sample Regional', 'Fictional Field']);
/** The hostile fixture hides format characters and odd separators inside generic names; they never excuse a name. */
const FORMAT_CHARS_RE = /\p{Cf}/gu;
const ODD_SEPARATORS_RE = /[\p{Zl}\p{Zp}\u00a0]/gu;

/** A name with format characters removed and line, paragraph and no-break separators read as plain spaces. */
function plainName(text: string): string {
  return text.replace(FORMAT_CHARS_RE, '').replace(ODD_SEPARATORS_RE, ' ').replace(/\s+/g, ' ').trim();
}
const TYPES = new Set(['B738', 'A320', 'E75L', 'C172', 'B77W', 'A21N']);
/** Shapes the parser would accept: only values of these shapes could be real identifiers. */
const SHAPED = Object.freeze({
  hex: /^[0-9a-f]{6}$/i,
  callsign: /^[A-Za-z0-9]{2,8}$/,
  registration: /^[A-Za-z0-9-]{2,16}$/,
});

/** Every [key, value] pair in a fixture payload, recursively. */
function* pairs(value: unknown): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const item of value) yield* pairs(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield [key, item];
      yield* pairs(item);
    }
  }
}

describe('sky fixtures are fictional (AIRSPACE.md §10)', () => {
  const clock = fixtureClock(UPDATED_MS);

  it.each(SKY_FIXTURE_KINDS)('%s: identifiers, routes, names, types and position keys', (kind) => {
    for (const [key, value] of pairs(skyAttributes(kind, clock))) {
      const text = typeof value === 'string' ? value : undefined;
      if (key === 'hex' && text !== undefined && SHAPED.hex.test(text)) expect(text).toMatch(FICTIONAL.hex);
      if (key === 'callsign' && text !== undefined && SHAPED.callsign.test(text)) {
        expect(text).toMatch(FICTIONAL.callsign);
      }
      if (key === 'flight_number' && text !== undefined) expect(text).toMatch(FICTIONAL.callsign);
      if (key === 'registration' && text !== undefined && SHAPED.registration.test(text)) {
        expect(text).toMatch(FICTIONAL.registration);
      }
      if ((key === 'origin' || key === 'destination') && text !== undefined) expect(text).toMatch(FICTIONAL.routeCode);
      if ((key === 'origin_name' || key === 'destination_name') && text !== undefined) {
        expect(AIRPORT_NAMES.has(plainName(text)), key).toBe(true);
      }
      if (key === 'airline' && text !== undefined) expect(text.replace(/[^A-Za-z ]/g, ' ')).toBe('Example Air');
      if (key === 'aircraft_type') expect(TYPES.has(String(value)), String(value)).toBe(true);
      // Position-like keys exist only in the hostile payload, and never hold a plausible coordinate.
      if (/lat|lon/i.test(key)) {
        expect(kind).toBe('hostile');
        expect(typeof value === 'number' && (value === 0 || Math.abs(value) > 180), key).toBe(true);
      }
    }
  });

  it('builds each documented state', () => {
    const snapshot = (kind: (typeof SKY_FIXTURE_KINDS)[number]) => {
      const parsed = parseAirspace(skyEntity(kind, clock));
      if (parsed.kind !== 'ok') throw new Error(`${kind} did not parse`);
      return parsed;
    };
    const normal = snapshot('normal');
    expect(normal.aircraft).toHaveLength(8);
    expect(normal.aircraft.filter((item) => item.overhead).map((item) => item.label)).toEqual(['DEMO214']);
    expect(normal.aircraft[0]?.route?.source).toBe('VRS via ADSB.lol');
    expect(normal.aircraft.map((item) => item.labelKind)).toContain('registration');
    expect(normal.aircraft.map((item) => item.labelKind)).toContain('hex');
    expect(normal.aircraft.some((item) => item.trackDeg === undefined)).toBe(true);
    expect(normal.recent).toHaveLength(3);
    expect([normal.droppedNearby, normal.droppedRecent]).toEqual([0, 0]);
    const dense = snapshot('dense');
    expect([dense.aircraft.length, dense.aircraft.filter((item) => item.overhead).length]).toEqual([50, 3]);
    expect([dense.recent.length, dense.recentFull]).toEqual([12, true]);
    const degraded = snapshot('degraded');
    expect([degraded.droppedNearby, degraded.droppedRecent]).toEqual([2, 0]);
    expect(UPDATED_MS - degraded.updatedMs).toBe(7 * MINUTE);
    const empty = snapshot('empty');
    expect([empty.aircraft.length, empty.recent.length]).toEqual([0, 2]);
    expect(skyEntity('empty', clock).state).toBe('0');
  });
});

/** Package-relative directories whose inline aircraft payloads and doc examples must be fictional. */
const SCANNED_DIRS = ['src', 'tests', 'e2e', 'docs', 'install'];
const SCANNED_EXTENSIONS = /\.(?:ts|mjs|js|json|md|ya?ml)$/;
/**
 * `hex: '...'`, `"callsign": "..."` and, in docs and YAML, unquoted `registration: N0...`. No space before the colon,
 * as prettier, JSON and YAML write keys; a ternary (`'registration' : 'hex'`) is not a key.
 */
const QUOTED_PAIR_RE = /["']?\b(hex|callsign|registration)["']?:\s*["'`]([^"'`\n]*)["'`]/g;
const BARE_PAIR_RE = /\b(hex|callsign|registration):\s*([A-Za-z0-9-]+)\s*$/gm;
/** The leak scanner's floor (MIN_AIRCRAFT_IDENTIFIER_LENGTH): shorter values identify nothing. */
const MIN_IDENTIFIER_CHARS = 3;

function scannedFiles(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) return scannedFiles(full);
    return SCANNED_EXTENSIONS.test(name) ? [full] : [];
  });
}

describe('inline aircraft payloads and doc examples are fictional (AIRSPACE.md §9)', () => {
  it('uses only fictional addresses, callsigns and registrations in src, tests, e2e, docs and install', () => {
    const root = process.cwd();
    const offenders: string[] = [];
    let checked = 0;
    for (const file of SCANNED_DIRS.flatMap((dir) => scannedFiles(join(root, dir)))) {
      const text = readFileSync(file, 'utf8');
      const prose = /\.(?:md|ya?ml)$/.test(file);
      const matches = [...text.matchAll(QUOTED_PAIR_RE), ...(prose ? text.matchAll(BARE_PAIR_RE) : [])];
      for (const match of matches) {
        const key = match[1] as keyof typeof SHAPED;
        const value = match[2] ?? '';
        if (value.length < MIN_IDENTIFIER_CHARS || !SHAPED[key].test(value)) continue;
        checked += 1;
        const fictional =
          key === 'hex' ? FICTIONAL.hex : key === 'callsign' ? FICTIONAL.callsign : FICTIONAL.registration;
        if (!fictional.test(value)) offenders.push(`${relative(root, file)} ${key}`);
      }
    }
    expect(checked, 'the scan found no aircraft payloads at all').toBeGreaterThan(10);
    // Paths and keys only, never the value.
    expect(offenders).toEqual([]);
  });
});
