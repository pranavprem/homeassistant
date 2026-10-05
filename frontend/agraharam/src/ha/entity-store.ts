/**
 * Entity store (§4.5). UI code, selectors and controllers only ever see StoreView; the mutating EntityStore is
 * constructed and driven by HassHost, DemoHost and the root's minute tick.
 *
 * Diffing compares state objects by reference for bound and derived IDs only, so an update costs O(bound) at about
 * 100 entities, and an identity-only hass update (HA's empty `_updateHass({})`) notifies nobody.
 */
import type { EntityId } from '../config/schema.ts';
import { log } from '../util/log.ts';
import type { HostChange, MetaKind, Unsubscribe } from './host.ts';
import type { StatesMap } from './resync.ts';
import type { ConfigLike, HassEntityLike } from './types.ts';

export interface StoreSnapshot {
  /** hass.states itself (same reference, never copied): the resync barrier compares references. */
  readonly states: Readonly<Record<string, HassEntityLike | undefined>>;
  readonly connected: boolean;
  readonly resync: { readonly armed: boolean; readonly base?: StatesMap }; // from the ResyncTracker (§4.4)
  /** Meta tokens. Each is a single reference or a fixed-length tuple, compared ELEMENT-WISE with Object.is
   *  (a fresh array per update must not notify): locale = [locale, formatEntityState, formatEntityAttributeValue,
   *  unit_system], connection = [connected, resync.armed, config.state], theme = darkMode boolean,
   *  registry = hass.entities, services = hass.services, user = hass.user. 'clock' is not in snapshots. */
  readonly meta: Readonly<Record<Exclude<MetaKind, 'clock'>, unknown>>;
}

/** The only store type UI code, selectors and controllers see (HostReader.store, DashboardServices.store). */
export interface StoreView {
  get(id: EntityId): HassEntityLike | undefined; // from the latest snapshot (stale while disconnected)
  isDerived(id: EntityId): boolean;
  isReady(): boolean; // at least one ingest
  isConnected(): boolean; // connected AND resync barrier clear (states are current)
  isResyncing(): boolean; // connected but barrier armed (labels only; §4.4)
  freshSinceResync(id: EntityId): boolean; // entity object differs from the pre-snapshot resync base (§4.4)
  haState(): ConfigLike['state']; // undefined treated as 'RUNNING'
  subscribe(ids: readonly EntityId[], meta: readonly MetaKind[], listener: (change: HostChange) => void): Unsubscribe;
}

type ConnectionToken = readonly [connected: boolean, armed: boolean, haState: ConfigLike['state']];

/** Builds the `connection` meta token in the one tuple layout the store reads haState() from. */
export function connectionToken(connected: boolean, armed: boolean, haState: ConfigLike['state']): ConnectionToken {
  return [connected, armed, haState];
}

const SNAPSHOT_META_KINDS: readonly Exclude<MetaKind, 'clock'>[] = Object.freeze([
  'connection',
  'locale',
  'theme',
  'registry',
  'services',
  'user',
]);
const HA_STATE_INDEX = 2;
const NO_ENTITIES: ReadonlySet<EntityId> = Object.freeze(new Set<EntityId>());
const NO_META: ReadonlySet<MetaKind> = Object.freeze(new Set<MetaKind>());
const CLOCK_ONLY: ReadonlySet<MetaKind> = Object.freeze(new Set<MetaKind>(['clock']));

interface Subscription {
  readonly ids: ReadonlySet<EntityId>;
  readonly meta: ReadonlySet<MetaKind>;
  readonly listener: (change: HostChange) => void;
}

/** Constructed and mutated only by HassHost, DemoHost and the root (tick). */
export class EntityStore implements StoreView {
  readonly #bound: ReadonlySet<EntityId>;
  #derived: ReadonlySet<EntityId> = NO_ENTITIES;
  #snapshot: StoreSnapshot | undefined;
  readonly #subscriptions = new Set<Subscription>();

  constructor(bound: Iterable<EntityId>) {
    this.#bound = new Set(bound);
  }

  /** Separate derived set (§4.2 rule 10): derived IDs are readable but never part of the gateway allowlist. Added
   *  and removed IDs are reported changed, because their normalized status changes. */
  setDerived(ids: Iterable<EntityId>): void {
    const next = new Set(ids);
    const changed = new Set<EntityId>();
    for (const id of next) if (!this.#derived.has(id) && !this.#bound.has(id)) changed.add(id);
    for (const id of this.#derived) if (!next.has(id) && !this.#bound.has(id)) changed.add(id);
    this.#derived = next;
    if (this.#snapshot !== undefined && changed.size > 0) this.#notify({ entities: changed, meta: NO_META });
  }

  /** First ingest: every bound and derived ID and every snapshot meta kind changed. */
  ingest(next: StoreSnapshot): HostChange {
    const previous = this.#snapshot;
    this.#snapshot = next;
    const change: HostChange = {
      entities: previous === undefined ? this.#tracked() : this.#changedEntities(previous, next),
      meta: previous === undefined ? new Set(SNAPSHOT_META_KINDS) : changedMeta(previous, next),
    };
    if (change.entities.size > 0 || change.meta.size > 0) this.#notify(change);
    return change;
  }

  /** Emits meta 'clock' only (minute ticker, visibility realign). */
  tick(): HostChange {
    const change: HostChange = { entities: NO_ENTITIES, meta: CLOCK_ONLY };
    this.#notify(change);
    return change;
  }

  get(id: EntityId): HassEntityLike | undefined {
    if (!this.#bound.has(id) && !this.#derived.has(id)) return undefined;
    return this.#snapshot?.states[id];
  }

  isDerived(id: EntityId): boolean {
    return this.#derived.has(id) && !this.#bound.has(id);
  }

  isReady(): boolean {
    return this.#snapshot !== undefined;
  }

  isConnected(): boolean {
    return this.#snapshot !== undefined && this.#snapshot.connected && !this.#snapshot.resync.armed;
  }

  isResyncing(): boolean {
    return this.#snapshot !== undefined && this.#snapshot.connected && this.#snapshot.resync.armed;
  }

  /** The resync base is always a pre-snapshot map (§4.4), and the snapshot replaces every entity object, so an
   *  object identical to the base's was never refreshed (for example an entity deleted during the outage) and is
   *  not current. Without a base (nothing was observed before the barrier armed) every present entity counts as
   *  fresh: the barrier itself keeps the store disconnected until it clears. */
  freshSinceResync(id: EntityId): boolean {
    const base = this.#snapshot?.resync.base;
    if (base === undefined) return true;
    return this.#snapshot?.states[id] !== base[id];
  }

  haState(): ConfigLike['state'] {
    const token = this.#snapshot?.meta.connection;
    const haState = Array.isArray(token) ? (token[HA_STATE_INDEX] as ConfigLike['state']) : undefined;
    return haState ?? 'RUNNING';
  }

  subscribe(ids: readonly EntityId[], meta: readonly MetaKind[], listener: (change: HostChange) => void): Unsubscribe {
    const subscription: Subscription = { ids: new Set(ids), meta: new Set(meta), listener };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  #tracked(): Set<EntityId> {
    return new Set([...this.#bound, ...this.#derived]);
  }

  #changedEntities(previous: StoreSnapshot, next: StoreSnapshot): Set<EntityId> {
    const changed = new Set<EntityId>();
    for (const id of this.#bound) if (previous.states[id] !== next.states[id]) changed.add(id);
    for (const id of this.#derived) if (previous.states[id] !== next.states[id]) changed.add(id);
    return changed;
  }

  /** One callback per interested subscriber, with the change narrowed to what it subscribed to. */
  #notify(change: HostChange): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!this.#subscriptions.has(subscription)) continue;
      const entities = intersect(change.entities, subscription.ids);
      const meta = intersect(change.meta, subscription.meta);
      if (entities.size === 0 && meta.size === 0) continue;
      try {
        subscription.listener({ entities, meta });
      } catch {
        log.error('store-listener-failed');
      }
    }
  }
}

function changedMeta(previous: StoreSnapshot, next: StoreSnapshot): Set<MetaKind> {
  const changed = new Set<MetaKind>();
  for (const kind of SNAPSHOT_META_KINDS) {
    if (!sameToken(previous.meta[kind], next.meta[kind])) changed.add(kind);
  }
  return changed;
}

/** Tuples are compared element-wise, so a fresh array with the same members is the same token. */
function sameToken(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value: unknown, index) => Object.is(value, b[index]));
  }
  return Object.is(a, b);
}

function intersect<T>(changed: ReadonlySet<T>, wanted: ReadonlySet<T>): ReadonlySet<T> {
  if (changed.size === 0 || wanted.size === 0) return changed.size === 0 ? changed : new Set<T>();
  const result = new Set<T>();
  for (const value of changed) if (wanted.has(value)) result.add(value);
  return result;
}

/**
 * A StoreView facade over a store, so code handed the view cannot reach ingest(), tick() or setDerived() even with
 * a cast (§4.4: the root's tick is the only store mutation outside the hosts).
 */
export function storeView(store: StoreView): StoreView {
  return Object.freeze({
    get: (id: EntityId) => store.get(id),
    isDerived: (id: EntityId) => store.isDerived(id),
    isReady: () => store.isReady(),
    isConnected: () => store.isConnected(),
    isResyncing: () => store.isResyncing(),
    freshSinceResync: (id: EntityId) => store.freshSinceResync(id),
    haState: () => store.haState(),
    subscribe: (ids: readonly EntityId[], meta: readonly MetaKind[], listener: (change: HostChange) => void) =>
      store.subscribe(ids, meta, listener),
  });
}
