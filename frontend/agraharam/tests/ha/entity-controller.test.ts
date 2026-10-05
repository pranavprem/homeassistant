import { LitElement } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { EntityController } from '../../src/ha/entity-controller.ts';
import { connectionToken, EntityStore, type StoreSnapshot } from '../../src/ha/entity-store.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';

const WEATHER = entityId('weather.demo_home');
const LIGHT = entityId('light.demo_kitchen');

function snapshot(states: Readonly<Record<string, HassEntityLike>>): StoreSnapshot {
  return {
    states,
    connected: true,
    resync: { armed: false },
    meta: {
      connection: connectionToken(true, false, 'RUNNING'),
      locale: [undefined, undefined, undefined, undefined],
      theme: false,
      registry: undefined,
      services: undefined,
      user: undefined,
    },
  };
}

/** A section-like element that renders through an EntityController and counts renders. */
class ProbeSection extends LitElement {
  store: EntityStore | undefined;
  ids: readonly EntityId[] = [WEATHER];
  renders = 0;
  readonly controller = new EntityController(
    this,
    () => this.store,
    () => this.ids,
  );

  protected override render(): null {
    this.renders += 1;
    return null;
  }
}
customElements.define('agr-test-probe-section', ProbeSection);

/** A section that renders its weather state, so a test can read what is on screen. */
class TextProbeSection extends LitElement {
  store: EntityStore | undefined;
  readonly controller = new EntityController(
    this,
    () => this.store,
    () => [WEATHER],
  );

  protected override render(): string {
    return this.store?.get(WEATHER)?.state ?? '';
  }
}
customElements.define('agr-test-text-probe-section', TextProbeSection);

async function mountProbe(store: EntityStore): Promise<ProbeSection> {
  const probe = document.createElement('agr-test-probe-section') as ProbeSection;
  probe.store = store;
  document.body.append(probe);
  await probe.updateComplete;
  probe.renders = 0;
  return probe;
}

function freshStore(): { store: EntityStore; states: Record<string, HassEntityLike> } {
  const store = new EntityStore([WEATHER, LIGHT]);
  const states = { [WEATHER]: testEntity(WEATHER, 'sunny'), [LIGHT]: testEntity(LIGHT, 'off') };
  store.ingest(snapshot(states));
  return { store, states };
}

describe('EntityController (§4.5)', () => {
  it('requests one update per change to its own entities, batched by Lit', async () => {
    const { store, states } = freshStore();
    const probe = await mountProbe(store);
    const rainy = { ...states, [WEATHER]: testEntity(WEATHER, 'rainy') };
    store.ingest(snapshot(rainy));
    await probe.updateComplete;
    expect(probe.renders).toBe(1);
    store.ingest(snapshot({ ...rainy, [LIGHT]: testEntity(LIGHT, 'on') }));
    await probe.updateComplete;
    expect(probe.renders).toBe(1);
  });

  it('resubscribes to a new store identity, so a rebuilt runtime keeps the section live', async () => {
    const { store } = freshStore();
    const probe = await mountProbe(store);
    const next = freshStore();
    probe.store = next.store;
    probe.requestUpdate();
    await probe.updateComplete;
    probe.renders = 0;
    store.ingest(snapshot({ [WEATHER]: testEntity(WEATHER, 'old store') }));
    await probe.updateComplete;
    expect(probe.renders).toBe(0);
    next.store.ingest(snapshot({ ...next.states, [WEATHER]: testEntity(WEATHER, 'new store') }));
    await probe.updateComplete;
    expect(probe.renders).toBe(1);
  });

  it('resubscribes when the ID signature changes', async () => {
    const { store, states } = freshStore();
    const probe = await mountProbe(store);
    probe.ids = [LIGHT];
    probe.requestUpdate();
    await probe.updateComplete;
    probe.renders = 0;
    store.ingest(snapshot({ ...states, [LIGHT]: testEntity(LIGHT, 'on') }));
    await probe.updateComplete;
    expect(probe.renders).toBe(1);
  });

  it('unsubscribes on disconnect and subscribes again on reconnect', async () => {
    const { store, states } = freshStore();
    const subscribe = vi.spyOn(store, 'subscribe');
    const probe = await mountProbe(store);
    probe.remove();
    store.ingest(snapshot({ ...states, [WEATHER]: testEntity(WEATHER, 'while detached') }));
    expect(probe.renders).toBe(0);
    document.body.append(probe);
    await probe.updateComplete;
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('renders changes made while detached as soon as it is re-attached', async () => {
    const { store, states } = freshStore();
    const probe = document.createElement('agr-test-text-probe-section') as TextProbeSection;
    probe.store = store;
    document.body.append(probe);
    await probe.updateComplete;
    expect(probe.shadowRoot?.textContent).toBe('sunny');
    probe.remove();
    store.ingest(snapshot({ ...states, [WEATHER]: testEntity(WEATHER, 'changed while detached') }));
    document.body.append(probe);
    await probe.updateComplete;
    expect(probe.shadowRoot?.textContent).toBe('changed while detached');
    probe.remove();
  });

  it('does nothing until a store exists', async () => {
    const probe = document.createElement('agr-test-probe-section') as ProbeSection;
    document.body.append(probe);
    await probe.updateComplete;
    expect(probe.renders).toBe(1);
  });
});
