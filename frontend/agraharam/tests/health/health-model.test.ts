import { describe, expect, it } from 'vitest';
import { healthEntityIds, selectHealth, selectHealthDetails } from '../../src/model/health.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom } from '../helpers/services.ts';
import { testInput } from '../header/support.ts';

const WEATHER = 'weather.demo_home';
const CLIMATE = 'climate.demo_bedroom';
const LIGHT = 'light.demo_courtyard';
const GARAGE = 'cover.demo_garage';
const CAMERA = 'camera.demo_front_gate';
const PRIVACY = 'switch.demo_front_gate_privacy';
const ALARM = 'alarm_control_panel.demo_home';
const FRONT = 'binary_sensor.demo_front_door';
const BACK = 'binary_sensor.demo_back_door';
const PERSON = 'person.demo_meera';
const SUN = 'sun.sun';

const config = configFrom({
  people: [PERSON],
  sun: SUN,
  weather: WEATHER,
  climate: [{ entity: CLIMATE, name: 'Bedroom' }],
  rooms: [{ name: 'Courtyard', lights: [LIGHT] }],
  cameras: [{ entity: CAMERA, name: 'Front gate', privacy_entity: PRIVACY }],
  garage: { cover: GARAGE },
  security: {
    alarm: ALARM,
    policy: 'input_select.demo_security_policy',
    perimeter: [
      { entity: FRONT, name: 'Front door' },
      { entity: BACK, name: 'Back door' },
      { entity: GARAGE, name: 'Garage door' },
    ],
  },
});

const ALL_GOOD: Readonly<Record<string, string>> = {
  [PERSON]: 'home',
  [SUN]: 'below_horizon',
  [WEATHER]: 'cloudy',
  [CLIMATE]: 'cool',
  [LIGHT]: 'on',
  [CAMERA]: 'idle',
  [PRIVACY]: 'off',
  [GARAGE]: 'closed',
  [ALARM]: 'disarmed',
  [FRONT]: 'off',
  [BACK]: 'off',
};

function health(states: Readonly<Record<string, string | undefined>>, options: FakeStoreOptions = {}) {
  const entities = Object.entries(states)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([id, state]) => testEntity(id, state, { friendly_name: `${id.split('.')[1]} friendly` }));
  return testInput(config, fakeStore(entities, options));
}

describe('selectHealth: named monitored inputs only (§4.8)', () => {
  it('counts monitored entry points and devices in the headline, with the word "monitored"', () => {
    const vm = selectHealth(health(ALL_GOOD));
    // weather, climate, light, camera, privacy, garage (also an entry point, counted once), alarm, front, back
    expect(vm.headline).toBe('3 of 3 monitored entry points closed. 9 of 9 devices reporting.');
    expect(vm.tone).toBe('ok');
    expect(vm.perimeter).toEqual({ closed: 3, total: 3, open: [], unknown: [] });
    expect(vm.devices).toEqual({ reporting: 9, total: 9, notReporting: [] });
    expect(vm.problems).toEqual([]);
  });

  it('never says everything is normal, in any state', () => {
    const variants = [
      health(ALL_GOOD),
      health({ ...ALL_GOOD, [BACK]: 'on', [LIGHT]: 'unavailable' }),
      health(ALL_GOOD, { connected: false }),
      health(ALL_GOOD, { ready: false }),
      health({}, { haState: 'STARTING' }),
    ];
    for (const input of variants) {
      const text = JSON.stringify([selectHealth(input), selectHealthDetails(input)]);
      expect(text).not.toMatch(/all systems|normal|all good|everything/i);
    }
  });

  it('leaves out people, sun, policy, scripts and calendars', () => {
    const ids = healthEntityIds(config);
    expect(ids).not.toContain(PERSON);
    expect(ids).not.toContain(SUN);
    expect(ids).not.toContain('input_select.demo_security_policy');
    expect(ids).toEqual(expect.arrayContaining([WEATHER, CLIMATE, LIGHT, CAMERA, PRIVACY, GARAGE, ALARM, FRONT, BACK]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('omits the entry point clause when no perimeter is configured', () => {
    const noPerimeter = configFrom({ weather: WEATHER, rooms: [{ name: 'Courtyard', lights: [LIGHT] }] });
    const vm = selectHealth(testInput(noPerimeter, fakeStore([testEntity(WEATHER, 'sunny'), testEntity(LIGHT, 'on')])));
    expect(vm.perimeter).toBeUndefined();
    expect(vm.headline).toBe('2 of 2 devices reporting.');
  });

  it('says so when nothing is monitored, without implying health', () => {
    const vm = selectHealth(testInput(configFrom({ people: [PERSON] }), fakeStore([testEntity(PERSON, 'home')])));
    expect(vm.headline).toBe('No monitored devices are configured.');
    expect(vm.tone).toBe('muted');
  });

  it('maps entry points through model/perimeter.ts: binary_sensor on is open, cover open is open', () => {
    const vm = selectHealth(health({ ...ALL_GOOD, [BACK]: 'on', [GARAGE]: 'opening' }));
    expect(vm.perimeter).toMatchObject({ closed: 1, total: 3, open: ['Back door', 'Garage door'] });
    expect(vm.facts[0]).toMatchObject({ count: '1 of 3', tone: 'attention', icon: 'door-open' });
    expect(vm.problems.slice(0, 2)).toEqual([
      { key: BACK, name: 'Back door', label: 'Open' },
      { key: GARAGE, name: 'Garage door', label: 'Open' },
    ]);
  });

  it('lists an unavailable entry point once, as an entry point, even though it is also a device', () => {
    const vm = selectHealth(health({ ...ALL_GOOD, [FRONT]: 'unavailable' }));
    expect(vm.perimeter?.unknown).toEqual(['Front door']);
    expect(vm.devices.notReporting).toEqual([{ name: 'Front door', status: 'unavailable' }]);
    expect(vm.problems).toEqual([{ key: FRONT, name: 'Front door', label: 'Unavailable' }]);
  });

  it('distinguishes unavailable, not found and unknown devices by name', () => {
    const vm = selectHealth(
      health({ ...ALL_GOOD, [LIGHT]: 'unavailable', [CLIMATE]: undefined, [PRIVACY]: 'unknown' }),
    );
    expect(vm.devices.notReporting).toEqual([
      { name: 'Bedroom', status: 'missing-binding' },
      { name: 'demo_courtyard friendly', status: 'unavailable' },
      { name: 'demo_front_gate_privacy friendly', status: 'unknown' },
    ]);
    expect(vm.headline).toBe('3 of 3 monitored entry points closed. 6 of 9 devices reporting.');
    expect(vm.tone).toBe('attention');
  });

  it('cuts named problems to the budget of 3 and counts the rest', () => {
    const vm = selectHealth(
      health({ ...ALL_GOOD, [BACK]: 'on', [LIGHT]: 'unavailable', [CLIMATE]: 'unavailable', [CAMERA]: 'unavailable' }),
    );
    expect(vm.problems).toHaveLength(3);
    expect(vm.problems[0]?.label).toBe('Open');
    expect(vm.problemsOverflow).toBe(1);
  });

  it('while HA starts, absent devices are Loading, never Not found', () => {
    const vm = selectHealth(health({ ...ALL_GOOD, [CLIMATE]: undefined, [FRONT]: undefined }, { haState: 'STARTING' }));
    expect(JSON.stringify(vm)).not.toContain('missing-binding');
    expect(JSON.stringify(vm)).not.toContain('Not found');
    expect(vm.headline).toBe(
      '2 of 3 monitored entry points closed, 1 still loading. 7 of 9 devices reporting, 2 still loading.',
    );
    expect(vm.problems).toEqual([]);
    expect(vm.facts[0]).toMatchObject({ tone: 'muted', icon: 'info' });
    expect(vm.facts[1]).toMatchObject({ tone: 'muted', icon: 'info' });
    expect(vm.tone).toBe('muted');
    const details = selectHealthDetails(
      health({ ...ALL_GOOD, [CLIMATE]: undefined, [FRONT]: undefined }, { haState: 'STARTING' }),
    );
    expect(details.loading.map((device) => device.name)).toEqual(['Bedroom', 'Front door']);
    expect(details.entryPoints.find((entry) => entry.key === FRONT)).toMatchObject({ label: 'Loading', tone: 'muted' });
  });

  it('while HA starts, an entry point still loading is not read as open or unknown', () => {
    const single = configFrom({
      security: { alarm: ALARM, policy: 'input_select.demo_security_policy', perimeter: [FRONT] },
    });
    const vm = selectHealth(testInput(single, fakeStore([testEntity(ALARM, 'disarmed')], { haState: 'STARTING' })));
    expect(vm.facts[0]).toMatchObject({
      count: '0 of 1',
      text: 'monitored entry points closed, 1 still loading',
      tone: 'muted',
      icon: 'info',
    });
    expect(vm.perimeter?.unknown).toEqual([]);
  });

  it('while HA starts, an open entry point still needs a look even with others loading', () => {
    const vm = selectHealth(health({ ...ALL_GOOD, [FRONT]: undefined, [BACK]: 'on' }, { haState: 'STARTING' }));
    expect(vm.facts[0]).toMatchObject({
      count: '1 of 3',
      text: 'monitored entry points closed, 1 still loading',
      tone: 'attention',
      icon: 'door-open',
    });
  });

  it('once HA is running, the same absent device is Not found', () => {
    const vm = selectHealth(health({ ...ALL_GOOD, [CLIMATE]: undefined }));
    expect(vm.devices.notReporting).toEqual([{ name: 'Bedroom', status: 'missing-binding' }]);
    expect(vm.problems).toEqual([{ key: CLIMATE, name: 'Bedroom', label: 'Not found' }]);
  });

  it('pauses while disconnected or resyncing instead of counting stale states', () => {
    const disconnected = selectHealth(health(ALL_GOOD, { connected: false }));
    expect(disconnected).toMatchObject({ state: 'paused', tone: 'muted', facts: [], problems: [] });
    expect(disconnected.headline).toContain('Paused while Home Assistant is disconnected.');
    const resyncing = selectHealth(health(ALL_GOOD, { connected: false, resyncing: true }));
    expect(resyncing.headline).toContain('Waiting for current states');
  });

  it.each([
    ['disconnected', { connected: false }],
    ['resyncing', { connected: false, resyncing: true }],
  ])('while %s, never reports a device as not reporting: only the connection is down', (_, options) => {
    const panel = selectHealth(health(ALL_GOOD, options));
    expect(panel.devices).toEqual({ reporting: 0, total: 9, notReporting: [] });
    expect(panel.perimeter).toEqual({ closed: 0, total: 3, open: [], unknown: [] });
    const details = selectHealthDetails(health(ALL_GOOD, options));
    expect(details.notReporting).toEqual([]);
    expect(details.reporting).toEqual([]);
    expect(details.loading).toEqual([]);
    expect(details.monitored).toHaveLength(9);
    expect(details.monitored.map((device) => device.name)).toContain('Weather');
    expect(JSON.stringify(details)).not.toContain('Unknown');
  });

  it('while paused, entry points keep the app-wide Offline label in a muted tone', () => {
    const details = selectHealthDetails(health(ALL_GOOD, { connected: false }));
    expect(details.entryPoints.map(({ name, label, tone }) => ({ name, label, tone }))).toEqual([
      { name: 'Front door', label: 'Offline', tone: 'muted' },
      { name: 'Back door', label: 'Offline', tone: 'muted' },
      { name: 'Garage door', label: 'Offline', tone: 'muted' },
    ]);
  });

  it('while paused, an entity HA never delivered is still only a monitored name, not Not found', () => {
    const details = selectHealthDetails(health({ ...ALL_GOOD, [CLIMATE]: undefined }, { connected: false }));
    expect(details.notReporting).toEqual([]);
    expect(details.monitored.map((device) => device.name)).toContain('Bedroom');
    expect(JSON.stringify(details)).not.toContain('Not found');
  });

  it('tones live entry points: closed ok, open or unavailable attention', () => {
    const details = selectHealthDetails(health({ ...ALL_GOOD, [BACK]: 'on', [GARAGE]: 'unavailable' }));
    expect(details.entryPoints.map(({ label, tone }) => ({ label, tone }))).toEqual([
      { label: 'Closed', tone: 'ok' },
      { label: 'Open', tone: 'attention' },
      { label: 'Unavailable', tone: 'attention' },
    ]);
  });

  it('is loading before the first state arrives', () => {
    expect(selectHealth(health(ALL_GOOD, { ready: false })).state).toBe('loading');
  });

  it('treats an entity the reconnect snapshot did not replace as not reporting', () => {
    const vm = selectHealth(health(ALL_GOOD, { notFresh: [LIGHT] }));
    expect(vm.devices.notReporting).toEqual([{ name: 'demo_courtyard friendly', status: 'unknown' }]);
  });

  it('names devices by configured or friendly name, falls back to role words, and never shows an entity ID', () => {
    const details = selectHealthDetails(
      testInput(config, fakeStore([testEntity(WEATHER, 'sunny', { friendly_name: 'Lakeview' })])),
    );
    const names = [...details.reporting, ...details.notReporting].map((device) => device.name);
    expect(names).toContain('Weather');
    expect(names).not.toContain('Lakeview');
    expect(names).toEqual(expect.arrayContaining(['Bedroom', 'Courtyard light', 'Front gate', 'Front gate privacy']));
    expect(names.join(' ')).not.toMatch(/demo_|\./);
  });
});
