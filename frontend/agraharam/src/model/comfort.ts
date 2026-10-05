/**
 * Comfort selectors (§4.8, §6.2.1, §7.1): climate, air purifier and bed tiles, the panel's summary pill and the
 * overview budget. Pure; every control's Availability comes from the gateway plus the device's own feature bits.
 *
 * Bed tiles are read-only by construction: BedTileVM has no control fields and nothing here evaluates an action
 * for a bed entity.
 */
import type { EntityId, Ref } from '../config/schema.ts';
import type { ActionKey, ActionStatus } from '../ha/actions/types.ts';
import { CLIMATE_FEATURE, hasFeatures } from '../ha/features.ts';
import type { Formatter } from '../ha/host.ts';
import { ABSENT_LABELS, normalizeEntity, numericDisplay, parseNumericValue, readableEntity } from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { selectAirTile } from './air.ts';
import { humanizeOption, selectChoice, stringList } from './choice.ts';
import { entityActionKey, gatedAvailability } from './controls.ts';
import { CONTENT_BUDGET } from './budget.ts';
import { friendlyName, type Display, type Tone } from './display.ts';
import { stepValue, temperatureGrid } from '../domain/steps.ts';
import type { AirTileVM, BedTileVM, ChoiceVM, ClimateTileVM, ComfortVM, SelectorInput, StepperVM } from './types.ts';

const CLIMATE_FALLBACK_NAME = 'Climate';
const BED_FALLBACK_NAME = 'Bed';

/** HA's own labels for the core HVAC modes; anything else is humanized from the raw value. */
const HVAC_MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  off: 'Off',
  heat: 'Heat',
  cool: 'Cool',
  heat_cool: 'Heat/Cool',
  auto: 'Auto',
  dry: 'Dry',
  fan_only: 'Fan only',
});

/** hvac_action words for the tile line; cooling and heating read "Cooling to 72°" (§4.8). */
const HVAC_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  cooling: 'Cooling',
  heating: 'Heating',
  drying: 'Drying',
  fan: 'Fan running',
  idle: 'Idle',
  preheating: 'Preheating',
  defrosting: 'Defrosting',
  off: 'Off',
});

/** The panel pill reads like the reference's "74° inside": the indoor temperature, in neutral ink (§16.14). */
const SUMMARY_SUFFIX = 'inside';
const SUMMARY_TONE: Tone = 'neutral';

export type ComfortTile =
  | { readonly kind: 'climate'; readonly vm: ClimateTileVM }
  | { readonly kind: 'air'; readonly vm: AirTileVM }
  | { readonly kind: 'bed'; readonly vm: BedTileVM };

/** Every comfort tile in overview order: climate first, then air, then bed (§6.2.1). The drawer lists them all. */
export function selectComfortTiles(input: SelectorInput): readonly ComfortTile[] {
  const { config } = input;
  return [
    ...config.climate.map((ref): ComfortTile => ({ kind: 'climate', vm: selectClimateTile(input, ref) })),
    ...config.air.map((ref): ComfortTile => ({ kind: 'air', vm: selectAirTile(input, ref, 'air') })),
    ...config.bedComfort.map((ref): ComfortTile => ({ kind: 'bed', vm: selectBedTile(input, ref) })),
  ];
}

/**
 * Cuts every comfort tile (in overview order) to the panel budget and derives the summary pill. The root may raise the
 * budget to CONTENT_BUDGET.comfortTilesRoomy when the panel's column has spare height (§16.14).
 */
export function comfortOverview(
  tiles: readonly ComfortTile[],
  budget: number = CONTENT_BUDGET.comfortTiles,
): ComfortVM {
  const shown = tiles.slice(0, budget);
  const summary = comfortSummary(tiles);
  return {
    ...(summary !== undefined && { summary }),
    climate: shown.flatMap((tile) => (tile.kind === 'climate' ? [tile.vm] : [])),
    air: shown.flatMap((tile) => (tile.kind === 'air' ? [tile.vm] : [])),
    bed: shown.flatMap((tile) => (tile.kind === 'bed' ? [tile.vm] : [])),
    overflow: tiles.length - shown.length,
  };
}

/** Every configured comfort entity, for store subscriptions. */
export function comfortEntityIds(config: SelectorInput['config']): readonly EntityId[] {
  return [...config.climate, ...config.air, ...config.bedComfort].map((ref) => ref.entity);
}

/** Action keys of the controllable comfort entities (bed entities are never actionable). */
export function comfortActionKeys(config: SelectorInput['config']): readonly ActionKey[] {
  return [...config.climate, ...config.air].map((ref) => entityActionKey(ref.entity));
}

/**
 * "74° inside": the live current temperature of the first configured climate device that reports one (the primary
 * thermostat). What the equipment is doing ("Cooling to 72°") stays on its tile. Stale, absent or loading readings
 * never fill the pill, so it never claims a temperature it does not know.
 */
export function comfortSummary(tiles: readonly ComfortTile[]): ComfortVM['summary'] {
  for (const tile of tiles) {
    if (tile.kind !== 'climate' || tile.vm.status !== 'available') continue;
    const current = tile.vm.current;
    if (current.kind === 'value' && !current.stale) {
      return { label: `${current.text} ${SUMMARY_SUFFIX}`, tone: SUMMARY_TONE };
    }
  }
  return undefined;
}

function hvacModeLabel(mode: string): string {
  return HVAC_MODE_LABELS[mode] ?? humanizeOption(mode);
}

export function selectClimateTile(input: SelectorInput, ref: Ref): ClimateTileVM {
  const id = ref.entity;
  const normalized = normalizeEntity(input.store, id);
  const name = friendlyName(input.store, id, ref.name, CLIMATE_FALLBACK_NAME);
  const formatter = input.reader.formatter();
  const entity = readableEntity(normalized);
  const pending = input.gateway.status(entityActionKey(id));
  const current = numericDisplay(normalized, (e) => e.attributes['current_temperature'], tileTemperature(formatter));
  if (entity === undefined) {
    return {
      key: id,
      name,
      status: normalized.status,
      current,
      modeLabel: absentLabel(normalized.status),
      ...pendingOf(pending),
    };
  }
  const supportsTarget = hasFeatures(entity.attributes['supported_features'], [CLIMATE_FEATURE.TARGET_TEMPERATURE]);
  const target = supportsTarget
    ? numericDisplay(normalized, (e) => e.attributes['temperature'], tileTemperature(formatter))
    : undefined;
  const action = typeof entity.attributes['hvac_action'] === 'string' ? entity.attributes['hvac_action'] : undefined;
  const modeLabel = hvacModeLabel(entity.state);
  const actionLabel = climateActionLabel(entity.state, modeLabel, action, target);
  const setTemperature = supportsTarget ? selectSetTemperature(input, id, entity, name, formatter) : undefined;
  const hvacModes = selectHvacModes(input, id, entity, name, pending);
  return {
    key: id,
    name,
    status: normalized.status,
    current,
    ...(target !== undefined && { target }),
    modeLabel,
    ...(action !== undefined && { action }),
    ...(actionLabel !== undefined && { actionLabel }),
    ...(setTemperature !== undefined && { setTemperature }),
    ...(hvacModes !== undefined && { hvacModes }),
    ...pendingOf(pending),
  };
}

export function selectBedTile(input: SelectorInput, ref: Ref): BedTileVM {
  const id = ref.entity;
  const normalized = normalizeEntity(input.store, id);
  const format = tileTemperature(input.reader.formatter());
  const entity = readableEntity(normalized);
  const hasTarget = entity !== undefined && entity.attributes['temperature'] !== undefined;
  return {
    key: id,
    name: friendlyName(input.store, id, ref.name, BED_FALLBACK_NAME),
    status: normalized.status,
    current: numericDisplay(normalized, (e) => e.attributes['current_temperature'], format),
    ...(hasTarget && { target: numericDisplay(normalized, (e) => e.attributes['temperature'], format) }),
  };
}

/** Compact tile temperatures read "74°" (the reference style); the full unit appears beside the stepper. */
function tileTemperature(formatter: Formatter): (value: number) => string {
  return (value) => formatter.temperature(value, undefined);
}

function absentLabel(status: ClimateTileVM['status']): string {
  return status === 'available' ? ABSENT_LABELS['no-data'] : ABSENT_LABELS[status];
}

function pendingOf(pending: ActionStatus | undefined): { readonly pending?: ActionStatus } {
  return pending === undefined ? {} : { pending };
}

/**
 * The tile's second line: "Cooling to 72°" or "Heating to 68°" from hvac_action; other actions read "Idle, set to
 * 72°"; without hvac_action the mode stands in ("Cool, set to 72°"). Off is just "Off".
 */
function climateActionLabel(
  mode: string,
  modeLabel: string,
  action: string | undefined,
  target: Display | undefined,
): string | undefined {
  const targetText = target?.kind === 'value' ? target.text : undefined;
  if (action === 'cooling' || action === 'heating') {
    const word = HVAC_ACTION_LABELS[action] ?? action;
    return targetText === undefined ? word : `${word} to ${targetText}`;
  }
  if (action === 'off' || (action === undefined && mode === 'off')) return 'Off';
  const word = action === undefined ? modeLabel : (HVAC_ACTION_LABELS[action] ?? humanizeOption(action));
  return targetText === undefined ? word : `${word}, set to ${targetText}`;
}

/**
 * The target stepper (§7.1, §7.2): present only with TARGET_TEMPERATURE and a numeric target. Its availability is
 * evaluated with a value the stepper can actually produce, so an off-grid observed target never reads invalid.
 */
function selectSetTemperature(
  input: SelectorInput,
  entity: EntityId,
  state: HassEntityLike,
  name: string,
  formatter: Formatter,
): StepperVM | undefined {
  const value = parseNumericValue(state.attributes['temperature']);
  const grid = temperatureGrid(state.attributes, formatter.temperatureUnit);
  if (value === null || grid === undefined) return undefined;
  const up = stepValue(value, 1, grid);
  const probe = up !== value ? up : stepValue(value, -1, grid);
  return {
    value,
    ...grid,
    unit: formatter.temperatureUnit,
    availability: gatedAvailability(
      input.gateway,
      { kind: 'climate.set_temperature', entity, temperature: probe },
      true,
      name,
    ),
  };
}

/** HVAC modes come from the entity's own `hvac_modes` list and are sent verbatim (§7.1 "∈ hvac_modes"). */
function selectHvacModes(
  input: SelectorInput,
  entity: EntityId,
  state: HassEntityLike,
  name: string,
  pending: ActionStatus | undefined,
): ChoiceVM | undefined {
  const values = stringList(state.attributes['hvac_modes']);
  if (values.length === 0) return undefined;
  return selectChoice(input.gateway, {
    label: 'Mode',
    kind: 'mode',
    values,
    current: values.includes(state.state) ? state.state : undefined,
    labelOf: hvacModeLabel,
    request: (mode) => ({ kind: 'climate.set_hvac_mode', entity, mode }),
    deviceName: name,
    pending,
  });
}
