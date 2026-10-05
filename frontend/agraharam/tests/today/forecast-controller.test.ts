/**
 * Forecast lifecycle (§9.2, §12.1 row 10): which subscriptions start, when they stop, the socket-generation rule
 * through the real HassHost, the resync barrier, the single retry after invalid_entity_id, and leak-free teardown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, ResolvedConfig } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { FakeHass } from '../../src/dev/fake-hass.ts';
import { WEATHER_FEATURE } from '../../src/ha/features.ts';
import {
  ForecastController,
  forecastPlan,
  type ForecastSource,
  type ForecastTypeState,
} from '../../src/ha/forecast-controller.ts';
import { HassHost } from '../../src/ha/hass-host.ts';
import type { ForecastHandlers, ForecastType, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard, type StatusBoard } from '../../src/ha/status-board.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { fakeReader } from '../helpers/services.ts';
import { ManualStore, TestHost } from './controller-host.ts';

const WEATHER = entityId('weather.demo_home');
const OTHER_WEATHER = entityId('weather.demo_other');
const FULL = WEATHER_FEATURE.FORECAST_DAILY | WEATHER_FEATURE.FORECAST_HOURLY;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// State machine over a hand-fed store and a recording reader.

interface Recorded {
  readonly id: EntityId;
  readonly type: ForecastType;
  readonly handlers: ForecastHandlers;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

function weatherEntity(features: number, state = 'sunny', id: string = WEATHER) {
  return testEntity(id, state, { temperature: 70, supported_features: features });
}

function setup(features = FULL, options: { weather?: EntityId } = {}) {
  const manual = new ManualStore(
    [WEATHER, OTHER_WEATHER],
    [weatherEntity(features), weatherEntity(FULL, 'sunny', OTHER_WEATHER)],
  );
  const subscriptions: Recorded[] = [];
  const reader: HostReader = {
    ...fakeReader(manual.view, () => manual.phase()),
    subscribeForecast: (id, type, handlers) => {
      const record = { id, type, handlers, unsubscribe: vi.fn() };
      subscriptions.push(record);
      return record.unsubscribe;
    },
  };
  const status = createStatusBoard();
  let source: ForecastSource = { reader, status, weather: options.weather ?? WEATHER };
  const host = new TestHost();
  const controller = new ForecastController(host, () => source);
  return {
    manual,
    subscriptions,
    status,
    host,
    controller,
    reader,
    source: () => source,
    setSource(next: Partial<ForecastSource>) {
      source = { ...source, ...next };
      host.update();
    },
    unbindWeather() {
      source = { reader: source.reader, status: source.status };
      host.update();
    },
    active: () => subscriptions.filter((s) => s.unsubscribe.mock.calls.length === 0),
  };
}

describe('the last live forecast survives a re-created Today section (§5.1 layout change)', () => {
  const HOURLY = [{ datetime: '2026-10-01T18:00:00Z', temperature: 68 }];

  it('a new controller on the same reader and socket starts from it, still subscribes, and takes the new payload', () => {
    const t = setup();
    t.host.connect();
    t.subscriptions[0]?.handlers.next({ type: 'hourly', forecast: HOURLY });
    t.host.disconnect();

    const host = new TestHost();
    const recreated = new ForecastController(host, t.source);
    host.connect();
    expect(recreated.snapshot().hourly).toEqual({ kind: 'live', items: HOURLY });
    expect(recreated.snapshot().daily).toEqual({ kind: 'subscribing' });
    expect(t.active().map((s) => s.type)).toEqual(['hourly', 'daily']);

    const fresh = [{ datetime: '2026-10-01T19:00:00Z', temperature: 66 }];
    t.active()[0]?.handlers.next({ type: 'hourly', forecast: fresh });
    expect(recreated.snapshot().hourly).toEqual({ kind: 'live', items: fresh });
  });

  it('is not used after the socket changed, nor by another runtime reader', () => {
    let generation = 1;
    const t = setup();
    const reader: HostReader = { ...t.reader, connectionGeneration: () => generation };
    t.setSource({ reader });
    t.host.connect();
    t.active()[0]?.handlers.next({ type: 'hourly', forecast: HOURLY });
    t.host.disconnect();

    generation = 2;
    const afterReconnect = new TestHost();
    const first = new ForecastController(afterReconnect, t.source);
    afterReconnect.connect();
    expect(first.snapshot().hourly).toEqual({ kind: 'subscribing' });
    afterReconnect.disconnect();

    const otherRuntime: ForecastSource = { ...t.source(), reader: { ...reader } };
    const host = new TestHost();
    const second = new ForecastController(host, () => otherRuntime);
    host.connect();
    expect(second.snapshot().hourly).toEqual({ kind: 'subscribing' });
  });
});

describe('forecastPlan (§9.2 needed types)', () => {
  it('hourly if advertised; daily if advertised, else twice_daily', () => {
    expect(forecastPlan(FULL)).toEqual({ hourly: true, daily: 'daily' });
    expect(forecastPlan(WEATHER_FEATURE.FORECAST_HOURLY | WEATHER_FEATURE.FORECAST_TWICE_DAILY)).toEqual({
      hourly: true,
      daily: 'twice_daily',
    });
    expect(forecastPlan(WEATHER_FEATURE.FORECAST_DAILY | WEATHER_FEATURE.FORECAST_TWICE_DAILY)).toEqual({
      hourly: false,
      daily: 'daily',
    });
    expect(forecastPlan(0)).toEqual({ hourly: false });
    expect(forecastPlan(undefined)).toEqual({ hourly: false });
    expect(forecastPlan('3')).toEqual({ hourly: false });
  });
});

describe('ForecastController', () => {
  it('starts one subscription per advertised type while connected', () => {
    const t = setup();
    t.host.connect();
    expect(t.subscriptions.map((s) => [s.id, s.type])).toEqual([
      [WEATHER, 'hourly'],
      [WEATHER, 'daily'],
    ]);
    expect(t.controller.snapshot()).toEqual({ hourly: { kind: 'subscribing' }, daily: { kind: 'subscribing' } });
  });

  it('subscribes to nothing when the entity advertises no forecast type', () => {
    const t = setup(0);
    t.host.connect();
    expect(t.subscriptions).toEqual([]);
    expect(t.status.get('forecast')).toBe('no forecast types');
  });

  it('subscribes to nothing without a weather binding', () => {
    const t = setup();
    t.unbindWeather();
    t.host.connect();
    expect(t.subscriptions).toEqual([]);
    expect(t.status.get('forecast')).toBe('not configured');
  });

  it('teardown calls each unsubscribe exactly once', () => {
    const t = setup();
    t.host.connect();
    t.host.disconnect();
    t.host.disconnect();
    expect(t.subscriptions.map((s) => s.unsubscribe.mock.calls.length)).toEqual([1, 1]);
    expect(t.controller.snapshot()).toEqual({});
  });

  it('re-attaching (route change, edit-mode toggle) resubscribes and asks the host to render', () => {
    const t = setup();
    t.host.connect();
    t.host.disconnect();
    const requests = t.host.updateRequests;
    t.host.connect();
    expect(t.active().map((s) => s.type)).toEqual(['hourly', 'daily']);
    expect(t.host.updateRequests).toBe(requests + 1);
  });

  it('a disconnect stops every subscription once and the reconnect starts new ones', () => {
    const t = setup();
    t.host.connect();
    t.manual.setConnected(false);
    expect(t.subscriptions.map((s) => s.unsubscribe.mock.calls.length)).toEqual([1, 1]);
    expect(t.status.get('forecast')).toBe('paused disconnected');
    t.manual.setConnected(true);
    expect(t.subscriptions).toHaveLength(4);
    expect(t.active().map((s) => s.type)).toEqual(['hourly', 'daily']);
  });

  it('a weather binding change stops the old subscriptions once and subscribes to the new entity', () => {
    const t = setup();
    t.host.connect();
    t.setSource({ weather: OTHER_WEATHER });
    expect(t.subscriptions.slice(0, 2).map((s) => s.unsubscribe.mock.calls.length)).toEqual([1, 1]);
    expect(t.active().map((s) => s.id)).toEqual([OTHER_WEATHER, OTHER_WEATHER]);
  });

  it('stops when the entity becomes unavailable or missing, and when its feature bit disappears', () => {
    const t = setup();
    t.host.connect();
    t.manual.put(testEntity(WEATHER, 'unavailable'));
    expect(t.active()).toEqual([]);
    t.manual.put(weatherEntity(FULL));
    expect(t.active()).toHaveLength(2);
    t.manual.put(weatherEntity(WEATHER_FEATURE.FORECAST_DAILY));
    expect(t.active().map((s) => s.type)).toEqual(['daily']);
    t.manual.remove(WEATHER);
    expect(t.active()).toEqual([]);
    expect(t.subscriptions.every((s) => s.unsubscribe.mock.calls.length <= 1)).toBe(true);
  });

  it('keeps an unknown-state entity subscribed (only unavailable or missing stops it)', () => {
    const t = setup();
    t.host.connect();
    t.manual.put(testEntity(WEATHER, 'unknown', { supported_features: FULL }));
    expect(t.active()).toHaveLength(2);
  });

  it('never subscribes while resyncing, then exactly once per type when the barrier clears', () => {
    const t = setup();
    t.host.connect();
    t.manual.setConnected(false);
    t.manual.setConnected(true, true); // socket back, snapshot not yet ingested
    expect(t.subscriptions).toHaveLength(2);
    expect(t.status.get('forecast')).toBe('paused resyncing');
    t.manual.setConnected(true, false);
    expect(t.subscriptions).toHaveLength(4);
    t.host.update();
    expect(t.subscriptions).toHaveLength(4);
  });

  it('records payloads and ignores events that arrive after a stop', () => {
    const t = setup();
    t.host.connect();
    const requestsAfterConnect = t.host.updateRequests;
    const [hourly] = t.subscriptions;
    hourly?.handlers.next({ type: 'hourly', forecast: [{ datetime: '2026-10-01T18:00:00Z', temperature: 68 }] });
    expect(t.controller.snapshot().hourly).toEqual({
      kind: 'live',
      items: [{ datetime: '2026-10-01T18:00:00Z', temperature: 68 }],
    });
    expect(t.host.updateRequests).toBe(requestsAfterConnect + 1);
    t.host.disconnect();
    hourly?.handlers.next({ type: 'hourly', forecast: [] });
    hourly?.handlers.error({ code: 'unknown' });
    expect(t.controller.snapshot()).toEqual({});
  });

  it('a late event from a replaced subscription does not overwrite the current one', () => {
    const t = setup();
    t.host.connect();
    const firstDaily = t.subscriptions[1];
    t.manual.setConnected(false);
    t.manual.setConnected(true);
    firstDaily?.handlers.next({ type: 'daily', forecast: [] });
    expect(t.controller.snapshot().daily).toEqual({ kind: 'subscribing' });
  });

  it('maps forecast: null to live with an empty list, and errors by kind', () => {
    const t = setup();
    t.host.connect();
    const [hourly, daily] = t.subscriptions;
    hourly?.handlers.next({ type: 'hourly', forecast: null });
    daily?.handlers.error({ code: 'unsupported', haCode: 'forecast_not_supported' });
    expect(t.controller.snapshot()).toEqual<Record<string, ForecastTypeState>>({
      hourly: { kind: 'live', items: [] },
      daily: { kind: 'unsupported' },
    });
    expect(t.status.get('forecast')).toBe('hourly live, daily unsupported');
  });

  it('invalid_entity_id: one new attempt when HA becomes RUNNING and one per registry change, none otherwise', () => {
    const t = setup(WEATHER_FEATURE.FORECAST_DAILY);
    t.manual.setHaState('STARTING');
    t.host.connect();
    const fail = (index: number) =>
      t.subscriptions[index]?.handlers.error({ code: 'unknown', haCode: 'invalid_entity_id' });
    fail(0);
    expect(t.controller.snapshot().daily).toEqual({ kind: 'error', reason: 'entity', haCode: 'invalid_entity_id' });
    t.manual.put(testEntity(WEATHER, 'rainy', { supported_features: WEATHER_FEATURE.FORECAST_DAILY }));
    t.host.update();
    expect(t.subscriptions).toHaveLength(1);
    t.manual.setHaState('RUNNING');
    expect(t.subscriptions).toHaveLength(2);
    expect(t.subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    fail(1);
    t.host.update();
    t.manual.setHaState('RUNNING');
    expect(t.subscriptions).toHaveLength(2);
    t.manual.touchRegistry();
    expect(t.subscriptions).toHaveLength(3);
    fail(2);
    t.manual.put(testEntity(WEATHER, 'sunny', { supported_features: WEATHER_FEATURE.FORECAST_DAILY }));
    expect(t.subscriptions).toHaveLength(3);
  });

  it('other errors are never retried while the start conditions hold', () => {
    const t = setup(WEATHER_FEATURE.FORECAST_DAILY);
    t.host.connect();
    t.subscriptions[0]?.handlers.error({ code: 'unknown', haCode: 'home_assistant_error' });
    t.manual.touchRegistry();
    t.manual.setHaState('RUNNING');
    t.host.update();
    expect(t.subscriptions).toHaveLength(1);
    expect(t.status.get('forecast')).toBe('daily error home_assistant_error');
  });

  it('leaves no timers behind after teardown', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.connect();
    t.subscriptions[0]?.handlers.next({ type: 'hourly', forecast: [] });
    t.host.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing subscribe is contained and logged', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = setup();
    const broken: HostReader = {
      ...fakeReader(t.manual.view, () => 'connected'),
      subscribeForecast: () => {
        throw new Error('boom');
      },
    };
    t.setSource({ reader: broken });
    expect(() => t.host.connect()).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'forecast-controller-failed');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Through the real HassHost and FakeHass (hajs-like connection, command ids, two-step reconnect).

function liveConfig(scenario: Parameters<typeof demoCardInput>[0]): ResolvedConfig {
  const result = validateConfig(demoCardInput(scenario));
  if (!result.ok) throw new Error('demo config invalid');
  return result.config;
}

function live(scenario: Parameters<typeof demoCardInput>[0] = 'normal') {
  vi.useFakeTimers();
  const fake = new FakeHass(scenario);
  const config = liveConfig(scenario);
  const runtime = new HassHost(config.bindings.keys());
  runtime.update(fake.hass);
  const stop = fake.onPush((hass) => runtime.update(hass));
  const status: StatusBoard = runtime.status;
  const host = new TestHost();
  const controller = new ForecastController(host, () => ({
    reader: runtime.reader,
    status,
    ...(config.weather !== undefined && { weather: config.weather }),
  }));
  const calls = (method: string) => fake.calls.filter((call) => call.method === method);
  return { fake, runtime, host, controller, status, calls, stop };
}

describe('ForecastController with HassHost and FakeHass', () => {
  it('daily + hourly: two subscriptions with the exact message and resubscribe: false, then live', () => {
    const t = live('normal');
    t.host.connect();
    expect(t.calls('connection.subscribeMessage').map((call) => call.args)).toEqual([
      [{ type: 'weather/subscribe_forecast', entity_id: WEATHER, forecast_type: 'hourly' }, { resubscribe: false }],
      [{ type: 'weather/subscribe_forecast', entity_id: WEATHER, forecast_type: 'daily' }, { resubscribe: false }],
    ]);
    vi.advanceTimersByTime(100);
    expect(t.controller.snapshot().hourly?.kind).toBe('live');
    expect(t.controller.snapshot().daily?.kind).toBe('live');
    expect(t.status.get('forecast')).toBe('hourly live, daily live');
  });

  it('teardown unsubscribes each subscription exactly once on the same socket', async () => {
    const t = live('normal');
    t.host.connect();
    await Promise.resolve();
    t.host.disconnect();
    expect(t.calls('unsubscribe_events').map((call) => call.args[0])).toEqual([
      { subscription: 1, socket: 1, stale: false },
      { subscription: 2, socket: 1, stale: false },
    ]);
    expect(t.calls('callService')).toEqual([]);
  });

  it('daily-only: one subscription', () => {
    const t = live('degraded');
    t.host.connect();
    expect(
      t.calls('connection.subscribeMessage').map((call) => (call.args[0] as { forecast_type: string }).forecast_type),
    ).toEqual(['daily']);
  });

  it('no forecast bits: no subscription at all', () => {
    const t = live('empty');
    t.host.connect();
    expect(t.calls('connection.subscribeMessage')).toEqual([]);
  });

  it('forecast_not_supported from HA → unsupported', async () => {
    const t = live('degraded');
    t.fake.setState(WEATHER, 'partlycloudy', { supported_features: FULL }); // hourly advertised, not served
    t.host.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.controller.snapshot().hourly).toEqual({ kind: 'unsupported' });
  });

  it('a socket drop never sends an old-generation unsubscribe, and the reconnect resubscribes once per type', async () => {
    const t = live('normal');
    t.host.connect();
    await Promise.resolve();
    t.fake.disconnect(); // 'disconnected' moves the generation on before the controller stops
    expect(t.calls('unsubscribe_events')).toEqual([]);
    t.fake.reconnect({ snapshotDelayMs: 0 }); // 'ready': command ids restart at 1
    expect(t.calls('connection.subscribeMessage')).toHaveLength(2); // still resyncing
    vi.advanceTimersByTime(0);
    expect(t.runtime.reader.connection().phase).toBe('connected');
    expect(t.calls('connection.subscribeMessage')).toHaveLength(4);
    await Promise.resolve();
    t.host.disconnect();
    expect(t.calls('unsubscribe_events').map((call) => call.args[0])).toEqual([
      { subscription: 1, socket: 2, stale: false },
      { subscription: 2, socket: 2, stale: false },
    ]);
  });

  it('an unsubscribe held across a reconnect is dropped, never sent on the new socket', async () => {
    const t = live('normal');
    const unsubscribe = t.runtime.reader.subscribeForecast(WEATHER, 'hourly', { next: vi.fn(), error: vi.fn() });
    await Promise.resolve();
    t.fake.disconnect();
    t.fake.reconnect({ snapshotDelayMs: 0 });
    vi.advanceTimersByTime(0);
    unsubscribe();
    expect(t.calls('unsubscribe_events')).toEqual([]);
  });

  it('two-step reconnect: no subscribe during the barrier, exactly one per type after the snapshot', () => {
    const t = live('normal');
    t.host.connect();
    t.fake.disconnect();
    t.fake.reconnect({ snapshotDelayMs: 400 });
    expect(t.runtime.reader.connection().phase).toBe('resyncing');
    t.host.update();
    expect(t.calls('connection.subscribeMessage')).toHaveLength(2);
    vi.advanceTimersByTime(400);
    expect(t.calls('connection.subscribeMessage')).toHaveLength(4);
    expect(t.calls('callService')).toEqual([]);
  });

  it('HA forecast errors surface as error states (starting scenario)', async () => {
    const t = live('starting');
    t.host.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.controller.snapshot()).toEqual({
      hourly: { kind: 'error', reason: 'other', haCode: 'home_assistant_error' },
      daily: { kind: 'error', reason: 'other', haCode: 'home_assistant_error' },
    });
  });
});
