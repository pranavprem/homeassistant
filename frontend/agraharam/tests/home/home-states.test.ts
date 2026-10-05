/**
 * Rooms never claim a state that is not known (ACCEPTANCE item 3, §4.6, §16.10): lights still loading while HA
 * starts read "Loading", never "Off"; a light the post-reconnect snapshot did not replace is not counted as on; and
 * a garage-class cover stays read-only whatever its status.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { GARAGE_LIKE_COVER_COPY } from '../../src/ha/actions/messages.ts';
import { selectHome, selectRoom } from '../../src/model/home.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const NOW = new Date('2026-09-30T17:51:00-07:00');
const LANTERN = 'light.demo_den_lantern';
const LAMP = 'light.demo_den_lamp';
const STEPS = 'light.demo_den_steps';
const SHUTTER = 'cover.demo_den_shutter';
const CONFIG = { rooms: [{ name: 'Den', lights: [LANTERN, LAMP], curtains: [SHUTTER] }] };

function input(
  states: readonly HassEntityLike[],
  store: FakeStoreOptions = {},
  config: Record<string, unknown> = CONFIG,
): SelectorInput {
  const resolved: ResolvedConfig = configFrom(config);
  const view = fakeStore(states, store);
  return { config: resolved, store: view, reader: fakeReader(view), gateway: new FakeGateway(), now: NOW };
}

const light = (id: string, state: string): HassEntityLike =>
  testEntity(id, state, { supported_color_modes: ['onoff'] });

describe('rooms while Home Assistant is starting', () => {
  it('reads "Loading" in a muted tone when no bound light has arrived yet', () => {
    const room = selectRoom(input([], { haState: 'STARTING' }), 0);
    expect(room?.lights.map((item) => item.status)).toEqual(['loading', 'loading']);
    expect(room).toMatchObject({ summary: 'Loading', tone: 'muted', lightsOn: 0 });
  });

  it('never reads plain "Off" while some lights are still loading', () => {
    const room = selectRoom(input([light(LANTERN, 'off')], { haState: 'STARTING' }), 0);
    expect(room).toMatchObject({ summary: 'Off, 1 loading', tone: 'muted' });
  });

  it('counts the lights that are known to be on next to the ones still loading', () => {
    const config = { rooms: [{ name: 'Den', lights: [LANTERN, LAMP, STEPS] }] };
    const room = selectRoom(input([light(LANTERN, 'on'), light(LAMP, 'off')], { haState: 'STARTING' }, config), 0);
    expect(room).toMatchObject({ summary: '1 on, 1 loading', lightsOn: 1 });
  });
});

describe('rooms after a resync barrier clears', () => {
  it('does not count a light the snapshot did not replace as on, nor show the room lit', () => {
    const vm = selectHome(input([light(LANTERN, 'on'), light(LAMP, 'off')], { notFresh: [LANTERN] }));
    const room = vm.rooms[0];
    expect(room?.lights[0]).toMatchObject({ status: 'disconnected', on: null, brightnessPct: null });
    expect(room).toMatchObject({ lightsOn: 0, summary: 'Off, 1 not reporting', tone: 'attention' });
    expect(vm.lightsOn).toBe(0);
  });

  it('reads "Not reporting" when no light in the room was refreshed', () => {
    const room = selectRoom(input([light(LANTERN, 'on'), light(LAMP, 'on')], { notFresh: [LANTERN, LAMP] }), 0);
    expect(room).toMatchObject({ summary: 'Not reporting', tone: 'muted', lightsOn: 0 });
  });

  it('still counts the fresh lights that are on', () => {
    const vm = selectHome(input([light(LANTERN, 'on'), light(LAMP, 'on')], { notFresh: [LAMP] }));
    expect(vm.rooms[0]?.lightsOn).toBe(1);
    expect(vm.lightsOn).toBe(1);
  });

  it('keeps last known values while the whole connection is down (stale, not "not reporting")', () => {
    const vm = selectHome(input([light(LANTERN, 'on'), light(LAMP, 'off')], { connected: false }));
    expect(vm.rooms[0]).toMatchObject({ freshness: 'stale', lightsOn: 1, summary: '1 of 2 on', tone: 'muted' });
    expect(vm.lightsOn).toBeNull();
  });
});

describe('garage-class covers in a room', () => {
  it.each(['unavailable', 'unknown', 'closed'])('stay read-only with the reason while the cover is %s', (state) => {
    const cover = testEntity(SHUTTER, state, { device_class: 'garage' });
    const curtain = selectRoom(input([light(LANTERN, 'off'), light(LAMP, 'off'), cover]), 0)?.curtains[0];
    expect(curtain).toMatchObject({ readOnly: true, reason: GARAGE_LIKE_COVER_COPY.elsewhere });
    expect(curtain?.open).toMatchObject({ enabled: false, reason: 'not-allowed' });
    expect(curtain?.close).toMatchObject({ enabled: false, reason: 'not-allowed' });
  });

  it('stays read-only with the last known device class while disconnected', () => {
    const cover = testEntity(SHUTTER, 'closed', { device_class: 'gate' });
    const curtain = selectRoom(input([cover], { connected: false }), 0)?.curtains[0];
    expect(curtain?.readOnly).toBe(true);
  });
});
