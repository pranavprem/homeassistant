import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHass } from '../../src/dev/fake-hass.ts';

const LIGHT = 'light.demo_kitchen';
const CAMERA = 'camera.demo_front_gate';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeHass (§10.3)', () => {
  it("reconnects in HA's two-step order: ready and a connected push with the same states, then the snapshot", async () => {
    const fake = new FakeHass('normal');
    const order: string[] = [];
    fake.connection.addEventListener('ready', () => order.push(`ready getter=${fake.connection.connected}`));
    const pushes: { connected: boolean; states: unknown }[] = [];
    fake.onPush((hass) => pushes.push({ connected: hass.connected, states: hass.states }));
    const before = fake.hass.states;
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 400 });
    expect(order).toEqual(['ready getter=true']);
    expect(pushes.map((push) => push.connected)).toEqual([false, true]);
    expect(pushes[1]?.states).toBe(before);
    await vi.advanceTimersByTimeAsync(399);
    expect(pushes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const snapshot = pushes[2]?.states as Record<string, unknown>;
    expect(snapshot).not.toBe(before);
    for (const [id, entity] of Object.entries(before)) expect(snapshot[id], id).not.toBe(entity);
  });

  it('delivers outage changes only in the snapshot, and keeps old objects for entities deleted during the outage', async () => {
    const fake = new FakeHass('normal');
    const privacy = 'switch.demo_hall_camera_privacy';
    const before = fake.hass.states;
    fake.disconnect();
    fake.queueOutageChange(privacy, 'off');
    fake.deleteDuringOutage(LIGHT);
    expect(fake.hass.states).toBe(before);
    fake.reconnect({ snapshotDelayMs: 0 });
    expect(fake.hass.states[privacy]?.state).toBe('on');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.hass.states[privacy]?.state).toBe('off');
    expect(fake.hass.states[LIGHT]).toBe(before[LIGHT]);
  });

  it('restarts command ids at 1 on a new socket and flags unsubscribes from an older socket', async () => {
    const fake = new FakeHass('normal');
    const unsubscribe = await fake.connection.subscribeMessage(() => undefined, {
      type: 'weather/subscribe_forecast',
      entity_id: 'weather.demo_home',
      forecast_type: 'hourly',
    });
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await unsubscribe();
    expect(fake.calls.find((call) => call.method === 'unsubscribe_events')?.args).toEqual([
      { subscription: 1, socket: 1, stale: true },
    ]);
    expect(fake.connection.socket).toBe(2);
  });

  it('records the members real hass has but our types omit', () => {
    const fake = new FakeHass('normal');
    void fake.hass.callWS({ type: 'probe' }).catch(() => undefined);
    fake.connection.sendMessage({ type: 'probe' });
    void fake.connection.sendMessagePromise({ type: 'probe' }).catch(() => undefined);
    expect(fake.calls.map((call) => call.method)).toEqual([
      'callWS',
      'connection.sendMessage',
      'connection.sendMessagePromise',
    ]);
  });

  it('queues a service call made while the socket is down and sends it on the next socket (the hajs gap)', async () => {
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    fake.disconnect();
    const call = fake.hass.callService('light', 'turn_on', {}, { entity_id: LIGHT });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.hass.states[LIGHT]?.state).toBe('off');
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(call).resolves.toEqual({ context: { id: expect.any(String) } });
    expect(fake.hass.states[LIGHT]?.state).toBe('on');
  });

  it('serves camera stills by behavior through fetchWithAuth', async () => {
    const normal = new FakeHass('normal');
    const ok = normal.hass.fetchWithAuth(`/api/camera_proxy/${encodeURIComponent(CAMERA)}?width=320&height=240`);
    await vi.advanceTimersByTimeAsync(200);
    const response = await ok;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    const restricted = new FakeHass('restricted');
    const denied = restricted.hass.fetchWithAuth(`/api/camera_proxy/${encodeURIComponent(CAMERA)}`);
    await vi.advanceTimersByTimeAsync(200);
    expect((await denied).status).toBe(401);
  });

  it("answers calendar reads in HA's shape", async () => {
    const fake = new FakeHass('normal');
    const now = Date.now();
    const query = new URLSearchParams({
      start: new Date(now).toISOString(),
      end: new Date(now + 24 * 60 * 60_000).toISOString(),
    });
    const events = fake.hass.callApi<{ summary: string; start: { dateTime: string } }[]>(
      'GET',
      `calendars/${encodeURIComponent('calendar.demo_household')}?${query}`,
    );
    await vi.advanceTimersByTimeAsync(200);
    const result = await events;
    expect(result.map((event) => event.summary)).toEqual(['Grocery pickup', 'Call the plumber']);
    expect(result[0]?.start.dateTime).toEqual(expect.any(String));
  });

  it('applies the scenario facts: offline drops after the first push; starting lacks a service', () => {
    const offline = new FakeHass('offline');
    offline.applyScenarioConnection();
    expect(offline.hass.connected).toBe(false);
    expect(offline.connection.connected).toBe(false);
    const starting = new FakeHass('starting');
    expect(starting.hass.config.state).toBe('STARTING');
    expect(starting.hass.services['vacuum']).not.toHaveProperty('start');
    expect(new FakeHass('restricted').hass.user?.is_admin).toBe(false);
  });
});
