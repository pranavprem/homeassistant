/**
 * HA core 2026.9.2 capability facts used by the action catalog (§7.1), the selectors and the forecast controller
 * (§9.2): `supported_features` bit values and the light color modes that take a brightness. `as const` objects
 * rather than TS enums, so the file stays erasable syntax. One implementation per predicate, so the gateway and the
 * selectors can never disagree about what a device supports.
 */

export const CLIMATE_FEATURE = Object.freeze({ TARGET_TEMPERATURE: 1 } as const);

export const FAN_FEATURE = Object.freeze({
  SET_SPEED: 1,
  PRESET_MODE: 8,
  TURN_OFF: 16,
  TURN_ON: 32,
} as const);

export const VACUUM_FEATURE = Object.freeze({ PAUSE: 4, RETURN_HOME: 16, START: 8192 } as const);

export const COVER_FEATURE = Object.freeze({ OPEN: 1, CLOSE: 2 } as const);

export const MEDIA_PLAYER_FEATURE = Object.freeze({
  PAUSE: 1,
  VOLUME_SET: 4,
  VOLUME_MUTE: 8,
  PREVIOUS_TRACK: 16,
  NEXT_TRACK: 32,
  SELECT_SOURCE: 2048,
  PLAY: 16384,
} as const);

export const WEATHER_FEATURE = Object.freeze({
  FORECAST_DAILY: 1,
  FORECAST_HOURLY: 2,
  FORECAST_TWICE_DAILY: 4,
} as const);

/**
 * True when `supportedFeatures` contains ALL bits of ANY mask in `requires` (§7.1 "Capability"); an empty list
 * requires nothing. A missing or malformed `supported_features` attribute supports nothing.
 */
export function hasFeatures(supportedFeatures: unknown, requires: readonly number[]): boolean {
  if (requires.length === 0) return true;
  const supported =
    typeof supportedFeatures === 'number' && Number.isSafeInteger(supportedFeatures) ? supportedFeatures : 0;
  return requires.some((mask) => (supported & mask) === mask);
}

/** Core light color modes that support brightness: everything but onoff and unknown (§7.1 light.set_brightness). */
const BRIGHTNESS_COLOR_MODES: ReadonlySet<string> = new Set([
  'brightness',
  'color_temp',
  'hs',
  'xy',
  'rgb',
  'rgbw',
  'rgbww',
  'white',
]);

/** True when the light's `supported_color_modes` include one that takes a brightness. */
export function supportsBrightness(attributes: Readonly<Record<string, unknown>>): boolean {
  const modes = attributes['supported_color_modes'];
  return Array.isArray(modes) && modes.some((mode) => typeof mode === 'string' && BRIGHTNESS_COLOR_MODES.has(mode));
}
