/**
 * Shared fixtures for the header, diagnostics and house health tests: a fictional config, a reader
 * whose connection, host kind, admin flag and formatter a test can set, and DashboardServices built from them.
 */
import type { DashboardServices } from '../../src/components/services.ts';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { ConnectionInfo, Formatter, HostKind, HostReader } from '../../src/ha/host.ts';
import type { LocaleLike } from '../../src/ha/types.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore } from '../helpers/fake-store.ts';
import { configFrom, fakeReader, fakeServices } from '../helpers/services.ts';

export const MEERA = 'person.demo_meera';
export const ARUN = 'person.demo_arun';
export const ALARM = 'alarm_control_panel.demo_home';
export const POLICY = 'input_select.demo_security_policy';
export const FRONT_DOOR = 'binary_sensor.demo_front_door';
export const BACK_DOOR = 'binary_sensor.demo_back_door';

/** 2026-09-30 17:51 in Los Angeles: the e2e pinned time (§12.2). */
export const PINNED_NOW = new Date('2026-09-30T17:51:00-07:00');

/** A deterministic formatter: US English, 12-hour, in the given server zone (Los Angeles by default). */
export function laFormatter(locale: Partial<LocaleLike> = {}, serverTimeZone = 'America/Los_Angeles'): Formatter {
  return createFormatter({
    locale: { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'server', ...locale },
    serverTimeZone,
    temperatureUnit: '°F',
  });
}

export function headerConfig(extra: Record<string, unknown> = {}): ResolvedConfig {
  return configFrom({
    title: 'Agraharam',
    diagnostics: true,
    people: [
      { entity: MEERA, name: 'Meera' },
      { entity: ARUN, name: 'Arun' },
    ],
    security: {
      alarm: ALARM,
      policy: POLICY,
      perimeter: [
        { entity: FRONT_DOOR, name: 'Front door' },
        { entity: BACK_DOOR, name: 'Back door' },
      ],
    },
    ...extra,
  });
}

export interface ReaderOptions {
  readonly connection?: () => ConnectionInfo;
  readonly kind?: HostKind;
  readonly admin?: boolean;
  readonly formatter?: Formatter;
}

export function testReader(store: StoreView, options: ReaderOptions = {}): HostReader {
  const formatter = options.formatter ?? laFormatter();
  return {
    ...fakeReader(store),
    kind: options.kind ?? 'hass',
    connection: options.connection ?? (() => ({ phase: 'connected', haState: 'RUNNING' })),
    isAdmin: () => options.admin ?? true,
    formatter: () => formatter,
  };
}

export function testInput(
  config: ResolvedConfig,
  store: StoreView = fakeStore([]),
  options: ReaderOptions & { readonly now?: Date } = {},
): SelectorInput {
  return {
    config,
    store,
    reader: testReader(store, options),
    gateway: new FakeGateway(),
    now: options.now ?? PINNED_NOW,
  };
}

export function testServices(
  config: ResolvedConfig,
  store: StoreView,
  options: ReaderOptions & { readonly mode?: DashboardServices['mode'] } = {},
): DashboardServices & { gateway: FakeGateway } {
  const base = fakeServices({ config, store, ...(options.mode !== undefined && { mode: options.mode }) });
  return { ...base, reader: testReader(store, options) };
}

export interface Mounted<E extends HTMLElement> {
  readonly element: E;
  /** Every agr-open-drawer request id that bubbled (composed) out of the element, in order. */
  readonly drawerRequests: string[];
  readonly triggers: HTMLElement[];
}

/** Appends `element` inside a fresh container (removed by the per-test DOM reset) that records drawer requests. */
export function mountInContainer<E extends HTMLElement>(element: E): Mounted<E> {
  const container = document.createElement('div');
  const drawerRequests: string[] = [];
  const triggers: HTMLElement[] = [];
  container.addEventListener('agr-open-drawer', (event) => {
    drawerRequests.push(event.detail.request.id);
    triggers.push(event.detail.trigger);
  });
  container.append(element);
  document.body.append(container);
  return { element, drawerRequests, triggers };
}

/**
 * All text under `root`, visible and visually hidden, whitespace collapsed: shadow roots are entered and slotted
 * light children are included after them, so containment checks see everything a reader could.
 */
export function shadowText(root: Element | ShadowRoot): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    if (node instanceof Element && node.shadowRoot) for (const child of node.shadowRoot.childNodes) walk(child);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
