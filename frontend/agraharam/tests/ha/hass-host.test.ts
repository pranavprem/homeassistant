import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { FakeHass } from '../../src/dev/fake-hass.ts';
import { createGateway } from '../../src/ha/actions/gateway.ts';
import type { ActionRequest } from '../../src/ha/actions/types.ts';
import { cameraGateFor } from '../../src/ha/camera-gate.ts';
import { fetchSnapshot } from '../../src/ha/hass/camera.ts';
import { HassHost } from '../../src/ha/hass-host.ts';
import type { ServiceCall } from '../../src/ha/host.ts';
import { normalizeEntity } from '../../src/ha/normalize.ts';
import { RESYNC_GRACE_MS } from '../../src/ha/resync.ts';
import type { ConnectionLike, HassEntityLike, HassLike, RegistryEntryLike } from '../../src/ha/types.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';

vi.mock('../../src/ha/hass/camera.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ha/hass/camera.ts')>()),
  fetchSnapshot: vi.fn(),
}));

const LIGHT = entityId('light.demo_kitchen');
const CAMERA = entityId('camera.demo_front_gate');
const OTHER_CAMERA = entityId('camera.demo_side_path');
const TOGGLE: ServiceCall = {
  domain: 'light',
  service: 'turn_on',
  data: { brightness_pct: 40 },
  target: { entity_id: LIGHT },
};
const SNAPSHOT_REQUEST = () => ({ width: 320, height: 240, signal: new AbortController().signal });

function normalBindings(): EntityId[] {
  const result = validateConfig(demoCardInput('normal'));
  if (!result.ok) throw new Error('demo config invalid');
  return [...result.config.bindings.keys()];
}

/** A host driven by FakeHass the way the root drives it: every push is an update. */
function hostWithFake(fake = new FakeHass('normal', { latencyMs: [0, 0] })) {
  const host = new HassHost(normalBindings());
  host.update(fake.hass);
  const stop = fake.onPush((hass) => host.update(hass));
  return { host, fake, stop };
}

function callServiceCount(fake: FakeHass): number {
  return fake.calls.filter((call) => call.method === 'callService').length;
}

afterEach(() => {
  vi.mocked(fetchSnapshot).mockReset();
});

describe('HassHost port: the live-socket guard (§4.4)', () => {
  it('calls hass.callService with a copied payload, the target and notifyOnError false', async () => {
    const { host, fake } = hostWithFake();
    await expect(host.port.invoke(TOGGLE)).resolves.toEqual({ contextId: expect.any(String) });
    expect(fake.calls.find((call) => call.method === 'callService')?.args).toEqual([
      'light',
      'turn_on',
      { brightness_pct: 40 },
      { entity_id: LIGHT },
      false,
      false,
    ]);
  });

  it('refuses without calling when hass.connected is stale but the socket getter is false', async () => {
    const { host, fake, stop } = hostWithFake();
    stop(); // HA has not pushed the disconnected hass yet: hass.connected still reads true
    fake.connection.drop();
    expect(fake.hass.connected).toBe(true);
    await expect(host.port.invoke(TOGGLE)).rejects.toEqual({ portError: 'not-sent', reason: 'disconnected' });
    expect(callServiceCount(fake)).toBe(0);
  });

  it('refuses while resyncing (both flags true, barrier armed) and accepts after the snapshot', async () => {
    vi.useFakeTimers();
    const { host, fake } = hostWithFake();
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    expect(fake.hass.connected && fake.connection.connected).toBe(true);
    expect(host.reader.connection().phase).toBe('resyncing');
    await expect(host.port.invoke(TOGGLE)).rejects.toEqual({ portError: 'not-sent', reason: 'disconnected' });
    expect(callServiceCount(fake)).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.reader.connection().phase).toBe('connected');
    const invoked = host.port.invoke(TOGGLE);
    await vi.advanceTimersByTimeAsync(0);
    await expect(invoked).resolves.toMatchObject({ contextId: expect.any(String) });
    expect(callServiceCount(fake)).toBe(1);
  });

  it('refuses after dispose with reason disposed', async () => {
    const { host, fake } = hostWithFake();
    host.dispose();
    await expect(host.port.invoke(TOGGLE)).rejects.toEqual({ portError: 'not-sent', reason: 'disposed' });
    expect(callServiceCount(fake)).toBe(0);
  });

  it('never calls a service on its own across updates, disconnects and reconnects', async () => {
    vi.useFakeTimers();
    const { fake } = hostWithFake();
    for (let push = 0; push < 20; push += 1) fake.setState(LIGHT, push % 2 === 0 ? 'on' : 'off');
    fake.pushIdentityOnly();
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(callServiceCount(fake)).toBe(0);
    expect(fake.calls.filter((call) => call.method !== 'connection.subscribeMessage')).toEqual([]);
  });
});

describe('HassHost connection (§4.4, §16.10)', () => {
  it('is loading before the first update', () => {
    expect(new HassHost([LIGHT]).reader.connection()).toEqual({ phase: 'loading' });
  });

  it('defines connected as hass.connected AND the live getter: a false getter means disconnected and stale', () => {
    const { host, fake, stop } = hostWithFake();
    stop();
    fake.connection.drop();
    host.update(fake.hass); // HA pushes before its own flag flips: hass.connected true, getter false
    expect(host.reader.connection().phase).toBe('disconnected');
    expect(host.reader.store.isConnected()).toBe(false);
    expect(normalizeEntity(host.reader.store, LIGHT)).toMatchObject({ status: 'disconnected', stale: true });
  });

  it('reports HA starting and the version for diagnostics', () => {
    const fake = new FakeHass('starting');
    const host = new HassHost(normalBindings());
    host.update(fake.hass);
    expect(host.reader.connection()).toEqual({ phase: 'connected', haState: 'STARTING', haVersion: '2026.9.2' });
    expect(host.reader.store.haState()).toBe('STARTING');
  });

  it('starts a runtime created during the barrier in resyncing (the tracker is shared)', () => {
    const { fake } = hostWithFake();
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 60_000 });
    const rebuilt = new HassHost(normalBindings());
    rebuilt.update(fake.hass);
    expect(rebuilt.reader.connection().phase).toBe('resyncing');
    fake.dispose();
  });

  it('moves the socket generation on disconnect and ready, and on a new connection object', () => {
    const { host, fake } = hostWithFake();
    const generations = [host.reader.connectionGeneration()];
    fake.disconnect();
    generations.push(host.reader.connectionGeneration());
    fake.reconnect({ snapshotDelayMs: 60_000 });
    generations.push(host.reader.connectionGeneration());
    const replacement = new FakeHass('normal');
    host.update(replacement.hass);
    generations.push(host.reader.connectionGeneration());
    expect(new Set(generations).size).toBe(generations.length);
    expect([...generations].sort((a, b) => a - b)).toEqual(generations);
    fake.dispose();
  });

  it('re-ingests on tracker events so the connection meta notifies at once', () => {
    const { host, fake, stop } = hostWithFake();
    stop();
    const listener = vi.fn();
    host.reader.store.subscribe([], ['connection'], listener);
    fake.connection.drop(); // only the hajs event: no hass push yet
    expect(listener).toHaveBeenCalledTimes(1);
    expect(host.reader.connection().phase).toBe('disconnected');
  });

  it('never reports connected between ready and the snapshot when its last hass still says connected', () => {
    const { host, fake, stop } = hostWithFake();
    stop(); // a detached panel: the `connected: false` push never reaches it
    fake.connection.drop();
    const phases: string[] = [];
    host.reader.store.subscribe([], ['connection'], () => phases.push(host.reader.connection().phase));
    fake.connection.reopen(); // 'ready' with the retained hass still saying connected: true
    expect(phases).not.toContain('connected');
    expect(host.reader.connection().phase).toBe('resyncing');
    expect(host.reader.store.isConnected()).toBe(false);
  });

  it('keeps values stale while resyncing and marks entities the snapshot did not replace as stale after it', async () => {
    vi.useFakeTimers();
    const { host, fake } = hostWithFake();
    fake.disconnect();
    fake.deleteDuringOutage(LIGHT);
    fake.reconnect({ snapshotDelayMs: 0 });
    expect(normalizeEntity(host.reader.store, CAMERA)).toMatchObject({ status: 'disconnected', stale: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(normalizeEntity(host.reader.store, CAMERA).status).toBe('available');
    expect(normalizeEntity(host.reader.store, LIGHT)).toMatchObject({ status: 'disconnected', stale: true });
  });

  it('unsubscribes from the tracker on dispose', () => {
    const { host, fake, stop } = hostWithFake();
    stop();
    const listener = vi.fn();
    host.reader.store.subscribe([], ['connection'], listener);
    host.dispose();
    fake.connection.drop();
    expect(listener).not.toHaveBeenCalled();
    expect(fake.connection.listenerCount('disconnected')).toBe(1);
  });
});

/** The 'alert' scenario as a live config: alarm triggered, Courtyard bound to a privacy entity that reads off. */
function alertConfig() {
  const result = validateConfig(demoCardInput('alert'));
  if (!result.ok) throw new Error('demo config invalid');
  return result.config;
}

const SILENCE: ActionRequest = { kind: 'security.run', role: 'silence_sound' };
const COURTYARD = entityId('camera.demo_courtyard');

/** A runtime that observed the house, then was disposed (orphan timer) before the outage: nothing observes it. */
function observedThenDisposed(fake: FakeHass, bindings: Iterable<EntityId>): void {
  const first = new HassHost(bindings);
  first.update(fake.hass);
  first.dispose();
}

function phaseOf(host: HassHost): string {
  return host.reader.connection().phase;
}

describe('HassHost reconnect freshness (§4.4, §16.15)', () => {
  it('a host that first observes the snapshot after an unobserved reconnect clears on the grace with every replaced entity fresh', async () => {
    vi.useFakeTimers();
    const fake = new FakeHass('alert', { latencyMs: [0, 0] });
    const config = alertConfig();
    observedThenDisposed(fake, config.bindings.keys());
    fake.deleteDuringOutage(LIGHT);
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0); // the snapshot lands while no runtime exists
    const host = new HassHost(config.bindings.keys());
    host.update(fake.hass);
    const gateway = createGateway({ port: host.port, reader: host.reader, config, isPreview: () => false });
    const courtyard = config.cameras.find((camera) => camera.entity === COURTYARD);
    if (courtyard === undefined) throw new Error('no courtyard camera');

    expect(phaseOf(host)).toBe('resyncing');
    expect(gateway.evaluate(SILENCE)).toMatchObject({ enabled: false, reason: 'disconnected' });
    expect(cameraGateFor(host.reader.store, courtyard).kind).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(RESYNC_GRACE_MS - 1);
    expect(phaseOf(host)).toBe('resyncing');
    await vi.advanceTimersByTimeAsync(1);

    expect(phaseOf(host)).toBe('connected');
    // The alarm is triggered, so Silence sound runs at once; before the fix the stale alarm and script refused it.
    expect(gateway.evaluate(SILENCE)).toEqual({ enabled: true, confirm: false });
    expect(cameraGateFor(host.reader.store, courtyard).kind).toBe('allowed');
    expect(normalizeEntity(host.reader.store, LIGHT)).toMatchObject({ status: 'disconnected', stale: true });
    // An unrelated change afterwards keeps every unchanged entity fresh (hajs keeps their objects).
    fake.setState(CAMERA, 'idle', { access_token: 'rotated' });
    host.update(fake.hass);
    expect(cameraGateFor(host.reader.store, courtyard).kind).toBe('allowed');
    expect(gateway.evaluate(SILENCE)).toEqual({ enabled: true, confirm: false });
    gateway.dispose();
    fake.dispose();
  });

  it('a host that first observes the pre-snapshot map clears exactly when the snapshot lands, never on the grace', async () => {
    vi.useFakeTimers();
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const bindings = normalBindings();
    observedThenDisposed(fake, bindings);
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 10_000 });
    const host = new HassHost(bindings);
    host.update(fake.hass); // connected: true with the pre-outage states
    fake.onPush((hass) => host.update(hass));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(phaseOf(host)).toBe('resyncing');
    await vi.advanceTimersByTimeAsync(1);
    expect(phaseOf(host)).toBe('connected');
    expect(normalizeEntity(host.reader.store, LIGHT).status).toBe('available');
    fake.dispose();
  });

  it('an ambiguous first map followed by the snapshot before the grace clears at the snapshot', async () => {
    vi.useFakeTimers();
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const bindings = normalBindings();
    observedThenDisposed(fake, bindings);
    fake.setState(LIGHT, 'on'); // a change no runtime saw before the socket dropped
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 500 });
    const host = new HassHost(bindings);
    host.update(fake.hass);
    fake.onPush((hass) => host.update(hass));
    await vi.advanceTimersByTimeAsync(499);
    expect(phaseOf(host)).toBe('resyncing');
    await vi.advanceTimersByTimeAsync(1);
    expect(phaseOf(host)).toBe('connected');
    expect(normalizeEntity(host.reader.store, LIGHT)).toMatchObject({ status: 'available', stale: false });
    expect(normalizeEntity(host.reader.store, CAMERA)).toMatchObject({ status: 'available', stale: false });
    fake.dispose();
  });

  it('a retained, detached host stays resyncing after another host clears the barrier, until its own next update', async () => {
    vi.useFakeTimers();
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    const detached = hostWithFake(fake);
    detached.stop(); // the panel was removed: its host keeps the last hass it saw, with the light off
    fake.setState(LIGHT, 'on'); // a change only the attached host observes
    const attached = hostWithFake(fake);
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0); // the snapshot lands; the attached host's observation clears the barrier
    expect(phaseOf(attached.host)).toBe('connected');

    // The tracker's base is newer than the detached host's map, so its pre-outage light would read as fresh and
    // connected. It stays resyncing instead, with every value stale.
    expect(phaseOf(detached.host)).toBe('resyncing');
    expect(detached.host.reader.store.isConnected()).toBe(false);
    expect(normalizeEntity(detached.host.reader.store, LIGHT)).toMatchObject({ status: 'disconnected', stale: true });

    detached.host.update(fake.hass); // re-attached: HA hands it the current hass
    expect(phaseOf(detached.host)).toBe('connected');
    expect(normalizeEntity(detached.host.reader.store, LIGHT)).toMatchObject({ status: 'available', stale: false });
    expect(detached.host.reader.store.get(LIGHT)?.state).toBe('on');
    attached.stop();
    fake.dispose();
  });

  it('FakeHass keeps every unchanged entity object across a live change, as hajs does', async () => {
    vi.useFakeTimers();
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = fake.hass.states;
    fake.setState(LIGHT, 'on');
    const next = fake.hass.states;
    expect(next).not.toBe(snapshot);
    for (const [id, entity] of Object.entries(snapshot)) {
      if (id === LIGHT) expect(next[id], id).not.toBe(entity);
      else expect(next[id], id).toBe(entity);
    }
    fake.dispose();
  });

  it('FakeHass delivers nothing between ready and the snapshot; the snapshot carries the change', async () => {
    vi.useFakeTimers();
    const fake = new FakeHass('normal', { latencyMs: [0, 0] });
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 1_000 });
    const preSnapshot = fake.hass.states;
    fake.setState(LIGHT, 'on');
    expect(fake.hass.states).toBe(preSnapshot);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.hass.states[LIGHT]?.state).toBe('on');
    fake.dispose();
  });
});

describe('HassHost camera session denial (§4.4, §16.10)', () => {
  const unauthorized = { code: 'permission-denied', status: 401 };
  const forbidden = { code: 'permission-denied', status: 403 };

  beforeEach(() => {
    vi.mocked(fetchSnapshot).mockResolvedValue(new Blob(['svg'], { type: 'image/svg+xml' }));
  });

  it('after one 401, every snapshot on the connection rejects at once without a request', async () => {
    vi.mocked(fetchSnapshot).mockRejectedValueOnce(unauthorized);
    const { host, fake } = hostWithFake();
    await expect(host.reader.fetchCameraSnapshot(CAMERA, SNAPSHOT_REQUEST())).rejects.toEqual(unauthorized);
    await expect(host.reader.fetchCameraSnapshot(OTHER_CAMERA, SNAPSHOT_REQUEST())).rejects.toEqual(unauthorized);
    // Module level per connection: a runtime rebuilt by setConfig or orphan disposal does not reset it.
    const rebuilt = new HassHost(normalBindings());
    rebuilt.update(fake.hass);
    await expect(rebuilt.reader.fetchCameraSnapshot(CAMERA, SNAPSHOT_REQUEST())).rejects.toEqual(unauthorized);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('allows one new attempt after a reconnect (generation change)', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSnapshot).mockRejectedValueOnce(unauthorized);
    const { host, fake } = hostWithFake();
    await expect(host.reader.fetchCameraSnapshot(CAMERA, SNAPSHOT_REQUEST())).rejects.toEqual(unauthorized);
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.reader.fetchCameraSnapshot(CAMERA, SNAPSHOT_REQUEST())).resolves.toBeInstanceOf(Blob);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps a 403 per camera', async () => {
    vi.mocked(fetchSnapshot).mockRejectedValueOnce(forbidden);
    const { host } = hostWithFake();
    await expect(host.reader.fetchCameraSnapshot(CAMERA, SNAPSHOT_REQUEST())).rejects.toEqual(forbidden);
    await expect(host.reader.fetchCameraSnapshot(OTHER_CAMERA, SNAPSHOT_REQUEST())).resolves.toBeInstanceOf(Blob);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('never fetches while disconnected', async () => {
    const { host, fake } = hostWithFake();
    fake.disconnect();
    await expect(host.reader.fetchCameraSnapshot(CAMERA, SNAPSHOT_REQUEST())).rejects.toEqual({ code: 'disconnected' });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});

/** A minimal hass for derived-battery timing, where the registry and states arrive separately. */
function registryHass(options: {
  connection: ConnectionLike;
  states: Readonly<Record<string, HassEntityLike>>;
  entities?: Readonly<Record<string, RegistryEntryLike>>;
  state?: 'RUNNING' | 'STARTING';
}): HassLike {
  return {
    states: options.states,
    ...(options.entities !== undefined && { entities: options.entities }),
    services: {},
    connected: true,
    connection: options.connection,
    config: { unit_system: { temperature: '°C', length: 'km' }, time_zone: 'UTC', state: options.state ?? 'RUNNING' },
    callService: () => Promise.reject(new Error('unused')),
    callApi: () => Promise.reject(new Error('unused')),
    fetchWithAuth: () => Promise.reject(new Error('unused')),
  };
}

describe('HassHost derived vacuum battery (§4.4)', () => {
  const VACUUM = entityId('vacuum.demo_pebble');
  const BATTERY = entityId('sensor.demo_pebble_battery');
  const REGISTRY = {
    [VACUUM]: { entity_id: VACUUM, device_id: 'demo-device' },
    [BATTERY]: { entity_id: BATTERY, device_id: 'demo-device' },
  };
  const connection: ConnectionLike = { connected: true, subscribeMessage: () => Promise.reject(new Error('unused')) };

  it('derives the battery once its state appears, one update after the registry', () => {
    const host = new HassHost([VACUUM], { vacuums: [VACUUM] });
    const vacuum = testEntity(VACUUM, 'docked');
    host.update(registryHass({ connection, states: { [VACUUM]: vacuum }, entities: REGISTRY }));
    expect(host.reader.store.isDerived(BATTERY)).toBe(false);
    host.update(
      registryHass({
        connection,
        states: { [VACUUM]: vacuum, [BATTERY]: testEntity(BATTERY, '82', { device_class: 'battery' }) },
        entities: REGISTRY,
      }),
    );
    expect(host.reader.store.isDerived(BATTERY)).toBe(true);
    expect(host.reader.store.get(BATTERY)?.state).toBe('82');
    expect(host.reader.entitiesOnDevice('demo-device')).toEqual([VACUUM, BATTERY]);
  });

  it('re-derives when HA becomes RUNNING', () => {
    const host = new HassHost([VACUUM], { vacuums: [VACUUM] });
    const states = {
      [VACUUM]: testEntity(VACUUM, 'docked'),
      [BATTERY]: testEntity(BATTERY, '82', { device_class: 'battery' }),
    };
    host.update(registryHass({ connection, states, state: 'STARTING' }));
    expect(host.reader.store.isDerived(BATTERY)).toBe(false);
    const entities = REGISTRY;
    host.update(registryHass({ connection, states, entities, state: 'STARTING' }));
    host.update(registryHass({ connection, states, entities, state: 'RUNNING' }));
    expect(host.reader.store.isDerived(BATTERY)).toBe(true);
  });
});

describe('HassHost reads', () => {
  it('forwards every new hass to tracked live elements until untracked', async () => {
    const { host, fake } = hostWithFake();
    let captured: { track(el: HTMLElement): () => void } | undefined;
    const camera = await import('../../src/ha/hass/camera.ts');
    const openSpy = vi.spyOn(camera, 'openLiveStream').mockImplementation((context) => {
      captured = context;
      return Promise.resolve({ kind: 'unsupported', reason: 'no-helpers' });
    });
    await host.reader.openLiveStream(CAMERA);
    const element = document.createElement('div') as HTMLElement & { hass?: unknown };
    const untrack = captured?.track(element);
    fake.setState(LIGHT, 'on');
    expect(element.hass).toBe(fake.hass);
    untrack?.();
    const forwarded = element.hass;
    fake.setState(LIGHT, 'off');
    expect(element.hass).toBe(forwarded);
    openSpy.mockRestore();
  });

  it('answers hasService from hass.services and keeps the formatter until the locale changes', () => {
    const fake = new FakeHass('starting');
    const host = new HassHost(normalBindings());
    host.update(fake.hass);
    expect(host.reader.hasService('light', 'turn_on')).toBe(true);
    expect(host.reader.hasService('vacuum', 'start')).toBe(false);
    const formatter = host.reader.formatter();
    fake.setState(LIGHT, 'on');
    host.update(fake.hass);
    expect(host.reader.formatter()).toBe(formatter);
    expect(formatter.temperatureUnit).toBe('°F');
  });

  it('reads admin and dark mode from hass', () => {
    const fake = new FakeHass('restricted', { darkMode: true });
    const host = new HassHost(normalBindings());
    host.update(fake.hass);
    expect(host.reader.isAdmin()).toBe(false);
    expect(host.reader.isDarkMode()).toBe(true);
    expect(host.key.startsWith('hass|-|')).toBe(true);
  });
});
