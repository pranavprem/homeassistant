/**
 * Radar geometry (AIRSPACE.md §6): north-up points, clamping, rings in the HA length unit and the profile locale,
 * track rotation, labels and paint order, no NaN anywhere, the recent list never drawn and never highlighted.
 */
import { describe, expect, it } from 'vitest';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { skyEntity, SKY_FIXTURE_KINDS } from '../../src/demo/fixtures/sky.ts';
import { createFormatter } from '../../src/ha/format.ts';
import { parseAirspace, type Aircraft, type AirspaceSnapshot } from '../../src/model/airspace.ts';
import { radarMarks, radarPoint, radarRings, RADAR_OUTER_R } from '../../src/model/radar.ts';
import { createSkySelector, type SkyDrawerUi } from '../../src/model/sky.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const NOW_MS = Date.parse('2026-10-09T18:00:00.000Z');
/** Mark labels are capped at three (AIRSPACE.md §6). */
const MAX_LABELS = 3;
/** The fictional overhead aircraft (DEMO214): nearby now and also the newest recent pass in the normal fixture. */
const NEARBY_AND_RECENT_HEX = '001a2b';

function formatterFor(language: string, lengthUnit: 'km' | 'mi' = 'km') {
  return createFormatter({
    temperatureUnit: '°C',
    lengthUnit,
    locale: { language, number_format: 'language', time_format: '12', time_zone: 'local' },
  });
}

const EN_NUMBER = formatterFor('en-US').number;

function snapshot(kind: (typeof SKY_FIXTURE_KINDS)[number]): AirspaceSnapshot {
  const parsed = parseAirspace(skyEntity(kind, fixtureClock(NOW_MS)));
  if (parsed.kind !== 'ok') throw new Error(`${kind} did not parse`);
  return parsed;
}

function aircraft(overrides: Partial<Aircraft>): Aircraft {
  return {
    hex: '001a2b',
    label: 'DEMO1',
    labelKind: 'callsign',
    distanceKm: 5,
    bearingDeg: 0,
    overhead: false,
    lastSeenMs: NOW_MS,
    ...overrides,
  };
}

describe('radarPoint (AIRSPACE.md §6)', () => {
  it.each([
    [0, 0, -45],
    [90, 45, 0],
    [180, 0, 45],
    [270, -45, 0],
    [360, 0, -45],
  ])('puts bearing %s° at (%s, %s) for half the radius, north up', (bearing, x, y) => {
    expect(radarPoint(12.5, bearing, 25)).toEqual({ x, y, clamped: false });
  });

  it('rounds to 0.1, keeps home at the centre and never yields -0', () => {
    expect(radarPoint(10, 45, 25)).toEqual({ x: 25.5, y: -25.5, clamped: false });
    const centre = radarPoint(0, 180, 25);
    expect(centre).toEqual({ x: 0, y: 0, clamped: false });
    expect(Object.is(centre.x, -0) || Object.is(centre.y, -0)).toBe(false);
  });

  it('clamps beyond the radius onto the outer ring', () => {
    expect(radarPoint(26, 90, 25)).toEqual({ x: RADAR_OUTER_R, y: 0, clamped: true });
    expect(radarPoint(25, 90, 25)).toEqual({ x: RADAR_OUTER_R, y: 0, clamped: false });
  });
});

describe('radarRings (AIRSPACE.md §6)', () => {
  it('draws the overhead ring and 1-2-5 rings in km', () => {
    expect(radarRings(25, 3, 'km', EN_NUMBER)).toEqual([
      { r: 10.8, label: '3 km', overhead: true },
      { r: 36, label: '10 km', overhead: false },
      { r: 72, label: '20 km', overhead: false },
    ]);
  });

  it('draws them in miles, skipping a ring that would crowd the rim', () => {
    expect(radarRings(25, 3, 'mi', EN_NUMBER)).toEqual([
      { r: 10.8, label: '1.9 mi', overhead: true },
      { r: 29, label: '5 mi', overhead: false },
      { r: 57.9, label: '10 mi', overhead: false },
    ]);
  });

  it('skips a ring within 8 units of the overhead ring, and keeps the overhead ring always', () => {
    expect(radarRings(10, 4.5, 'km', EN_NUMBER)).toEqual([{ r: 40.5, label: '4.5 km', overhead: true }]);
    expect(radarRings(1, 1, 'km', EN_NUMBER)).toEqual([
      { r: 45, label: '0.5 km', overhead: false },
      { r: 90, label: '1 km', overhead: true },
    ]);
    for (const radius of [1, 7, 25, 33, 100]) {
      const rings = radarRings(radius, 0.1, 'km', EN_NUMBER);
      expect(rings.length, String(radius)).toBeLessThanOrEqual(4);
      expect(rings.every((ring) => Number.isFinite(ring.r) && ring.r > 0 && ring.r <= RADAR_OUTER_R)).toBe(true);
    }
  });

  it('labels the rings in the profile locale, like every other distance', () => {
    expect(radarRings(25, 3, 'mi', formatterFor('de').number).map((ring) => ring.label)).toEqual([
      '1,9 mi',
      '5 mi',
      '10 mi',
    ]);
    expect(radarRings(10, 4.5, 'km', formatterFor('fr').number).map((ring) => ring.label)).toEqual(['4,5 km']);
  });
});

describe('radarMarks (AIRSPACE.md §6)', () => {
  it('rotates live marks by ground track and draws a dot without one', () => {
    const [withTrack, withoutTrack] = radarMarks(
      [aircraft({ trackDeg: 135 }), aircraft({ hex: '002c3d', distanceKm: 8 })],
      25,
      { live: true },
    );
    expect(withTrack?.rotation).toBe(135);
    expect(Object.hasOwn(withoutTrack as object, 'rotation')).toBe(false);
  });

  it('draws no chevrons and no overhead emphasis when not live', () => {
    const marks = radarMarks([aircraft({ trackDeg: 90, overhead: true, distanceKm: 1 })], 25, { live: false });
    expect(marks[0]).toMatchObject({ overhead: false });
    expect(Object.hasOwn(marks[0] as object, 'rotation')).toBe(false);
    expect(Object.hasOwn(marks[0] as object, 'label')).toBe(false);
  });

  it('labels the expanded aircraft first, then overhead ones, at most three, painting them last', () => {
    const dense = snapshot('dense');
    const expanded = dense.aircraft[10]?.hex as string;
    const marks = radarMarks(dense.aircraft, dense.radiusKm, { live: true, expanded });
    const labelled = marks.filter((mark) => mark.label !== undefined);
    expect(labelled).toHaveLength(MAX_LABELS);
    expect(labelled.map((mark) => mark.key)).toContain(expanded);
    expect(marks.at(-1)).toMatchObject({ key: expanded, expanded: true });
    expect(marks.slice(-3, -1).every((mark) => mark.overhead)).toBe(true);
    expect(marks).toHaveLength(50);
  });

  it.each(SKY_FIXTURE_KINDS)('%s: every mark is finite and inside the viewBox', (kind) => {
    const parsed = snapshot(kind);
    for (const live of [true, false]) {
      for (const mark of radarMarks(parsed.aircraft, parsed.radiusKm, { live })) {
        expect(Number.isFinite(mark.x) && Number.isFinite(mark.y)).toBe(true);
        expect(Math.hypot(mark.x, mark.y)).toBeLessThanOrEqual(RADAR_OUTER_R + 0.1);
        if (mark.rotation !== undefined) expect(Number.isFinite(mark.rotation)).toBe(true);
      }
    }
  });
});

describe('the drawer radar (AIRSPACE.md §6)', () => {
  function normalDrawer(ui: SkyDrawerUi) {
    const store = fakeStore([skyEntity('normal', fixtureClock(NOW_MS))]);
    const formatter = formatterFor('en-US');
    const subject = {
      config: configFrom({ airspace: { entity: 'sensor.demo_sky_airspace' } }),
      store,
      reader: { ...fakeReader(store), formatter: () => formatter },
      gateway: new FakeGateway(),
      now: new Date(NOW_MS),
    };
    const selector = createSkySelector();
    return selector.drawer(subject, selector.state(subject), ui);
  }

  it('draws nearby aircraft only, never the recent list, with a summary name', () => {
    const drawer = normalDrawer({ view: 'recent', sort: 'latest', filter: '' });
    const parsed = snapshot('normal');
    const nearby = new Set(parsed.aircraft.map((item) => item.hex));
    const recentOnly = parsed.recent.filter((item) => !nearby.has(item.hex));
    expect(recentOnly.length).toBeGreaterThan(0);
    expect(drawer.radar?.marks.map((mark) => mark.key).sort()).toEqual([...nearby].sort());
    expect(drawer.radar?.summary).toBe('8 aircraft within 25 km, 1 overhead. Nearest DEMO214, 1.4 km north-west.');
  });

  it('never highlights a live mark for an expanded recent pass, but does for the same aircraft in Nearby', () => {
    const recent = normalDrawer({ view: 'recent', sort: 'latest', filter: '', expanded: NEARBY_AND_RECENT_HEX });
    expect(recent.expanded).toBe(NEARBY_AND_RECENT_HEX);
    expect(recent.radar?.marks.map((mark) => mark.key)).toContain(NEARBY_AND_RECENT_HEX);
    expect(recent.radar?.marks.some((mark) => mark.expanded)).toBe(false);

    const nearby = normalDrawer({ view: 'nearby', sort: 'distance', filter: '', expanded: NEARBY_AND_RECENT_HEX });
    expect(nearby.radar?.marks.filter((mark) => mark.expanded).map((mark) => mark.key)).toEqual([
      NEARBY_AND_RECENT_HEX,
    ]);
  });
});
