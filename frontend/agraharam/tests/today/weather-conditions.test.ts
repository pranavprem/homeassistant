/** The Today condition map (§6.5): HA's condition states, untrusted text included, always yield an icon and a label. */
import { describe, expect, it } from 'vitest';
import { ICONS } from '../../src/icons/icons.ts';
import { conditionIcon, conditionPresentation, NO_CONDITION } from '../../src/model/weather-conditions.ts';

describe('conditionPresentation', () => {
  it('maps known conditions and humanizes unknown ones', () => {
    expect(conditionPresentation('partlycloudy')).toMatchObject({ icon: 'cloud-sun', label: 'Partly cloudy' });
    expect(conditionPresentation('dust-storm')).toEqual({ icon: 'cloud', label: 'Dust storm' });
    expect(conditionPresentation(undefined)).toBe(NO_CONDITION);
    expect(conditionPresentation('unknown')).toBe(NO_CONDITION);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'never resolves the Object.prototype member %j: it is an unknown condition with a real icon',
    (condition) => {
      const presentation = conditionPresentation(condition);
      expect(presentation.icon).toBe('cloud');
      expect(Object.hasOwn(ICONS, presentation.icon)).toBe(true);
      expect(typeof presentation.label).toBe('string');
      expect(conditionIcon(condition, true)).toBe('cloud');
    },
  );
});
