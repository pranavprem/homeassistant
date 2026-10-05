import { describe, expect, it } from 'vitest';
import { demoEntity, fixtureClock } from '../../src/demo/fixture-types.ts';

const NOW = new Date(2026, 8, 30, 17, 51, 0).getTime(); // local 5:51 PM, as in the e2e pinned clock

describe('fixtureClock', () => {
  it('exposes now and minute offsets as ISO strings', () => {
    const clock = fixtureClock(NOW);
    expect(clock.now.getTime()).toBe(NOW);
    expect(clock.at(46)).toBe(new Date(NOW + 46 * 60_000).toISOString());
    expect(clock.at(-30)).toBe(new Date(NOW - 30 * 60_000).toISOString());
  });

  it('places dayAt on local wall time of today plus the day offset', () => {
    const tomorrowMorning = new Date(fixtureClock(NOW).dayAt(1, 7, 4));
    expect(tomorrowMorning.getDate()).toBe(1); // October 1st
    expect(tomorrowMorning.getMonth()).toBe(9);
    expect(tomorrowMorning.getHours()).toBe(7);
    expect(tomorrowMorning.getMinutes()).toBe(4);
  });
});

describe('demoEntity', () => {
  it('builds a frozen, complete state with clock-relative timestamps', () => {
    const clock = fixtureClock(NOW);
    const state = demoEntity(clock, 'light.demo_kitchen', 'on', { friendly_name: 'Kitchen' }, 10);
    expect(state).toEqual({
      entity_id: 'light.demo_kitchen',
      state: 'on',
      attributes: { friendly_name: 'Kitchen' },
      last_changed: clock.at(-10),
      last_updated: clock.at(-10),
      context: { id: 'demo-context-light.demo_kitchen', parent_id: null, user_id: null },
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.attributes)).toBe(true);
  });
});
