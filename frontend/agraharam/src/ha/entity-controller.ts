/**
 * Store subscription controller (§4.5). Sections attach one to re-render when their bound entities or meta kinds
 * change; Lit batches the requestUpdate() calls into one render per microtask.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { EntityId } from '../config/schema.ts';
import { log } from '../util/log.ts';
import type { StoreView } from './entity-store.ts';
import type { MetaKind, Unsubscribe } from './host.ts';

/** Sections that render controls subscribe to these, because Availability depends on all of them:
 *  services (service-missing while HA starts), user (sticky denial reset), registry (derived battery). */
export const CONTROL_META: readonly MetaKind[] = Object.freeze([
  'connection',
  'locale',
  'services',
  'user',
  'registry',
]);

const DEFAULT_META: readonly MetaKind[] = Object.freeze(['connection', 'locale']);

export class EntityController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #store: () => StoreView | undefined;
  readonly #ids: () => readonly EntityId[];
  readonly #meta: readonly MetaKind[];
  #subscribedStore: StoreView | undefined;
  #subscribedSignature = '';
  #unsubscribe: Unsubscribe | undefined;
  #connected = false;

  /** `meta` defaults to ['connection', 'locale']. */
  constructor(
    host: ReactiveControllerHost,
    store: () => StoreView | undefined,
    ids: () => readonly EntityId[],
    meta: readonly MetaKind[] = DEFAULT_META,
  ) {
    this.#host = host;
    this.#store = store;
    this.#ids = ids;
    this.#meta = meta;
    host.addController(this);
  }

  /** A re-attached section does not re-render by itself, and the store may have changed while it was detached
   *  (unsubscribed), so a new subscription asks for one render, as the forecast and calendar controllers do. */
  hostConnected(): void {
    this.#connected = true;
    if (this.#resubscribeIfChanged()) this.#host.requestUpdate();
  }

  hostDisconnected(): void {
    this.#connected = false;
    this.#unsubscribeCurrent();
  }

  /** Resubscribes when the store() IDENTITY or the ids() signature (joined string) changed, unsubscribing from
   *  the old store first. A setConfig that rebuilds the runtime therefore moves every section to the new store,
   *  including sections whose own IDs did not change. */
  hostUpdate(): void {
    if (this.#connected) this.#resubscribeIfChanged();
  }

  /** Returns true when it subscribed to a store. */
  #resubscribeIfChanged(): boolean {
    try {
      const store = this.#store();
      const ids = this.#ids();
      const signature = ids.join('\n');
      if (
        this.#unsubscribe !== undefined &&
        store === this.#subscribedStore &&
        signature === this.#subscribedSignature
      ) {
        return false;
      }
      this.#unsubscribeCurrent();
      this.#subscribedStore = store;
      this.#subscribedSignature = signature;
      if (store === undefined) return false;
      this.#unsubscribe = store.subscribe(ids, this.#meta, () => this.#host.requestUpdate());
      return true;
    } catch {
      log.error('entity-controller-failed');
      return false;
    }
  }

  #unsubscribeCurrent(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#subscribedStore = undefined;
    this.#subscribedSignature = '';
  }
}
