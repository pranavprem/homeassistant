/**
 * Shared harness for the cross-cutting acceptance suites (§12.1, ACCEPTANCE.md "Meaningful adapter/control
 * checks" 1-11). Every suite mounts the REAL card (root, HassHost or DemoHost, resync barrier, gateway, sections and
 * overlays) and drives it the way Home Assistant does: FakeHass pushes a new hass object on every change and
 * records every method call, including the members real hass has but our types omit (callWS, sendMessage,
 * sendMessagePromise). Assertions read only what a user or HA can observe: rendered text, ARIA state, focus and
 * the recorded calls.
 */
import { expect, vi } from 'vitest';
import type { DemoScenarioId, EntityId } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { DEMO_SCENARIO_IDS } from '../../src/demo/scenarios.ts';
import { INFLIGHT } from '../../src/ha/actions/inflight.ts';
import type { FakeHassCall, FakeHassObject } from '../../src/dev/fake-hass.ts';
import type { HassLike } from '../../src/ha/types.ts';
import { deepElements, deepQuery, deepQueryAll, settle, stubWidth } from '../helpers/dom.ts';
import { FakeHass, WIDE_WIDTH, type MountedCard } from '../helpers/mount.ts';
import { FakeIntersectionObserver } from '../helpers/observers.ts';

/** Methods that change Home Assistant or can send an arbitrary socket message. None may run without a gesture. */
export const WRITE_METHODS: readonly string[] = Object.freeze([
  'callService',
  'callWS',
  'connection.sendMessage',
  'connection.sendMessagePromise',
]);
/** The only subscription the card may open (a read). */
export const FORECAST_SUBSCRIPTION = 'weather/subscribe_forecast';
/** A fixed simulated device latency, so ticket timing is deterministic under fake timers. */
export const DEVICE_LATENCY_MS = 300;
/** Long enough for any simulated device step to land (covers open, then opened). */
export const SETTLE_DEVICES_MS = 3_000;
/** Timers the acceptance suites fake. Lit's microtask updates stay real. */
const FAKED_TIMERS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'performance',
] as const;

/** Every entity bound by any demo scenario: the targets a test can leave marked in the in-flight registry. */
const ALL_DEMO_TARGETS: readonly EntityId[] = Object.freeze(
  DEMO_SCENARIO_IDS.flatMap((scenario) => {
    const result = validateConfig(demoCardInput(scenario));
    return result.ok ? [...result.config.bindings.keys()] : [];
  }),
);

export interface LiveCard extends MountedCard {
  readonly fake: FakeHass;
}

export interface LiveOptions {
  readonly scenario?: DemoScenarioId;
  /** The card input without `type`; defaults to the scenario's demo input in live mode. */
  readonly input?: Record<string, unknown>;
  readonly latencyMs?: readonly [number, number];
  readonly width?: number;
  readonly darkMode?: boolean;
  /** Rewrites each hass object before the card receives it (for example a metric unit system). */
  readonly transform?: (hass: FakeHassObject) => HassLike;
}

/**
 * Per-test setup: fake timers, and an empty module-level in-flight registry. The registry deliberately outlives
 * card instances (§4.7), so without this a ticket from an earlier test would keep its target busy in the next.
 */
export function useAcceptanceTimers(): void {
  vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
  INFLIGHT.clear(ALL_DEMO_TARGETS);
}

/** The scenario's demo bindings as a LIVE card input (`demo` absent, `controls: true`). */
export function liveInput(
  scenario: DemoScenarioId = 'normal',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const { type: _type, ...rest } = demoCardInput(scenario);
  return { ...rest, ...overrides };
}

/** Mounts the card in live mode against FakeHass, exactly as hui-card would (hass before attach, then pushes). */
export async function mountLive(options: LiveOptions = {}): Promise<LiveCard> {
  const scenario = options.scenario ?? 'normal';
  const fake = new FakeHass(scenario, {
    latencyMs: options.latencyMs ?? [DEVICE_LATENCY_MS, DEVICE_LATENCY_MS],
    random: () => 0,
    ...(options.darkMode !== undefined && { darkMode: options.darkMode }),
  });
  const card = document.createElement('agraharam-dashboard');
  stubWidth(card, options.width ?? WIDE_WIDTH);
  card.setConfig({ type: 'custom:agraharam-dashboard', ...(options.input ?? liveInput(scenario)) });
  const transform = options.transform ?? ((hass: FakeHassObject) => hass);
  const deliver = (hass: FakeHassObject): void => {
    card.hass = transform(hass);
  };
  deliver(fake.hass);
  const stopPushes = fake.onPush(deliver);
  document.body.append(card);
  await settle();
  const root = card.shadowRoot;
  if (root === null) throw new Error('card has no shadow root');
  return {
    card,
    root,
    fake,
    services: () => root.querySelector('agr-header')?.services,
    stopPushes,
  };
}

/** Advances fake time (running due timers and their promise continuations), then lets Lit render. */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

// ---------------------------------------------------------------------------------------------------------------
// Recorded calls

export interface RecordedServiceCall {
  readonly domain: unknown;
  readonly service: unknown;
  readonly data: unknown;
  readonly target: unknown;
}

export function writeCalls(fake: FakeHass): FakeHassCall[] {
  return fake.calls.filter((call) => WRITE_METHODS.includes(call.method));
}

export function serviceCalls(fake: FakeHass): RecordedServiceCall[] {
  return fake.calls
    .filter((call) => call.method === 'callService')
    .map(({ args }) => ({ domain: args[0], service: args[1], data: args[2], target: args[3] }));
}

/** Subscriptions other than the forecast read; there must never be any. */
export function nonForecastSubscriptions(fake: FakeHass): FakeHassCall[] {
  return fake.calls.filter(
    (call) =>
      call.method === 'connection.subscribeMessage' &&
      (call.args[0] as Record<string, unknown> | undefined)?.['type'] !== FORECAST_SUBSCRIPTION,
  );
}

/** The live-mode zero-mutation assertion of §12.1 row 1: no write, no socket message, only forecast reads. */
export function expectNoMutation(fake: FakeHass): void {
  expect(writeCalls(fake)).toEqual([]);
  expect(nonForecastSubscriptions(fake)).toEqual([]);
}

export function fetchesFor(fake: FakeHass, cameraId: string): FakeHassCall[] {
  const prefix = `/api/camera_proxy/${encodeURIComponent(cameraId)}?`;
  return fake.calls.filter((call) => call.method === 'fetchWithAuth' && String(call.args[0]).startsWith(prefix));
}

// ---------------------------------------------------------------------------------------------------------------
// Unhandled errors (HA's logging mixin turns each into system_log.write, a service call, §4.9)

export interface UnhandledTracker {
  readonly errors: unknown[];
  dispose(): void;
}

/** Counts uncaught window errors and unhandled rejections while a test runs (Vitest also fails on them). */
export function trackUnhandled(): UnhandledTracker {
  const errors: unknown[] = [];
  const onError = (event: Event): void => {
    errors.push(event);
  };
  const onRejection = (reason: unknown): void => {
    errors.push(reason);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  process.on('unhandledRejection', onRejection);
  return {
    errors,
    dispose: () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
      process.off('unhandledRejection', onRejection);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Composed-tree queries

/** The rendered shadow root of a section or drawer element. */
export function shadowOf(element: Element | null | undefined): ShadowRoot {
  const root = element?.shadowRoot;
  if (root === null || root === undefined) throw new Error(`no shadow root on ${element?.tagName ?? 'nothing'}`);
  return root;
}

export function section(card: MountedCard, tag: string): Element {
  const found = card.root.querySelector(tag);
  if (found === null) throw new Error(`section ${tag} is not rendered`);
  return found;
}

/** The native control carrying `focusKey` (the stable per-control key of §5.1), anywhere in the composed tree. */
export function control<E extends HTMLElement = HTMLElement>(root: ParentNode, focusKey: string): E {
  const found = deepQuery<E>(root, `[data-focus-key="${focusKey}"]`);
  if (found === null) throw new Error(`no control with focus key ${focusKey}`);
  return found;
}

export function buttons(root: ParentNode): HTMLButtonElement[] {
  return deepQueryAll<HTMLButtonElement>(root, 'button');
}

/** A button by its accessible text (visible label or visually hidden name), anywhere under `root`. */
export function buttonNamed(root: ParentNode, name: string | RegExp): HTMLButtonElement {
  const match = buttons(root).find((button) => matches(normalized(button.textContent), name));
  if (match === undefined) throw new Error(`no button named ${String(name)}`);
  return match;
}

/**
 * The text under `root` in composed (rendered) order: a shadow host contributes its shadow tree, a slot its
 * assigned nodes. Includes visually hidden text, which is part of what assistive technology reads.
 */
export function renderedText(root: Node): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node instanceof HTMLStyleElement || node instanceof HTMLScriptElement) return;
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      for (const child of assigned.length > 0 ? assigned : [...node.childNodes]) walk(child);
      return;
    }
    const children = node instanceof Element && node.shadowRoot !== null ? node.shadowRoot.childNodes : node.childNodes;
    for (const child of children) walk(child);
  };
  walk(root);
  return normalized(parts.join(' '));
}

/** The text a button's aria-describedby points at, resolved in the button's own tree (§5.5). */
export function describedBy(element: Element): string {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const root = element.getRootNode() as ShadowRoot | Document;
  return ids
    .map((id) => normalized(root.getElementById(id)?.textContent))
    .filter(Boolean)
    .join(' ');
}

/** Every open native dialog in the document, through shadow roots. */
export function openDialogs(): HTMLDialogElement[] {
  return deepQueryAll<HTMLDialogElement>(document.body, 'dialog').filter((dialog) => dialog.open);
}

/** The overlay host's shadow root, where drawers and dialogs are mounted. */
export function overlays(card: MountedCard): ShadowRoot {
  return shadowOf(card.root.querySelector('agr-overlay-host'));
}

/** The topmost mounted overlay element (drawer, camera dialog or confirm dialog), if any. */
export function topOverlay(card: MountedCard): Element | undefined {
  const layer = overlays(card).querySelector('.layer');
  const children = layer === null ? [] : [...layer.children];
  return children[children.length - 1];
}

export function confirmDialog(card: MountedCard): Element | null {
  return overlays(card).querySelector('agr-confirm-dialog');
}

/** Marks every observed element as on screen, so visible-only work (camera stills) may start. */
export function revealAll(): void {
  for (const observer of FakeIntersectionObserver.instances) {
    for (const target of [...observer.targets]) observer.deliver(target, true);
  }
}

/**
 * A pointer press on a control: it takes focus, then activates (what a click, Enter or Space runs), then Lit
 * renders. Focusing first matters in happy-dom, which (unlike browsers) keeps document focus on a node that was
 * removed, such as a closed dialog's button, and then fails focus lookups.
 */
export async function press(element: HTMLElement): Promise<void> {
  element.focus();
  element.click();
  await settle();
}

function normalized(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function matches(text: string, name: string | RegExp): boolean {
  return typeof name === 'string' ? text === name : name.test(text);
}

export { deepElements, deepQuery, deepQueryAll, FakeHass, settle };
