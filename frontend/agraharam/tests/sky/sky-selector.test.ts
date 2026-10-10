/**
 * Sky status and view models (AIRSPACE.md §3 to §6): status precedence over every normalize status, offline only
 * while HA is disconnected or resyncing, the stale, skew, waiting and drawable bounds with the same entity object
 * (the parse is clock-independent), the panel and drawer view models, units, compass, trends, ages, accessible
 * names, links, copy and memo identity.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { skyAttributes, skyEntity, type SkyFixtureKind } from '../../src/demo/fixtures/sky.ts';
import { connectionToken, EntityStore, type StoreView } from '../../src/ha/entity-store.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { Formatter, HostKind } from '../../src/ha/host.ts';
import { normalizeEntity } from '../../src/ha/normalize.ts';
import type { StatesMap } from '../../src/ha/resync.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { airspaceState } from '../../src/model/airspace.ts';
import { createSkySelector, defaultSkySort, type AircraftVM, type SkyDrawerUi } from '../../src/model/sky.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { compassPoint } from '../../src/model/weather-details.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, fakeStore, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const SKY = 'sensor.demo_sky_airspace';
const NOW_MS = Date.parse('2026-10-09T18:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The fixture's fresh snapshot is 15 s older than its clock. */
const FIXTURE_AGE_MS = 15 * SECOND;
const LOCALE = { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'local' } as const;
const KM = createFormatter({ temperatureUnit: '°C', lengthUnit: 'km', locale: LOCALE });
const MI = createFormatter({ temperatureUnit: '°F', lengthUnit: 'mi', locale: LOCALE });
const CONFIG = configFrom({ airspace: { entity: SKY } });
const NEARBY: SkyDrawerUi = { view: 'nearby', sort: 'distance', filter: '' };

interface InputOptions {
  readonly formatter?: Formatter;
  readonly kind?: HostKind;
  readonly config?: ResolvedConfig;
}

function input(store: StoreView, nowMs: number, options: InputOptions = {}): SelectorInput {
  const formatter = options.formatter ?? KM;
  return {
    config: options.config ?? CONFIG,
    store,
    reader: { ...fakeReader(store), kind: options.kind ?? 'hass', formatter: () => formatter },
    gateway: new FakeGateway(),
    now: new Date(nowMs),
  };
}

/**
 * A fixture entity whose snapshot is `ageMs` old at NOW_MS. The degraded payload is 7 minutes older than its own
 * clock, so it is used with the default only (then it is 7 minutes old).
 */
function fixture(kind: SkyFixtureKind, ageMs = FIXTURE_AGE_MS): HassEntityLike {
  return skyEntity(kind, fixtureClock(NOW_MS - ageMs + FIXTURE_AGE_MS));
}

function sensor(attributes: Readonly<Record<string, unknown>>, state: string, lastUpdatedMs: number): HassEntityLike {
  return {
    entity_id: SKY,
    state,
    attributes,
    last_changed: new Date(lastUpdatedMs).toISOString(),
    last_updated: new Date(lastUpdatedMs).toISOString(),
    context: { id: 'test-context', parent_id: null, user_id: null },
  };
}

function stateOf(entity: HassEntityLike | undefined, nowMs = NOW_MS, options: FakeStoreOptions = {}) {
  return airspaceState(input(fakeStore(entity === undefined ? [] : [entity], options), nowMs));
}

interface RealConnection {
  readonly connected: boolean;
  readonly armed: boolean;
  /** The pre-snapshot states map the resync barrier armed with (§4.4); an entity still in it was not replaced. */
  readonly base?: StatesMap;
}

/** A real EntityStore after one ingest, so isConnected, resync and per-entity freshness follow production rules. */
function realStore(entity: HassEntityLike, connection: RealConnection): StoreView {
  const store = new EntityStore([entityId(SKY)]);
  store.ingest({
    states: { [SKY]: entity },
    connected: connection.connected,
    resync: { armed: connection.armed, ...(connection.base !== undefined && { base: connection.base }) },
    meta: {
      connection: connectionToken(connection.connected, connection.armed, 'RUNNING'),
      locale: [undefined, undefined, undefined, undefined],
      theme: false,
      registry: undefined,
      services: undefined,
      user: undefined,
    },
  });
  return store;
}

function views(entity: HassEntityLike, options: InputOptions & { nowMs?: number; store?: FakeStoreOptions } = {}) {
  const selector = createSkySelector();
  const subject = input(fakeStore([entity], options.store), options.nowMs ?? NOW_MS, options);
  const state = selector.state(subject);
  return {
    state,
    panel: selector.panel(subject, state),
    drawer: (ui: SkyDrawerUi = NEARBY) => selector.drawer(subject, state, ui),
  };
}

function byLabel(rows: readonly AircraftVM[], label: string): AircraftVM {
  const row = rows.find((item) => item.label === label);
  if (row === undefined) throw new Error(`no row ${label}`);
  return row;
}

describe('airspaceState: precedence over every normalize status (AIRSPACE.md §4)', () => {
  it('is loading before the first ingest, and while HA starts without the entity', () => {
    expect(stateOf(fixture('normal'), NOW_MS, { ready: false }).status).toBe('loading');
    expect(stateOf(undefined, NOW_MS, { haState: 'STARTING' }).status).toBe('loading');
  });

  it('is missing when HA has no such entity, and when airspace is not configured', () => {
    expect(stateOf(undefined).status).toBe('missing');
    const unconfigured = input(fakeStore([fixture('normal')]), NOW_MS, { config: configFrom({}) });
    expect(airspaceState(unconfigured).status).toBe('missing');
  });

  it('is unavailable for an unavailable or unknown sensor, never data', () => {
    for (const state of ['unavailable', 'unknown']) {
      const entity = { ...fixture('normal'), state };
      expect(stateOf(entity)).toEqual({ status: 'unavailable', skewAhead: false, noData: false, drawable: false });
    }
  });

  it('layers offline over data only: a disconnected unavailable or malformed sensor stays that', () => {
    expect(stateOf({ ...fixture('normal'), state: 'unavailable' }, NOW_MS, { connected: false }).status).toBe(
      'unavailable',
    );
    const malformed = sensor({ ...skyAttributes('normal', fixtureClock(NOW_MS)), radius_km: 0 }, '8', NOW_MS);
    expect(stateOf(malformed, NOW_MS, { connected: false }).status).toBe('malformed');
    expect(stateOf(undefined, NOW_MS, { connected: false }).status).toBe('missing');
  });

  it('is offline over live, empty and stale data while disconnected or resyncing', () => {
    for (const options of [{ connected: false }, { connected: false, resyncing: true }]) {
      const offline = stateOf(fixture('normal'), NOW_MS, options);
      expect(offline.status).toBe('offline');
      expect(offline.parse?.aircraft).toHaveLength(8);
      expect(offline.drawable).toBe(true);
    }
    expect(stateOf(fixture('empty'), NOW_MS, { connected: false }).status).toBe('offline');
    expect(stateOf(fixture('degraded'), NOW_MS, { connected: false }).status).toBe('offline');
  });

  it('reports unsupported and malformed payloads', () => {
    const attributes = skyAttributes('normal', fixtureClock(NOW_MS));
    expect(stateOf(sensor({ ...attributes, schema_version: 2 }, '8', NOW_MS)).status).toBe('unsupported');
    expect(stateOf(sensor({ ...attributes, aircraft: 'none' }, '8', NOW_MS)).status).toBe('malformed');
  });
});

describe('airspaceState: offline means HA is disconnected or resyncing (AIRSPACE.md §4, §5)', () => {
  it('is offline over data while the resync barrier holds, although the socket already reads connected', () => {
    const entity = fixture('normal');
    const store = realStore(entity, { connected: true, armed: true, base: { [SKY]: entity } });
    expect([store.isConnected(), store.isResyncing()]).toEqual([false, true]);
    expect(airspaceState(input(store, NOW_MS))).toMatchObject({ status: 'offline', drawable: true });
  });

  it('judges an entity the reconnect snapshot did not replace by its own age once HA is connected', () => {
    // For example a sensor deleted during the outage: hass.states keeps the old object. normalize reads it as
    // 'disconnected' (not refreshed), but HA is connected, so its own updated_at decides: never "offline", and stale
    // then undrawable as it ages.
    const unrefreshed = (ageMs: number) => {
      const entity = fixture('normal', ageMs);
      const store = realStore(entity, { connected: true, armed: false, base: { [SKY]: entity } });
      expect([store.isConnected(), normalizeEntity(store, entityId(SKY)).status]).toEqual([true, 'disconnected']);
      return airspaceState(input(store, NOW_MS));
    };
    expect(unrefreshed(FIXTURE_AGE_MS).status).toBe('live');
    expect(unrefreshed(4 * MINUTE)).toMatchObject({ status: 'stale', drawable: true });
    expect(unrefreshed(16 * MINUTE)).toMatchObject({ status: 'stale', drawable: false });
  });

  it('is live again once a disconnect ends and the sensor was refreshed', () => {
    const entity = fixture('normal');
    expect(airspaceState(input(realStore(entity, { connected: false, armed: false }), NOW_MS)).status).toBe('offline');
    const refreshed = fixture('normal');
    const store = realStore(refreshed, { connected: true, armed: false, base: { [SKY]: entity } });
    expect(airspaceState(input(store, NOW_MS)).status).toBe('live');
  });
});

describe('airspaceState: liveness bounds (AIRSPACE.md §5)', () => {
  it('is live up to 180 s after updated_at and stale after, with no entity update', () => {
    const entity = fixture('normal');
    const updatedMs = NOW_MS - FIXTURE_AGE_MS;
    expect(stateOf(entity, updatedMs + 179 * SECOND).status).toBe('live');
    expect(stateOf(entity, updatedMs + 180 * SECOND).status).toBe('live');
    expect(stateOf(entity, updatedMs + 181 * SECOND).status).toBe('stale');
    expect(stateOf(fixture('empty')).status).toBe('empty');
  });

  it('stops drawing stale or offline data 15 minutes after updated_at', () => {
    const entity = fixture('normal');
    const updatedMs = NOW_MS - FIXTURE_AGE_MS;
    expect(stateOf(entity, updatedMs + 15 * MINUTE)).toMatchObject({ status: 'stale', drawable: true });
    expect(stateOf(entity, updatedMs + 15 * MINUTE + SECOND)).toMatchObject({ status: 'stale', drawable: false });
    expect(stateOf(entity, updatedMs + 16 * MINUTE, { connected: false })).toMatchObject({
      status: 'offline',
      drawable: false,
    });
    expect(stateOf(entity, updatedMs + 15 * MINUTE + SECOND).parse).toBeDefined();
  });

  it('blames a timestamp more than 60 s ahead on the device clock, and recovers with the same entity object', () => {
    const ahead = fixture('normal', -61 * SECOND);
    expect(stateOf(ahead)).toEqual({ status: 'malformed', skewAhead: true, noData: false, drawable: false });
    expect(stateOf(ahead, NOW_MS + 2 * SECOND)).toMatchObject({ status: 'live', skewAhead: false, ageMs: 0 });
    expect(stateOf(fixture('normal', -30 * SECOND))).toMatchObject({ status: 'live', ageMs: 0 });
  });

  it('waits at most 180 s for aircraft data, then reports no data, even with the same entity object', () => {
    const store = fakeStore([sensor({}, '4', NOW_MS)]);
    const at = (ms: number) => airspaceState(input(store, ms));
    expect(at(NOW_MS).status).toBe('waiting');
    expect(at(NOW_MS + 180 * SECOND).status).toBe('waiting');
    expect(at(NOW_MS + 181 * SECOND)).toEqual({ status: 'malformed', skewAhead: false, noData: true, drawable: false });
  });

  it('cannot hold waiting past the bound with a count that keeps changing every 30 s', () => {
    // One StoreView object across updates, as the root holds it; each update is a new entity object.
    let current: HassEntityLike | undefined;
    const store: StoreView = { ...fakeStore([]), get: () => current };
    const statusAt = (step: number) => {
      current = sensor({}, String(step), NOW_MS + step * 30 * SECOND);
      return airspaceState(input(store, NOW_MS + step * 30 * SECOND)).status;
    };
    expect([0, 3, 6].map(statusAt)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(statusAt(7)).toBe('malformed');
    // Another store is another card: its window starts on its own.
    expect(airspaceState(input(fakeStore([current as HassEntityLike]), NOW_MS + 7 * 30 * SECOND)).status).toBe(
      'waiting',
    );
  });

  it('never waits on a last_updated in the future or long past', () => {
    expect(stateOf(sensor({}, '4', NOW_MS + 61 * SECOND))).toMatchObject({ status: 'malformed', noData: true });
    expect(stateOf(sensor({}, '4', NOW_MS - 181 * SECOND))).toMatchObject({ status: 'malformed', noData: true });
    expect(stateOf(sensor({}, '4', NOW_MS - 180 * SECOND)).status).toBe('waiting');
  });

  it('clears the waiting window when an envelope arrives, so a later restore waits afresh', () => {
    let current: HassEntityLike = sensor({}, '4', NOW_MS);
    const store: StoreView = { ...fakeStore([]), get: () => current };
    const at = (ms: number) => airspaceState(input(store, ms)).status;
    expect(at(NOW_MS)).toBe('waiting');
    current = skyEntity('normal', fixtureClock(NOW_MS + 60 * SECOND));
    expect(at(NOW_MS + 60 * SECOND)).toBe('live');
    current = sensor({}, '8', NOW_MS + 10 * MINUTE);
    expect(at(NOW_MS + 10 * MINUTE)).toBe('waiting');
    expect(at(NOW_MS + 10 * MINUTE + 180 * SECOND)).toBe('waiting');
    expect(at(NOW_MS + 10 * MINUTE + 181 * SECOND)).toBe('malformed');
  });

  it.each([
    ['unavailable', 'unavailable', true],
    ['unknown', 'unknown', true],
    ['unavailable while disconnected', 'unavailable', false],
    ['missing', undefined, true],
  ] as const)('restarts the waiting window after an %s observation', (_label, between, connectedBetween) => {
    // One StoreView object throughout: the waiting window is kept per store.
    let current: HassEntityLike | undefined = sensor({}, '4', NOW_MS);
    let connected = true;
    const store: StoreView = { ...fakeStore([]), get: () => current, isConnected: () => connected };
    const at = (ms: number) => airspaceState(input(store, ms)).status;
    expect(at(NOW_MS)).toBe('waiting');
    current = between === undefined ? undefined : { ...sensor({}, '4', NOW_MS + 10 * MINUTE), state: between };
    connected = connectedBetween;
    expect(at(NOW_MS + 10 * MINUTE)).toBe(between === undefined ? 'missing' : 'unavailable');
    // Restored without attributes ten minutes later: a fresh window, still bounded.
    connected = true;
    current = sensor({}, '6', NOW_MS + 20 * MINUTE);
    expect(at(NOW_MS + 20 * MINUTE)).toBe('waiting');
    expect(at(NOW_MS + 20 * MINUTE + 180 * SECOND)).toBe('waiting');
    expect(at(NOW_MS + 20 * MINUTE + 181 * SECOND)).toBe('malformed');
  });

  it('shares the waiting window between the panel and the drawer selectors', () => {
    const store = fakeStore([sensor({}, '4', NOW_MS)]);
    expect(createSkySelector().state(input(store, NOW_MS)).status).toBe('waiting');
    expect(createSkySelector().state(input(store, NOW_MS + 181 * SECOND)).status).toBe('malformed');
  });
});

describe('sky panel (AIRSPACE.md §4, §6)', () => {
  it('counts nearby aircraft, overhead aircraft and the nearest, live', () => {
    const { panel } = views(fixture('normal'));
    expect(panel).toMatchObject({
      count: 8,
      countLabel: 'aircraft within 25 km',
      overheadCount: 1,
      radiusText: 'within 25 km',
      freshness: { status: 'live', live: true, ageText: 'Updated just now' },
    });
    expect(panel.nearest?.label).toBe('DEMO214');
    expect(panel.freshness.pill).toBeUndefined();
    expect(panel.freshness.sentence).toBeUndefined();
    expect(Object.hasOwn(panel, 'droppedText')).toBe(false);
  });

  it('reads quiet skies with a zero count and no nearest when empty', () => {
    const { panel } = views(fixture('empty'));
    expect(panel).toMatchObject({ count: 0, countLabel: 'Quiet skies within 25 km' });
    expect(Object.hasOwn(panel, 'overheadCount')).toBe(false);
    expect(Object.hasOwn(panel, 'nearest')).toBe(false);
  });

  it('picks the nearest overhead aircraft whatever the list order', () => {
    const attributes = skyAttributes('normal', fixtureClock(NOW_MS));
    const reversed = { ...attributes, aircraft: [...(attributes['aircraft'] as unknown[])].reverse() };
    expect(views(sensor(reversed, '8', NOW_MS)).panel.nearest?.label).toBe('DEMO214');
  });

  it('shows "Not live" and the age, never a count, when stale or offline', () => {
    const stale = views(fixture('degraded')).panel;
    expect(stale.freshness).toEqual({
      status: 'stale',
      live: false,
      pill: { label: 'Not live', tone: 'attention' },
      ageText: 'Last update 7 min ago',
      sentence: 'No fresh aircraft data',
    });
    expect(Object.hasOwn(stale, 'count')).toBe(false);
    expect(Object.hasOwn(stale, 'nearest')).toBe(false);
    const offline = views(fixture('normal'), { store: { connected: false } }).panel;
    expect(offline.freshness.sentence).toBe('Not live while Home Assistant is offline');
    expect(offline.freshness.pill).toBeUndefined();
  });

  it('notes nearby entries that were not shown, never recent ones beside the nearby count', () => {
    const attributes = skyAttributes('normal', fixtureClock(NOW_MS));
    const bad = (count: number) => Array.from({ length: count }, () => ({ hex: 'bad' }));
    const withBad = (nearby: number, recent = 0) => ({
      ...attributes,
      aircraft: [...(attributes['aircraft'] as unknown[]), ...bad(nearby)],
      recent: [...(attributes['recent'] as unknown[]), ...bad(recent)],
    });
    expect(views(sensor(withBad(1), '8', NOW_MS)).panel.droppedText).toBe('1 entry not shown');
    expect(views(sensor(withBad(2, 3), '8', NOW_MS)).panel.droppedText).toBe('2 entries not shown');
    expect(Object.hasOwn(views(sensor(withBad(0, 2), '8', NOW_MS)).panel, 'droppedText')).toBe(false);
  });

  it('uses the HA length unit for the radius', () => {
    expect(views(fixture('normal'), { formatter: MI }).panel).toMatchObject({
      countLabel: 'aircraft within 15.5 mi',
      radiusText: 'within 15.5 mi',
    });
  });

  it.each([
    ['missing', undefined, {}, 'Sky sensor not found'],
    ['unavailable', 'unavailable', {}, 'Aircraft data unavailable'],
    ['unsupported', 'schema', {}, 'Unsupported sky data'],
    ['malformed', 'malformed', {}, 'Sky data could not be read'],
    ['skew', 'ahead', {}, "Sky data is ahead of this device's clock"],
    ['no data', 'nodata', {}, 'No aircraft data from the sky sensor'],
    ['waiting', 'waiting', {}, 'Waiting for aircraft data'],
    ['loading', 'normal', { ready: false }, 'Loading the sky.'],
  ] as const)('words the %s state', (_label, variant, storeOptions, sentence) => {
    const attributes = skyAttributes('normal', fixtureClock(NOW_MS));
    const entities: Record<string, HassEntityLike> = {
      unavailable: { ...fixture('normal'), state: 'unavailable' },
      schema: sensor({ ...attributes, schema_version: 3 }, '8', NOW_MS),
      malformed: sensor({ ...attributes, updated_at: 'yesterday' }, '8', NOW_MS),
      ahead: fixture('normal', -2 * MINUTE),
      nodata: sensor({}, '8', NOW_MS - 10 * MINUTE),
      waiting: sensor({}, '8', NOW_MS),
      normal: fixture('normal'),
    };
    const entity = variant === undefined ? undefined : entities[variant];
    const selector = createSkySelector();
    const subject = input(fakeStore(entity === undefined ? [] : [entity], storeOptions), NOW_MS);
    const panel = selector.panel(subject, selector.state(subject));
    expect(panel.freshness.sentence).toBe(sentence);
    expect(panel.freshness.live).toBe(false);
  });
});

describe('sky drawer (AIRSPACE.md §4, §6)', () => {
  it('offers the three views with counts, "12+" for a full recent list', () => {
    expect(views(fixture('normal')).drawer().views).toEqual([
      { id: 'nearby', label: 'Nearby', count: 8 },
      { id: 'overhead', label: 'Overhead', count: 1 },
      { id: 'recent', label: 'Recent', count: 3 },
    ]);
    expect(
      views(fixture('dense'))
        .drawer()
        .views.map((view) => view.count),
    ).toEqual([50, 3, '12+']);
  });

  it('offers Latest only in Recent, where it is the default; another view falls back to Distance', () => {
    const { drawer } = views(fixture('normal'));
    expect(drawer({ view: 'recent', sort: 'latest', filter: '' }).sorts).toEqual([
      'latest',
      'distance',
      'altitude',
      'name',
    ]);
    expect(drawer({ view: 'nearby', sort: 'latest', filter: '' })).toMatchObject({
      sort: 'distance',
      sorts: ['distance', 'altitude', 'name'],
    });
    expect([defaultSkySort('recent'), defaultSkySort('nearby'), defaultSkySort('overhead')]).toEqual([
      'latest',
      'distance',
      'distance',
    ]);
  });

  it('sorts by distance, altitude (unknown last), name (numeric) and latest', () => {
    const { drawer } = views(fixture('normal'));
    const labels = (ui: Partial<SkyDrawerUi>) => drawer({ ...NEARBY, ...ui }).rows.map((row) => row.label);
    expect(labels({ sort: 'distance' })).toEqual([
      'DEMO214',
      'TEST88',
      'DEMO7',
      'N0482Q',
      '001234',
      'TEST451',
      'DEMO66',
      'TEST302',
    ]);
    expect(labels({ sort: 'altitude' }).slice(0, 2)).toEqual(['DEMO66', '001234']);
    expect(labels({ sort: 'name' })).toEqual([
      '001234',
      'DEMO7',
      'DEMO66',
      'DEMO214',
      'N0482Q',
      'TEST88',
      'TEST302',
      'TEST451',
    ]);
    expect(labels({ view: 'recent', sort: 'latest' })).toEqual(['DEMO214', 'TEST910', 'N0733K']);
    const noAltitude = sensor(
      {
        ...skyAttributes('normal', fixtureClock(NOW_MS)),
        aircraft: (skyAttributes('normal', fixtureClock(NOW_MS))['aircraft'] as Record<string, unknown>[]).map(
          (row, index) => (index === 0 ? { ...row, altitude_ft: undefined } : row),
        ),
      },
      '8',
      NOW_MS,
    );
    const altitudeOrder = views(noAltitude).drawer({ ...NEARBY, sort: 'altitude' }).rows;
    expect(altitudeOrder.at(-1)?.label).toBe('DEMO214');
  });

  it('filters case-insensitively over label, identifiers, type, airline and route codes, trimmed', () => {
    const { drawer } = views(fixture('normal'));
    const labels = (filter: string) => drawer({ ...NEARBY, filter }).rows.map((row) => row.label);
    expect(labels('  b738 ')).toEqual(['DEMO214', 'DEMO66']);
    expect(labels('example air')).toEqual(['DEMO214']);
    expect(labels('xbbb')).toEqual(['DEMO214']);
    expect(labels('n0214')).toEqual(['DEMO214']);
    const none = drawer({ ...NEARBY, filter: 'nothing like this' });
    expect(none).toMatchObject({ rows: [], total: 8, emptyText: 'No aircraft match this search.' });
  });

  it('offers search from 16 rows, and keeps the expanded row only while it is listed', () => {
    expect(views(fixture('dense')).drawer().searchable).toBe(true);
    const { drawer } = views(fixture('normal'));
    expect(drawer().searchable).toBe(false);
    expect(drawer({ ...NEARBY, expanded: '002c3d' }).expanded).toBe('002c3d');
    expect(Object.hasOwn(drawer({ ...NEARBY, view: 'overhead', expanded: '002c3d' }), 'expanded')).toBe(false);
    expect(Object.hasOwn(drawer({ ...NEARBY, filter: 'demo214', expanded: '002c3d' }), 'expanded')).toBe(false);
  });

  it('keeps search and the typed filter while the count falls below 16, and withdraws it once cleared', () => {
    const attributes = skyAttributes('dense', fixtureClock(NOW_MS));
    const nearby = (count: number) => {
      const aircraft = (attributes['aircraft'] as unknown[]).slice(0, count);
      return views(sensor({ ...attributes, aircraft }, String(count), NOW_MS)).drawer;
    };
    const typed = { ...NEARBY, filter: 'demo' };
    expect(nearby(17)(typed).searchable).toBe(true);
    const fewer = nearby(15)(typed);
    expect(fewer).toMatchObject({ searchable: true, total: 15 });
    expect(fewer.rows.length).toBeGreaterThan(0);
    expect(fewer.rows.length).toBeLessThan(fewer.total);
    expect(fewer.rows.every((row) => row.label.startsWith('DEMO'))).toBe(true);
    expect(nearby(15)(NEARBY).searchable).toBe(false);
    expect(nearby(15)({ ...NEARBY, filter: '   ' }).searchable).toBe(false);
  });

  it('shows nothing aircraft-related beyond the drawable cutoff, only the banner', () => {
    const stale = views(fixture('normal', 16 * MINUTE)).drawer();
    expect(stale).toMatchObject({ rows: [], total: 0, searchable: false });
    expect(stale.freshness.sentence).toBe('No fresh aircraft data.');
    expect(Object.hasOwn(stale, 'radar')).toBe(false);
    expect(stale.views.every((view) => view.count === undefined)).toBe(true);
    const offline = views(fixture('normal', 16 * MINUTE), { store: { connected: false } }).drawer();
    expect(offline.freshness.sentence).toBe('Not live. Aircraft return when Home Assistant reconnects.');
  });

  it('shows the last list, muted, under a "Not live" banner while stale or offline and drawable', () => {
    const stale = views(fixture('normal', 4 * MINUTE)).drawer();
    expect(stale.freshness.sentence).toBe('Not live. Positions have changed since the last update.');
    expect(stale.rows).toHaveLength(8);
    expect(stale.rows.some((row) => row.overhead)).toBe(false);
    expect(stale.radar?.live).toBe(false);
    expect(views(fixture('empty', 4 * MINUTE)).drawer().freshness.sentence).toBe(
      'Not live. The last update reported no aircraft.',
    );
    const offline = (kind: SkyFixtureKind) => views(fixture(kind), { store: { connected: false } }).drawer();
    expect(offline('normal').freshness.sentence).toBe('Not live. Showing the last aircraft received.');
    expect(offline('empty').freshness.sentence).toBe('Not live. No aircraft were reported in the last update.');
  });

  it('words empty views by view and liveness', () => {
    const empty = views(fixture('empty')).drawer;
    expect(empty().emptyText).toBe('No aircraft within 25 km right now.');
    expect(empty({ ...NEARBY, view: 'overhead' }).emptyText).toBe('Nothing overhead right now.');
    const noRecent = sensor({ ...skyAttributes('empty', fixtureClock(NOW_MS)), recent: [] }, '0', NOW_MS);
    expect(views(noRecent).drawer({ view: 'recent', sort: 'latest', filter: '' }).emptyText).toBe(
      'No aircraft passed overhead in the last 30 minutes.',
    );
    expect(views(fixture('empty', 4 * MINUTE)).drawer().emptyText).toBe(
      'No aircraft were reported in the last update.',
    );
  });

  it('captions the radar, notes recent passes and dropped entries, and keeps the attribution', () => {
    const drawer = views(fixture('normal')).drawer();
    expect(drawer).toMatchObject({
      radiusText: 'Within 25 km',
      overheadText: 'Dashed ring: overhead within 3 km',
      recentNote: 'Aircraft seen within 3 km in the last 30 minutes, newest 12 kept. Fast flyovers can be missed.',
      attribution: 'Aircraft positions: ADSB.lol (ODbL 1.0); reported routes: VRS via ADSB.lol (CC0)',
    });
    expect(Object.hasOwn(drawer, 'footnote')).toBe(false);
    expect(views(fixture('degraded')).drawer().footnote).toBe(
      '2 nearby entries in the latest sky data could not be shown.',
    );
    const missing = createSkySelector();
    const subject = input(fakeStore([]), NOW_MS);
    expect(missing.drawer(subject, missing.state(subject), NEARBY).recentNote).toBe(
      'Aircraft seen overhead in the last 30 minutes, newest 12 kept. Fast flyovers can be missed.',
    );
  });

  it('reports dropped nearby and recent entries separately in the footnote', () => {
    const attributes = skyAttributes('normal', fixtureClock(NOW_MS));
    const bad = (count: number) => Array.from({ length: count }, () => ({ hex: 'bad' }));
    const footnote = (nearby: number, recent: number) =>
      views(
        sensor(
          {
            ...attributes,
            aircraft: [...(attributes['aircraft'] as unknown[]), ...bad(nearby)],
            recent: [...(attributes['recent'] as unknown[]), ...bad(recent)],
          },
          '8',
          NOW_MS,
        ),
      ).drawer().footnote;
    expect(footnote(2, 1)).toBe('2 nearby entries and 1 recent entry in the latest sky data could not be shown.');
    expect(footnote(0, 3)).toBe('3 recent entries in the latest sky data could not be shown.');
    expect(footnote(1, 0)).toBe('1 nearby entry in the latest sky data could not be shown.');
  });

  it('draws recent passes as history, never overhead now', () => {
    const recent = views(fixture('normal')).drawer({ view: 'recent', sort: 'latest', filter: '' }).rows;
    expect(recent.every((row) => !row.overhead)).toBe(true);
    expect(byLabel(recent, 'DEMO214').closest).toBe('Closest 1.1 km at last overhead pass');
    expect(byLabel(recent, 'TEST910').accessibleName).toContain('at last overhead pass');
  });

  it('links to the tracking site in HA mode only', () => {
    expect(byLabel(views(fixture('normal')).drawer().rows, 'DEMO214').link).toBe('https://globe.adsb.lol/?icao=001a2b');
    const demo = views(fixture('normal'), { kind: 'demo' }).drawer().rows;
    expect(demo.every((row) => row.link === undefined)).toBe(true);
  });
});

describe('aircraft wording (AIRSPACE.md §3)', () => {
  const rows = views(fixture('normal')).drawer().rows;

  it('describes an aircraft with barometric altitude, ground speed and track, and a reported route', () => {
    expect(byLabel(rows, 'DEMO214')).toEqual({
      key: '001a2b',
      label: 'DEMO214',
      labelKind: 'callsign',
      icao: '001A2B',
      registration: 'N0214D',
      type: 'B738',
      altitude: '4,800 ft baro',
      speed: '212 kn',
      track: { deg: '135°', compass: 'SE' },
      trend: { kind: 'descending', word: 'Descending', text: 'Descending · 640 ft/min' },
      distance: '1.4 km',
      bearing: { deg: '315°', compass: 'NW' },
      overhead: true,
      seen: 'seen just now',
      route: {
        codes: 'XAAA → XBBB',
        names: 'Example International → Sample Regional',
        airline: 'Example Air',
        source: 'VRS via ADSB.lol',
      },
      accessibleName: 'DEMO214, B738, 4,800 feet barometric, 1.4 kilometres north-west, descending, overhead',
      link: 'https://globe.adsb.lol/?icao=001a2b',
    });
  });

  it('names a hex-only aircraft by its ICAO address, and omits what is unknown', () => {
    const hexOnly = byLabel(rows, '001234');
    expect(hexOnly.labelKind).toBe('hex');
    expect(hexOnly.accessibleName).toBe('ICAO address 001234, B77W, 33,000 feet barometric, 15 kilometres west');
    expect(Object.hasOwn(hexOnly, 'trend')).toBe(false);
    expect(Object.hasOwn(byLabel(rows, 'TEST451'), 'track')).toBe(false);
  });

  it('uses one decimal below 10 units and whole numbers above, in km or miles', () => {
    expect(['DEMO7', 'N0482Q'].map((label) => byLabel(rows, label).distance)).toEqual(['9.8 km', '11 km']);
    const miles = views(fixture('normal'), { formatter: MI }).drawer().rows;
    expect(['DEMO214', 'TEST451'].map((label) => byLabel(miles, label).distance)).toEqual(['0.9 mi', '11 mi']);
    expect(byLabel(miles, 'DEMO214').accessibleName).toContain('0.9 miles north-west');
  });

  it('reads level below 250 ft/min, and climbing or descending from it', () => {
    const trendAt = (vertical: number) => {
      const attributes = skyAttributes('normal', fixtureClock(NOW_MS));
      const aircraft = (attributes['aircraft'] as Record<string, unknown>[]).map((row, index) =>
        index === 0 ? { ...row, vertical_rate_fpm: vertical } : row,
      );
      return byLabel(views(sensor({ ...attributes, aircraft }, '8', NOW_MS)).drawer().rows, 'DEMO214').trend;
    };
    expect(trendAt(249)).toEqual({ kind: 'level', word: 'Level', text: 'Level' });
    expect(trendAt(-249)).toEqual({ kind: 'level', word: 'Level', text: 'Level' });
    expect(trendAt(250)).toEqual({ kind: 'climbing', word: 'Climbing', text: 'Climbing · 250 ft/min' });
    expect(trendAt(-1500)).toEqual({ kind: 'descending', word: 'Descending', text: 'Descending · 1,500 ft/min' });
  });

  it('pads degrees to three digits', () => {
    expect(byLabel(rows, 'TEST88').bearing).toEqual({ deg: '045°', compass: 'NE' });
    expect(byLabel(rows, 'DEMO66').bearing).toEqual({ deg: '022°', compass: 'NNE' });
  });

  it('words ages at minute granularity, never negative', () => {
    const ageText = (ageMs: number) => views(fixture('normal', ageMs)).panel.freshness.ageText;
    expect(ageText(59 * SECOND)).toBe('Updated just now');
    expect(ageText(60 * SECOND)).toBe('Updated 1 min ago');
    expect(ageText(179 * SECOND)).toBe('Updated 2 min ago');
    expect(ageText(-30 * SECOND)).toBe('Updated just now');
    const recent = views(fixture('normal')).drawer({ view: 'recent', sort: 'latest', filter: '' }).rows;
    expect(byLabel(recent, 'TEST910').seen).toBe('seen 11 min ago');
  });
});

describe('compassPoint (16-wind)', () => {
  it.each([
    [0, 'N', 'north'],
    [11.24, 'N', 'north'],
    [11.25, 'NNE', 'north-north-east'],
    [90, 'E', 'east'],
    [225, 'SW', 'south-west'],
    [348.74, 'NNW', 'north-north-west'],
    [348.75, 'N', 'north'],
    [360, 'N', 'north'],
    [-10, 'N', 'north'],
    [-90, 'W', 'west'],
  ])('%s° is %s', (deg, abbr, name) => {
    expect(compassPoint(deg)).toEqual({ abbr, name });
  });
});

describe('createSkySelector: memoization (AIRSPACE.md §6)', () => {
  it('reuses rows, radar and the nearest aircraft for the same inputs, and rebuilds on a change', () => {
    const entity = fixture('normal');
    const store = fakeStore([entity]);
    const selector = createSkySelector();
    const render = (nowMs: number, ui: SkyDrawerUi = NEARBY, formatter: Formatter = KM) => {
      const subject = input(store, nowMs, { formatter });
      const state = selector.state(subject);
      return { panel: selector.panel(subject, state), drawer: selector.drawer(subject, state, ui) };
    };
    const first = render(NOW_MS);
    const again = render(NOW_MS + 10 * SECOND);
    expect(again.drawer.rows).toBe(first.drawer.rows);
    expect(again.drawer.radar).toBe(first.drawer.radar);
    expect(again.panel.nearest).toBe(first.panel.nearest);
    expect(render(NOW_MS, { ...NEARBY, filter: 'demo' }).drawer.rows).not.toBe(first.drawer.rows);
    const nextMinute = render(NOW_MS + MINUTE);
    expect(nextMinute.drawer.rows).not.toBe(first.drawer.rows);
    expect(nextMinute.drawer.radar).toBe(first.drawer.radar);
    expect(render(NOW_MS + MINUTE, NEARBY, MI).drawer.rows).not.toBe(nextMinute.drawer.rows);
  });
});
