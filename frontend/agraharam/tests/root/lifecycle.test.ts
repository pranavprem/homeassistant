import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORPHAN_DISPOSE_MS } from '../../src/agraharam-dashboard.ts';
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import type { EntityId } from '../../src/config/schema.ts';
import { INFLIGHT } from '../../src/ha/actions/inflight.ts';
import type { ActionRequest } from '../../src/ha/actions/types.ts';
import { deepActiveElement } from '../../src/util/focus.ts';
import { deepQuery, deepQueryAll, settle, stubWidth } from '../helpers/dom.ts';
import type { FakeHassCall } from '../../src/dev/fake-hass.ts';
import { FakeHass, mountCard, type MountedCard } from '../helpers/mount.ts';
import { resizeElement } from '../helpers/observers.ts';

const SECTION_TAGS = [
  'agr-today',
  'agr-comfort',
  'agr-home',
  'agr-cameras',
  'agr-garage',
  'agr-media',
  'agr-health',
  'agr-upcoming',
];
const WEATHER = 'weather.demo_home' as EntityId;

function liveConfig(): Record<string, unknown> {
  const { type: _type, ...rest } = demoCardInput('normal');
  return { ...rest, controls: false };
}

/** Live mode with controls on, so the real gateway can act. */
function controlsOnConfig(scenario: 'normal' | 'dense' = 'normal'): Record<string, unknown> {
  const { type: _type, ...rest } = demoCardInput(scenario);
  return { ...rest, controls: true };
}

function serviceCalls(fake: FakeHass): FakeHassCall[] {
  return fake.calls.filter((call) => call.method === 'callService');
}

async function click(target: HTMLElement | null): Promise<void> {
  if (target === null) throw new Error('the control to click is not rendered');
  target.click();
  await settle();
}

/** Routes a confirm-required action through agr-confirm-dialog and confirms it, as a user would. */
async function confirmAction(mountedCard: MountedCard, action: ActionRequest): Promise<void> {
  const trigger = mountedCard.root.querySelector('agr-home') as HTMLElement;
  trigger.dispatchEvent(
    new CustomEvent('agr-request-confirm', { bubbles: true, composed: true, detail: { action, trigger } }),
  );
  await settle();
  await click(deepQuery<HTMLElement>(document.body, 'button.confirm'));
}

function overlayHost(mountedCard: MountedCard): AgrOverlayHost {
  return mountedCard.root.querySelector('agr-overlay-host') as AgrOverlayHost;
}

function openDialogs(): HTMLDialogElement[] {
  return deepQueryAll<HTMLDialogElement>(document.body, 'dialog').filter((dialog) => dialog.open);
}

async function openDrawerAndConfirm(mountedCard: MountedCard): Promise<void> {
  const trigger = mountedCard.root.querySelector('agr-home') as HTMLElement;
  trigger.dispatchEvent(
    new CustomEvent('agr-open-drawer', {
      bubbles: true,
      composed: true,
      detail: { request: { id: 'room', room: 0 }, trigger },
    }),
  );
  trigger.dispatchEvent(
    new CustomEvent('agr-request-confirm', {
      bubbles: true,
      composed: true,
      detail: { action: { kind: 'garage.open' }, trigger },
    }),
  );
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('root rendering and layout (D2, §6.2)', () => {
  it('renders the demo ribbon and placeholder panels for every section, wide on the first render', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    expect(mounted.root.querySelector('agr-demo-ribbon')).not.toBeNull();
    expect(mounted.root.querySelector('.frame')?.getAttribute('data-layout')).toBe('wide');
    expect(mounted.root.querySelector('.columns')?.getAttribute('data-columns')).toBe('3');
    for (const tag of SECTION_TAGS) expect(mounted.root.querySelector(tag), tag).not.toBeNull();
    expect(mounted.card.getAttribute('data-theme')).toBe('light');
  });

  it('creates sections once for a host already laid out (no guessed mode, no re-creation)', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    const today = mounted.root.querySelector('agr-today');
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    resizeElement(mounted.card, 1384);
    vi.advanceTimersByTime(20);
    await settle();
    expect(mounted.root.querySelector('agr-today')).toBe(today);
  });

  it('stands every panel in its column before the first hass, then fills the same elements in (no re-creation)', async () => {
    const fake = new FakeHass('normal');
    const card = document.createElement('agraharam-dashboard');
    stubWidth(card, 1384);
    card.setConfig({ type: 'custom:agraharam-dashboard', ...liveConfig() });
    document.body.append(card);
    await settle();
    const root = card.shadowRoot as ShadowRoot;
    expect(root.querySelector('.columns')?.getAttribute('data-columns')).toBe('3');
    const shells = SECTION_TAGS.map((tag) => root.querySelector(tag));
    for (const [index, shell] of shells.entries()) {
      expect(shell, SECTION_TAGS[index]).not.toBeNull();
      expect(shell?.shadowRoot?.querySelector('agr-panel')?.getAttribute('heading-id')).toBeTruthy();
    }
    expect(fake.calls).toEqual([]);

    card.hass = fake.hass;
    await settle();
    expect(SECTION_TAGS.map((tag) => root.querySelector(tag))).toEqual(shells);
    expect(root.querySelector('agr-today')?.services).toBeDefined();
    card.remove();
  });

  it('renders the header and an empty frame for a 0-width host until the first ResizeObserver callback', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const mounted = await mountCard({ config: { demo: true }, width: 0 });
    expect(mounted.root.querySelector('agr-header')).not.toBeNull();
    expect(mounted.root.querySelector('.columns')).toBeNull();
    resizeElement(mounted.card, 390);
    expect(mounted.root.querySelector('.columns')).toBeNull(); // applied in the next animation frame
    vi.advanceTimersByTime(20);
    await settle();
    expect(mounted.root.querySelector('.frame')?.getAttribute('data-layout')).toBe('narrow');
  });

  it('follows later width changes with hysteresis, applied in requestAnimationFrame', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const mounted = await mountCard({ config: { demo: true } });
    const layout = () => mounted.root.querySelector('.frame')?.getAttribute('data-layout');
    resizeElement(mounted.card, 1070);
    vi.advanceTimersByTime(20);
    await settle();
    expect(layout()).toBe('wide');
    resizeElement(mounted.card, 1060);
    vi.advanceTimersByTime(20);
    await settle();
    expect(layout()).toBe('medium');
    expect(mounted.root.querySelector('.columns')?.getAttribute('data-columns')).toBe('2');
  });
});

describe('root lifecycle (§9.1)', () => {
  it('closes overlays on detach; re-attaching reopens nothing and new overlays open modally again', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    await openDrawerAndConfirm(mounted);
    expect(openDialogs()).toHaveLength(2);
    mounted.card.remove();
    expect(openDialogs()).toEqual([]);
    document.body.append(mounted.card);
    await settle();
    expect(openDialogs()).toEqual([]);
    expect(overlayHost(mounted).hasOpenOverlay).toBe(false);
    await openDrawerAndConfirm(mounted);
    expect(openDialogs()).toHaveLength(2);
  });

  it('keeps the runtime and gateway across a detach shorter than the orphan timeout, then disposes them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    const before = mounted.services();
    mounted.card.remove();
    vi.advanceTimersByTime(ORPHAN_DISPOSE_MS - 1_000);
    document.body.append(mounted.card);
    await settle();
    expect(mounted.services()?.store).toBe(before?.store);
    expect(before?.gateway.disposed).toBe(false);

    mounted.stopPushes(); // HA does not push hass to a removed panel
    mounted.card.remove();
    vi.advanceTimersByTime(ORPHAN_DISPOSE_MS);
    expect(before?.gateway.disposed).toBe(true);
    const listener = vi.fn();
    before?.store.subscribe([WEATHER], ['connection'], listener);
    fake.disconnect(); // a disposed host no longer re-ingests on tracker events
    expect(listener).not.toHaveBeenCalled();
    expect(fake.connection.listenerCount('disconnected')).toBe(1);

    fake.reconnect({ snapshotDelayMs: 0 });
    vi.advanceTimersByTime(0);
    document.body.append(mounted.card);
    await settle();
    expect(mounted.services()).toBeUndefined(); // rebuilt only by the next hass, never from a retained one
    fake.setState(WEATHER, 'rainy');
    mounted.card.hass = fake.hass;
    await settle();
    expect(mounted.services()?.store).not.toBe(before?.store);
    expect(mounted.services()?.gateway.disposed).toBe(false);
  });

  it('publishes the same DashboardServices object when nothing structural changed', async () => {
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    const today = mounted.root.querySelector('agr-today') as HTMLElement & { services: unknown };
    const services = today.services;
    fake.setState(WEATHER, 'rainy');
    fake.pushIdentityOnly();
    await settle();
    expect(today.services).toBe(services);
  });

  it('a setConfig with a new runtime key moves sections to a new store that receives updates', async () => {
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    const before = mounted.services();
    const { cameras: _cameras, ...withoutCameras } = liveConfig();
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', ...withoutCameras });
    await settle();
    const after = mounted.services();
    expect(after?.store).not.toBe(before?.store);
    expect(before?.gateway.disposed).toBe(true);
    const listener = vi.fn();
    after?.store.subscribe([WEATHER], [], listener);
    fake.setState(WEATHER, 'rainy');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mounted.root.querySelector('agr-cameras')).toBeNull();
  });

  it('rebuilds the gateway on every accepted config, even with the same runtime key (security roles swapped)', async () => {
    const fake = new FakeHass('normal');
    const config = liveConfig() as { security: { actions: Record<string, string> } } & Record<string, unknown>;
    const mounted = await mountCard({ config, fake });
    const before = mounted.services();
    const actions = config.security.actions;
    const swapped = { ...actions, hold_night: actions['hold_away'], hold_away: actions['hold_night'] };
    mounted.card.setConfig({
      type: 'custom:agraharam-dashboard',
      ...config,
      security: { ...config.security, actions: swapped },
    });
    await settle();
    const after = mounted.services();
    expect(after?.store).toBe(before?.store);
    expect(after?.gateway).not.toBe(before?.gateway);
    expect(before?.gateway.disposed).toBe(true);
    expect(after?.config.security?.actions.hold_night).toBe(actions['hold_away']);
  });

  it('replaces the host when demo flips with identical bindings', async () => {
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    expect(mounted.services()?.reader.kind).toBe('hass');
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', ...liveConfig(), demo: true });
    await settle();
    expect(mounted.services()?.reader.kind).toBe('demo');
    expect(mounted.services()?.mode).toBe('demo');
  });

  it('closes overlays on every accepted setConfig, but an identical config is a no-op', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    await openDrawerAndConfirm(mounted);
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', demo: true });
    await settle();
    expect(openDialogs()).toHaveLength(2);
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', demo: true, title: 'Renamed' });
    await settle();
    expect(openDialogs()).toEqual([]);
    await openDrawerAndConfirm(mounted);
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', demo: true, demo_scenario: 'degraded' });
    await settle();
    expect(openDialogs()).toEqual([]);
  });

  it('turns preview on by moving the gateway epoch and publishing preview: true', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    const gateway = mounted.services()?.gateway;
    const epoch = gateway?.epoch() ?? 0;
    mounted.card.preview = true;
    await settle();
    expect(gateway?.epoch()).toBe(epoch + 1);
    expect(mounted.services()?.preview).toBe(true);
    mounted.card.preview = false;
    await settle();
    expect(gateway?.epoch()).toBe(epoch + 1);
  });

  it('emits the clock meta at every minute boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 8, 30, 17, 51, 30));
    const mounted = await mountCard({ config: { demo: true } });
    const listener = vi.fn();
    mounted.services()?.store.subscribe([], ['clock'], listener);
    vi.advanceTimersByTime(29_000);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('contains a throw during a hass update: logged by code, no unhandled error, card intact', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    const broken = Object.create(fake.hass, {
      states: {
        get() {
          throw new Error('broken hass');
        },
      },
    });
    expect(() => {
      mounted.card.hass = broken;
    }).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'hass-update-failed');
    expect(mounted.root.querySelector('.frame')).not.toBeNull();
  });

  it('carries ignored-in-demo warnings in services for diagnostics', async () => {
    const mounted = await mountCard({ config: { demo: true, controls: true, weather: 'light.demo_wrong' } });
    expect(mounted.services()?.warnings.map((warning) => [warning.path, warning.code])).toEqual([
      ['weather', 'ignored-in-demo'],
      ['controls', 'ignored-in-demo'],
    ]);
  });
});

describe('the real gateway across the root lifecycle (§9.1, §12.1)', () => {
  const GARAGE_OPEN: ActionRequest = { kind: 'garage.open' };

  it('re-attaching keeps the same gateway, and one click then makes exactly one call', async () => {
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: controlsOnConfig(), fake });
    const gateway = mounted.services()?.gateway;
    mounted.card.remove();
    document.body.append(mounted.card);
    await settle();
    expect(mounted.services()?.gateway).toBe(gateway);
    expect(gateway?.disposed).toBe(false);
    await click(deepQuery<HTMLElement>(mounted.root, 'button[data-focus-key="room:0:toggle"]'));
    expect(serviceCalls(fake)).toHaveLength(1);
    expect(serviceCalls(fake)[0]?.args[0]).toBe('light');
  });

  it('a garage call in flight stays busy across a re-attach, and while its lock lasts, in the runtime rebuilt after orphan disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The simulated door never answers inside this test, so the open_cover call stays in flight.
    const fake = new FakeHass('normal', { latencyMs: [120_000, 120_000] });
    const mounted = await mountCard({ config: controlsOnConfig(), fake });
    const garage = mounted.services()?.config.garage?.cover;
    try {
      await confirmAction(mounted, GARAGE_OPEN);
      expect(serviceCalls(fake).map((call) => call.args.slice(0, 2))).toEqual([['cover', 'open_cover']]);
      const before = mounted.services()?.gateway;
      expect(before?.evaluate(GARAGE_OPEN)).toMatchObject({ enabled: false, reason: 'busy' });

      mounted.card.remove(); // an edit-mode toggle: the same gateway, tickets and locks survive
      document.body.append(mounted.card);
      await settle();
      expect(mounted.services()?.gateway).toBe(before);
      expect(before?.evaluate(GARAGE_OPEN)).toMatchObject({ enabled: false, reason: 'busy' });

      mounted.stopPushes();
      mounted.card.remove();
      vi.advanceTimersByTime(ORPHAN_DISPOSE_MS);
      expect(before?.disposed).toBe(true);
      document.body.append(mounted.card);
      mounted.card.hass = fake.hass;
      await settle();
      const after = mounted.services()?.gateway;
      expect(after).not.toBe(before);
      // performance.now() is not faked, so the 60 s lock is still live in monotonic time: the module-level
      // registry, not the disposed gateway, carries it into the new runtime.
      expect(after?.evaluate(GARAGE_OPEN)).toMatchObject({ enabled: false, reason: 'busy' });
      expect(serviceCalls(fake)).toHaveLength(1);
    } finally {
      if (garage !== undefined) INFLIGHT.clear([garage]);
    }
  });

  it('after a setConfig swaps two security roles, a confirmed request runs the script of the new mapping', async () => {
    const fake = new FakeHass('normal');
    const config = controlsOnConfig() as { security: { actions: Record<string, string> } } & Record<string, unknown>;
    const mounted = await mountCard({ config, fake });
    const actions = config.security.actions;
    const swapped = { ...actions, hold_night: actions['hold_away'], hold_away: actions['hold_night'] };
    mounted.card.setConfig({
      type: 'custom:agraharam-dashboard',
      ...config,
      security: { ...config.security, actions: swapped },
    });
    await settle();
    await confirmAction(mounted, { kind: 'security.run', role: 'hold_night' });
    expect(serviceCalls(fake).map((call) => call.args.slice(0, 4))).toEqual([
      ['script', 'turn_on', {}, { entity_id: actions['hold_away'] }],
    ]);
  });

  it('a derived vacuum battery is never actionable', async () => {
    const fake = new FakeHass('dense');
    const mounted = await mountCard({ config: controlsOnConfig('dense'), fake });
    const services = mounted.services();
    const derived = fake.scenario.states
      .map((state) => state.entity_id as EntityId)
      .filter((id) => services?.store.isDerived(id) === true);
    expect(derived.length).toBeGreaterThan(0);
    for (const entity of derived) {
      for (const kind of ['vacuum.start', 'light.turn_on', 'fan.turn_on', 'curtain.open'] as const) {
        expect(services?.gateway.evaluate({ kind, entity }), `${kind} ${entity}`).toMatchObject({
          enabled: false,
          reason: 'not-allowed',
        });
      }
    }
  });

  it('restores focus by data-focus-key after a layout change re-creates the sections', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    const before = deepQuery<HTMLButtonElement>(mounted.root, 'button[data-focus-key="room:0:toggle"]');
    before?.focus();
    expect(deepActiveElement()).toBe(before);
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    resizeElement(mounted.card, 390);
    vi.advanceTimersByTime(20); // apply the new mode
    await settle();
    vi.advanceTimersByTime(20); // the restore runs in the frame after the re-render
    expect(mounted.root.querySelector('.frame')?.getAttribute('data-layout')).toBe('narrow');
    const after = deepActiveElement();
    expect(after).not.toBe(before);
    expect(after?.getAttribute('data-focus-key')).toBe('room:0:toggle');
  });

  it('cancels a pending focus restore when the card is detached, so it never runs on a detached card', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    deepQuery<HTMLButtonElement>(mounted.root, 'button[data-focus-key="room:0:toggle"]')?.focus();
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    resizeElement(mounted.card, 390);
    vi.advanceTimersByTime(20); // apply the new mode; the restore is now scheduled for the next frame
    await settle();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mounted.card.remove();
    vi.advanceTimersByTime(20);
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it('schedules no focus frame when the card is detached before the re-render completes', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    deepQuery<HTMLButtonElement>(mounted.root, 'button[data-focus-key="room:0:toggle"]')?.focus();
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    resizeElement(mounted.card, 390);
    vi.advanceTimersByTime(20); // apply the new mode: the restore now waits for updateComplete
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mounted.card.remove(); // before the re-render completes
    await settle();
    vi.advanceTimersByTime(20);
    expect(frame).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    frame.mockRestore();
    focus.mockRestore();
  });
});

describe('theme attribute (§6.5)', () => {
  it('writes data-theme once, and again only when the theme changes, not on every hass update', async () => {
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    expect(mounted.card.getAttribute('data-theme')).toBe('light');
    const setAttribute = vi.spyOn(mounted.card, 'setAttribute');
    fake.setState(WEATHER, 'rainy', { temperature: 61 });
    fake.setState(WEATHER, 'sunny', { temperature: 70 });
    await settle();
    expect(setAttribute.mock.calls.filter(([name]) => name === 'data-theme')).toEqual([]);
    mounted.card.hass = { ...fake.hass, themes: { ...fake.hass.themes, darkMode: true } };
    await settle();
    expect(setAttribute.mock.calls.filter(([name]) => name === 'data-theme')).toEqual([['data-theme', 'dark']]);
    setAttribute.mockRestore();
  });
});

describe('realistic hidden-tab order (§16.10)', () => {
  /** Mutating or indirect calls: never allowed, at any point (§1.2 item 4, §12.1 row 1). */
  const FORBIDDEN_METHODS = ['callService', 'callWS', 'connection.sendMessage', 'connection.sendMessagePromise'];

  /** The only calls allowed once the snapshot cleared the barrier: the forecast subscription and calendar GETs. */
  function isAllowedRead(call: FakeHassCall): boolean {
    if (call.method === 'connection.subscribeMessage') {
      return (call.args[0] as { type?: unknown }).type === 'weather/subscribe_forecast';
    }
    return call.method === 'callApi' && call.args[0] === 'GET' && String(call.args[1]).startsWith('calendars/');
  }

  /**
   * Shared assertions. `outage` holds every call from the socket drop until the snapshot: it must be empty, so no
   * read starts on pre-outage states. Unsubscribes may happen only for the socket they were made on (§9.2).
   */
  function expectNoCallsBeforeTheSnapshot(fake: FakeHass, outage: readonly FakeHassCall[], after: FakeHassCall[]) {
    expect(fake.calls.filter((call) => FORBIDDEN_METHODS.includes(call.method))).toEqual([]);
    expect(fake.calls.filter((call) => call.method === 'unsubscribe_events' && isStale(call))).toEqual([]);
    // Over the whole run (mount and removal included) only reads and same-socket unsubscribes happen.
    expect(fake.calls.filter((call) => !isAllowedRead(call) && call.method !== 'unsubscribe_events')).toEqual([]);
    expect(outage).toEqual([]);
    expect(after.length).toBeGreaterThan(0); // the forecast and calendar did restart, once the barrier cleared
    expect(after.filter((call) => !isAllowedRead(call))).toEqual([]);
  }

  function isStale(call: FakeHassCall): boolean {
    return (call.args[0] as { stale?: unknown }).stale === true;
  }

  it('panel removed, a state change, socket dropped, re-appended before ready, two-step reconnect: no calls until the snapshot, stale until then', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    mounted.stopPushes();
    mounted.card.remove(); // the hidden tab's panel is removed
    // Removal stops the forecast while socket 1 is still open: same generation, so its unsubscribes are sent.
    expect(fake.calls.filter((call) => call.method === 'unsubscribe_events').map((call) => call.args[0])).toEqual([
      { subscription: 1, socket: 1, stale: false },
      { subscription: 2, socket: 1, stale: false },
    ]);
    fake.setState(WEATHER, 'rainy'); // one state change HA saw while the panel was gone
    const atDrop = fake.calls.length;
    fake.disconnect(); // the frontend suspends the socket
    document.body.append(mounted.card); // re-appended before 'ready'
    mounted.card.hass = fake.hass; // HA pushes its current hass to the re-added panel
    const stop = fake.onPush((hass) => {
      mounted.card.hass = hass;
    });
    await settle();
    const services = mounted.services();
    expect(services?.reader.connection().phase).toBe('disconnected');
    fake.reconnect({ snapshotDelayMs: 400 });
    expect(services?.reader.connection().phase).toBe('resyncing');
    expect(services?.store.isConnected()).toBe(false);
    vi.advanceTimersByTime(399);
    await settle();
    const outage = fake.calls.slice(atDrop);
    vi.advanceTimersByTime(1);
    expect(services?.reader.connection().phase).toBe('connected');
    expect(services?.store.get(WEATHER)?.state).toBe('rainy');
    expectNoCallsBeforeTheSnapshot(fake, outage, fake.calls.slice(atDrop));
    stop();
  });

  it('a panel whose retained hass still says connected (no disconnected push) starts no read before the snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = new FakeHass('normal');
    const mounted = await mountCard({ config: liveConfig(), fake });
    mounted.stopPushes(); // HA stops pushing to the removed panel, so it never sees `connected: false`
    mounted.card.remove();
    fake.setState(WEATHER, 'rainy');
    const atDrop = fake.calls.length;
    fake.disconnect();
    document.body.append(mounted.card); // re-appended, still holding the pre-outage hass
    await settle();
    const services = mounted.services();
    const phases: string[] = [];
    services?.store.subscribe([], ['connection'], () => phases.push(services.reader.connection().phase));
    const stop = fake.onPush((hass) => {
      mounted.card.hass = hass;
    });
    fake.reconnect({ snapshotDelayMs: 400 }); // 'ready' fires while the retained hass says connected: true
    await settle();
    expect(phases).not.toContain('connected');
    vi.advanceTimersByTime(399);
    await settle();
    const outage = fake.calls.slice(atDrop);
    vi.advanceTimersByTime(1);
    expect(services?.reader.connection().phase).toBe('connected');
    expectNoCallsBeforeTheSnapshot(fake, outage, fake.calls.slice(atDrop));
    stop();
  });
});

describe('config errors (D4)', () => {
  it('renders issues in the card with the non-admin detail until hass says admin', async () => {
    const mounted = await mountCard({ config: { cameras: 'not a list' } });
    const panel = mounted.root.querySelector('agr-config-error');
    expect(panel?.detailed).toBe(false);
    expect(mounted.root.querySelector('.frame')).toBeNull();
    mounted.card.hass = new FakeHass('normal').hass;
    await settle();
    expect(mounted.root.querySelector('agr-config-error')?.detailed).toBe(true);
    mounted.card.hass = new FakeHass('restricted').hass;
    await settle();
    expect(mounted.root.querySelector('agr-config-error')?.detailed).toBe(false);
  });

  it('a later valid config replaces the error panel', async () => {
    const mounted = await mountCard({ config: { cameras: 'not a list' } });
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', demo: true });
    await settle();
    expect(mounted.root.querySelector('agr-config-error')).toBeNull();
    expect(mounted.root.querySelector('agr-today')).not.toBeNull();
  });

  it('an invalid config disposes the runtime and gateway', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    const gateway = mounted.services()?.gateway;
    mounted.card.setConfig({ type: 'custom:agraharam-dashboard', bogus: 1 });
    await settle();
    expect(gateway?.disposed).toBe(true);
  });
});

describe('demo isolation (§10.1)', () => {
  it('reads only themes.darkMode and user.is_admin from the real hass, and calls nothing on it', async () => {
    const fake = new FakeHass('normal', { darkMode: true });
    const reads = new Set<string>();
    const spyHass = new Proxy(fake.hass, {
      get(target, property, receiver) {
        reads.add(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const card = document.createElement('agraharam-dashboard');
    stubWidth(card, 1384);
    card.setConfig({ type: 'custom:agraharam-dashboard', demo: true });
    card.hass = spyHass;
    document.body.append(card);
    await settle();
    card.hass = spyHass;
    const mounted = {
      card,
      root: card.shadowRoot as ShadowRoot,
      services: () => undefined,
      stopPushes: () => undefined,
    };
    await openDrawerAndConfirm(mounted);
    (deepQueryAll<HTMLButtonElement>(document.body, 'button.confirm')[0] as HTMLButtonElement | undefined)?.click();
    await settle();
    expect([...reads].sort()).toEqual(['themes', 'user']);
    expect(fake.calls).toEqual([]);
    expect(card.getAttribute('data-theme')).toBe('dark');
    expect(card.shadowRoot?.querySelector('agr-header')?.services?.reader.kind).toBe('demo');
  });
});
