import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import type { DemoBehavior } from '../../src/demo/fixture-types.ts';
import {
  demoContextId,
  demoSnapshotSvg,
  ScenarioDevices,
  SIMULATED_REJECTIONS,
  SIMULATED_SERVICES,
  simulatedServiceRegistry,
  simulateServiceCall,
} from '../../src/demo/simulate.ts';
import type { ServiceCall, ServiceDomain } from '../../src/ha/host.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';

const NOW = Date.UTC(2026, 8, 30, 0, 51);

/** Every service of the §7.1 catalog. */
const CATALOG_SERVICES = [
  'light.turn_on',
  'light.turn_off',
  'climate.set_temperature',
  'climate.set_hvac_mode',
  'fan.turn_on',
  'fan.turn_off',
  'fan.set_percentage',
  'fan.set_preset_mode',
  'vacuum.start',
  'vacuum.pause',
  'vacuum.return_to_base',
  'cover.open_cover',
  'cover.close_cover',
  'media_player.media_play',
  'media_player.media_pause',
  'media_player.media_next_track',
  'media_player.media_previous_track',
  'media_player.volume_set',
  'media_player.volume_mute',
  'media_player.select_source',
  'script.turn_on',
];

function call(service: string, target: string | string[], data: Record<string, unknown> = {}): ServiceCall {
  const [domain, name] = service.split('.') as [ServiceDomain, string];
  return { domain, service: name, data, target: { entity_id: target as EntityId | EntityId[] } };
}

function finalState(steps: readonly { state: HassEntityLike }[]): HassEntityLike | undefined {
  return steps[steps.length - 1]?.state;
}

function statesOf(...entities: HassEntityLike[]): ReadonlyMap<EntityId, HassEntityLike> {
  return new Map(entities.map((entity) => [entity.entity_id as EntityId, entity]));
}

describe('simulateServiceCall (§10.2)', () => {
  it('covers every §7.1 service', () => {
    expect([...SIMULATED_SERVICES].sort()).toEqual([...CATALOG_SERVICES].sort());
  });

  it.each(CATALOG_SERVICES)('%s produces at least one timed step with a new state object', (service) => {
    const [domain] = service.split('.');
    const entity = testEntity(`${domain}.demo_x`, 'off', { media_title: 'Evening raga', brightness: 10 });
    const steps = simulateServiceCall(call(service, entity.entity_id, { hvac_mode: 'cool' }), statesOf(entity), NOW);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.atMs).toBeGreaterThan(NOW);
      expect(step.state).not.toBe(entity);
      expect(Object.isFrozen(step.state)).toBe(true);
    }
  });

  it('lights: brightness from brightness_pct, cleared on turn_off', () => {
    const light = testEntity('light.demo_lamp', 'off', { brightness: null });
    expect(
      finalState(
        simulateServiceCall(call('light.turn_on', light.entity_id, { brightness_pct: 40 }), statesOf(light), NOW),
      ),
    ).toMatchObject({
      state: 'on',
      attributes: { brightness: 102 },
    });
    const on = testEntity('light.demo_lamp', 'on', { brightness: 200 });
    expect(
      finalState(simulateServiceCall(call('light.turn_off', on.entity_id), statesOf(on), NOW))?.attributes[
        'brightness'
      ],
    ).toBeNull();
  });

  it('covers move through opening to open, each step built on the previous one', () => {
    const cover = testEntity('cover.demo_garage', 'closed', { device_class: 'garage' });
    const steps = simulateServiceCall(call('cover.open_cover', cover.entity_id), statesOf(cover), NOW);
    expect(steps.map((step) => step.state.state)).toEqual(['opening', 'open']);
    expect(steps[1]?.state.attributes).toMatchObject({ device_class: 'garage', current_position: 100 });
    expect((steps[1]?.atMs ?? 0) > (steps[0]?.atMs ?? 0)).toBe(true);
  });

  it('scripts get a new last_triggered and the call context, then finish', () => {
    const script = testEntity('script.demo_hold_night', 'off');
    const steps = simulateServiceCall(call('script.turn_on', script.entity_id), statesOf(script), NOW);
    expect(steps.map((step) => step.state.state)).toEqual(['on', 'off']);
    expect(steps[0]?.state.context.id).toBe(demoContextId(NOW));
    expect(steps[0]?.state.attributes['last_triggered']).toEqual(expect.any(String));
  });

  it('media next track changes the title; volume rounds to 0.01', () => {
    const player = testEntity('media_player.demo_tv', 'playing', { media_title: 'Evening raga', volume_level: 0.2 });
    expect(
      finalState(simulateServiceCall(call('media_player.media_next_track', player.entity_id), statesOf(player), NOW))
        ?.attributes['media_title'],
    ).not.toBe('Evening raga');
    expect(
      finalState(
        simulateServiceCall(
          call('media_player.volume_set', player.entity_id, { volume_level: 0.333 }),
          statesOf(player),
          NOW,
        ),
      )?.attributes['volume_level'],
    ).toBe(0.33);
  });

  it('applies to every target of a room action and ignores missing targets and unknown services', () => {
    const a = testEntity('light.demo_a', 'off');
    const b = testEntity('light.demo_b', 'off');
    const steps = simulateServiceCall(
      call('light.turn_on', ['light.demo_a', 'light.demo_b', 'light.demo_gone']),
      statesOf(a, b),
      NOW,
    );
    expect(steps.map((step) => step.state.entity_id)).toEqual(['light.demo_a', 'light.demo_b']);
    expect(simulateServiceCall(call('camera.demo_unknown_service', 'light.demo_a'), statesOf(a), NOW)).toEqual([]);
  });

  it('builds hass.services without the missing ones', () => {
    const registry = simulatedServiceRegistry(['vacuum.start']);
    expect(Object.keys(registry['vacuum'] ?? {})).toEqual(['pause', 'return_to_base']);
    expect(registry['script']).toEqual({ turn_on: {} });
  });

  it('generates a text-free SVG scene per camera', () => {
    const svg = demoSnapshotSvg(entityId('camera.demo_front_gate'));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<text');
    expect(svg).not.toMatch(/<script|on\w+=/i);
    expect(demoSnapshotSvg(entityId('camera.demo_front_gate'))).toBe(svg);
  });

  it('carries a darker night palette for a dark color scheme, so a still never outshines the dark page', () => {
    const svg = demoSnapshotSvg(entityId('camera.demo_front_gate'));
    const [, day = '', night = ''] =
      /<style>(.*)@media \(prefers-color-scheme: dark\)\{(.*)\}<\/style>/.exec(svg) ?? [];
    const luminance = (css: string): number => {
      const hex = /\.sky\{fill:#([0-9a-f]{6})\}/.exec(css)?.[1] ?? '000000';
      return [0, 2, 4].reduce((sum, at) => sum + Number.parseInt(hex.slice(at, at + 2), 16), 0);
    };
    expect(day).not.toBe('');
    expect(night).not.toBe('');
    expect(luminance(night)).toBeLessThan(luminance(day) / 2);
  });
});

describe('ScenarioDevices', () => {
  const LIGHT = entityId('light.demo_lamp');
  let changes: Readonly<Record<string, HassEntityLike>>[];

  function devices(behaviors: readonly DemoBehavior[] = [], defaultInvoke?: DemoBehavior['onInvoke']): ScenarioDevices {
    return new ScenarioDevices({
      states: [testEntity(LIGHT, 'off')],
      behaviors: new Map(behaviors.map((behavior) => [behavior.entity, behavior])),
      ...(defaultInvoke !== undefined && { defaultInvoke }),
      latencyMs: [400, 1200],
      random: () => 0.5,
      now: () => Date.now(),
      onChange: (states) => changes.push(states),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the simulated latency and then applies the state with a new map', async () => {
    const sim = devices();
    const before = sim.states;
    const result = sim.invoke(call('light.turn_on', LIGHT));
    await vi.advanceTimersByTimeAsync(799);
    expect(changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ contextId: expect.any(String) });
    await vi.advanceTimersByTimeAsync(500);
    expect(sim.states).not.toBe(before);
    expect(sim.states[LIGHT]?.state).toBe('on');
  });

  it.each<[NonNullable<DemoBehavior['onInvoke']>, unknown]>([
    ['reject-validation', SIMULATED_REJECTIONS.validation],
    ['reject-unauthorized', SIMULATED_REJECTIONS.unauthorized],
    ['connection-lost', SIMULATED_REJECTIONS.connectionLost],
  ])('rejects with an HA-shaped error for %s and changes nothing', async (onInvoke, rejection) => {
    const sim = devices([{ entity: LIGHT, onInvoke }]);
    const result = sim.invoke(call('light.turn_on', LIGHT));
    const assertion = expect(result).rejects.toEqual(rejection);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(changes).toHaveLength(0);
  });

  it('resolves but never changes state for never-confirm, and honors the scenario default', async () => {
    const sim = devices([], 'never-confirm');
    const result = sim.invoke(call('light.turn_on', LIGHT));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeDefined();
    expect(sim.states[LIGHT]?.state).toBe('off');
  });

  it('clears pending work on dispose', async () => {
    const sim = devices();
    void sim.invoke(call('light.turn_on', LIGHT)).catch(() => undefined);
    sim.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
