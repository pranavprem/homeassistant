/**
 * §18 acceptance through the REAL card (root, HassHost, resync barrier, gateway, sections and overlays) against
 * FakeHass, on the fictional degraded, starting and dense scenarios:
 *
 * - a mixed room's All on is exactly one call per domain, and a refused switch call reads as partly done, never as
 *   nothing changed, with every target locked until the 15 s room timeout;
 * - a settings switch and an unavailable lamp are left out of the room call, and the settings switch stays read-only;
 * - a whole-house shortcut needs its confirm dialog, sends exactly one script.turn_on, and an unanswered run becomes
 *   uncertain after 10 s, with nothing retried;
 * - a switch HA has not delivered while it starts reads "Loading", never "Not found";
 * - until the entity registry arrives (FakeHass registryPending), lamp switches and rooms with switches wait with a
 *   visible notice while lights stay usable; the delivery clears it, and nothing waits forever without being said;
 * - mounting, the room drawers, a preview toggle and a two-step reconnect send nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_PENDING_COPY, SETTINGS_SWITCH_COPY } from '../../src/ha/actions/messages.ts';
import { ACTION_TIMEOUT_MS } from '../../src/ha/actions/types.ts';
import type { DemoScenarioId } from '../../src/config/schema.ts';
import { stubWidth } from '../helpers/dom.ts';
import { WIDE_WIDTH } from '../helpers/mount.ts';
import {
  advance,
  confirmDialog,
  control,
  deepQuery,
  describedBy,
  DEVICE_LATENCY_MS,
  expectNoMutation,
  FakeHass,
  liveInput,
  mountLive,
  press,
  renderedText,
  revealAll,
  section,
  serviceCalls,
  settle,
  shadowOf,
  topOverlay,
  trackUnhandled,
  useAcceptanceTimers,
  type LiveCard,
  type UnhandledTracker,
} from './support.ts';

const READING_ROOM = 1;
const WORKSHOP = 3;
const DENSE_KITCHEN = 2;
const DENSE_COURTYARD = 0;
const ROOM_TIMEOUT_MS = ACTION_TIMEOUT_MS.room;

let unhandled: UnhandledTracker;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useAcceptanceTimers();
  unhandled = trackUnhandled();
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  expect(unhandled.errors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
  unhandled.dispose();
});

/** Opens room `index`'s drawer from its Home chip and returns the drawer element. */
async function openRoom(card: LiveCard, index: number): Promise<Element> {
  await press(control(shadowOf(section(card, 'agr-home')), `room:${index}:open`));
  const drawer = topOverlay(card);
  if (drawer === undefined || drawer.tagName.toLowerCase() !== 'agr-room-drawer') throw new Error('no room drawer');
  return drawer;
}

/** The card in live mode on a FakeHass whose entity registry has not arrived yet, as on every page load. */
async function mountRegistryPending(scenario: DemoScenarioId): Promise<LiveCard> {
  const fake = new FakeHass(scenario, {
    latencyMs: [DEVICE_LATENCY_MS, DEVICE_LATENCY_MS],
    random: () => 0,
    registryPending: true,
  });
  const card = document.createElement('agraharam-dashboard');
  stubWidth(card, WIDE_WIDTH);
  card.setConfig({ type: 'custom:agraharam-dashboard', ...liveInput(scenario) });
  card.hass = fake.hass;
  const stopPushes = fake.onPush((hass) => {
    card.hass = hass;
  });
  document.body.append(card);
  await settle();
  const root = card.shadowRoot;
  if (root === null) throw new Error('card has no shadow root');
  return { card, root, fake, services: () => root.querySelector('agr-header')?.services, stopPushes };
}

describe('degraded: a mixed room with a refusing switch (design §5.2, §10)', () => {
  it('All on sends one light call and one switch call, then reads "Partly done" with the partial copy', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    const drawer = await openRoom(card, READING_ROOM);
    await press(control(shadowOf(drawer), `room-drawer:${READING_ROOM}:all-on`));
    await advance(DEVICE_LATENCY_MS * 2);
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: ['light.demo_reading_lamp'] } },
      { domain: 'switch', service: 'turn_on', data: {}, target: { entity_id: ['switch.demo_reading_strip'] } },
    ]);
    const text = renderedText(drawer);
    // The room's quick toggle describes the ticket in short; the drawer's live region carries the whole outcome.
    const quick = control(shadowOf(section(card, 'agr-home')), `room:${READING_ROOM}:toggle`);
    expect(describedBy(quick)).toContain('Partly done');
    expect(text).toMatch(
      /Some of the Reading room lights may have switched, but Home Assistant didn't accept the rest/,
    );
    expect(text).not.toMatch(/Nothing was changed/);
  });

  it('keeps the room and its targets locked until the 15 s room timeout, and never retries', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    const drawer = await openRoom(card, READING_ROOM);
    await press(control(shadowOf(drawer), `room-drawer:${READING_ROOM}:all-on`));
    await advance(DEVICE_LATENCY_MS * 2);
    const allOn = control(shadowOf(drawer), `room-drawer:${READING_ROOM}:all-on`);
    expect(allOn.getAttribute('aria-disabled')).toBe('true');
    await press(allOn);
    await advance(ROOM_TIMEOUT_MS);
    expect(serviceCalls(card.fake)).toHaveLength(2);
    expect(card.services()?.gateway.evaluate({ kind: 'room.lights_on', room: READING_ROOM }).enabled).toBe(true);
  });

  it('the Workshop leaves the unavailable lamp and the settings switch out, and shows the settings reason', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    const drawer = await openRoom(card, WORKSHOP);
    expect(renderedText(drawer)).toContain(SETTINGS_SWITCH_COPY);
    const childLock = control(
      shadowOf(drawer),
      `room-drawer:${WORKSHOP}:switch:switch.demo_workshop_child_lock:toggle`,
    );
    expect(childLock.getAttribute('aria-disabled')).toBe('true');
    await press(childLock);
    await advance(1_000);
    expect(serviceCalls(card.fake)).toEqual([]);
    const allOn = control(shadowOf(drawer), `room-drawer:${WORKSHOP}:all-on`);
    expect(allOn.getAttribute('aria-disabled')).not.toBe('true');
    await press(allOn);
    await advance(DEVICE_LATENCY_MS * 2);
    // Only the light: the lamp switch is unavailable and the child lock is a settings switch.
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: ['light.demo_workshop'] } },
    ]);
  });
});

describe('degraded: the whole-house lights shortcut (design §5.4, §9.1)', () => {
  it('asks first; Confirm sends ONE script.turn_on; with no run reported it is uncertain after 10 s', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    const home = shadowOf(section(card, 'agr-home'));
    await press(control(home, 'home:shortcut:lights_toggle'));
    const dialog = confirmDialog(card);
    expect(dialog).not.toBeNull();
    expect(renderedText(dialog as Element)).toContain('Toggle the whole-house lights?');
    expect(serviceCalls(card.fake)).toEqual([]);
    const confirm = shadowOf(dialog).querySelector<HTMLButtonElement>('button.confirm');
    if (confirm === null) throw new Error('no Confirm button');
    await press(confirm);
    await advance(DEVICE_LATENCY_MS);
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: 'script.demo_house_lights_toggle' } },
    ]);
    await advance(ACTION_TIMEOUT_MS.shortcut);
    expect(renderedText(home)).toMatch(/Lights\s*:\s*No response yet/);
    expect(renderedText(home)).toContain("The whole-house lights script didn't confirm within 10 seconds.");
    await advance(60_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });

  it('Cancel sends nothing', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    await press(control(shadowOf(section(card, 'agr-home')), 'home:shortcut:lights_toggle'));
    const cancel = shadowOf(confirmDialog(card)).querySelector<HTMLButtonElement>('button.cancel');
    if (cancel === null) throw new Error('no Cancel button');
    await press(cancel);
    await advance(30_000);
    expect(serviceCalls(card.fake)).toEqual([]);
  });
});

describe('starting: a lamp switch HA has not delivered yet (design §10)', () => {
  it('reads "Loading", never "Not found"', async () => {
    const card = await mountLive({ scenario: 'starting' });
    const drawer = await openRoom(card, DENSE_KITCHEN);
    const text = renderedText(drawer);
    expect(text).toContain('Loading');
    expect(text).not.toContain('Not found');
  });
});

describe('registry pending (§18 B1): visible, bounded, and lights stay usable', () => {
  it('shows the Home notice; a room with switches waits with 0 calls; a light-only room acts at once', async () => {
    const card = await mountRegistryPending('dense');
    const home = shadowOf(section(card, 'agr-home'));
    expect(renderedText(home)).toContain(REGISTRY_PENDING_COPY.notice);
    const kitchen = control(home, `room:${DENSE_KITCHEN}:toggle`);
    expect(kitchen.getAttribute('aria-disabled')).toBe('true');
    await press(kitchen);
    await advance(1_000);
    expect(serviceCalls(card.fake)).toEqual([]);
    await press(control(home, `room:${DENSE_COURTYARD}:toggle`));
    await advance(DEVICE_LATENCY_MS);
    expect(serviceCalls(card.fake).map((call) => call.domain)).toEqual(['light']);
  });

  it('never clears on its own (an hour later, still waiting and still saying so)', async () => {
    const card = await mountRegistryPending('dense');
    await advance(60 * 60 * 1000);
    const home = shadowOf(section(card, 'agr-home'));
    expect(renderedText(home)).toContain(REGISTRY_PENDING_COPY.notice);
    expect(control(home, `room:${DENSE_KITCHEN}:toggle`).getAttribute('aria-disabled')).toBe('true');
  });

  it('the delivery clears the notice and the Kitchen toggle then sends one call per domain', async () => {
    const card = await mountRegistryPending('dense');
    card.fake.deliverRegistry();
    await settle();
    const home = shadowOf(section(card, 'agr-home'));
    expect(renderedText(home)).not.toContain(REGISTRY_PENDING_COPY.notice);
    await press(control(home, `room:${DENSE_KITCHEN}:toggle`));
    await advance(DEVICE_LATENCY_MS);
    expect(serviceCalls(card.fake).map((call) => `${call.domain}.${call.service}`)).toEqual([
      'light.turn_off',
      'switch.turn_off',
    ]);
  });
});

describe('zero mutation with the §18 additions (§12.1 row 1)', () => {
  it('dense: mount, every room drawer, a preview toggle and a two-step reconnect send nothing', async () => {
    const card = await mountLive({ scenario: 'dense' });
    revealAll();
    await advance(1_000);
    const rooms = card.services()?.config.rooms.length ?? 0;
    expect(rooms).toBe(10);
    // Six chips on the overview (§6.2.1); the rest are reached through the home drawer, so open what is shown.
    let opened = 0;
    for (let index = 0; index < rooms; index += 1) {
      const chip = deepQuery(shadowOf(section(card, 'agr-home')), `[data-focus-key="room:${index}:open"]`);
      if (chip === null) continue;
      const drawer = await openRoom(card, index);
      expect(renderedText(drawer).length, `room ${index}`).toBeGreaterThan(0);
      opened += 1;
      (card.root.querySelector('agr-overlay-host') as unknown as { closeAll(): void }).closeAll();
      await settle();
    }
    expect(opened).toBe(6);
    card.card.preview = true;
    await advance(1_000);
    card.card.preview = false;
    await advance(1_000);
    card.fake.disconnect();
    await settle();
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(5_000);
    expectNoMutation(card.fake);
  });

  it('degraded and starting mount and render with the new rooms and shortcuts without any write', async () => {
    for (const scenario of ['degraded', 'starting'] as const) {
      const card = await mountLive({ scenario });
      revealAll();
      await advance(15_000);
      expectNoMutation(card.fake);
      card.card.remove();
    }
  });
});
