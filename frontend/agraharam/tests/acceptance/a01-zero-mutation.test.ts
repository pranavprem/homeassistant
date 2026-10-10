/**
 * ACCEPTANCE check 1 (§12.1 row 1): mount, render, route change, reconnect and demo interactions never mutate
 * real Home Assistant.
 *
 * Live cases run the real HassHost against FakeHass and assert, through FakeHass's runtime spies, that nothing
 * wrote (callService, callWS, sendMessage, sendMessagePromise) and that every subscription is the forecast read.
 * The static call-site fitness rules cannot see indirect paths, which is why these are runtime spies. Every case
 * also asserts that no error escaped: HA's logging mixin would turn one into a system_log.write service call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoScenarioId } from '../../src/config/schema.ts';
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import { mountCard, type MountedCard } from '../helpers/mount.ts';
import {
  advance,
  buttons,
  confirmDialog,
  expectNoMutation,
  FORECAST_SUBSCRIPTION,
  liveInput,
  mountLive,
  overlays,
  revealAll,
  settle,
  shadowOf,
  topOverlay,
  trackUnhandled,
  useAcceptanceTimers,
  FakeHass,
  type LiveCard,
  type UnhandledTracker,
} from './support.ts';
import {
  chooseSky,
  closeOverlays as closeSkyOverlays,
  openSkyDrawer,
  openWeatherDrawer,
  publishSky,
  SKY,
  skyPayload,
  skyRoot,
  skyRowButtons,
} from './sky-support.ts';

const WEATHER = 'weather.demo_home';
const ALARM = 'alarm_control_panel.demo_home';
const FRONT_GATE = 'camera.demo_front_gate';
const COURTYARD_LANTERN = 'light.demo_courtyard_lantern';
const KITCHEN_LIGHT = 'light.demo_kitchen';
const STATE_PUSHES = 50;
const ROUTE_CHANGE_GAP_MS = 1_000;
const EDIT_MODE_MS = 1_000;
const SECTION_TAGS = [
  'agr-header',
  'agr-today',
  'agr-comfort',
  'agr-home',
  'agr-cameras',
  'agr-garage',
  'agr-media',
  'agr-health',
  'agr-upcoming',
] as const;
/** Generous for the demo host's 400-1200 ms simulated latency and multi-step covers. */
const DEMO_ACTION_MS = 2_500;

let unhandled: UnhandledTracker;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useAcceptanceTimers();
  unhandled = trackUnhandled();
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  // A contained failure is still a defect worth seeing, and an escaped one would become a service call in HA.
  expect(unhandled.errors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  unhandled.dispose();
});

/** Fifty unrelated and related live updates: temperatures, lights, the alarm, rotating camera tokens, no-ops. */
async function pushStates(card: LiveCard): Promise<void> {
  for (let push = 0; push < STATE_PUSHES; push += 1) {
    switch (push % 5) {
      case 0:
        card.fake.setState(WEATHER, 'sunny', { temperature: 60 + (push % 7) });
        break;
      case 1:
        card.fake.setState(COURTYARD_LANTERN, push % 2 === 0 ? 'on' : 'off');
        break;
      case 2:
        card.fake.setState(FRONT_GATE, 'idle', { access_token: `rotated-${push}` });
        break;
      case 3:
        card.fake.setState(ALARM, push % 2 === 0 ? 'armed_away' : 'disarmed');
        break;
      default:
        card.fake.pushIdentityOnly();
    }
    await settle();
  }
}

/** hui-card-options moves the card into a wrapper with preview on, then back with preview off. */
async function editModeToggle(card: MountedCard): Promise<void> {
  const parent = card.card.parentElement as HTMLElement;
  const wrapper = document.createElement('div');
  parent.append(wrapper);
  wrapper.append(card.card);
  card.card.preview = true;
  await advance(EDIT_MODE_MS);
  parent.append(card.card);
  card.card.preview = false;
  wrapper.remove();
  await settle();
}

describe('live mode: no write on mount, render and state pushes (row 1a)', () => {
  it('mounting the normal scenario and 50 state pushes call no service and open only forecast reads', async () => {
    const card = await mountLive();
    revealAll();
    await advance(1_000);
    await pushStates(card);
    await advance(30_000);
    expectNoMutation(card.fake);
    const subscriptions = card.fake.calls.filter((call) => call.method === 'connection.subscribeMessage');
    expect(subscriptions.length).toBeGreaterThan(0);
    for (const call of subscriptions) {
      expect(call.args[0]).toMatchObject({ type: FORECAST_SUBSCRIPTION, entity_id: WEATHER });
      expect(call.args[1]).toEqual({ resubscribe: false });
    }
  });

  it.each<DemoScenarioId>(['degraded', 'offline', 'empty', 'alert', 'restricted', 'starting', 'dense'])(
    'the %s scenario mounts and renders without any write',
    async (scenario) => {
      const card = await mountLive({ scenario });
      card.fake.applyScenarioConnection();
      revealAll();
      await advance(15_000);
      expectNoMutation(card.fake);
    },
  );
});

describe('live mode: no write on route change, edit-mode toggle or hidden tab (row 1b)', () => {
  it('remove and re-append the same element (a route change away and back)', async () => {
    const card = await mountLive();
    card.card.remove();
    await advance(ROUTE_CHANGE_GAP_MS);
    document.body.append(card.card);
    await settle();
    revealAll();
    await advance(5_000);
    expectNoMutation(card.fake);
  });

  it('the edit-mode toggle sequence (wrapper, preview on, back, preview off)', async () => {
    const card = await mountLive();
    await editModeToggle(card);
    await editModeToggle(card);
    await advance(5_000);
    expectNoMutation(card.fake);
  });

  it('the hidden-tab order: panel removed, a state change, socket dropped, re-appended before ready, reconnect', async () => {
    const card = await mountLive();
    card.stopPushes(); // HA does not push hass to a removed panel
    card.card.remove();
    card.fake.setState(KITCHEN_LIGHT, 'on');
    card.fake.disconnect();
    document.body.append(card.card);
    card.card.hass = card.fake.hass; // HA pushes its current hass to the re-added panel
    const stop = card.fake.onPush((hass) => {
      card.card.hass = hass;
    });
    await settle();
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(5_000);
    expect(card.services()?.reader.connection().phase).toBe('connected');
    expectNoMutation(card.fake);
    stop();
  });

  it('a detach longer than the orphan timeout, then re-attach and a fresh hass', async () => {
    const card = await mountLive();
    card.stopPushes();
    card.card.remove();
    await advance(61_000);
    document.body.append(card.card);
    card.card.hass = card.fake.hass;
    await advance(5_000);
    expect(card.services()?.gateway.disposed).toBe(false);
    expectNoMutation(card.fake);
  });
});

describe("live mode: no write on reconnect in HA's two-step order (row 1c)", () => {
  it('connected: true with the old states first, the snapshot one macrotask later', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await settle();
    card.fake.reconnect({ snapshotDelayMs: 0 });
    expect(card.services()?.reader.connection().phase).toBe('resyncing');
    await advance(0);
    expect(card.services()?.reader.connection().phase).toBe('connected');
    await advance(5_000);
    expectNoMutation(card.fake);
  });

  it('connected: true and the snapshot delivered in one push', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await settle();
    card.stopPushes();
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    card.card.hass = card.fake.hass; // one hass: connected and the new states map together
    await advance(5_000);
    expect(card.services()?.reader.connection().phase).toBe('connected');
    expectNoMutation(card.fake);
  });

  it('repeated drops and reconnects with state changes in between', async () => {
    const card = await mountLive();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      card.fake.disconnect();
      card.fake.queueOutageChange(COURTYARD_LANTERN, cycle % 2 === 0 ? 'off' : 'on');
      await advance(100);
      card.fake.reconnect({ snapshotDelayMs: 400 });
      await advance(1_000);
    }
    expectNoMutation(card.fake);
  });
});

describe('live mode: no write on preview or configuration changes (row 1d)', () => {
  it('preview true then false', async () => {
    const card = await mountLive();
    card.card.preview = true;
    await advance(1_000);
    card.card.preview = false;
    await advance(1_000);
    expectNoMutation(card.fake);
  });

  it('setConfig with a new title (same runtime), without cameras (new runtime), then back', async () => {
    const card = await mountLive();
    const input = liveInput('normal');
    card.card.setConfig({ type: 'custom:agraharam-dashboard', ...input, title: 'Courtyard house' });
    await advance(500);
    const { cameras: _cameras, ...withoutCameras } = input;
    card.card.setConfig({ type: 'custom:agraharam-dashboard', ...withoutCameras });
    await advance(500);
    card.card.setConfig({ type: 'custom:agraharam-dashboard', ...input });
    card.card.hass = card.fake.hass;
    await advance(5_000);
    expectNoMutation(card.fake);
  });

  it('an invalid config replacing a valid one, then a valid one again', async () => {
    const card = await mountLive();
    card.card.setConfig({ type: 'custom:agraharam-dashboard', weather: 'light.demo_not_weather' });
    await advance(500);
    card.card.setConfig({ type: 'custom:agraharam-dashboard', ...liveInput('normal') });
    card.card.hass = card.fake.hass;
    await advance(5_000);
    expectNoMutation(card.fake);
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Demo mode (row 1e): every enabled control, every drawer, every confirm dialog, and the real hass sees nothing.

/** A button that would act or open something: enabled, connected and not a dialog's own Close button. */
function actionable(button: HTMLButtonElement): boolean {
  return button.isConnected && button.getAttribute('aria-disabled') !== 'true' && !button.disabled;
}

/**
 * Closes every overlay the way the root does on detach. happy-dom fires no 'close' event for dialog.close(), so a
 * Close click would leave the drawer mounted here; real dialog closing is covered by e2e/keyboard.spec.ts.
 */
function closeOverlays(card: MountedCard): void {
  (card.root.querySelector('agr-overlay-host') as AgrOverlayHost).closeAll();
  // Focus returns to the card frame, as it would after a real close (happy-dom keeps focus on removed nodes).
  card.root.querySelector<HTMLElement>('.frame')?.focus();
}

/** A pointer press: the button takes focus, then activates. */
function press(button: HTMLButtonElement): void {
  button.focus();
  button.click();
}

/** Confirms the open confirm dialog, if any (the only way a confirm-required action is sent). */
async function confirmIfAsked(card: MountedCard): Promise<number> {
  const dialog = confirmDialog(card);
  if (dialog === null) return 0;
  const confirm = shadowOf(dialog).querySelector<HTMLButtonElement>('button.confirm');
  if (confirm) press(confirm);
  await advance(DEMO_ACTION_MS);
  return 1;
}

/** Clicks every enabled control in the open drawer once (confirming any confirm dialog), then closes it. */
async function exerciseDrawer(card: MountedCard, drawer: Element): Promise<{ clicks: number; confirms: number }> {
  let clicks = 0;
  let confirms = 0;
  for (const button of buttons(shadowOf(drawer))) {
    if (!actionable(button) || button.classList.contains('close')) continue;
    press(button);
    clicks += 1;
    await advance(DEMO_ACTION_MS);
    confirms += await confirmIfAsked(card);
    if (!drawer.isConnected) break; // the click opened another drawer in its place
  }
  closeOverlays(card);
  await settle();
  return { clicks, confirms };
}

async function exerciseEverything(card: MountedCard): Promise<{ clicks: number; confirms: number; drawers: number }> {
  const totals = { clicks: 0, confirms: 0, drawers: 0 };
  for (const tag of SECTION_TAGS) {
    const element = card.root.querySelector(tag);
    if (element === null) continue;
    for (const button of buttons(shadowOf(element))) {
      if (!actionable(button)) continue;
      press(button);
      totals.clicks += 1;
      await advance(DEMO_ACTION_MS);
      totals.confirms += await confirmIfAsked(card);
      const drawer = topOverlay(card);
      if (drawer !== undefined) {
        totals.drawers += 1;
        const result = await exerciseDrawer(card, drawer);
        totals.clicks += result.clicks;
        totals.confirms += result.confirms;
      }
    }
  }
  return totals;
}

describe('demo mode: the real hass is never called (row 1e)', () => {
  it.each<DemoScenarioId>(['normal', 'alert', 'dense'])(
    'clicking every enabled control and drawer in %s and confirming every confirm dialog leaves every FakeHass spy at 0',
    async (scenario) => {
      const fake = new FakeHass(scenario);
      const card = await mountCard({ config: { demo: true, demo_scenario: scenario }, fake });
      revealAll();
      await advance(2_000);
      const totals = await exerciseEverything(card);
      await advance(70_000); // every gateway timeout and confirm auto-cancel has run

      expect(fake.calls).toEqual([]);
      // The exercise was real: controls were clicked, drawers opened and actions ran through the demo host.
      expect(totals.clicks).toBeGreaterThan(20);
      expect(totals.drawers).toBeGreaterThan(3);
      expect(card.services()?.gateway.recent().length).toBeGreaterThan(0);
      expect(card.services()?.reader.kind).toBe('demo');
      expect(overlays(card).querySelector('.layer')?.children.length ?? 0).toBe(0);
    },
  );

  it('confirms at least one confirm-required action in the normal demo (the garage)', async () => {
    const fake = new FakeHass('normal');
    const card = await mountCard({ config: { demo: true }, fake });
    const totals = await exerciseEverything(card);
    expect(totals.confirms).toBeGreaterThan(0);
    expect(fake.calls).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Sky (AIRSPACE.md §1, ARCHITECTURE.md §19): the optional panel and both read-only drawers never write, in either mode.

/** Events through which a card asks Home Assistant to act or to open its own dialogs; the sky raises none. */
const HA_REQUEST_EVENTS = ['hass-more-info', 'hass-action', 'hass-notification', 'll-custom'] as const;
const SKY_VIEWS = ['overhead', 'recent', 'nearby'] as const;
const SKY_SORTS = ['altitude', 'name', 'distance'] as const;
/** Six sky clock ticks (10 s each): the panel and the drawer re-render without any entity update. */
const SKY_TICKS_MS = 60_000;

/** Counts the HA request events that reach the document from anywhere in the card. */
function trackHaRequests(): { readonly count: () => number; dispose(): void } {
  let count = 0;
  const onEvent = (): void => {
    count += 1;
  };
  for (const type of HA_REQUEST_EVENTS) document.addEventListener(type, onEvent, { capture: true });
  return {
    count: () => count,
    dispose: () => {
      for (const type of HA_REQUEST_EVENTS) document.removeEventListener(type, onEvent, { capture: true });
    },
  };
}

/**
 * Opens the sky drawer from the panel, walks every view and sort, expands and collapses every listed row, chooses a
 * radar mark, lets the sky clock tick, closes it; then opens and closes the weather drawer from Today's header.
 * Returns how many controls were pressed, so a test can prove the exercise was real.
 */
async function exerciseSky(card: MountedCard): Promise<number> {
  let presses = 0;
  const drawer = await openSkyDrawer(card);
  presses += 1;
  for (const view of SKY_VIEWS) {
    await chooseSky(drawer, 'view', view);
    presses += 1;
    for (const sort of view === 'recent' ? ['latest', ...SKY_SORTS] : SKY_SORTS) {
      await chooseSky(drawer, 'sort', sort);
      presses += 1;
    }
    for (const row of skyRowButtons(drawer)) {
      row.focus();
      row.click(); // expand
      row.click(); // collapse
      await settle();
      presses += 2;
    }
  }
  const mark = drawer.querySelector('agr-sky-radar')?.shadowRoot?.querySelector('g.aircraft .hit');
  mark?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  presses += mark === null || mark === undefined ? 0 : 1;
  await advance(SKY_TICKS_MS);
  await closeSkyOverlays(card);
  await openWeatherDrawer(card);
  presses += 1;
  await advance(SKY_TICKS_MS);
  await closeSkyOverlays(card);
  return presses;
}

describe('sky: the panel and the sky and weather drawers never write (AIRSPACE.md §1)', () => {
  let requests: ReturnType<typeof trackHaRequests>;

  beforeEach(() => {
    requests = trackHaRequests();
  });

  afterEach(() => {
    expect(requests.count(), 'HA request events (more-info, actions)').toBe(0);
    requests.dispose();
  });

  it('live: mounting, every view, sort and row, a radar mark, the clock and fresh payloads call nothing', async () => {
    const card = await mountLive({ scenario: 'sky' });
    await advance(1_000);
    const before = card.fake.calls.length;

    const presses = await exerciseSky(card);
    await publishSky(card, skyPayload('dense'));
    await exerciseSky(card);
    await publishSky(card, skyPayload('empty'));
    await advance(SKY_TICKS_MS);

    expect(presses).toBeGreaterThan(20);
    expectNoMutation(card.fake);
    // Nothing the sky did reached Home Assistant at all: no read names the sensor, and no write or read was added
    // by the exercise beyond the card's own scheduled reads (forecast, calendar), which never name it either.
    const added = card.fake.calls.slice(before);
    expect(added.filter((call) => JSON.stringify(call.args).includes(SKY))).toEqual([]);
    expect(added.filter((call) => call.method === 'callService')).toEqual([]);
  });

  it('live with controls off, a non-admin and the editor preview: the same exercise calls nothing', async () => {
    const card = await mountLive({
      scenario: 'sky',
      input: liveInput('sky', { controls: false }),
      transform: (hass) => ({ ...hass, user: { id: 'demo-guest', is_admin: false } }),
    });
    card.card.preview = true;
    await advance(1_000);
    expect(await exerciseSky(card)).toBeGreaterThan(20);
    expectNoMutation(card.fake);
  });

  it('live: a disconnect and a two-step reconnect with the sky drawer open call nothing', async () => {
    const card = await mountLive({ scenario: 'sky' });
    const drawer = await openSkyDrawer(card);
    skyRowButtons(drawer)[0]?.click();
    card.fake.disconnect();
    await advance(SKY_TICKS_MS);
    card.fake.queueOutageChange(SKY, '50', skyPayload('dense'));
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(5_000);
    expect(skyRowButtons(drawer)).toHaveLength(50);
    await closeSkyOverlays(card);
    expectNoMutation(card.fake);
  });

  it('demo: the same exercise leaves every FakeHass spy at 0 and records no gateway action', async () => {
    const fake = new FakeHass('sky');
    const card = await mountCard({ config: { demo: true, demo_scenario: 'sky' }, fake });
    await advance(2_000);
    expect(skyRoot(card).querySelector('agr-panel')).not.toBeNull();

    expect(await exerciseSky(card)).toBeGreaterThan(20);
    await advance(70_000);

    expect(fake.calls).toEqual([]);
    expect(card.services()?.reader.kind).toBe('demo');
    expect(card.services()?.gateway.recent()).toEqual([]);
  });
});
