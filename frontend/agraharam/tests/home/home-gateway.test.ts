/**
 * Home controls through the REAL action gateway (§12.1 rows 1, 3, 5, 7 and 11): one gesture is exactly one
 * correctly scoped ServicePort call, nothing is sent on mount, render or a disabled or repeated tap, garage-class
 * covers in a room stay read-only, scripts read "Requested", finish times follow the minute tick and room names are
 * escaped. home-components.test.ts covers the same elements against a FakeGateway; this file proves the calls.
 */
import { describe, expect, it, vi } from 'vitest';
import '../../src/components/home/agr-home.ts';
import '../../src/components/home/agr-home-drawer.ts';
import '../../src/components/home/agr-room-drawer.ts';
import type { AgrHome } from '../../src/components/home/agr-home.ts';
import type { AgrHomeDrawer } from '../../src/components/home/agr-home-drawer.ts';
import type { AgrRoomDrawer } from '../../src/components/home/agr-room-drawer.ts';
import type { OpenDrawerDetail } from '../../src/components/shell/overlay-types.ts';
import type { EntityId } from '../../src/config/schema.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS } from '../../src/ha/actions/types.ts';
import { COVER_FEATURE, VACUUM_FEATURE } from '../../src/ha/features.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { flush, homeWorld, mountWith, type HomeWorld, type StateSpec } from './home-harness.ts';

const IDS = Object.freeze({
  lantern: 'light.demo_den_lantern',
  sconce: 'light.demo_den_sconce',
  strip: 'light.demo_den_strip',
  lamp: 'light.demo_den_lamp',
  blind: 'cover.demo_den_blind',
  shutter: 'cover.demo_den_shutter',
  vacuum: 'vacuum.demo_pebble',
  washerStatus: 'sensor.demo_washer_status',
  washerFinish: 'sensor.demo_washer_finish',
  monitors: 'script.demo_studio_monitors',
});
const ROOM_NAME = 'Den';
const GARAGE_REASON = "Garage, gate and door covers can't be moved from this dashboard.";
const CONTROLS_OFF = 'Controls are turned off in the dashboard configuration.';
const COVER_BITS = COVER_FEATURE.OPEN | COVER_FEATURE.CLOSE;
const VACUUM_BITS = VACUUM_FEATURE.START | VACUUM_FEATURE.PAUSE | VACUUM_FEATURE.RETURN_HOME;
const FINISH_IN_MIN = 2;
const MS_PER_MINUTE = 60_000;
const PAST_FINISH_MS = (FINISH_IN_MIN + 1) * MS_PER_MINUTE;
const STATE_PUSHES = 20;

/** One room whose lights are on, unavailable, unknown and off, plus every other Home device kind. */
function input(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    rooms: [
      {
        name: ROOM_NAME,
        lights: [IDS.lantern, IDS.sconce, IDS.strip, IDS.lamp],
        curtains: [IDS.blind, IDS.shutter],
      },
    ],
    vacuums: [{ entity: IDS.vacuum, name: 'Pebble' }],
    appliances: [{ name: 'Washer', status_sensor: IDS.washerStatus, remaining_sensor: IDS.washerFinish }],
    studio_monitors_script: IDS.monitors,
    ...extra,
  };
}

function states(finishIso: string, overrides: Readonly<Record<string, StateSpec>> = {}): Record<string, StateSpec> {
  return {
    [IDS.lantern]: ['on', { friendly_name: 'Lantern', supported_color_modes: ['brightness'], brightness: 128 }],
    [IDS.sconce]: ['unavailable', { friendly_name: 'Sconce' }],
    [IDS.strip]: ['unknown', { friendly_name: 'Strip', supported_color_modes: ['onoff'] }],
    [IDS.lamp]: ['off', { friendly_name: 'Lamp', supported_color_modes: ['brightness'] }],
    [IDS.blind]: ['closed', { friendly_name: 'Den blind', device_class: 'blind', supported_features: COVER_BITS }],
    [IDS.shutter]: ['closed', { friendly_name: 'Den shutter', device_class: 'garage', supported_features: COVER_BITS }],
    [IDS.vacuum]: ['docked', { friendly_name: 'Pebble', supported_features: VACUUM_BITS }],
    [IDS.washerStatus]: ['Rinsing', { friendly_name: 'Washer status' }],
    [IDS.washerFinish]: [finishIso, { friendly_name: 'Washer finish', device_class: 'timestamp' }],
    [IDS.monitors]: ['off', { friendly_name: 'Studio monitors', last_triggered: '2026-09-29T10:00:00.000Z' }],
    ...overrides,
  };
}

function world(
  extra: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, StateSpec>> = {},
): HomeWorld {
  const finish = fixtureClock(Date.now()).at(FINISH_IN_MIN);
  return homeWorld({ input: input(extra), states: states(finish, overrides) });
}

/** A mounted element is queried from inside its own shadow root (the deep helpers walk descendants only). */
function inside(root: ParentNode): ParentNode {
  return root instanceof Element && root.shadowRoot !== null ? root.shadowRoot : root;
}

/** The native control carrying `focusKey`, wherever it is in the composed tree. */
function control(root: ParentNode, focusKey: string): HTMLElement {
  const found = deepQuery<HTMLElement>(inside(root), `[data-focus-key="${focusKey}"]`);
  if (found === null) throw new Error(`no control ${focusKey}`);
  return found;
}

/** Every rendered text node, joined, including visually hidden text (accessible names and reasons). */
function renderedText(root: ParentNode): string {
  return textOf(deepQueryAll(inside(root), '*'));
}

/** Only the text a sighted user sees: visually hidden names and aria-describedby reasons are left out. */
function visibleText(root: ParentNode): string {
  return textOf(deepQueryAll(inside(root), '*').filter((element) => element.closest('.visually-hidden') === null));
}

function textOf(elements: readonly Element[]): string {
  return elements
    .flatMap((element) => [...element.childNodes])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The section's single polite live region (§7.2). */
function liveRegion(root: ParentNode): string {
  const regions = deepQueryAll(inside(root), 'agr-control-notes').flatMap((notes) =>
    deepQueryAll(notes.shadowRoot ?? notes, '[role="status"]'),
  );
  expect(regions).toHaveLength(1);
  return (regions[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function find(root: ParentNode, selector: string): Element | null {
  return deepQuery(inside(root), selector);
}

function findAll<E extends Element = Element>(root: ParentNode, selector: string): E[] {
  return deepQueryAll<E>(inside(root), selector);
}

describe('Home through the real gateway: nothing is sent unless a user acts', () => {
  it('mounting the panel and both drawers, then 20 state pushes and minute ticks, sends nothing', async () => {
    const w = world();
    await mountWith<AgrHome>('agr-home', w);
    await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: 0 } });
    await mountWith<AgrHomeDrawer>('agr-home-drawer', w, { request: { id: 'home' } });
    for (let push = 0; push < STATE_PUSHES; push += 1) {
      w.set(IDS.lantern, push % 2 === 0 ? 'off' : 'on', { supported_color_modes: ['brightness'], brightness: 90 });
      w.tick();
      await settle();
    }
    expect(w.port.calls).toEqual([]);
  });
});

describe('room quick toggle (§7.1 room.lights_off)', () => {
  it('one tap is ONE light.turn_off scoped to the available lights; a second tap while pending sends nothing', async () => {
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);

    control(home, 'room:0:toggle').click();
    await flush();
    expect(w.port.calls).toEqual([
      // The unavailable sconce and the unknown strip are left out of the target (§7.1 "Unknown state").
      { domain: 'light', service: 'turn_off', data: {}, target: { entity_id: [IDS.lantern, IDS.lamp] } },
    ]);

    control(home, 'room:0:toggle').click();
    await flush();
    expect(w.port.calls).toHaveLength(1);
  });

  it('an aria-disabled quick toggle (controls off) sends nothing, and one panel notice explains why', async () => {
    const w = world({ controls: false });
    const home = await mountWith<AgrHome>('agr-home', w);
    const quick = control(home, 'room:0:toggle');
    expect(quick.getAttribute('aria-disabled')).toBe('true');
    quick.click();
    control(home, 'home:studio-monitors').click();
    control(home, `vacuum:${IDS.vacuum}:start`).click();
    await flush();
    expect(w.port.calls).toEqual([]);
    // One visible panel notice replaces the per-control lines (§16.10); each control keeps it as a hidden reason.
    expect(visibleText(home).split(CONTROLS_OFF)).toHaveLength(2);
    expect(renderedText(home).split(CONTROLS_OFF).length).toBeGreaterThan(2);
  });

  it('a held Enter (key repeat) is suppressed on the quick toggle and on the studio monitors button', async () => {
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);
    for (const key of ['room:0:toggle', 'home:studio-monitors']) {
      const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
      control(home, key).dispatchEvent(repeat);
      expect(repeat.defaultPrevented, key).toBe(true);
    }
    expect(w.port.calls).toEqual([]);
  });
});

describe('room drawer', () => {
  it('a garage-class cover listed as a curtain is read-only with its reason, and nothing can move it', async () => {
    const w = world();
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: 0 } });
    const shutter = findAll<HTMLElement>(drawer, 'agr-curtain-row').find((row) =>
      renderedText(row.shadowRoot as ShadowRoot).includes('Den shutter'),
    );
    const shutterRoot = shutter?.shadowRoot;
    if (shutterRoot === null || shutterRoot === undefined) throw new Error('no shutter row');
    expect(visibleText(shutterRoot)).toContain(GARAGE_REASON);
    const describedBy = shutterRoot.querySelector('[role="group"]')?.getAttribute('aria-describedby') ?? '';
    expect(shutterRoot.getElementById(describedBy)?.textContent).toBe(GARAGE_REASON);
    const buttons = findAll<HTMLButtonElement>(shutterRoot, 'button');
    expect(buttons.filter((button) => button.getAttribute('aria-disabled') !== 'true')).toEqual([]);
    for (const button of buttons) button.click();
    await flush();
    expect(w.port.calls).toEqual([]);
    expect(w.gateway.evaluate({ kind: 'curtain.open', entity: IDS.shutter as EntityId })).toMatchObject({
      enabled: false,
      reason: 'not-allowed',
    });

    // The ordinary blind beside it still opens with one explicit call.
    control(drawer, `room-drawer:0:curtain:${IDS.blind}:open`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'cover', service: 'open_cover', data: {}, target: { entity_id: IDS.blind } },
    ]);
  });

  it('brightness gestures coalesce into ONE light.turn_on after the debounce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: 0 } });
    const slider = control(drawer, `room-drawer:0:light:${IDS.lamp}:brightness`) as HTMLInputElement;
    for (const value of ['30', '45', '62']) {
      slider.value = value;
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
    }
    expect(w.port.calls).toEqual([]);
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS);
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'light', service: 'turn_on', data: { brightness_pct: 62 }, target: { entity_id: IDS.lamp } },
    ]);
  });
});

describe('vacuums', () => {
  it('with an unknown state, start and pause are disabled with their reason and only return to dock sends', async () => {
    const w = world({}, { [IDS.vacuum]: ['unknown', { friendly_name: 'Pebble', supported_features: VACUUM_BITS }] });
    const home = await mountWith<AgrHome>('agr-home', w);
    for (const command of ['start', 'pause']) {
      const button = control(home, `vacuum:${IDS.vacuum}:${command}`);
      expect(button.getAttribute('aria-disabled'), command).toBe('true');
      button.click();
    }
    expect(renderedText(home)).toContain("Pebble hasn't reported its state");
    await flush();
    expect(w.port.calls).toEqual([]);

    control(home, `vacuum:${IDS.vacuum}:return`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'vacuum', service: 'return_to_base', data: {}, target: { entity_id: IDS.vacuum } },
    ]);
  });
});

describe('studio monitors (§7.1 studio_monitors.run)', () => {
  it('one tap is one script.turn_on on the configured script, confirmed as "Requested", never "Done"', async () => {
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);
    expect(renderedText(home)).toContain('Switches both monitors together.');
    // An action button, not a state toggle: the script reports no state (§8.4).
    expect(renderedText(home)).toContain('Switch monitors');
    expect(control(home, 'home:studio-monitors').hasAttribute('aria-pressed')).toBe(false);
    control(home, 'home:studio-monitors').click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: IDS.monitors } },
    ]);

    w.port.resolveNext('demo-monitors-call');
    w.set(IDS.monitors, 'on', { friendly_name: 'Studio monitors', last_triggered: '2026-09-30T17:22:00.000Z' });
    await flush();
    const row = find(home, '.studio');
    if (row === null) throw new Error('no studio monitors row');
    expect(visibleText(row)).toContain('Requested');
    expect(renderedText(row)).not.toMatch(/\bDone\b|\b(?:On|Off)\b/);
    expect(liveRegion(home)).toBe('Studio monitors Requested');
    expect(w.port.calls).toHaveLength(1);
  });
});

describe('appliances and the minute tick', () => {
  it('"Done …" disappears once the finish time passes, on a clock tick with no entity change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);
    expect(renderedText(home)).toMatch(/Done \d/);
    vi.setSystemTime(Date.now() + PAST_FINISH_MS);
    w.tick();
    await settle();
    expect(renderedText(home)).not.toMatch(/Done \d/);
    expect(w.port.calls).toEqual([]);
  });
});

describe('budget overflow (§6.2.1)', () => {
  it('"All rooms and devices" appears only when rooms overflow, and opens the home drawer', async () => {
    const fits = await mountWith<AgrHome>('agr-home', world());
    expect(find(fits, '[data-focus-key="home:all"]')).toBeNull();
    fits.remove();

    // Seven rooms against a budget of six; the extra rooms' lights are simply missing.
    const extraRooms = Array.from({ length: 6 }, (_unused, index) => ({
      name: `Annex ${index + 1}`,
      lights: [`light.demo_annex_${index + 1}`],
    }));
    const w = world({ rooms: [...(input().rooms as unknown[]), ...extraRooms] });
    const home = await mountWith<AgrHome>('agr-home', w);
    expect(findAll(home, 'agr-room-chip')).toHaveLength(6);
    const opened: OpenDrawerDetail[] = [];
    document.body.addEventListener('agr-open-drawer', (event) => {
      opened.push((event as CustomEvent<OpenDrawerDetail>).detail);
    });
    control(home, 'home:all').click();
    expect(opened.map((detail) => detail.request)).toEqual([{ id: 'home' }]);
    expect(w.port.calls).toEqual([]);
  });
});

describe('escaping (§12.1 row 11)', () => {
  it('renders a room name with markup as literal text', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>Den';
    const home = await mountWith<AgrHome>('agr-home', world({ rooms: [{ name: payload, lights: [IDS.lantern] }] }));
    expect(renderedText(home)).toContain(payload);
    expect(find(home, 'img')).toBeNull();
    expect(find(home, 'script')).toBeNull();
  });
});
