/**
 * The readings model (§18, design §6.3, §7.1, §7.2 with review S4, S9, N5 and C3): one honest condition per row,
 * strict attention rules on raw states, counts that never call an invalid or missing reading healthy, "within
 * limits" only when every row is live, ruled and passing, no counts at all while paused or loading, and a memoised
 * selector that re-evaluates only when something a reading reads has changed. Fictional IDs only.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { HostReader } from '../../src/ha/host.ts';
import type { HassEntityLike, RegistryEntryLike } from '../../src/ha/types.ts';
import {
  collectionEntityIds,
  createReadingsSelector,
  readingGroupMeta,
  readingGroupStartsExpanded,
  readingsFact,
  readingsSentence,
  type ReadingsVM,
  type ReadingVM,
} from '../../src/model/readings.ts';
import type { SelectorInput } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const selectReadings = createReadingsSelector();

const NOW = new Date('2026-09-30T17:51:00-07:00');
const FORMATTER = createFormatter({
  locale: { language: 'en', number_format: 'language', time_format: '12', time_zone: 'server' },
  serverTimeZone: 'America/Los_Angeles',
  temperatureUnit: '°F',
});

interface World {
  readonly config: ResolvedConfig;
  readonly states?: readonly HassEntityLike[];
  readonly store?: FakeStoreOptions;
  readonly registry?: readonly RegistryEntryLike[];
  readonly registryLoaded?: boolean;
  readonly now?: Date;
}

function inputFor(world: World): SelectorInput {
  const store: StoreView = fakeStore(world.states ?? [], world.store);
  const registry = new Map((world.registry ?? []).map((entry) => [entry.entity_id, entry]));
  const reader: HostReader = {
    ...fakeReader(store),
    formatter: () => FORMATTER,
    registry: (id) => registry.get(id),
    registryLoaded: () => world.registryLoaded ?? true,
  };
  return { config: world.config, store, reader, gateway: new FakeGateway(), now: world.now ?? NOW };
}

/** One group, one row: `attention` as written in YAML. */
function oneRow(entity: string, attention?: Record<string, unknown>, name = 'Row'): ResolvedConfig {
  return configFrom({
    collections: [{ name: 'Group', entities: [{ entity, name, ...(attention !== undefined && { attention }) }] }],
  });
}

function row(world: World): ReadingVM {
  const vm = selectReadings(inputFor(world));
  const found = vm.groups[0]?.rows[0];
  if (found === undefined) throw new Error('no row');
  return found;
}

const INK = 'sensor.demo_printer_black_ink';
const STATUS = 'sensor.demo_printer_status';
const DOOR = 'binary_sensor.demo_fridge_door';
const PERCENT = { unit_of_measurement: '%' };

describe('row conditions (§7.1, first match wins)', () => {
  it('available with a range rule: attention strictly below or above, the bound itself in range', () => {
    const rule = { below: 15 };
    expect(row({ config: oneRow(INK, rule), states: [testEntity(INK, '14.9', PERCENT)] })).toMatchObject({
      condition: 'attention',
      detail: 'Below 15%',
      value: { kind: 'value', text: '14.9%' },
    });
    expect(row({ config: oneRow(INK, rule), states: [testEntity(INK, '15', PERCENT)] }).condition).toBe('ok');
    expect(row({ config: oneRow(INK, rule), states: [testEntity(INK, '15.1', PERCENT)] }).condition).toBe('ok');
    const fridge = oneRow('sensor.demo_fridge', { above: 41 });
    const unit = { unit_of_measurement: '°F' };
    expect(row({ config: fridge, states: [testEntity('sensor.demo_fridge', '41', unit)] }).condition).toBe('ok');
    expect(row({ config: fridge, states: [testEntity('sensor.demo_fridge', '41.01', unit)] })).toMatchObject({
      condition: 'attention',
      detail: 'Above 41 °F',
    });
  });

  it('compares the raw state, not the rounded display (no conversion, no rounding)', () => {
    // Shown as "15" at display precision 0, but 14.6 is below 15.
    const vm = row({
      config: oneRow(INK, { below: 15 }),
      states: [testEntity(INK, '14.6', PERCENT)],
      registry: [{ entity_id: INK, display_precision: 0 }],
    });
    expect(vm).toMatchObject({ condition: 'attention', value: { text: '15%' } });
  });

  it('both bounds: below and above each give their own detail; between is ok', () => {
    const config = oneRow('sensor.demo_fridge', { below: 33, above: 41 });
    const at = (state: string) => row({ config, states: [testEntity('sensor.demo_fridge', state)] });
    expect(at('32').detail).toBe('Below 33');
    expect(at('42').detail).toBe('Above 41');
    expect(at('37').condition).toBe('ok');
  });

  it('equals matches the raw state exactly: case-sensitive and untranslated', () => {
    const config = oneRow(STATUS, { equals: ['error', 'offline'] });
    expect(row({ config, states: [testEntity(STATUS, 'error')] }).condition).toBe('attention');
    expect(row({ config, states: [testEntity(STATUS, 'Error')] }).condition).toBe('ok');
    expect(row({ config, states: [testEntity(STATUS, 'printing')] }).condition).toBe('ok');
    const door = oneRow(DOOR, { equals: 'on' });
    expect(row({ config: door, states: [testEntity(DOOR, 'on', { device_class: 'door' })] })).toMatchObject({
      condition: 'attention',
      value: { text: 'Open' },
    });
  });

  it('a range rule on a non-numeric reading is unavailable with "Can\'t compare with the limit", never healthy', () => {
    expect(row({ config: oneRow(INK, { below: 15 }), states: [testEntity(INK, 'low')] })).toMatchObject({
      condition: 'unavailable',
      detail: "Can't compare with the limit",
      value: { kind: 'value', text: 'Low' },
    });
  });

  it('a range rule on a duration compares the raw number in its own unit', () => {
    const attributes = { device_class: 'duration', unit_of_measurement: 'h' };
    const config = oneRow('sensor.demo_pebble_filter_left', { below: 10 });
    expect(row({ config, states: [testEntity('sensor.demo_pebble_filter_left', '6', attributes)] })).toMatchObject({
      condition: 'attention',
      value: { text: '6 h' },
      detail: 'Below 10 h',
    });
    expect(row({ config, states: [testEntity('sensor.demo_pebble_filter_left', '112', attributes)] })).toMatchObject({
      condition: 'ok',
      value: { text: '4 d 16 h' },
    });
  });

  it.each([
    ['unavailable', 'unavailable', 'Unavailable'],
    ['unknown', 'unavailable', 'Unknown'],
  ])('a ruled row whose state is %s counts as unavailable (never ok)', (state, condition, label) => {
    for (const rule of [{ below: 15 }, { equals: 'error' }]) {
      expect(row({ config: oneRow(INK, rule), states: [testEntity(INK, state)] })).toMatchObject({
        condition,
        value: { kind: 'absent', label },
      });
    }
  });

  it('a missing entity reads "Not found" and counts as unavailable, with or without a rule (C3)', () => {
    for (const rule of [undefined, { below: 15 }]) {
      expect(row({ config: oneRow(INK, rule), states: [] })).toMatchObject({
        condition: 'unavailable',
        value: { kind: 'absent', label: 'Not found' },
      });
    }
  });

  it('a rule-less unavailable row counts as unavailable (C3)', () => {
    expect(row({ config: oneRow(INK), states: [testEntity(INK, 'unavailable')] })).toMatchObject({
      condition: 'unavailable',
      value: { kind: 'absent', label: 'Unavailable' },
    });
  });

  it('a rule-less unknown row reads "Unknown" and is not counted (C3); events and empty text say what they are', () => {
    expect(row({ config: oneRow(INK), states: [testEntity(INK, 'unknown')] })).toMatchObject({
      condition: 'info',
      value: { label: 'Unknown' },
    });
    expect(
      row({ config: oneRow('event.demo_doorbell'), states: [testEntity('event.demo_doorbell', 'unknown')] }),
    ).toMatchObject({ condition: 'info', value: { label: 'No events yet' } });
  });

  it('a rule-less available row is info with its value; an unreadable timestamp is "No reading" and unavailable', () => {
    expect(row({ config: oneRow(INK), states: [testEntity(INK, '42', PERCENT)] })).toMatchObject({
      condition: 'info',
      value: { kind: 'value', text: '42%' },
    });
    expect(
      row({
        config: oneRow('sensor.demo_finish'),
        states: [testEntity('sensor.demo_finish', 'soon', { device_class: 'timestamp' })],
      }),
    ).toMatchObject({ condition: 'unavailable', value: { kind: 'absent', label: 'No reading' } });
  });

  it('while HA starts, an absent row is loading (skeleton), never "Not found"', () => {
    expect(row({ config: oneRow(INK, { below: 15 }), states: [], store: { haState: 'STARTING' } })).toMatchObject({
      condition: 'loading',
    });
  });

  it('before the first state arrives every row is loading', () => {
    expect(row({ config: oneRow(INK), states: [testEntity(INK, '42')], store: { ready: false } }).condition).toBe(
      'loading',
    );
  });

  it('a row the reconnect snapshot did not refresh reads "No current reading" and counts as unavailable', () => {
    expect(row({ config: oneRow(INK), states: [testEntity(INK, '42')], store: { notFresh: [INK] } })).toMatchObject({
      condition: 'unavailable',
      value: { kind: 'absent', label: 'No current reading' },
    });
  });

  it('while disconnected or resyncing: last known values, stale, muted, not counted; none known reads "Offline" (S4)', () => {
    for (const store of [{ connected: false }, { connected: false, resyncing: true }] as const) {
      const vm = row({ config: oneRow(INK, { below: 15 }), states: [testEntity(INK, '9', PERCENT)], store });
      expect(vm).toMatchObject({ condition: 'stale', value: { kind: 'value', text: '9%', stale: true } });
      expect(vm.detail).toBeUndefined();
      expect(row({ config: oneRow(INK, { below: 15 }), states: [], store })).toMatchObject({
        condition: 'stale',
        value: { kind: 'absent', label: 'Offline' },
      });
    }
  });

  it('names rows by configured name, then friendly name (capped at 60), then "Reading <n>", never the entity ID', () => {
    const config = configFrom({
      collections: [
        {
          name: 'Group',
          entities: [{ entity: INK, name: 'Black ink' }, STATUS, 'sensor.demo_unnamed'],
        },
      ],
    });
    const vm = selectReadings(
      inputFor({
        config,
        states: [
          testEntity(INK, '12', { friendly_name: 'Ignored' }),
          testEntity(STATUS, 'printing', { friendly_name: `Printer ${'s'.repeat(80)}` }),
          testEntity('sensor.demo_unnamed', '3'),
        ],
      }),
    );
    const names = vm.groups[0]?.rows.map((item) => item.name) ?? [];
    expect(names[0]).toBe('Black ink');
    expect([...(names[1] ?? '')]).toHaveLength(60);
    expect(names[2]).toBe('Reading 3');
    expect(names.join(' ')).not.toMatch(/demo_/);
  });
});

describe('counts, the House fact and the drawer sentence (§7.2)', () => {
  const RULED = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ entity: `sensor.demo_r${index}`, attention: { below: 10 } }));
  const configOf = (entities: unknown[]) => configFrom({ collections: [{ name: 'Group', entities }] });
  const states = (values: readonly string[]) =>
    values.map((state, index) => testEntity(`sensor.demo_r${index}`, state));
  const vmOf = (values: readonly string[], store?: FakeStoreOptions) =>
    selectReadings(
      inputFor({ config: configOf(RULED(values.length)), states: states(values), ...(store && { store }) }),
    );
  const fact = (vm: ReadingsVM) => readingsFact(vm, FORMATTER);

  it('counts attention, unavailable, loading and checked (passing) rows', () => {
    const vm = vmOf(['5', '50', 'unavailable', 'low', '20']);
    expect(vm.counts).toEqual({ total: 5, checked: 2, attention: 1, unavailable: 2, loading: 0 });
    expect(vm.groups[0]?.counts).toEqual(vm.counts);
  });

  it('attention first, with unavailable appended; singular and plural', () => {
    expect(fact(vmOf(['5', '50', 'unavailable']))).toEqual({
      key: 'readings',
      count: '1',
      text: 'reading needs attention, 1 unavailable',
      tone: 'attention',
      icon: 'circle-alert',
    });
    expect(fact(vmOf(['5', '4']))?.text).toBe('readings need attention');
  });

  it('then unavailable, with loading appended', () => {
    expect(fact(vmOf(['unavailable', '50']))).toMatchObject({
      count: '1',
      text: 'reading unavailable',
      tone: 'attention',
    });
    const starting = selectReadings(
      inputFor({ config: configOf(RULED(3)), states: states(['unavailable']), store: { haState: 'STARTING' } }),
    );
    expect(fact(starting)).toMatchObject({ count: '1', text: 'reading unavailable, 2 still loading' });
  });

  it('then loading only, muted', () => {
    const starting = selectReadings(
      inputFor({ config: configOf(RULED(2)), states: [], store: { haState: 'STARTING' } }),
    );
    expect(fact(starting)).toMatchObject({ count: '2', text: 'readings still loading', tone: 'muted', icon: 'info' });
  });

  it('"within limits" only when every row is live, ruled and passing', () => {
    expect(fact(vmOf(['50', '20']))).toEqual({
      key: 'readings',
      count: '2',
      text: 'readings within limits',
      tone: 'ok',
      icon: 'circle-check',
    });
    // One rule-less row means not everything was checked: neutral, never the all-clear.
    const mixed = selectReadings(
      inputFor({
        config: configOf([...RULED(2), 'sensor.demo_free']),
        states: [...states(['50', '20']), testEntity('sensor.demo_free', '1')],
      }),
    );
    expect(fact(mixed)).toEqual({
      key: 'readings',
      count: '3',
      text: 'readings, 2 within limits',
      tone: 'neutral',
      icon: 'info',
    });
    // A rule-less unknown row is not counted against the total either way, but it still blocks the all-clear.
    const unknownFree = selectReadings(
      inputFor({
        config: configOf([...RULED(1), 'sensor.demo_free']),
        states: [...states(['50']), testEntity('sensor.demo_free', 'unknown')],
      }),
    );
    expect(fact(unknownFree)?.text).not.toContain('readings within limits');
  });

  it('no rules at all: a neutral count of readings', () => {
    const plain = selectReadings(
      inputFor({ config: configOf(['sensor.demo_a', 'sensor.demo_b']), states: [testEntity('sensor.demo_a', '1')] }),
    );
    // The missing one is unavailable; that is what the fact says.
    expect(fact(plain)).toMatchObject({ text: 'reading unavailable' });
    const present = selectReadings(
      inputFor({
        config: configOf(['sensor.demo_a', 'sensor.demo_b']),
        states: [testEntity('sensor.demo_a', '1'), testEntity('sensor.demo_b', '2')],
      }),
    );
    expect(fact(present)).toMatchObject({ count: '2', text: 'readings', tone: 'neutral' });
  });

  it('formats counts through the formatter', () => {
    const many = Array.from({ length: 12 }, (_, group) => ({
      name: `Group ${group}`,
      entities: Array.from({ length: 32 }, (_, index) => `sensor.demo_g${group}_r${index}`),
    }));
    const config = configFrom({ collections: many });
    const all = collectionEntityIds(config).map((id) => testEntity(id, '1'));
    expect(fact(selectReadings(inputFor({ config, states: all })))).toMatchObject({ count: '384', text: 'readings' });
  });

  it('has no fact while paused or loading; the drawer sentence says why', () => {
    const paused = vmOf(['5'], { connected: false });
    expect(paused.state).toBe('paused');
    expect(fact(paused)).toBeUndefined();
    expect(paused.counts).toMatchObject({ attention: 0, unavailable: 0, checked: 0 });
    expect(readingsSentence(paused, FORMATTER)).toBe(
      'Paused while Home Assistant is disconnected. Values shown are the last known.',
    );
    const resyncing = vmOf(['5'], { connected: false, resyncing: true });
    expect(readingsSentence(resyncing, FORMATTER)).toBe('Waiting for current states from Home Assistant.');
    const loading = vmOf(['5'], { ready: false });
    expect(fact(loading)).toBeUndefined();
    expect(readingsSentence(loading, FORMATTER)).toBe('Loading readings.');
    expect(readingsSentence(vmOf(['5', '50', 'unavailable']), FORMATTER)).toBe(
      '1 reading needs attention, 1 unavailable.',
    );
  });
});

describe('group meta and expansion defaults (§7.2, §9.4, S4)', () => {
  const config = configFrom({
    collections: [
      { name: 'Printer', entities: [{ entity: INK, attention: { below: 15 } }] },
      { name: 'Car', entities: [{ entity: 'sensor.demo_tire', attention: { below: 38 } }] },
      { name: 'Fridge', entities: [{ entity: 'sensor.demo_fridge', attention: { above: 41 } }] },
      { name: 'Notes', entities: ['input_text.demo_note', 'sensor.demo_extra'] },
    ],
  });
  const states = [
    testEntity(INK, '9'),
    testEntity('sensor.demo_tire', 'unavailable'),
    testEntity('sensor.demo_fridge', '38'),
    testEntity('input_text.demo_note', 'Hello'),
    testEntity('sensor.demo_extra', '2'),
  ];
  const metas = (vm: ReadingsVM) => vm.groups.map((group) => readingGroupMeta(group, vm, FORMATTER));
  const expanded = (vm: ReadingsVM) => vm.groups.map((group) => readingGroupStartsExpanded(group, vm));

  it('live: words each group briefly and opens only the groups that need a look', () => {
    const vm = selectReadings(inputFor({ config, states }));
    expect(metas(vm)).toEqual(['1 needs attention', '1 unavailable', 'All within limits', '2 readings']);
    expect(expanded(vm)).toEqual([true, true, false, false]);
  });

  it('paused or loading: every group reads "Paused" or "Loading", never "All within limits", and all start closed', () => {
    const paused = selectReadings(inputFor({ config, states, store: { connected: false } }));
    expect(metas(paused)).toEqual(['Paused', 'Paused', 'Paused', 'Paused']);
    expect(expanded(paused)).toEqual([false, false, false, false]);
    const loading = selectReadings(inputFor({ config, states, store: { ready: false } }));
    expect(metas(loading)).toEqual(['Loading', 'Loading', 'Loading', 'Loading']);
    expect(expanded(loading)).toEqual([false, false, false, false]);
  });

  it('a lone group always starts open, even while paused', () => {
    const lone = oneRow(INK, { below: 15 });
    const paused = selectReadings(
      inputFor({ config: lone, states: [testEntity(INK, '50')], store: { connected: false } }),
    );
    expect(expanded(paused)).toEqual([true]);
    const live = selectReadings(inputFor({ config: lone, states: [testEntity(INK, '50')] }));
    expect(expanded(live)).toEqual([true]);
  });

  it('collects entity IDs de-duplicated in configuration order, and maps the configured icon', () => {
    const shared = configFrom({
      collections: [
        { name: 'One', icon: 'printer', entities: [INK, STATUS] },
        { name: 'Two', entities: [STATUS, 'sensor.demo_z'] },
      ],
    });
    expect(collectionEntityIds(shared)).toEqual([INK, STATUS, 'sensor.demo_z']);
    const vm = selectReadings(inputFor({ config: shared }));
    expect(vm.groups.map((group) => group.icon)).toEqual(['printer', undefined]);
    expect(vm.groups.map((group) => group.rows.map((item) => item.key))).toEqual([
      ['0:0', '0:1'],
      ['1:0', '1:1'],
    ]);
  });
});

describe('the memoised selector (S9, N5)', () => {
  const config = configFrom({
    collections: [{ name: 'Printer', entities: [{ entity: INK, attention: { below: 15 } }, STATUS] }],
  });

  /** A reader whose answers the test changes between calls, over a store whose entities it replaces. */
  function mutable() {
    let entities = new Map<string, HassEntityLike>([
      [INK, testEntity(INK, '12')],
      [STATUS, testEntity(STATUS, 'printing')],
      ['light.demo_other', testEntity('light.demo_other', 'off')],
    ]);
    let connected = true;
    let registryLoaded = false;
    let registryEntry: RegistryEntryLike | undefined;
    const store: StoreView = {
      ...fakeStore([]),
      get: (id) => entities.get(id),
      isConnected: () => connected,
    };
    const reader: HostReader = {
      ...fakeReader(store),
      formatter: () => FORMATTER,
      registry: (id) => (id === INK ? registryEntry : undefined),
      registryLoaded: () => registryLoaded,
    };
    let now = NOW;
    const input = (): SelectorInput => ({ config, store, reader, gateway: new FakeGateway(), now });
    return {
      input,
      replace(id: string, state: string) {
        entities = new Map(entities).set(id, testEntity(id, state));
      },
      setConnected(next: boolean) {
        connected = next;
      },
      deliverRegistry(entry: RegistryEntryLike) {
        registryLoaded = true;
        registryEntry = entry;
      },
      advance(ms: number) {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  it('returns the same view model for an unrelated entity change and an identity-only push', () => {
    const world = mutable();
    const select = createReadingsSelector();
    const first = select(world.input());
    world.replace('light.demo_other', 'on');
    expect(select(world.input())).toBe(first);
    expect(select(world.input())).toBe(first);
    world.advance(30_000); // within the same minute
    expect(select(world.input())).toBe(first);
  });

  it('builds a new one when a collection entity, the connection or the minute changes', () => {
    const world = mutable();
    const select = createReadingsSelector();
    const first = select(world.input());
    world.replace(INK, '20');
    const second = select(world.input());
    expect(second).not.toBe(first);
    expect(second.groups[0]?.rows[0]?.condition).toBe('ok');
    world.setConnected(false);
    const third = select(world.input());
    expect(third).not.toBe(second);
    expect(third.state).toBe('paused');
    world.setConnected(true);
    const fourth = select(world.input());
    world.advance(60_000);
    expect(select(world.input())).not.toBe(fourth);
  });

  it('invalidates on a registry change (display precision arrives with the registry, N5)', () => {
    const world = mutable();
    const select = createReadingsSelector();
    const before = select(world.input());
    world.replace(INK, '12.345');
    const unrounded = select(world.input());
    expect(unrounded).not.toBe(before);
    expect(unrounded.groups[0]?.rows[0]?.value).toMatchObject({ text: '12.35' });
    world.deliverRegistry({ entity_id: INK, display_precision: 0 });
    const rounded = select(world.input());
    expect(rounded).not.toBe(unrounded);
    expect(rounded.groups[0]?.rows[0]?.value).toMatchObject({ text: '12' });
  });

  it('is per element: two selectors never share a cache', () => {
    const world = mutable();
    const a = createReadingsSelector();
    const b = createReadingsSelector();
    expect(a(world.input())).not.toBe(b(world.input()));
    expect(a(world.input())).toEqual(b(world.input()));
  });
});
