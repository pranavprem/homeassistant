/**
 * Air purifier tile selector shared by Comfort and the room drawer (§16.10).
 *
 * Pure: it reads the store and asks the gateway to evaluate each control, and never requests anything. Controls are
 * gated by the entity's own feature bits as well as by the gateway, so an unsupported control is never offered.
 */
import type { EntityId, Ref } from '../config/schema.ts';
import type { ActionGateway, ActionStatus, Availability } from '../ha/actions/types.ts';
import { FAN_FEATURE, hasFeatures } from '../ha/features.ts';
import {
  absentFor,
  normalizeEntity,
  parseNumericValue,
  readableEntity,
  type NormalizedEntity,
} from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { humanizeOption, selectChoice, stringList } from './choice.ts';
import { entityActionKey, gatedAvailability } from './controls.ts';
import { absentDisplay, friendlyName, valueDisplay, type Display } from './display.ts';
import type { AirTileVM, ChoiceVM, SelectorInput, StepperVM } from './types.ts';

const FALLBACK_NAME: Readonly<Record<'air' | 'room_purifier', string>> = Object.freeze({
  air: 'Air purifier',
  room_purifier: 'Purifier',
});
/** HA fan percentages run 0–100; 0 is off, so set_percentage itself only accepts 1–100 (§7.1). */
const PERCENT_MAX = 100;
const PERCENT_MIN_REQUEST = 1;
const DEFAULT_PERCENT_STEP = 1;
/**
 * HA reports `percentage_step` as the raw float 100 / speed_count (33.333333333333336 for three speeds). As a native
 * range step that float puts 100 just past the last grid point, so the browser clamps the top to 66.67 and a fan at
 * 100% can never be shown or chosen. Truncating to six decimals keeps speed_count × step at or below 100.
 */
const STEP_PRECISION = 1e6;
/**
 * Absorbs that truncation (at most 100 × 1e-6 at the top of the grid) while staying below the smallest gap between a
 * speed's exact percentage n × 100 / speed_count and the next whole percent (1 / speed_count, at least 0.01).
 */
const GRID_TOLERANCE = 1e-3;

// ---------------------------------------------------------------------------------------------------------------
// Air purifier tile

export function selectAirTile(input: SelectorInput, ref: Ref, role: 'air' | 'room_purifier'): AirTileVM {
  const id = ref.entity;
  const normalized = normalizeEntity(input.store, id);
  const name = friendlyName(input.store, id, ref.name, FALLBACK_NAME[role]);
  const entity = readableEntity(normalized);
  const power = powerOf(entity);
  const pending = input.gateway.status(entityActionKey(id));
  const percentage = entity === undefined ? undefined : selectPercentage(input, id, entity, power, name);
  const presets = entity === undefined ? undefined : selectPresets(input, id, entity, name, pending);
  return {
    key: id,
    name,
    status: normalized.status,
    power,
    detail: fanDetail(input, normalized, entity, power),
    toggle: toggleAvailability(input.gateway, id, normalized, power, name),
    ...(percentage !== undefined && { percentage }),
    ...(presets !== undefined && { presets }),
    ...(pending !== undefined && { pending }),
  };
}

function powerOf(entity: HassEntityLike | undefined): AirTileVM['power'] {
  if (entity?.state === 'on' || entity?.state === 'off') return entity.state;
  return 'unknown';
}

/** The preset while on ("Sleep"), else the speed ("40%"), else "On"; "Off" while off. Absent states keep their own
 *  label and are never shown as 0. */
function fanDetail(
  input: SelectorInput,
  normalized: NormalizedEntity,
  entity: HassEntityLike | undefined,
  power: AirTileVM['power'],
): Display {
  if (entity === undefined) return absentFor(normalized.status);
  if (power === 'unknown') return absentDisplay('unknown');
  if (power === 'off') return valueDisplay('Off', normalized.stale);
  const preset = entity.attributes['preset_mode'];
  if (typeof preset === 'string' && preset !== '') return valueDisplay(humanizeOption(preset), normalized.stale);
  const percentage = parseNumericValue(entity.attributes['percentage']);
  if (percentage !== null && percentage > 0) {
    return valueDisplay(`${input.reader.formatter().number(Math.round(percentage))}%`, normalized.stale);
  }
  return valueDisplay('On', normalized.stale);
}

/**
 * The quick toggle chooses the opposite of the observed power (§7.2). With an unknown state both explicit actions
 * must be allowed, so the toggle is enabled only when turning on AND turning off are.
 */
function toggleAvailability(
  gateway: ActionGateway,
  entity: EntityId,
  normalized: NormalizedEntity,
  power: AirTileVM['power'],
  name: string,
): Availability {
  // Without a state object (missing, loading, unavailable) the bits are unknown and the gateway's reason stands.
  const known = normalized.entity;
  const supports = (bit: number): boolean =>
    known === undefined || hasFeatures(known.attributes['supported_features'], [bit]);
  const turnOn = (): Availability =>
    gatedAvailability(gateway, { kind: 'fan.turn_on', entity }, supports(FAN_FEATURE.TURN_ON), name);
  const turnOff = (): Availability =>
    gatedAvailability(gateway, { kind: 'fan.turn_off', entity }, supports(FAN_FEATURE.TURN_OFF), name);
  if (power === 'on') return turnOff();
  if (power === 'off') return turnOn();
  const on = turnOn();
  if (!on.enabled || normalized.status !== 'unknown') return on;
  return turnOff();
}

/**
 * A speed slider up to 100 on the device's speed grid. Position 0 means off (dragging there turns the fan off), so
 * it is offered only when the device supports TURN_OFF; otherwise the track starts at the first speed.
 */
function selectPercentage(
  input: SelectorInput,
  entity: EntityId,
  state: HassEntityLike,
  power: AirTileVM['power'],
  name: string,
): StepperVM | undefined {
  const features = state.attributes['supported_features'];
  if (!hasFeatures(features, [FAN_FEATURE.SET_SPEED])) return undefined;
  const observed = parseNumericValue(state.attributes['percentage']);
  const value = observed ?? (power === 'off' ? 0 : null);
  if (value === null) return undefined;
  const step = percentageStep(state);
  return {
    value,
    min: hasFeatures(features, [FAN_FEATURE.TURN_OFF]) ? 0 : step,
    max: PERCENT_MAX,
    step,
    unit: '%',
    availability: gatedAvailability(
      input.gateway,
      { kind: 'fan.set_percentage', entity, percentage: speedPercentage(step) },
      true,
      name,
    ),
  };
}

/**
 * The slider's grid step: `percentage_step` when it is a usable fraction of 100, truncated to six decimals so that
 * speed_count × step never exceeds 100 and the native range can reach its top grid point (see STEP_PRECISION).
 */
function percentageStep(state: HassEntityLike): number {
  const raw = parseNumericValue(state.attributes['percentage_step']);
  if (raw === null || raw <= 0 || raw > PERCENT_MAX) return DEFAULT_PERCENT_STEP;
  const step = Math.floor(raw * STEP_PRECISION) / STEP_PRECISION;
  return step > 0 ? step : DEFAULT_PERCENT_STEP;
}

/**
 * The whole percentage HA expects for a slider position: 0 (off) at or below 0, else HA's own value for that speed,
 * floor(n × 100 / speed_count), as HA core (util/percentage.py) and its frontend (data/fan.ts) compute it, clamped to
 * set_percentage's 1–100. Rounding instead would send 67 for speed 2 of 3, which HA maps to speed 3. Whole
 * percentages map to themselves, so drafts compare equal to the observed `percentage`.
 */
export function speedPercentage(position: number): number {
  if (position <= 0) return 0;
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN_REQUEST, Math.floor(position + GRID_TOLERANCE)));
}

/** Presets need PRESET_MODE or SET_SPEED (§7.1) and a non-empty `preset_modes` list; values are sent verbatim. */
function selectPresets(
  input: SelectorInput,
  entity: EntityId,
  state: HassEntityLike,
  name: string,
  pending: ActionStatus | undefined,
): ChoiceVM | undefined {
  const features = state.attributes['supported_features'];
  if (!hasFeatures(features, [FAN_FEATURE.PRESET_MODE, FAN_FEATURE.SET_SPEED])) return undefined;
  const values = stringList(state.attributes['preset_modes']);
  if (values.length === 0) return undefined;
  const current = state.attributes['preset_mode'];
  return selectChoice(input.gateway, {
    label: 'Preset',
    kind: 'preset',
    values,
    current: typeof current === 'string' ? current : undefined,
    labelOf: humanizeOption,
    request: (preset) => ({ kind: 'fan.set_preset_mode', entity, preset }),
    deviceName: name,
    pending,
  });
}
