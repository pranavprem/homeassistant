import { describe, expect, it } from 'vitest';
import { absentDisplay, displayText, friendlyName, valueDisplay } from '../../src/model/display.ts';
import { entityId, fakeStore, testEntity } from '../helpers/fake-store.ts';

describe('display helpers (§4.6)', () => {
  it('builds value and absent displays with the shared labels', () => {
    expect(valueDisplay('72°')).toEqual({ kind: 'value', text: '72°', stale: false });
    expect(absentDisplay('missing-binding')).toEqual({ kind: 'absent', reason: 'missing-binding', label: 'Not found' });
    expect(displayText(absentDisplay('no-data'))).toBe('No data');
    expect(displayText(valueDisplay('82%', true))).toBe('82%');
  });

  it('names an entity by config, then friendly name, then the fallback; never by entity ID', () => {
    const lamp = entityId('light.demo_lamp');
    const store = fakeStore([testEntity(lamp, 'on', { friendly_name: ' Reading lamp ' })]);
    expect(friendlyName(store, lamp, 'Lamp', 'Light')).toBe('Lamp');
    expect(friendlyName(store, lamp, undefined, 'Light')).toBe('Reading lamp');
    expect(friendlyName(fakeStore([]), lamp, undefined, 'Light')).toBe('Light');
  });
});
