import { describe, expect, it } from 'vitest';
import { FAN_FEATURE, hasFeatures, MEDIA_PLAYER_FEATURE } from '../../src/ha/features.ts';

describe('hasFeatures (§7.1 capability: all bits of any listed mask)', () => {
  it('requires nothing for an empty list', () => {
    expect(hasFeatures(undefined, [])).toBe(true);
  });

  it('accepts when any one mask is fully present', () => {
    const presetOnly = FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_ON;
    expect(hasFeatures(presetOnly, [FAN_FEATURE.SET_SPEED, FAN_FEATURE.PRESET_MODE])).toBe(true);
    expect(hasFeatures(presetOnly, [FAN_FEATURE.SET_SPEED])).toBe(false);
  });

  it('requires every bit of a combined mask', () => {
    const transport = MEDIA_PLAYER_FEATURE.PLAY | MEDIA_PLAYER_FEATURE.PAUSE;
    expect(hasFeatures(MEDIA_PLAYER_FEATURE.PLAY, [transport])).toBe(false);
    expect(hasFeatures(transport | MEDIA_PLAYER_FEATURE.VOLUME_SET, [transport])).toBe(true);
  });

  it('supports nothing when supported_features is missing or malformed', () => {
    for (const malformed of [undefined, null, '8', 1.5, Number.NaN]) {
      expect(hasFeatures(malformed, [FAN_FEATURE.PRESET_MODE])).toBe(false);
    }
  });
});
