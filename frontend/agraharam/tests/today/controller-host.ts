/**
 * A minimal ReactiveControllerHost for controller tests (shared by tests/today and tests/upcoming): it records
 * requestUpdate() calls and drives the controller lifecycle by hand, without rendering anything.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { EntityId } from '../../src/config/schema.ts';
import { connectionToken, EntityStore, storeView, type StoreView } from '../../src/ha/entity-store.ts';
import type { ConnectionPhase } from '../../src/ha/host.ts';
import type { ConfigLike, HassEntityLike } from '../../src/ha/types.ts';

export class TestHost implements ReactiveControllerHost {
  readonly #controllers = new Set<ReactiveController>();
  updateRequests = 0;

  addController(controller: ReactiveController): void {
    this.#controllers.add(controller);
  }

  removeController(controller: ReactiveController): void {
    this.#controllers.delete(controller);
  }

  requestUpdate(): void {
    this.updateRequests += 1;
  }

  get updateComplete(): Promise<boolean> {
    return Promise.resolve(true);
  }

  connect(): void {
    for (const controller of this.#controllers) controller.hostConnected?.();
  }

  disconnect(): void {
    for (const controller of this.#controllers) controller.hostDisconnected?.();
  }

  /** What Lit does before each render. */
  update(): void {
    for (const controller of this.#controllers) controller.hostUpdate?.();
  }
}

/** A real EntityStore fed by hand, with control over the connection flags, HA state and registry token. */
export class ManualStore {
  readonly store: EntityStore;
  readonly view: StoreView;
  #states: Readonly<Record<string, HassEntityLike>>;
  #connected = true;
  #armed = false;
  #haState: ConfigLike['state'] = 'RUNNING';
  #registry: object = {};
  #user: object = {};

  constructor(bound: readonly EntityId[], states: readonly HassEntityLike[]) {
    this.store = new EntityStore(bound);
    this.view = storeView(this.store);
    this.#states = Object.fromEntries(states.map((state) => [state.entity_id, state]));
    this.#ingest();
  }

  phase(): ConnectionPhase {
    if (!this.#connected) return 'disconnected';
    return this.#armed ? 'resyncing' : 'connected';
  }

  put(state: HassEntityLike): void {
    this.#states = { ...this.#states, [state.entity_id]: state };
    this.#ingest();
  }

  remove(id: string): void {
    const { [id]: _removed, ...rest } = this.#states;
    this.#states = rest;
    this.#ingest();
  }

  setConnected(connected: boolean, armed = false): void {
    this.#connected = connected;
    this.#armed = armed;
    this.#ingest();
  }

  setHaState(haState: ConfigLike['state']): void {
    this.#haState = haState;
    this.#ingest();
  }

  /** A new hass.entities identity: the 'registry' meta changes. */
  touchRegistry(): void {
    this.#registry = {};
    this.#ingest();
  }

  /** A new hass.user identity: the 'user' meta changes. */
  touchUser(): void {
    this.#user = {};
    this.#ingest();
  }

  #ingest(): void {
    this.store.ingest({
      states: this.#states,
      connected: this.#connected,
      resync: { armed: this.#armed },
      meta: {
        connection: connectionToken(this.#connected, this.#armed, this.#haState),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: this.#registry,
        services: undefined,
        user: this.#user,
      },
    });
  }
}
