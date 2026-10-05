/** A StoreView over a fixed list of states, for selector and normalization tests. */
import type { EntityId } from '../../src/config/schema.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import type { ConfigLike, HassEntityLike } from '../../src/ha/types.ts';

export interface FakeStoreOptions {
  readonly ready?: boolean;
  readonly connected?: boolean;
  readonly resyncing?: boolean;
  readonly haState?: ConfigLike['state'];
  /** Entities whose object the post-reconnect snapshot did not replace. */
  readonly notFresh?: readonly string[];
}

const FIXED_TIME = '2026-09-30T17:21:00.000Z';

export function entityId(id: string): EntityId {
  return id as EntityId;
}

export function testEntity(
  id: string,
  state: string,
  attributes: Readonly<Record<string, unknown>> = {},
): HassEntityLike {
  return {
    entity_id: id,
    state,
    attributes,
    last_changed: FIXED_TIME,
    last_updated: FIXED_TIME,
    context: { id: `test-context-${id}`, parent_id: null, user_id: null },
  };
}

export function fakeStore(states: readonly HassEntityLike[], options: FakeStoreOptions = {}): StoreView {
  const byId = new Map(states.map((state) => [state.entity_id, state]));
  const notFresh = new Set(options.notFresh);
  return {
    get: (id) => byId.get(id),
    isDerived: () => false,
    isReady: () => options.ready ?? true,
    isConnected: () => options.connected ?? true,
    isResyncing: () => options.resyncing ?? false,
    freshSinceResync: (id) => !notFresh.has(id),
    haState: () => options.haState,
    subscribe: () => () => undefined,
  };
}
