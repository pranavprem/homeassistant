/** The cameras fixture (§10.2): every designed camera state has a scenario, with fictional IDs only. */
import { afterEach, describe, expect, it } from 'vitest';
import type { DemoScenarioId } from '../../src/config/schema.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { camerasFixture } from '../../src/demo/fixtures/cameras.ts';
import { selectAllCameraTiles } from '../../src/model/cameras.ts';
import type { CameraTileVM } from '../../src/model/types.ts';
import { FakeHass, hassRuntime, type HassRuntime } from './camera-harness.ts';

let runtime: HassRuntime | undefined;

afterEach(() => {
  runtime?.stop();
  runtime?.fake.dispose();
  runtime = undefined;
});

function tilesFor(scenario: DemoScenarioId): readonly CameraTileVM[] {
  runtime = hassRuntime(new FakeHass(scenario, { latencyMs: [0, 0] }), demoCardInput(scenario));
  const { services } = runtime;
  return selectAllCameraTiles(
    {
      config: services.config,
      store: services.store,
      reader: services.reader,
      gateway: services.gateway,
      now: new Date(),
    },
    { preview: false },
  );
}

function gates(tiles: readonly CameraTileVM[]): string[] {
  return tiles.map((tile) => (tile.gate.kind === 'privacy' ? `privacy:${tile.gate.certainty}` : tile.gate.kind));
}

describe('cameras fixture (§10.2)', () => {
  it('normal: four cameras, Hall private, Courtyard visible behind a privacy entity that reads off', () => {
    const tiles = tilesFor('normal');
    expect(tiles.map((tile) => tile.name)).toEqual(['Front gate', 'Side path', 'Courtyard', 'Hall']);
    expect(gates(tiles)).toEqual(['allowed', 'allowed', 'allowed', 'privacy:on']);
    // The dev shell's "Outage change" needs a visible, privacy-bound camera to turn private (§10.3, §12.2).
    const courtyard = demoCardInput('normal').cameras?.find((camera) => camera.name === 'Courtyard');
    expect(courtyard?.privacy_entity).toBe('binary_sensor.demo_courtyard_camera_privacy');
    const privacy = camerasFixture
      .states('normal', fixtureClock(Date.now()))
      .find((state) => state.entity_id === courtyard?.privacy_entity);
    expect(privacy?.state).toBe('off');
  });

  it('degraded: offline, privacy unknown, an unexpected privacy string, privacy on', () => {
    expect(gates(tilesFor('degraded'))).toEqual(['offline', 'privacy:unknown', 'privacy:unknown', 'privacy:on']);
    const courtyardPrivacy = camerasFixture
      .states('degraded', fixtureClock(Date.now()))
      .find((state) => state.entity_id === 'binary_sensor.demo_courtyard_camera_privacy');
    expect(courtyardPrivacy?.state).toBe('enabled');
  });

  it('dense: eight cameras, two with privacy (one inverted), one on request, a 403 on the second', () => {
    const tiles = tilesFor('dense');
    expect(tiles).toHaveLength(8);
    expect(gates(tiles).filter((gate) => gate.startsWith('privacy'))).toEqual(['privacy:on']);
    expect(tiles.find((tile) => tile.name === 'Upstairs landing')?.gate.kind).toBe('allowed');
    expect(tiles.filter((tile) => !tile.thumbnails).map((tile) => tile.name)).toEqual(['Workshop door']);
    expect(tiles.find((tile) => tile.name.startsWith('Garden path'))?.intervalMs).toBe(30_000);
    const config = demoCardInput('dense').cameras ?? [];
    expect(config.filter((camera) => camera.privacy_entity !== undefined)).toHaveLength(2);
    expect(camerasFixture.behaviors?.('dense')).toEqual([{ entity: 'camera.demo_side_path', snapshot: 'forbidden' }]);
  });

  it('empty: no cameras configured, so the panel is hidden', () => {
    expect(camerasFixture.config('empty')).toEqual({});
    expect(camerasFixture.states('empty', fixtureClock(Date.now()))).toEqual([]);
  });

  it.each<DemoScenarioId>(['normal', 'degraded', 'dense'])('%s: only fictional *.demo_* IDs', (scenario) => {
    for (const state of camerasFixture.states(scenario, fixtureClock(Date.now()))) {
      expect(state.entity_id.split('.')[1]).toMatch(/^demo_/);
    }
  });
});
