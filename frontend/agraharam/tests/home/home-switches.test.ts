/**
 * Room lighting switches and the Whole-house shortcuts in Home (§18, design §6.1, §6.2, §9.1, §9.2), through the REAL
 * gateway: selectors take every Availability from gateway.evaluate(), so the reason a control shows is the gateway's
 * own; one gesture is one ticket with one call per domain; a settings switch is read-only and never counted; until
 * Home Assistant delivers its entity registry, switch controls and rooms with switches wait with a visible notice,
 * which appears only when it is the effective reason (review N1). Shortcuts always go through the confirm dialog.
 * Every ID is fictional (`*.demo_*`).
 */
import { describe, expect, it } from 'vitest';
import '../../src/components/home/agr-home.ts';
import '../../src/components/home/agr-room-drawer.ts';
import '../../src/components/home/agr-switch-row.ts';
import type { AgrHome } from '../../src/components/home/agr-home.ts';
import type { AgrRoomDrawer } from '../../src/components/home/agr-room-drawer.ts';
import type { ConfirmDetail } from '../../src/components/shell/overlay-types.ts';
import { REGISTRY_PENDING_COPY, SETTINGS_SWITCH_COPY } from '../../src/ha/actions/messages.ts';
import type { RegistryEntryLike } from '../../src/ha/types.ts';
import { selectHome, selectRoom } from '../../src/model/home.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { flush, homeWorld, mountWith, type HomeWorld, type StateSpec } from './home-harness.ts';

const IDS = Object.freeze({
  ceiling: 'light.demo_study_ceiling',
  desk: 'switch.demo_study_desk_lamp',
  floor: 'switch.demo_study_floor_lamp',
  childLock: 'switch.demo_study_plug_child_lock',
  lounge: 'light.demo_lounge_lamp',
  loftPlug: 'switch.demo_loft_string_lights',
  lightsToggle: 'script.demo_house_lights_toggle',
  curtainsToggle: 'script.demo_house_curtains_toggle',
});
const STUDY = 0;
const LOUNGE = 1;
const LOFT = 2;
const SCRIPT_IDLE: StateSpec = ['off', { last_triggered: '2026-09-29T10:00:00.000Z' }];
const CHILD_LOCK_ENTRY: RegistryEntryLike = { entity_id: IDS.childLock, entity_category: 'config' };

function input(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    rooms: [
      { name: 'Study', lights: [IDS.ceiling], switches: [IDS.desk, IDS.floor, IDS.childLock] },
      { name: 'Lounge', lights: [IDS.lounge] },
      { name: 'Loft', switches: [IDS.loftPlug] },
    ],
    shortcuts: { lights_toggle: IDS.lightsToggle, curtains_toggle: IDS.curtainsToggle },
    ...extra,
  };
}

function states(overrides: Readonly<Record<string, StateSpec>> = {}): Record<string, StateSpec> {
  return {
    [IDS.ceiling]: ['off', { friendly_name: 'Ceiling', supported_color_modes: ['onoff'] }],
    [IDS.desk]: ['on', { friendly_name: 'Desk lamp' }],
    [IDS.floor]: ['off', { friendly_name: 'Floor lamp' }],
    [IDS.childLock]: ['off', { friendly_name: 'Plug child lock' }],
    [IDS.lounge]: ['off', { friendly_name: 'Lounge lamp', supported_color_modes: ['onoff'] }],
    [IDS.loftPlug]: ['off', { friendly_name: 'String lights' }],
    [IDS.lightsToggle]: SCRIPT_IDLE,
    [IDS.curtainsToggle]: SCRIPT_IDLE,
    ...overrides,
  };
}

interface WorldOptions {
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly overrides?: Readonly<Record<string, StateSpec>>;
  readonly registryPending?: boolean;
  readonly preview?: boolean;
}

function world(options: WorldOptions = {}): HomeWorld {
  return homeWorld({
    input: input(options.extra),
    states: states(options.overrides),
    registry: [CHILD_LOCK_ENTRY],
    ...(options.registryPending === true && { registryPending: true }),
    ...(options.preview === true && { preview: true }),
  });
}

function selectorInput(w: HomeWorld): SelectorInput {
  return { config: w.config, store: w.store, reader: w.services.reader, gateway: w.gateway, now: new Date() };
}

function room(w: HomeWorld, index: number) {
  const vm = selectRoom(selectorInput(w), index);
  if (vm === undefined) throw new Error(`no room ${index}`);
  return vm;
}

function switchVm(w: HomeWorld, index: number, id: string) {
  const found = room(w, index).switches.find((item) => item.key === id);
  if (found === undefined) throw new Error(`no switch ${id}`);
  return found;
}

/** A mounted element's own shadow root, for deep queries. */
function inside(element: Element): ParentNode {
  return element.shadowRoot ?? element;
}

function control(root: Element, focusKey: string): HTMLElement {
  const found = deepQuery<HTMLElement>(inside(root), `[data-focus-key="${focusKey}"]`);
  if (found === null) throw new Error(`no control ${focusKey}`);
  return found;
}

/** Text a sighted user sees: visually hidden names and reasons are left out. */
function visibleText(root: Element): string {
  return deepQueryAll(inside(root), '*')
    .filter((element) => element.closest('.visually-hidden') === null)
    .flatMap((element) => [...element.childNodes])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('rooms selector with lighting switches (§6.1)', () => {
  it('counts lights and lamp switches together, never the settings switch, and turns the room off when any is on', () => {
    const w = world();
    const study = room(w, STUDY);
    expect(study.switches.map((item) => item.key)).toEqual([IDS.desk, IDS.floor, IDS.childLock]);
    expect(study.lightsTotal).toBe(3);
    expect(study.lightsOn).toBe(1);
    expect(study.quickToggle?.next).toBe('off');
    expect(study.quickToggle?.availability).toEqual(w.gateway.evaluate({ kind: 'room.lights_off', room: STUDY }));
    expect(study.allOn).toEqual(w.gateway.evaluate({ kind: 'room.lights_on', room: STUDY }));
    expect(study.allOff).toEqual({ enabled: true, confirm: false });
  });

  it('a switch-only room has lighting items and room actions; a light-only room is unchanged', () => {
    const w = world();
    const loft = room(w, LOFT);
    expect(loft.lights).toEqual([]);
    expect(loft.lightsTotal).toBe(1);
    expect(loft.quickToggle).toEqual({ next: 'on', availability: { enabled: true, confirm: false } });
    const lounge = room(w, LOUNGE);
    expect(lounge.switches).toEqual([]);
    expect(lounge.lightsTotal).toBe(1);
    expect(lounge.registryNotice).toBeUndefined();
  });

  it('builds each switch from its friendly name, state and the gateway toggle; a settings switch is read-only', () => {
    const w = world();
    expect(switchVm(w, STUDY, IDS.desk)).toMatchObject({
      name: 'Desk lamp',
      on: true,
      readOnly: false,
      toggle: w.gateway.evaluate({ kind: 'switch.turn_off', entity: IDS.desk as never }),
    });
    expect(switchVm(w, STUDY, IDS.floor)).toMatchObject({ on: false, toggle: { enabled: true, confirm: false } });
    expect(switchVm(w, STUDY, IDS.childLock)).toMatchObject({
      readOnly: true,
      reason: SETTINGS_SWITCH_COPY,
      toggle: { enabled: false, reason: 'not-allowed', message: SETTINGS_SWITCH_COPY },
    });
  });

  it('a settings switch stays read-only with its reason even with controls off', () => {
    const w = world({ extra: { controls: false } });
    expect(switchVm(w, STUDY, IDS.childLock)).toMatchObject({ readOnly: true, reason: SETTINGS_SWITCH_COPY });
    expect(switchVm(w, STUDY, IDS.desk).toggle).toMatchObject({ enabled: false, reason: 'controls-off' });
  });

  it('offers explicit On and Off for a switch in an unknown state; a missing switch falls back to "Switch <n>"', () => {
    const w = world({ overrides: { [IDS.floor]: ['unknown', { friendly_name: 'Floor lamp' }] } });
    expect(switchVm(w, STUDY, IDS.floor).explicit).toEqual({
      on: w.gateway.evaluate({ kind: 'switch.turn_on', entity: IDS.floor as never }),
      off: w.gateway.evaluate({ kind: 'switch.turn_off', entity: IDS.floor as never }),
    });
    const missing = homeWorld({
      input: { rooms: [{ name: 'Loft', switches: [IDS.loftPlug, IDS.floor] }] },
      states: { [IDS.loftPlug]: ['off', {}] },
    });
    expect(switchVm(missing, 0, IDS.floor)).toMatchObject({ name: 'Switch 2', status: 'missing-binding', on: null });
  });

  it('"All lights are already on" covers the switches: every lighting item on disables All on', () => {
    const w = world({
      overrides: {
        [IDS.ceiling]: ['on', { friendly_name: 'Ceiling', supported_color_modes: ['onoff'] }],
        [IDS.floor]: ['on', { friendly_name: 'Floor lamp' }],
      },
    });
    const study = room(w, STUDY);
    expect(study.lightsOn).toBe(3);
    expect(study.allOn).toMatchObject({ enabled: false, reason: 'not-applicable' });
  });
});

describe('registry pending (§18 B1): selectors give the gateway’s reason', () => {
  it('switch toggles and the room actions wait with the registry copy; light toggles and light-only rooms do not', () => {
    const w = world({ registryPending: true });
    const study = room(w, STUDY);
    const desk = switchVm(w, STUDY, IDS.desk);
    expect(desk.toggle).toEqual({
      enabled: false,
      reason: 'state-unknown',
      message: REGISTRY_PENDING_COPY.control('Desk lamp'),
    });
    expect(desk.toggle).toEqual(w.gateway.evaluate({ kind: 'switch.turn_off', entity: IDS.desk as never }));
    expect(study.allOn).toEqual({
      enabled: false,
      reason: 'state-unknown',
      message: REGISTRY_PENDING_COPY.control('the Study lights'),
    });
    expect(study.quickToggle?.availability).toMatchObject({ enabled: false, reason: 'state-unknown' });
    expect(study.registryNotice).toBe(REGISTRY_PENDING_COPY.notice);
    expect(study.lights[0]?.toggle).toEqual({ enabled: true, confirm: false });
    expect(room(w, LOUNGE).quickToggle?.availability).toEqual({ enabled: true, confirm: false });
    expect(room(w, LOUNGE).registryNotice).toBeUndefined();
  });

  it('counts every switch provisionally while the category is unknown, and none is read-only yet', () => {
    const w = world({ registryPending: true });
    expect(room(w, STUDY).lightsTotal).toBe(4);
    expect(switchVm(w, STUDY, IDS.childLock)).toMatchObject({
      readOnly: false,
      toggle: { enabled: false, reason: 'state-unknown' },
    });
  });

  it('when the registry arrives: the notice goes, toggles enable, and the settings switch turns read-only', () => {
    const w = world({ registryPending: true });
    w.deliverRegistry();
    const study = room(w, STUDY);
    expect(study.registryNotice).toBeUndefined();
    expect(study.lightsTotal).toBe(3);
    expect(switchVm(w, STUDY, IDS.desk).toggle).toEqual({ enabled: true, confirm: false });
    expect(switchVm(w, STUDY, IDS.childLock).readOnly).toBe(true);
  });

  it('Home carries one notice while any room with switches waits, and none without switches', () => {
    expect(selectHome(selectorInput(world({ registryPending: true }))).registryNotice).toBe(
      REGISTRY_PENDING_COPY.notice,
    );
    expect(selectHome(selectorInput(world())).registryNotice).toBeUndefined();
    const lightsOnly = homeWorld({
      input: { rooms: [{ name: 'Lounge', lights: [IDS.lounge] }] },
      states: { [IDS.lounge]: ['off', {}] },
      registryPending: true,
    });
    expect(selectHome(selectorInput(lightsOnly)).registryNotice).toBeUndefined();
  });

  it('N1: no registry notice when another reason is in effect (controls off, preview, disconnected)', () => {
    const off = world({ registryPending: true, extra: { controls: false } });
    expect(room(off, STUDY).registryNotice).toBeUndefined();
    expect(selectHome(selectorInput(off)).registryNotice).toBeUndefined();
    const preview = world({ registryPending: true, preview: true });
    expect(selectHome(selectorInput(preview)).registryNotice).toBeUndefined();
    const offline = world({ registryPending: true });
    offline.setConnected(false);
    expect(room(offline, STUDY).registryNotice).toBeUndefined();
    expect(selectHome(selectorInput(offline)).registryNotice).toBeUndefined();
  });
});

describe('roomRegistryNotice: only when waiting for the registry is the effective reason (review N1)', () => {
  type Case = {
    readonly label: string;
    readonly registryPending: boolean;
    readonly controls: boolean;
    readonly preview?: boolean;
    readonly disconnected?: boolean;
    readonly notice: boolean;
  };
  const CASES: readonly Case[] = [
    { label: 'pending, controls on', registryPending: true, controls: true, notice: true },
    { label: 'pending, controls off', registryPending: true, controls: false, notice: false },
    { label: 'pending, preview', registryPending: true, controls: true, preview: true, notice: false },
    { label: 'pending, disconnected', registryPending: true, controls: true, disconnected: true, notice: false },
    {
      label: 'pending, controls off and preview',
      registryPending: true,
      controls: false,
      preview: true,
      notice: false,
    },
    { label: 'loaded, controls on', registryPending: false, controls: true, notice: false },
    { label: 'loaded, controls off', registryPending: false, controls: false, notice: false },
    { label: 'loaded, preview', registryPending: false, controls: true, preview: true, notice: false },
    { label: 'loaded, disconnected', registryPending: false, controls: true, disconnected: true, notice: false },
  ];

  it.each(CASES.map((item) => [item.label, item] as const))('%s', (_label, item) => {
    const w = world({
      registryPending: item.registryPending,
      extra: { controls: item.controls },
      ...(item.preview === true && { preview: true }),
    });
    if (item.disconnected === true) w.setConnected(false);
    const expected = item.notice ? REGISTRY_PENDING_COPY.notice : undefined;
    expect(room(w, STUDY).registryNotice).toBe(expected);
    expect(room(w, LOFT).registryNotice).toBe(expected);
    expect(selectHome(selectorInput(w)).registryNotice).toBe(expected);
    // A light-only room never carries it.
    expect(room(w, LOUNGE).registryNotice).toBeUndefined();
  });

  it('a room whose lighting items are all unavailable still shows the notice while pending (the refusal comes first)', () => {
    const w = world({
      registryPending: true,
      overrides: {
        [IDS.ceiling]: ['unavailable', {}],
        [IDS.desk]: ['unavailable', {}],
        [IDS.floor]: ['unavailable', {}],
        [IDS.childLock]: ['unavailable', {}],
      },
    });
    expect(room(w, STUDY).registryNotice).toBe(REGISTRY_PENDING_COPY.notice);
  });
});

describe('Whole-house shortcuts in the Home overview (§6.2)', () => {
  it('lists the configured roles in order, with fixed labels and an availability that always confirms', () => {
    const w = world();
    expect(selectHome(selectorInput(w)).shortcuts?.buttons).toEqual([
      {
        role: 'lights_toggle',
        label: 'Lights',
        accessibleLabel: 'Whole-house lights',
        availability: { enabled: true, confirm: true },
      },
      {
        role: 'curtains_toggle',
        label: 'Curtains',
        accessibleLabel: 'Whole-house curtains',
        availability: { enabled: true, confirm: true },
      },
    ]);
  });

  it('lists only configured roles, is absent without shortcuts, and makes Home configured on its own', () => {
    const one = homeWorld({
      input: { shortcuts: { curtains_toggle: IDS.curtainsToggle } },
      states: { [IDS.curtainsToggle]: SCRIPT_IDLE },
    });
    const vm = selectHome(selectorInput(one));
    expect(vm.shortcuts?.buttons.map((button) => button.role)).toEqual(['curtains_toggle']);
    expect(vm.configured).toBe(true);
    const none = homeWorld({ input: { rooms: [{ name: 'Lounge', lights: [IDS.lounge] }] }, states: {} });
    expect(selectHome(selectorInput(none)).shortcuts).toBeUndefined();
  });
});

describe('agr-room-drawer with switches (§9.2)', () => {
  it('renders switch rows; a toggle is ONE switch call; a settings switch shows its reason and sends nothing', async () => {
    const w = world();
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: STUDY } });
    expect(deepQueryAll(inside(drawer), 'agr-switch-row')).toHaveLength(3);
    control(drawer, `room-drawer:${STUDY}:switch:${IDS.desk}:toggle`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'switch', service: 'turn_off', data: {}, target: { entity_id: IDS.desk } },
    ]);
    const lock = control(drawer, `room-drawer:${STUDY}:switch:${IDS.childLock}:toggle`);
    expect(lock.getAttribute('aria-disabled')).toBe('true');
    lock.click();
    await flush();
    expect(w.port.calls).toHaveLength(1);
    expect(visibleText(drawer)).toContain(SETTINGS_SWITCH_COPY);
  });

  it('All on sends the light call then the switch call, for the lamp switches only', async () => {
    const w = world({ overrides: { [IDS.desk]: ['off', { friendly_name: 'Desk lamp' }] } });
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: STUDY } });
    control(drawer, `room-drawer:${STUDY}:all-on`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: [IDS.ceiling] } },
      { domain: 'switch', service: 'turn_on', data: {}, target: { entity_id: [IDS.desk, IDS.floor] } },
    ]);
  });

  it('explicit On and Off for an unknown switch each send one call', async () => {
    const w = world({ overrides: { [IDS.floor]: ['unknown', { friendly_name: 'Floor lamp' }] } });
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: STUDY } });
    control(drawer, `room-drawer:${STUDY}:switch:${IDS.floor}:on`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'switch', service: 'turn_on', data: {}, target: { entity_id: IDS.floor } },
    ]);
  });

  it('registry pending: a visible notice, switch rows disabled with their reason, lights still usable, 0 switch calls', async () => {
    const w = world({ registryPending: true });
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: STUDY } });
    expect(visibleText(drawer)).toContain(REGISTRY_PENDING_COPY.notice);
    expect(visibleText(drawer)).toContain(REGISTRY_PENDING_COPY.control('Desk lamp'));
    for (const id of [IDS.desk, IDS.floor, IDS.childLock]) {
      const toggle = control(drawer, `room-drawer:${STUDY}:switch:${id}:toggle`);
      expect(toggle.getAttribute('aria-disabled'), id).toBe('true');
      toggle.click();
    }
    control(drawer, `room-drawer:${STUDY}:all-off`).click();
    await flush();
    expect(w.port.calls).toEqual([]);
    control(drawer, `room-drawer:${STUDY}:light:${IDS.ceiling}:toggle`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: IDS.ceiling } },
    ]);

    w.deliverRegistry();
    await settle();
    expect(visibleText(drawer)).not.toContain(REGISTRY_PENDING_COPY.notice);
    expect(control(drawer, `room-drawer:${STUDY}:switch:${IDS.desk}:toggle`).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
    expect(visibleText(drawer)).toContain(SETTINGS_SWITCH_COPY);
  });

  it('escapes switch names', async () => {
    const payload = '<img src=x onerror=alert(1)>Desk';
    const w = world({ overrides: { [IDS.desk]: ['on', { friendly_name: payload }] } });
    const drawer = await mountWith<AgrRoomDrawer>('agr-room-drawer', w, { request: { id: 'room', room: STUDY } });
    expect(visibleText(drawer)).toContain(payload);
    expect(deepQuery(inside(drawer), 'img')).toBeNull();
  });
});

describe('agr-home: the Whole-house row and the registry notice (§9.1)', () => {
  it('renders one group with Lights and Curtains, accessible names containing the visible text, and dialog popups', async () => {
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);
    const group = deepQuery(inside(home), '[role="group"][aria-label="Whole house shortcuts"]');
    expect(group).not.toBeNull();
    for (const [role, visible, name] of [
      ['lights_toggle', 'Lights', 'Whole-house lights'],
      ['curtains_toggle', 'Curtains', 'Whole-house curtains'],
    ] as const) {
      const button = control(home, `home:shortcut:${role}`);
      expect(button.getAttribute('aria-label'), role).toBe(name);
      expect(button.textContent?.replace(/\s+/g, ' ').trim(), role).toContain(visible);
      expect(name.toLowerCase()).toContain(visible.toLowerCase());
      expect(button.getAttribute('aria-haspopup'), role).toBe('dialog');
    }
    expect(visibleText(home)).toContain('Whole house');
  });

  it('a tap asks for confirmation (agr-request-confirm) and never sends a call by itself', async () => {
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);
    const asked: ConfirmDetail[] = [];
    document.body.addEventListener('agr-request-confirm', (event) => asked.push(event.detail));
    control(home, 'home:shortcut:lights_toggle').click();
    control(home, 'home:shortcut:curtains_toggle').click();
    await flush();
    expect(asked.map((detail) => detail.action)).toEqual([
      { kind: 'shortcut.run', role: 'lights_toggle' },
      { kind: 'shortcut.run', role: 'curtains_toggle' },
    ]);
    expect(w.port.calls).toEqual([]);
  });

  it('a mixed room quick toggle is one ticket with one call per domain', async () => {
    const w = world();
    const home = await mountWith<AgrHome>('agr-home', w);
    control(home, `room:${STUDY}:toggle`).click();
    await flush();
    expect(w.port.calls).toEqual([
      { domain: 'light', service: 'turn_off', data: {}, target: { entity_id: [IDS.ceiling] } },
      { domain: 'switch', service: 'turn_off', data: {}, target: { entity_id: [IDS.desk, IDS.floor] } },
    ]);
    control(home, `room:${STUDY}:toggle`).click();
    await flush();
    expect(w.port.calls).toHaveLength(2);
  });

  it('shows the registry notice visibly while waiting, and never with controls off (N1, no layout shift on load)', async () => {
    const waiting = await mountWith<AgrHome>('agr-home', world({ registryPending: true }));
    expect(visibleText(waiting)).toContain(REGISTRY_PENDING_COPY.notice);
    waiting.remove();
    const off = await mountWith<AgrHome>('agr-home', world({ registryPending: true, extra: { controls: false } }));
    expect(visibleText(off)).not.toContain(REGISTRY_PENDING_COPY.notice);
    expect(visibleText(off).split('Controls are turned off in the dashboard configuration.')).toHaveLength(2);
    off.remove();
    const loaded = await mountWith<AgrHome>('agr-home', world());
    expect(visibleText(loaded)).not.toContain(REGISTRY_PENDING_COPY.notice);
  });
});
