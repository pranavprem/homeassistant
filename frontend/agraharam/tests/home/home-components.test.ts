import { describe, expect, it, vi } from 'vitest';
import '../../src/components/home/agr-home.ts';
import '../../src/components/home/agr-home-drawer.ts';
import '../../src/components/home/agr-room-drawer.ts';
import type { AgrHome } from '../../src/components/home/agr-home.ts';
import type { AgrRoomDrawer } from '../../src/components/home/agr-room-drawer.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { OpenDrawerDetail } from '../../src/components/shell/overlay-types.ts';
import type { Availability } from '../../src/ha/actions/types.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS } from '../../src/ha/actions/types.ts';
import { FAN_FEATURE, VACUUM_FEATURE } from '../../src/ha/features.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity } from '../helpers/fake-store.ts';
import { liveStore } from '../helpers/live-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';

const ALL_VACUUM_BITS = VACUUM_FEATURE.START | VACUUM_FEATURE.PAUSE | VACUUM_FEATURE.RETURN_HOME;
const CONTROLS_OFF: Availability = {
  enabled: false,
  reason: 'controls-off',
  message: 'Controls are turned off in the dashboard configuration.',
};

const CONFIG = {
  rooms: [
    { name: 'Courtyard', lights: ['light.demo_lantern', 'light.demo_steps'] },
    {
      name: 'Workshop',
      lights: ['light.demo_workshop'],
      curtains: ['cover.demo_blind', 'cover.demo_roller'],
      purifier: 'fan.demo_air',
    },
  ],
  vacuums: [{ entity: 'vacuum.demo_pebble', name: 'Pebble', battery_sensor: 'sensor.demo_pebble_battery' }],
  appliances: [{ name: 'Dishwasher', status_sensor: 'sensor.demo_dish', remaining_sensor: 'sensor.demo_dish_left' }],
  studio_monitors_script: 'script.demo_monitors',
};

function states(): HassEntityLike[] {
  return [
    testEntity('light.demo_lantern', 'on', {
      friendly_name: 'Lantern',
      supported_color_modes: ['brightness'],
      brightness: 180,
    }),
    testEntity('light.demo_steps', 'off', { friendly_name: 'Steps', supported_color_modes: ['onoff'] }),
    testEntity('light.demo_workshop', 'off', { friendly_name: 'Workshop', supported_color_modes: ['brightness'] }),
    testEntity('cover.demo_blind', 'closed', { friendly_name: 'Blind', device_class: 'blind' }),
    testEntity('cover.demo_roller', 'closed', { friendly_name: 'Roller door', device_class: 'garage' }),
    testEntity('fan.demo_air', 'on', {
      friendly_name: 'Workshop air',
      percentage: 40,
      percentage_step: 20,
      supported_features: FAN_FEATURE.SET_SPEED | FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF,
    }),
    testEntity('vacuum.demo_pebble', 'docked', { friendly_name: 'Pebble', supported_features: ALL_VACUUM_BITS }),
    testEntity('sensor.demo_pebble_battery', '82', { unit_of_measurement: '%' }),
    testEntity('sensor.demo_dish', 'Washing'),
    testEntity('sensor.demo_dish_left', '35', { device_class: 'duration', unit_of_measurement: 'min' }),
    testEntity('script.demo_monitors', 'off'),
  ];
}

function services(
  options: { gateway?: FakeGateway; store?: StoreView; config?: Record<string, unknown> } = {},
): DashboardServices & { gateway: FakeGateway } {
  return fakeServices({
    config: configFrom(options.config ?? CONFIG),
    store: options.store ?? fakeStore(states()),
    ...(options.gateway !== undefined && { gateway: options.gateway }),
  });
}

async function mountHome(svc: DashboardServices): Promise<AgrHome> {
  const home = document.createElement('agr-home');
  home.services = svc;
  document.body.append(home);
  await settle();
  return home;
}

async function mountRoomDrawer(svc: DashboardServices, room: number): Promise<AgrRoomDrawer> {
  const drawer = document.createElement('agr-room-drawer');
  drawer.services = svc;
  drawer.request = { id: 'room', room };
  document.body.append(drawer);
  await settle();
  return drawer;
}

function nativeButton(root: ParentNode, focusKey: string): HTMLButtonElement {
  const button = deepQuery<HTMLButtonElement>(root, `button[data-focus-key="${focusKey}"]`);
  if (button === null) throw new Error(`no button ${focusKey}`);
  return button;
}

/** The section's single polite live region (§7.2). */
function liveRegionText(root: ParentNode): string {
  const regions = deepQueryAll(root, 'agr-control-notes').flatMap((notes) =>
    deepQueryAll(notes.shadowRoot ?? notes, '[role="status"]'),
  );
  expect(regions).toHaveLength(1);
  return (regions[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function text(root: ParentNode): string {
  return deepQueryAll(root, '*')
    .flatMap((element) => [...element.childNodes])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

describe('agr-home', () => {
  it('renders rooms, the vacuum, the appliance and the studio monitors without requesting anything', async () => {
    const svc = services();
    const home = await mountHome(svc);
    expect(deepQueryAll(home.shadowRoot!, 'agr-room-chip')).toHaveLength(2);
    expect(deepQueryAll(home.shadowRoot!, 'agr-vacuum-row')).toHaveLength(1);
    expect(text(home.shadowRoot!)).toContain('1 of 2 on');
    expect(text(home.shadowRoot!)).toContain('35 min left');
    expect(text(home.shadowRoot!)).toContain('82%');
    expect(svc.gateway.calls).toHaveLength(0);
  });

  it('shows the state on each quick toggle itself: a lit disc for a lit room, a plain one otherwise, on one flat device list', async () => {
    const home = await mountHome(services());
    const toggles = deepQueryAll<HTMLButtonElement>(home.shadowRoot!, 'button.quick');
    expect(toggles.map((toggle) => toggle.hasAttribute('data-lit'))).toEqual([true, false]);
    // The 44 px hit area holds a 36 px visible disc, so the toggle never crowds the chip's edges.
    expect(toggles.every((toggle) => toggle.querySelector('.disc[aria-hidden="true"]') !== null)).toBe(true);
    // Vacuums, appliances and the studio monitors share the flat row with a 36 px well (one text edge).
    const rows = deepQueryAll(home.shadowRoot!, '.device-row');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row.querySelector('.well') !== null)).toBe(true);
  });

  it('sends ONE room action for a quick toggle, and nothing more while it is pending', async () => {
    const svc = services();
    const home = await mountHome(svc);
    const toggle = nativeButton(home.shadowRoot!, 'room:0:toggle');
    toggle.click();
    await settle();
    toggle.click();
    nativeButton(home.shadowRoot!, 'room:0:toggle').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'room.lights_off', room: 0 }]);
    expect(nativeButton(home.shadowRoot!, 'room:0:toggle').getAttribute('aria-disabled')).toBe('true');
  });

  it('turns a dark room on with room.lights_on', async () => {
    const svc = services();
    const home = await mountHome(svc);
    nativeButton(home.shadowRoot!, 'room:1:toggle').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'room.lights_on', room: 1 }]);
  });

  it('opens the room drawer from the chip, with the chip button as the trigger', async () => {
    const home = await mountHome(services());
    const opened = vi.fn();
    document.body.addEventListener('agr-open-drawer', opened);
    const open = nativeButton(home.shadowRoot!, 'room:1:open');
    open.click();
    const detail = (opened.mock.calls[0]?.[0] as CustomEvent<OpenDrawerDetail>).detail;
    expect(detail.request).toEqual({ id: 'room', room: 1 });
    expect(detail.trigger).toBe(open);
  });

  it('guards disabled controls and shows one panel notice instead of per-control lines', async () => {
    const gateway = new FakeGateway();
    gateway.availability = CONTROLS_OFF;
    const home = await mountHome(services({ gateway }));
    const toggle = nativeButton(home.shadowRoot!, 'room:0:toggle');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    toggle.click();
    nativeButton(home.shadowRoot!, `vacuum:vacuum.demo_pebble:start`).click();
    nativeButton(home.shadowRoot!, 'home:studio-monitors').click();
    expect(gateway.calls).toHaveLength(0);
    const notices = deepQueryAll(home.shadowRoot!, 'p.notice');
    expect(notices.map((notice) => notice.textContent)).toEqual([CONTROLS_OFF.message]);
    const visibleReasons = deepQueryAll(home.shadowRoot!, '.reason').filter(
      (reason) => reason.textContent === CONTROLS_OFF.message,
    );
    expect(visibleReasons).toEqual([]);
  });

  it('states the disconnected pause once as a panel notice, like the other sections', async () => {
    const gateway = new FakeGateway();
    const paused: Availability = {
      enabled: false,
      reason: 'disconnected',
      message: 'Paused while Home Assistant is disconnected.',
    };
    gateway.availability = paused;
    const home = await mountHome(services({ gateway }));
    const notices = deepQueryAll(home.shadowRoot!, 'p.notice');
    expect(notices.map((notice) => notice.textContent)).toEqual([paused.message]);
    expect(deepQueryAll(home.shadowRoot!, '.reason').filter((reason) => reason.textContent === paused.message)).toEqual(
      [],
    );
  });

  it('starts the docked vacuum with one vacuum.start and offers no pause or dock while docked', async () => {
    const svc = services();
    const home = await mountHome(svc);
    expect(deepQuery(home.shadowRoot!, 'button[data-focus-key="vacuum:vacuum.demo_pebble:pause"]')).toBeNull();
    expect(deepQuery(home.shadowRoot!, 'button[data-focus-key="vacuum:vacuum.demo_pebble:return"]')).toBeNull();
    nativeButton(home.shadowRoot!, 'vacuum:vacuum.demo_pebble:start').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'vacuum.start', entity: 'vacuum.demo_pebble' }]);
  });

  it('runs the studio monitors script once and reports "Requested", never "Done"', async () => {
    const svc = services();
    const home = await mountHome(svc);
    nativeButton(home.shadowRoot!, 'home:studio-monitors').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'studio_monitors.run' }]);
    svc.gateway.settle('studio_monitors', 'confirmed');
    await settle();
    expect(liveRegionText(home.shadowRoot!)).toBe('Studio monitors Requested');
    expect(text(home.shadowRoot!)).toContain('Requested');
    expect(text(home.shadowRoot!)).not.toContain('Done');
  });

  it('keeps a failed ticket visible in the live region until it is dismissed', async () => {
    const svc = services();
    const home = await mountHome(svc);
    nativeButton(home.shadowRoot!, 'room:0:toggle').click();
    svc.gateway.settle('room:0', 'failed', { code: 'rejected', message: "Home Assistant didn't accept the request." });
    await settle();
    expect(liveRegionText(home.shadowRoot!)).toBe("Courtyard lights Home Assistant didn't accept the request.");
    nativeButton(home.shadowRoot!, 'home:dismiss:room:0:ticket').click();
    await settle();
    expect(svc.gateway.status('room:0')).toBeUndefined();
    expect(liveRegionText(home.shadowRoot!)).toBe('');
  });

  it('records an immediate failure from request() in the live region', async () => {
    const gateway = new FakeGateway();
    gateway.failWith = { code: 'busy', message: 'Waiting for Courtyard lights to respond to the last request.' };
    const home = await mountHome(services({ gateway }));
    nativeButton(home.shadowRoot!, 'room:0:toggle').click();
    await settle();
    expect(liveRegionText(home.shadowRoot!)).toContain('Waiting for Courtyard');
  });

  it('offers "All rooms and devices" only when the overview leaves something out', async () => {
    const opened = vi.fn();
    document.body.addEventListener('agr-open-drawer', opened);
    const fits = await mountHome(services());
    expect(deepQuery(fits.shadowRoot!, 'button[data-focus-key="home:all"]')).toBeNull();
    fits.remove();
    const rooms = Array.from({ length: 7 }, (_unused, index) => ({
      name: `Room ${index}`,
      lights: [`light.demo_r${index}`],
    }));
    const crowded = await mountHome(
      services({
        config: { rooms },
        store: fakeStore(rooms.map((_room, index) => testEntity(`light.demo_r${index}`, 'off'))),
      }),
    );
    expect(deepQueryAll(crowded.shadowRoot!, 'agr-room-chip')).toHaveLength(6);
    nativeButton(crowded.shadowRoot!, 'home:all').click();
    expect((opened.mock.calls[0]?.[0] as CustomEvent<OpenDrawerDetail>).detail.request).toEqual({ id: 'home' });
  });

  it('shows an absent battery as a hatched empty track and its label, never 0%', async () => {
    const store = fakeStore(states().filter((state) => state.entity_id !== 'sensor.demo_pebble_battery'));
    const home = await mountHome(services({ store }));
    const track = deepQuery(home.shadowRoot!, 'agr-vacuum-row .track');
    expect(track?.hasAttribute('data-absent')).toBe(true);
    expect(deepQuery(home.shadowRoot!, 'agr-vacuum-row .fill')).toBeNull();
    expect(text(home.shadowRoot!)).toContain('Not found');
    expect(text(home.shadowRoot!)).not.toMatch(/\b0%/);
  });

  it('renders runtime names as text, never as markup', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const home = await mountHome(
      services({
        config: { rooms: [{ name: payload, lights: ['light.demo_x'] }] },
        store: fakeStore([testEntity('light.demo_x', 'off')]),
      }),
    );
    expect(deepQuery(home.shadowRoot!, 'img')).toBeNull();
    expect(text(home.shadowRoot!)).toContain(payload);
  });

  it('shows an intentional empty state when nothing is configured', async () => {
    const home = await mountHome(services({ config: {} }));
    expect(deepQuery(home.shadowRoot!, 'agr-empty-state')).not.toBeNull();
  });

  it("refreshes an appliance's finish time on the minute tick, with no entity change", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-09-30T17:51:00-07:00');
    vi.setSystemTime(start);
    const config = configFrom({
      appliances: [{ name: 'Washer', status_sensor: 'sensor.demo_washer', remaining_sensor: 'sensor.demo_finish' }],
    });
    const live = liveStore(config, { 'sensor.demo_washer': 'Rinsing' });
    live.set('sensor.demo_finish', new Date(start.getTime() + 60_000).toISOString(), { device_class: 'timestamp' });
    const home = await mountHome(fakeServices({ config, store: live.store }));
    expect(text(home.shadowRoot!)).toContain('Done');
    vi.setSystemTime(new Date(start.getTime() + 2 * 60_000));
    live.store.tick();
    await settle();
    expect(text(home.shadowRoot!)).not.toContain('Done');
  });
});

describe('agr-room-drawer', () => {
  it('toggles one light with one scoped request', async () => {
    const svc = services();
    const drawer = await mountRoomDrawer(svc, 0);
    nativeButton(drawer.shadowRoot!, 'room-drawer:0:light:light.demo_lantern:toggle').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'light.turn_off', entity: 'light.demo_lantern' }]);
  });

  it('offers explicit All on and All off for the room, each one room action', async () => {
    const svc = services();
    const drawer = await mountRoomDrawer(svc, 0);
    nativeButton(drawer.shadowRoot!, 'room-drawer:0:all-on').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'room.lights_on', room: 0 }]);
  });

  it('debounces a brightness gesture into one light.set_brightness', async () => {
    const svc = services();
    const drawer = await mountRoomDrawer(svc, 0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slider = deepQuery<HTMLInputElement>(
      drawer.shadowRoot!,
      'input[data-focus-key="room-drawer:0:light:light.demo_lantern:brightness"]',
    );
    if (slider === null) throw new Error('no slider');
    for (const value of ['50', '55', '60']) {
      slider.value = value;
      slider.dispatchEvent(new Event('change'));
    }
    expect(svc.gateway.calls).toHaveLength(0);
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS);
    expect(svc.gateway.invoked).toEqual([{ kind: 'light.set_brightness', entity: 'light.demo_lantern', pct: 60 }]);
  });

  it('offers no brightness slider for an on/off-only light', async () => {
    const drawer = await mountRoomDrawer(services(), 0);
    expect(
      deepQuery(drawer.shadowRoot!, 'input[data-focus-key="room-drawer:0:light:light.demo_steps:brightness"]'),
    ).toBeNull();
  });

  it('opens and closes curtains explicitly, and shows a garage-class cover read-only with the reason', async () => {
    const svc = services();
    const drawer = await mountRoomDrawer(svc, 1);
    nativeButton(drawer.shadowRoot!, 'room-drawer:1:curtain:cover.demo_blind:open').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'curtain.open', entity: 'cover.demo_blind' }]);
    expect(
      deepQuery(drawer.shadowRoot!, 'button[data-focus-key="room-drawer:1:curtain:cover.demo_roller:open"]'),
    ).toBeNull();
    expect(
      deepQuery(drawer.shadowRoot!, 'button[data-focus-key="room-drawer:1:curtain:cover.demo_roller:close"]'),
    ).toBeNull();
    expect(text(drawer.shadowRoot!)).toContain("Garage, gate and door covers can't be moved from this dashboard.");
  });

  it('applies a fan intent from the shared purifier controls as one request', async () => {
    const svc = services();
    const drawer = await mountRoomDrawer(svc, 1);
    const controls = deepQuery(drawer.shadowRoot!, 'agr-fan-controls');
    expect(controls).not.toBeNull();
    controls?.dispatchEvent(
      new CustomEvent('agr-fan-intent', {
        bubbles: true,
        composed: true,
        detail: { kind: 'power', entity: 'fan.demo_air', next: 'off' },
      }),
    );
    expect(svc.gateway.invoked).toEqual([{ kind: 'fan.turn_off', entity: 'fan.demo_air' }]);
  });

  it('says so honestly when the room index is no longer configured', async () => {
    const drawer = await mountRoomDrawer(services(), 9);
    expect(deepQuery(drawer.shadowRoot!, 'agr-empty-state')).not.toBeNull();
  });
});

describe('agr-home-drawer', () => {
  it('lists every room, vacuum and appliance and routes a quick toggle to one room action', async () => {
    const rooms = Array.from({ length: 7 }, (_unused, index) => ({
      name: `Room ${index}`,
      lights: [`light.demo_r${index}`],
    }));
    const svc = services({
      config: { rooms },
      store: fakeStore(rooms.map((_room, index) => testEntity(`light.demo_r${index}`, 'off'))),
    });
    const drawer = document.createElement('agr-home-drawer');
    drawer.services = svc;
    drawer.request = { id: 'home' };
    document.body.append(drawer);
    await settle();
    expect(deepQueryAll(drawer.shadowRoot!, 'agr-room-chip')).toHaveLength(7);
    nativeButton(drawer.shadowRoot!, 'home-drawer:room:6:toggle').click();
    expect(svc.gateway.invoked).toEqual([{ kind: 'room.lights_on', room: 6 }]);
  });
});
