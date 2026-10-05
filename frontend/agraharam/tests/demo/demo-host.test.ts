import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { DemoHost } from '../../src/demo/demo-host.ts';
import type { ServiceCall } from '../../src/ha/host.ts';
import { normalizeEntity } from '../../src/ha/normalize.ts';
import { entityId } from '../helpers/fake-store.ts';

const LIGHT = entityId('light.demo_kitchen');
const CAMERA = entityId('camera.demo_front_gate');
const TURN_ON: ServiceCall = { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: LIGHT } };
const NOW = new Date(2026, 8, 30, 17, 51, 0).getTime();

function host(scenario: Parameters<typeof DemoHost.prototype.setScenario>[0] = 'normal'): DemoHost {
  return new DemoHost(scenario, { latencyMs: [0, 0], random: () => 0, now: () => NOW });
}

function snapshotRequest() {
  return { width: 320, height: 240, signal: new AbortController().signal };
}

let networkSpies: ReturnType<typeof vi.fn>[];

beforeEach(() => {
  vi.useFakeTimers();
  networkSpies = [vi.fn(), vi.fn(), vi.fn()];
  vi.stubGlobal('fetch', networkSpies[0]);
  vi.stubGlobal('WebSocket', networkSpies[1]);
  vi.stubGlobal('XMLHttpRequest', networkSpies[2]);
});

afterEach(() => {
  for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DemoHost (§4.4, §10.1)', () => {
  it('ingests the assembled scenario at once and reports connected', () => {
    const demo = host();
    expect(demo.reader.kind).toBe('demo');
    expect(demo.reader.connection()).toEqual({ phase: 'connected', haState: 'RUNNING', haVersion: '2026.9.2' });
    expect(normalizeEntity(demo.reader.store, LIGHT).status).toBe('available');
    expect(demo.key).toMatch(/^demo\|normal\|/);
  });

  it('applies a call through the simulator after the latency, so observation runs on real state changes', async () => {
    const demo = host();
    const listener = vi.fn();
    demo.reader.store.subscribe([LIGHT], [], listener);
    const result = demo.port.invoke(TURN_ON);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ contextId: expect.any(String) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(demo.reader.store.get(LIGHT)?.state).toBe('on');
    expect(listener).toHaveBeenCalled();
  });

  it('refuses calls while disconnected or disposed, without touching state', async () => {
    const demo = host();
    demo.setConnected(false);
    await expect(demo.port.invoke(TURN_ON)).rejects.toEqual({ portError: 'not-sent', reason: 'disconnected' });
    demo.dispose();
    await expect(demo.port.invoke(TURN_ON)).rejects.toEqual({ portError: 'not-sent', reason: 'disposed' });
  });

  it('offline: drops right after the first snapshot, keeps values stale and moves the generation', () => {
    const demo = host('offline');
    expect(demo.reader.connection().phase).toBe('disconnected');
    expect(demo.reader.connectionGeneration()).toBe(2);
    expect(normalizeEntity(demo.reader.store, LIGHT)).toMatchObject({ status: 'disconnected', stale: true });
  });

  it('loading: holds the first ingest until released', () => {
    const demo = host('loading');
    expect(demo.reader.connection()).toEqual({ phase: 'loading' });
    expect(normalizeEntity(demo.reader.store, LIGHT).status).toBe('loading');
    demo.releaseFirstIngest();
    expect(normalizeEntity(demo.reader.store, LIGHT).status).toBe('available');
  });

  it('restricted: a non-admin whose calls are rejected as unauthorized', async () => {
    const demo = host('restricted');
    expect(demo.reader.isAdmin()).toBe(false);
    const result = demo.port.invoke(TURN_ON);
    const assertion = expect(result).rejects.toEqual({ code: 'unauthorized', message: 'Unauthorized' });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('starting: HA is STARTING and one service is missing', () => {
    const demo = host('starting');
    expect(demo.reader.store.haState()).toBe('STARTING');
    expect(demo.reader.hasService('vacuum', 'start')).toBe(false);
    expect(demo.reader.hasService('light', 'turn_on')).toBe(true);
  });

  it('serves generated SVG stills, and mirrors the 401 session denial until the generation moves', async () => {
    const normal = host();
    const still = normal.reader.fetchCameraSnapshot(CAMERA, snapshotRequest());
    await vi.advanceTimersByTimeAsync(200);
    await expect(still).resolves.toMatchObject({ type: 'image/svg+xml' });

    const restricted = host('restricted');
    const first = restricted.reader.fetchCameraSnapshot(CAMERA, snapshotRequest());
    const firstAssertion = expect(first).rejects.toEqual({ code: 'permission-denied', status: 401 });
    await vi.advanceTimersByTimeAsync(200);
    await firstAssertion;
    await expect(
      restricted.reader.fetchCameraSnapshot(entityId('camera.demo_side_path'), snapshotRequest()),
    ).rejects.toEqual({
      code: 'permission-denied',
      status: 401,
    });
  });

  it('rejects an aborted snapshot request with aborted', async () => {
    const demo = host();
    const controller = new AbortController();
    const still = demo.reader.fetchCameraSnapshot(CAMERA, { width: 1, height: 1, signal: controller.signal });
    controller.abort();
    await expect(still).rejects.toEqual({ code: 'aborted' });
  });

  it('streams forecasts from fixtures and reports a missing type as unsupported', async () => {
    const demo = host();
    const next = vi.fn();
    const error = vi.fn();
    demo.reader.subscribeForecast(entityId('weather.demo_home'), 'hourly', { next, error });
    demo.reader.subscribeForecast(entityId('weather.demo_home'), 'twice_daily', { next, error });
    await vi.advanceTimersByTimeAsync(200);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ type: 'hourly' }));
    expect(error).toHaveBeenCalledWith({ code: 'unsupported', haCode: 'forecast_not_supported' });
  });

  it('ignores forecast events after unsubscribe', async () => {
    const demo = host();
    const next = vi.fn();
    const unsubscribe = demo.reader.subscribeForecast(entityId('weather.demo_home'), 'daily', { next, error: vi.fn() });
    unsubscribe();
    await vi.advanceTimersByTimeAsync(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns calendar events inside the requested range', async () => {
    const demo = host();
    const range = { start: new Date(NOW), end: new Date(NOW + 24 * 60 * 60_000) };
    const events = demo.reader.fetchCalendarEvents(
      entityId('calendar.demo_household'),
      range,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(200);
    await expect(events).resolves.toHaveLength(2);
  });

  it('opens a demo live stream element', async () => {
    const handle = await host().reader.openLiveStream(CAMERA);
    expect(handle.kind).toBe('demo');
    if (handle.kind === 'demo') expect(handle.element.tagName).toBe('AGR-DEMO-STREAM');
  });

  it('re-assembles another scenario on setScenario and changes its key', () => {
    const demo = host();
    demo.setScenario('degraded');
    expect(demo.key).toMatch(/^demo\|degraded\|/);
    expect(demo.reader.store.get(entityId('alarm_control_panel.demo_home') as EntityId)?.state).toBe('unknown');
  });

  it('clears every timer on dispose', async () => {
    const demo = host();
    void demo.port.invoke(TURN_ON).catch(() => undefined);
    void demo.reader.fetchCameraSnapshot(CAMERA, snapshotRequest()).catch(() => undefined);
    demo.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
