/** A real EntityStore fed by hand, for tests that need store notifications (fake-store.ts never notifies). */
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { connectionToken, EntityStore } from '../../src/ha/entity-store.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { testEntity } from './fake-store.ts';

export interface LiveStore {
  readonly store: EntityStore;
  /** Replaces one entity with a new object and ingests a new states map. */
  set(id: string, state: string, attributes?: Readonly<Record<string, unknown>>): void;
  setConnected(connected: boolean): void;
}

export function liveStore(config: ResolvedConfig, states: Readonly<Record<string, string>>): LiveStore {
  const store = new EntityStore(config.bindings.keys());
  let current: Readonly<Record<string, HassEntityLike>> = Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, testEntity(id, state)]),
  );
  let connected = true;
  const ingest = (): void => {
    store.ingest({
      states: current,
      connected,
      resync: { armed: false },
      meta: {
        connection: connectionToken(connected, false, 'RUNNING'),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: undefined,
        services: undefined,
        user: undefined,
      },
    });
  };
  ingest();
  return {
    store,
    set(id, state, attributes = {}) {
      current = { ...current, [id]: testEntity(id, state, attributes) };
      ingest();
    },
    setConnected(next) {
      connected = next;
      ingest();
    },
  };
}
