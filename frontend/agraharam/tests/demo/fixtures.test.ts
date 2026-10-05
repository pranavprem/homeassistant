import { describe, expect, it } from 'vitest';
import { isValidEntityId } from '../../src/config/entity-id.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { SECTION_FIXTURES } from '../../src/demo/fixtures/index.ts';

const clock = fixtureClock(Date.UTC(2026, 9, 1, 0, 51));
const fixtures = Object.entries(SECTION_FIXTURES);
const allStates = fixtures.flatMap(([, fixture]) => fixture.states('normal', clock));

/** Every string in a config fragment that is shaped like an entity ID. */
function referencedEntityIds(value: unknown): string[] {
  if (typeof value === 'string') return isValidEntityId(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(referencedEntityIds);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(referencedEntityIds);
  return [];
}

describe('seeded section fixtures (normal scenario)', () => {
  it('uses only fictional *.demo_* entity IDs', () => {
    for (const { entity_id } of allStates) {
      expect(isValidEntityId(entity_id), entity_id).toBe(true);
      expect(entity_id.split('.')[1], entity_id).toMatch(/^demo_/);
    }
  });

  it('never defines the same entity in two places', () => {
    const ids = allStates.map((state) => state.entity_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives each config key to exactly one section fixture', () => {
    const keys = fixtures.flatMap(([, fixture]) => Object.keys(fixture.config('normal')));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has a state for every entity a config fragment references', () => {
    const stateIds = new Set(allStates.map((state) => state.entity_id));
    for (const [name, fixture] of fixtures) {
      for (const id of referencedEntityIds(fixture.config('normal'))) {
        expect(stateIds.has(id), `${name}: ${id}`).toBe(true);
      }
    }
  });

  it('binds each security role to its own script (§4.2 rule 6)', () => {
    const scripts = Object.values(SECTION_FIXTURES.security.config('normal').security?.actions ?? {});
    expect(scripts.length).toBe(7);
    expect(new Set(scripts).size).toBe(scripts.length);
  });
});
