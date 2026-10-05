import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { connectionToken, EntityStore, storeView, type StoreSnapshot } from '../../src/ha/entity-store.ts';
import type { MetaKind } from '../../src/ha/host.ts';
import type { StatesMap } from '../../src/ha/resync.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';

const LIGHT = entityId('light.demo_kitchen');
const FAN = entityId('fan.demo_purifier');
const UNBOUND = 'sensor.demo_unbound';
const BATTERY = entityId('sensor.demo_pebble_battery');
const LOCALE = { language: 'en' };
const UNIT_SYSTEM = { temperature: '°F', length: 'mi' };

function snapshot(
  states: Readonly<Record<string, HassEntityLike>>,
  overrides: { connected?: boolean; armed?: boolean; base?: StatesMap; haState?: 'RUNNING' | 'STARTING' } = {},
): StoreSnapshot {
  const connected = overrides.connected ?? true;
  const armed = overrides.armed ?? false;
  return {
    states,
    connected,
    resync: overrides.base === undefined ? { armed } : { armed, base: overrides.base },
    meta: {
      // A fresh tuple on every snapshot, as HassHost builds it: compared element-wise, never by identity.
      connection: connectionToken(connected, armed, overrides.haState ?? 'RUNNING'),
      locale: [LOCALE, undefined, undefined, UNIT_SYSTEM],
      theme: false,
      registry: undefined,
      services: undefined,
      user: undefined,
    },
  };
}

function initialStates(): Record<string, HassEntityLike> {
  return {
    [LIGHT]: testEntity(LIGHT, 'off'),
    [FAN]: testEntity(FAN, 'on'),
    [UNBOUND]: testEntity(UNBOUND, '1'),
  };
}

function storeWithListener(ids: readonly EntityId[], meta: readonly MetaKind[] = ['connection']) {
  const store = new EntityStore([LIGHT, FAN]);
  const listener = vi.fn();
  store.subscribe(ids, meta, listener);
  return { store, listener };
}

describe('EntityStore (§4.5)', () => {
  it('reports every bound ID and every meta kind changed on the first ingest', () => {
    const store = new EntityStore([LIGHT, FAN]);
    const change = store.ingest(snapshot(initialStates()));
    expect([...change.entities].sort()).toEqual([FAN, LIGHT]);
    expect([...change.meta].sort()).toEqual(['connection', 'locale', 'registry', 'services', 'theme', 'user']);
    expect(store.isReady()).toBe(true);
  });

  it('notifies once for a bound change and not for unbound or identity-only updates', () => {
    const { store, listener } = storeWithListener([LIGHT]);
    const states = initialStates();
    store.ingest(snapshot(states));
    listener.mockClear();
    store.ingest(snapshot({ ...states, [UNBOUND]: testEntity(UNBOUND, '2') }));
    store.ingest(snapshot(states)); // identity-only: new snapshot object, same entity objects and tokens
    expect(listener).not.toHaveBeenCalled();
    store.ingest(snapshot({ ...states, [LIGHT]: testEntity(LIGHT, 'on') }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ entities: new Set([LIGHT]), meta: new Set() });
  });

  it('narrows each callback to what the subscriber asked for', () => {
    const { store, listener } = storeWithListener([FAN], ['locale']);
    const states = initialStates();
    store.ingest(snapshot(states));
    listener.mockClear();
    store.ingest(snapshot({ ...states, [LIGHT]: testEntity(LIGHT, 'on') }, { connected: false }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies each subscriber exactly once for the reconnect snapshot', () => {
    const store = new EntityStore([LIGHT, FAN]);
    const lightListener = vi.fn();
    const fanListener = vi.fn();
    store.subscribe([LIGHT], ['connection'], lightListener);
    store.subscribe([FAN, LIGHT], ['connection'], fanListener);
    const before = initialStates();
    store.ingest(snapshot(before));
    lightListener.mockClear();
    fanListener.mockClear();
    const fresh = Object.fromEntries(Object.entries(before).map(([id, entity]) => [id, { ...entity }]));
    store.ingest(snapshot(fresh, { base: before }));
    expect(lightListener).toHaveBeenCalledTimes(1);
    expect(fanListener).toHaveBeenCalledTimes(1);
  });

  it('defines connected as connected AND a clear barrier, and resyncing as connected with the barrier armed', () => {
    const store = new EntityStore([LIGHT]);
    store.ingest(snapshot(initialStates(), { armed: true }));
    expect(store.isConnected()).toBe(false);
    expect(store.isResyncing()).toBe(true);
    store.ingest(snapshot(initialStates(), { connected: false, armed: true }));
    expect(store.isResyncing()).toBe(false);
    store.ingest(snapshot(initialStates()));
    expect(store.isConnected()).toBe(true);
  });

  it('notifies the connection meta when the barrier arms or clears', () => {
    const { store, listener } = storeWithListener([], ['connection']);
    const states = initialStates();
    store.ingest(snapshot(states));
    listener.mockClear();
    store.ingest(snapshot(states, { armed: true }));
    store.ingest(snapshot(states, { armed: true }));
    store.ingest(snapshot(states));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('treats an entity the snapshot did not replace as not fresh (§16.10)', () => {
    const store = new EntityStore([LIGHT, FAN]);
    const before = initialStates();
    const fresh = { ...before, [FAN]: { ...(before[FAN] as HassEntityLike) } };
    store.ingest(snapshot(fresh, { base: before }));
    expect(store.freshSinceResync(FAN)).toBe(true);
    expect(store.freshSinceResync(LIGHT)).toBe(false);
  });

  it('reads haState from the connection token, treating undefined as RUNNING', () => {
    const store = new EntityStore([LIGHT]);
    expect(store.haState()).toBe('RUNNING');
    store.ingest(snapshot(initialStates(), { haState: 'STARTING' }));
    expect(store.haState()).toBe('STARTING');
  });

  it('exposes only bound and derived IDs, and reports new derived IDs as changed', () => {
    const store = new EntityStore([LIGHT]);
    const listener = vi.fn();
    store.subscribe([BATTERY], [], listener);
    store.ingest(snapshot({ ...initialStates(), [BATTERY]: testEntity(BATTERY, '82') }));
    expect(store.get(entityId(UNBOUND))).toBeUndefined();
    expect(store.get(BATTERY)).toBeUndefined();
    store.setDerived([BATTERY]);
    expect(listener).toHaveBeenCalledWith({ entities: new Set([BATTERY]), meta: new Set() });
    expect(store.get(BATTERY)?.state).toBe('82');
    expect(store.isDerived(BATTERY)).toBe(true);
    expect(store.isDerived(LIGHT)).toBe(false);
  });

  it('emits only the clock meta on tick', () => {
    const { store, listener } = storeWithListener([LIGHT], ['clock']);
    store.ingest(snapshot(initialStates()));
    listener.mockClear();
    expect([...store.tick().meta]).toEqual(['clock']);
    expect(listener).toHaveBeenCalledWith({ entities: new Set(), meta: new Set(['clock']) });
  });

  it('logs a throwing listener by code and keeps notifying the others', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new EntityStore([LIGHT]);
    const healthy = vi.fn();
    store.subscribe([LIGHT], [], () => {
      throw new Error('section bug');
    });
    store.subscribe([LIGHT], [], healthy);
    store.ingest(snapshot(initialStates()));
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'store-listener-failed');
  });

  it('stops notifying after unsubscribe', () => {
    const store = new EntityStore([LIGHT]);
    const listener = vi.fn();
    const unsubscribe = store.subscribe([LIGHT], [], listener);
    unsubscribe();
    store.ingest(snapshot(initialStates()));
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands UI code a view that cannot reach ingest, tick or setDerived', () => {
    const store = new EntityStore([LIGHT]);
    store.ingest(snapshot(initialStates()));
    const view = storeView(store) as unknown as Record<string, unknown>;
    expect(view['ingest']).toBeUndefined();
    expect(view['tick']).toBeUndefined();
    expect(view['setDerived']).toBeUndefined();
    expect(storeView(store).get(LIGHT)?.state).toBe('off');
  });
});
