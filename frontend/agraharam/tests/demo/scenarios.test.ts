import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoScenarioId, EntityId } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput, mergeConfigFragments } from '../../src/demo/configs.ts';
import { demoEntity, fixtureClock, type SectionFixture } from '../../src/demo/fixture-types.ts';
import { assembleScenario, DEMO_SCENARIO_IDS, SCENARIO_SPECS } from '../../src/demo/scenarios.ts';

const NOW = new Date(2026, 8, 30, 17, 51, 0).getTime();
const ALL_SCENARIOS: readonly DemoScenarioId[] = [
  'normal',
  'degraded',
  'offline',
  'empty',
  'alert',
  'loading',
  'restricted',
  'starting',
  'dense',
  'sky',
];

afterEach(() => {
  vi.doUnmock('../../src/demo/fixtures/index.ts');
  vi.resetModules();
});

describe('demo scenarios (§10.2)', () => {
  it('lists exactly the ten scenarios', () => {
    expect([...DEMO_SCENARIO_IDS].sort()).toEqual([...ALL_SCENARIOS].sort());
  });

  it.each(ALL_SCENARIOS)('%s: the demo input validates with no warnings and controls on', (id) => {
    const input = demoCardInput(id);
    expect(input).not.toHaveProperty('demo');
    expect(input.controls).toBe(true);
    const result = validateConfig(input);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it.each(ALL_SCENARIOS)('%s: assembles its own config', (id) => {
    const scenario = assembleScenario(id, fixtureClock(NOW));
    expect(scenario.spec.id).toBe(id);
    expect(scenario.input).toEqual(demoCardInput(id));
    expect(validateConfig(scenario.input).ok).toBe(true);
  });

  // §10.2 deliberately leaves bound IDs without a state in these scenarios ('Not found' in degraded, 'Loading'
  // in starting, missing integrations in empty), so full coverage is only required everywhere else.
  const SCENARIOS_WITH_ABSENT_BINDINGS: readonly string[] = ['degraded', 'starting', 'empty'];
  it.each(ALL_SCENARIOS.filter((id) => !SCENARIOS_WITH_ABSENT_BINDINGS.includes(id)))(
    '%s: assembles states for every configured entity',
    (id) => {
      const scenario = assembleScenario(id, fixtureClock(NOW));
      const ids = new Set(scenario.states.map((state) => state.entity_id));
      const result = validateConfig(scenario.input);
      if (!result.ok) throw new Error('invalid');
      for (const bound of result.config.bindings.keys()) expect(ids.has(bound), bound).toBe(true);
    },
  );

  it('has the host-level facts each scenario needs', () => {
    expect(SCENARIO_SPECS.offline.connection).toBe('drop-after-first-ingest');
    expect(SCENARIO_SPECS.loading.holdFirstIngest).toBe(true);
    expect(SCENARIO_SPECS.restricted).toMatchObject({
      user: { is_admin: false },
      defaultInvoke: 'reject-unauthorized',
      defaultSnapshot: 'unauthorized',
    });
    expect(SCENARIO_SPECS.starting).toMatchObject({ haState: 'STARTING', missingServices: ['vacuum.start'] });
    expect(SCENARIO_SPECS.normal).toMatchObject({
      connection: 'connected',
      haState: 'RUNNING',
      user: { is_admin: true },
    });
  });

  it('reports the alarm as unknown in degraded (§16.10)', () => {
    const alarm = assembleScenario('degraded', fixtureClock(NOW)).states.find((state) =>
      state.entity_id.startsWith('alarm_control_panel.'),
    );
    expect(alarm?.state).toBe('unknown');
  });

  it('configures airspace in the sky scenario only, which is otherwise the normal household (AIRSPACE.md §10)', () => {
    for (const id of ALL_SCENARIOS.filter((scenario) => scenario !== 'sky')) {
      expect(Object.hasOwn(demoCardInput(id), 'airspace'), id).toBe(false);
      expect(
        assembleScenario(id, fixtureClock(NOW)).states.some((state) => state.entity_id === 'sensor.demo_sky_airspace'),
        id,
      ).toBe(false);
    }
    const { airspace, ...household } = demoCardInput('sky');
    expect(airspace).toEqual({ entity: 'sensor.demo_sky_airspace' });
    expect(household).toEqual(demoCardInput('normal'));
    const sky = assembleScenario('sky', fixtureClock(NOW));
    const normal = assembleScenario('normal', fixtureClock(NOW));
    expect(sky.spec).toEqual({ ...normal.spec, id: 'sky' });
    expect(sky.states.filter((state) => state.entity_id !== 'sensor.demo_sky_airspace')).toEqual(normal.states);
    const result = validateConfig(sky.input);
    expect(result.ok && result.config.airspace).toEqual({ entity: 'sensor.demo_sky_airspace' });
    expect(result.ok && result.config.bindings.get('sensor.demo_sky_airspace' as EntityId)).toEqual(['airspace']);
  });

  it('places every fixture time relative to the clock', () => {
    const shiftMs = 3 * 24 * 60 * 60_000;
    const early = assembleScenario('normal', fixtureClock(NOW));
    const late = assembleScenario('normal', fixtureClock(NOW + shiftMs));
    const firstEarly = Date.parse(early.states[0]?.last_changed ?? '');
    const firstLate = Date.parse(late.states[0]?.last_changed ?? '');
    expect(firstLate - firstEarly).toBe(shiftMs);
    const hourly = (scenarioClock: number) =>
      Date.parse(
        (assembleScenario('normal', fixtureClock(scenarioClock)).forecasts.hourly as { datetime: string }[])[0]
          ?.datetime ?? '',
      );
    expect(hourly(NOW + shiftMs) - hourly(NOW)).toBe(shiftMs);
  });
});

describe('fixture merging (§10.2)', () => {
  it('concatenates arrays and merges mappings', () => {
    expect(
      mergeConfigFragments([
        { owner: 'a', value: { people: ['person.demo_a'], security: { alarm: 'alarm_control_panel.demo_x' } } },
        { owner: 'b', value: { people: ['person.demo_b'], security: { policy: 'input_select.demo_y' } } },
      ]),
    ).toEqual({
      people: ['person.demo_a', 'person.demo_b'],
      security: { alarm: 'alarm_control_panel.demo_x', policy: 'input_select.demo_y' },
    });
  });

  it('fails when two fixtures set the same scalar', () => {
    expect(() =>
      mergeConfigFragments([
        { owner: 'today', value: { weather: 'weather.demo_a' } },
        { owner: 'comfort', value: { weather: 'weather.demo_b' } },
      ]),
    ).toThrow('Demo fixtures today and comfort both set "weather".');
  });

  it('fails assembly when two fixtures define the same entity', async () => {
    const twin = (owner: string): SectionFixture => ({
      config: () => ({}),
      states: (_scenario, clock) => [demoEntity(clock, 'light.demo_twin', owner)],
    });
    vi.resetModules();
    vi.doMock('../../src/demo/fixtures/index.ts', () => ({
      SECTION_FIXTURES: { first: twin('a'), second: twin('b') },
    }));
    const scenarios = await import('../../src/demo/scenarios.ts');
    expect(() => scenarios.assembleScenario('normal', fixtureClock(NOW))).toThrow(
      'Demo fixtures first and second both define entity "light.demo_twin".',
    );
  });
});
