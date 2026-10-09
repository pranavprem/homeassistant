/**
 * FakeHass's registry-pending mode (§18 B1, review N2) must be as untidy as the real frontend: `hass.entities` is
 * null on every push until the first registry message, that message is one new hass with the SAME states map (so it
 * can never clear a resync barrier), and from then on the registry keeps its identity. The default mode keeps the
 * registry from the first push, as before. Checked both on FakeHass itself and through the real card's HassHost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHass } from '../../src/dev/fake-hass.ts';
import type { FakeHassObject } from '../../src/dev/fake-hass.ts';
import { advance, liveInput, settle, useAcceptanceTimers } from '../acceptance/support.ts';
import { stubWidth } from '../helpers/dom.ts';
import { WIDE_WIDTH } from '../helpers/mount.ts';
import '../../src/agraharam.ts';

const LIGHT = 'light.demo_kitchen';

afterEach(() => {
  vi.useRealTimers();
});

function recordPushes(fake: FakeHass): FakeHassObject[] {
  const pushes: FakeHassObject[] = [];
  fake.onPush((hass) => pushes.push(hass));
  return pushes;
}

describe('FakeHass registry modes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('by default carries the registry from the first push, with one identity across pushes', () => {
    const fake = new FakeHass('normal');
    const first = fake.hass.entities;
    expect(first).not.toBeNull();
    fake.setState(LIGHT, 'on');
    expect(fake.hass.entities).toBe(first);
  });

  it('with registryPending, every push carries entities: null until deliverRegistry()', async () => {
    const fake = new FakeHass('normal', { registryPending: true });
    const pushes = recordPushes(fake);
    expect(fake.hass.entities).toBeNull();
    fake.setState(LIGHT, 'on');
    fake.pushIdentityOnly();
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pushes.length).toBeGreaterThanOrEqual(4);
    expect(pushes.map((hass) => hass.entities)).toEqual(pushes.map(() => null));
  });

  it('deliverRegistry() pushes once: a new hass with the registry and the same states map, then keeps it', () => {
    const fake = new FakeHass('normal', { registryPending: true });
    const pushes = recordPushes(fake);
    const states = fake.hass.states;
    fake.deliverRegistry();
    expect(pushes).toHaveLength(1);
    const delivered = pushes[0];
    expect(delivered?.states).toBe(states);
    expect(delivered?.entities).not.toBeNull();
    expect(Object.keys(delivered?.entities ?? {})).toEqual(fake.scenario.registry.map((entry) => entry.entity_id));
    fake.deliverRegistry();
    expect(pushes).toHaveLength(1);
    fake.setState(LIGHT, 'on');
    expect(fake.hass.entities).toBe(delivered?.entities);
  });

  it('a registry delivered while a reconnect snapshot is pending does not replace the states map', async () => {
    const fake = new FakeHass('normal', { registryPending: true });
    const before = fake.hass.states;
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 400 });
    fake.deliverRegistry();
    expect(fake.hass.states).toBe(before);
    expect(fake.hass.entities).not.toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.hass.states).not.toBe(before);
    expect(fake.hass.entities).not.toBeNull();
  });
});

describe('through the real card (HassHost)', () => {
  beforeEach(() => {
    useAcceptanceTimers();
  });

  async function mountPending() {
    const fake = new FakeHass('normal', { registryPending: true, latencyMs: [300, 300], random: () => 0 });
    const card = document.createElement('agraharam-dashboard');
    stubWidth(card, WIDE_WIDTH);
    card.setConfig({ type: 'custom:agraharam-dashboard', ...liveInput('normal') });
    card.hass = fake.hass;
    fake.onPush((hass) => {
      card.hass = hass;
    });
    document.body.append(card);
    await settle();
    const services = () => card.shadowRoot?.querySelector('agr-header')?.services;
    return { fake, services };
  }

  it('reports registryLoaded false until the delivery, then true', async () => {
    const { fake, services } = await mountPending();
    expect(services()?.reader.registryLoaded()).toBe(false);
    await advance(60_000);
    expect(services()?.reader.registryLoaded()).toBe(false);
    fake.deliverRegistry();
    await settle();
    expect(services()?.reader.registryLoaded()).toBe(true);
  });

  it('a registry delivered during the resync barrier never clears it; only the snapshot does', async () => {
    const { fake, services } = await mountPending();
    fake.disconnect();
    await settle();
    fake.reconnect({ snapshotDelayMs: 400 });
    await settle();
    expect(services()?.reader.connection().phase).toBe('resyncing');
    fake.deliverRegistry();
    await settle();
    expect(services()?.reader.registryLoaded()).toBe(true);
    expect(services()?.reader.connection().phase).toBe('resyncing');
    await advance(400);
    expect(services()?.reader.connection().phase).toBe('connected');
    expect(fake.calls.filter((call) => call.method === 'callService')).toEqual([]);
  });
});
