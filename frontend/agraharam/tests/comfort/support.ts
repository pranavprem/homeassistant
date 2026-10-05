/** Shared setup for the comfort and media tests: selector inputs, section services and mounting. */
import type { DashboardServices } from '../../src/components/services.ts';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { actionKeyFor, type ActionRequest, type Availability } from '../../src/ha/actions/types.ts';
import { connectionToken, EntityStore, storeView, type StoreView } from '../../src/ha/entity-store.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { deepElements, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader, fakeServices } from '../helpers/services.ts';

export interface SupportOptions {
  readonly config: Record<string, unknown>;
  readonly gateway?: FakeGateway;
  /** hass.config.unit_system.temperature; the shared fake reader uses °F. */
  readonly unit?: string;
  readonly store?: FakeStoreOptions;
}

export const ENABLED: Availability = Object.freeze({ enabled: true, confirm: false });

/** What the gateway answers while HA is not offering a service yet (§7.1 step 5). */
export const SERVICE_MISSING: Extract<Availability, { enabled: false }> = Object.freeze({
  enabled: false,
  reason: 'service-missing',
  message: "Home Assistant isn't offering this control right now. The integration may still be loading.",
});

export function selectorInputFor(states: readonly HassEntityLike[], options: SupportOptions): SelectorInput {
  const store = fakeStore(states, options.store);
  const reader = fakeReader(store);
  const formatter = createFormatter({ temperatureUnit: options.unit ?? '°F' });
  return {
    config: configFrom(options.config),
    store,
    reader: { ...reader, formatter: () => formatter },
    gateway: options.gateway ?? new FakeGateway(),
    now: new Date(0),
  };
}

export function servicesFor(
  states: readonly HassEntityLike[],
  options: SupportOptions,
): DashboardServices & { gateway: FakeGateway } {
  const input = selectorInputFor(states, options);
  const services = fakeServices({ config: input.config, store: input.store, gateway: input.gateway as FakeGateway });
  return { ...services, reader: input.reader };
}

/**
 * A gateway that behaves like the real lock (§4.7 step 13): while a ticket on the key is pending or sent, every
 * request for that key evaluates busy, so a re-rendered control is disabled.
 */
export function lockingGateway(): FakeGateway {
  const gateway = new FakeGateway();
  gateway.availability = (req: ActionRequest): Availability => {
    const phase = gateway.status(actionKeyFor(req))?.phase;
    return phase === 'pending' || phase === 'sent'
      ? { enabled: false, reason: 'busy', message: 'Waiting for the device to respond to the last request.' }
      : ENABLED;
  };
  return gateway;
}

export async function mountElement<E extends HTMLElement>(tag: string, configure: (element: E) => void): Promise<E> {
  const element = document.createElement(tag) as E;
  configure(element);
  document.body.append(element);
  await settle();
  return element;
}

export function requestsOf(gateway: FakeGateway): readonly ActionRequest[] {
  return gateway.calls.map((call) => call.req);
}

/** Keydown as a browser delivers it; returns whether anything handled (prevented) it. */
export function pressKey(target: Element, key: string, repeat = false): boolean {
  const event = new KeyboardEvent('keydown', { key, repeat, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

export const NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

/** document.body outlives each test (setup.ts only clears its children), so its listeners are removed explicitly. */
let bodyListeners = new AbortController();

export function listenOnBody(type: string, listener: (event: Event) => void): void {
  document.body.addEventListener(type, listener, { signal: bodyListeners.signal });
}

/** Call from afterEach in every file that uses listenOnBody(). */
export function removeBodyListeners(): void {
  bodyListeners.abort();
  bodyListeners = new AbortController();
}

/** A real EntityStore (fake-store.ts never notifies) whose hass.services token a test replaces, as HassHost does. */
export interface ServicesMetaStore {
  readonly store: StoreView;
  /** Ingests the same states object with a fresh services token: only the 'services' meta kind changes. */
  pushServices(): void;
}

export function servicesMetaStore(config: ResolvedConfig, states: readonly HassEntityLike[]): ServicesMetaStore {
  const store = new EntityStore(config.bindings.keys());
  const statesMap = Object.fromEntries(states.map((state) => [state.entity_id, state]));
  const ingest = (): void => {
    store.ingest({
      states: statesMap,
      connected: true,
      resync: { armed: false },
      meta: {
        connection: connectionToken(true, false, 'RUNNING'),
        locale: [undefined, undefined, undefined, undefined],
        theme: false,
        registry: undefined,
        services: {},
        user: undefined,
      },
    });
  };
  ingest();
  return { store: storeView(store), pushServices: ingest };
}

/** Every text node under `root`, through open shadow roots, including visually hidden reasons. */
export function deepText(root: ParentNode): string {
  const roots: ParentNode[] = [root, ...deepElements(root).flatMap((element) => element.shadowRoot ?? [])];
  return roots.map((node) => node.textContent ?? '').join(' ');
}
