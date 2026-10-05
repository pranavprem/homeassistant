import { describe, expect, it } from 'vitest';
import { normalizeEntity } from '../../src/ha/normalize.ts';
import { perimeterPosition } from '../../src/model/perimeter.ts';
import { entityId, fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';

function position(id: string, state: string | undefined, options: FakeStoreOptions = {}) {
  const states = state === undefined ? [] : [testEntity(id, state)];
  return perimeterPosition(normalizeEntity(fakeStore(states, options), entityId(id)));
}

describe('perimeter mapping (§4.8)', () => {
  it.each([
    ['binary_sensor.demo_door', 'on', 'open', 'Open'],
    ['binary_sensor.demo_door', 'off', 'closed', 'Closed'],
    ['cover.demo_garage', 'closed', 'closed', 'Closed'],
    ['cover.demo_garage', 'open', 'open', 'Open'],
    ['cover.demo_garage', 'opening', 'open', 'Open'],
    ['cover.demo_garage', 'closing', 'open', 'Open'],
  ])('%s %s → %s', (id, state, expected, label) => {
    expect(position(id, state)).toEqual({ position: expected, label });
  });

  it('follows the normalization status for everything else', () => {
    expect(position('binary_sensor.demo_door', 'unavailable')).toEqual({ position: 'unknown', label: 'Unavailable' });
    expect(position('binary_sensor.demo_door', undefined)).toEqual({ position: 'unknown', label: 'Not found' });
    expect(position('cover.demo_garage', 'stopped')).toEqual({ position: 'unknown', label: 'Unknown' });
    expect(position('binary_sensor.demo_door', 'off', { connected: false })).toEqual({
      position: 'unknown',
      label: 'Offline',
    });
  });
});
