/**
 * Garage and car selector (§4.8, §8.5). The door shows its actual position with explicit Open and Close actions
 * whose availability comes from the gateway; the vehicle is read-only telemetry. Each part exists only when it is
 * configured, so an unconnected vehicle stays absent instead of looking live.
 */
import { domainOf } from '../config/entity-id.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import type { ActionGateway, ActionRequest, Availability } from '../ha/actions/types.ts';
import type { Formatter } from '../ha/host.ts';
import {
  normalizeEntity,
  numericDisplay,
  parseNumericValue,
  textDisplay,
  type NormalizedEntity,
} from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { absentDisplay, valueDisplay, type Display, type EntityStatus, type Tone } from './display.ts';
import type { GarageDoorVM, GarageVM, SelectorInput, VehicleVM } from './types.ts';
import { GARAGE_STATE_UNKNOWN_COPY } from '../ha/actions/messages.ts';

type GarageConfig = NonNullable<ResolvedConfig['garage']>;
type VehicleConfig = NonNullable<ResolvedConfig['vehicle']>;
type DoorPosition = GarageDoorVM['position'];

const DOOR_POSITION_LABELS: Readonly<Record<DoorPosition, string>> = Object.freeze({
  closed: 'Closed',
  open: 'Open',
  opening: 'Opening',
  closing: 'Closing',
  unknown: 'Position unknown',
});

/** Door labels for states that carry no position (§8.5). 'unknown' reads "Position unknown", never "Unknown". */
const DOOR_STATUS_LABELS: Readonly<Partial<Record<EntityStatus, string>>> = Object.freeze({
  unavailable: 'Unavailable',
  'missing-binding': 'Not found',
  disconnected: 'Offline',
  loading: 'Loading',
  'permission-denied': 'No access',
});

/** A closed door is the calm state; an open or moving door deserves attention; anything uncertain reads muted. */
const DOOR_POSITION_TONES: Readonly<Record<DoorPosition, Tone>> = Object.freeze({
  closed: 'neutral',
  open: 'attention',
  opening: 'attention',
  closing: 'attention',
  unknown: 'muted',
});

const MOVING_POSITIONS: ReadonlySet<DoorPosition> = new Set(['opening', 'closing']);
const KNOWN_POSITIONS: ReadonlySet<string> = new Set(['open', 'closed', 'opening', 'closing']);

/** The gateway's precondition text ("Already open") misreads a moving door, so the panel words that case itself. */
export const DOOR_MOVING_REASON = 'The door is moving. Wait for it to stop before using it again.';
/**
 * A door that reports no position offers no Open or Close button at all (two disabled buttons still read as an
 * offer), only this one line (§8.5, §16.14).
 */
export const DOOR_POSITION_UNKNOWN_LINE = 'Position unknown. Check the garage before using it from here.';

const OPEN_REQUEST: ActionRequest = Object.freeze({ kind: 'garage.open' });
const CLOSE_REQUEST: ActionRequest = Object.freeze({ kind: 'garage.close' });

const PERCENT_MAX = 100;
/** Charger states, lowercased, that mean energy is flowing into the vehicle right now. */
const CHARGING_SENSOR_STATES: ReadonlySet<string> = new Set(['charging']);
const BINARY_CHARGING_TEXT = Object.freeze({ on: 'Charging', off: 'Not charging' });

export function selectGarage(input: SelectorInput): GarageVM {
  const { config } = input;
  return {
    ...(config.garage !== undefined && { door: selectDoor(input, config.garage) }),
    ...(config.vehicle !== undefined && { vehicle: selectVehicle(input, config.vehicle) }),
  };
}

function selectDoor(input: SelectorInput, garage: GarageConfig): GarageDoorVM {
  const cover = normalizeEntity(input.store, garage.cover);
  const position = doorPosition(cover);
  const status = cover.status;
  const label = doorLabel(status, position);
  const tone = status === 'available' ? DOOR_POSITION_TONES[position] : 'muted';
  const pending = input.gateway.status('garage');
  const base = { name: garage.name, status, position, label, tone, ...(pending !== undefined && { pending }) };
  if (status === 'loading') return base;
  // §8.5: "Open garage" when closed, "Close garage" when open; both, disabled with the reason, otherwise.
  const offerOpen = position !== 'open';
  const offerClose = position !== 'closed';
  return {
    ...base,
    ...(offerOpen && { open: doorAvailability(input.gateway, OPEN_REQUEST, position) }),
    ...(offerClose && { close: doorAvailability(input.gateway, CLOSE_REQUEST, position) }),
  };
}

/** The live position, or the last known one while disconnected; anything HA does not define reads unknown. */
function doorPosition(cover: NormalizedEntity): DoorPosition {
  const readable = cover.status === 'available' || cover.status === 'disconnected';
  const state = readable ? cover.entity?.state : undefined;
  return state !== undefined && KNOWN_POSITIONS.has(state) ? (state as DoorPosition) : 'unknown';
}

/** A stale door keeps its last known position (the panel adds "Last known"); without one it reads Offline. */
function doorLabel(status: EntityStatus, position: DoorPosition): string {
  if (status === 'available' || status === 'unknown') return DOOR_POSITION_LABELS[position];
  if (status === 'disconnected' && position !== 'unknown') return DOOR_POSITION_LABELS[position];
  return DOOR_STATUS_LABELS[status] ?? DOOR_POSITION_LABELS.unknown;
}

function doorAvailability(gateway: ActionGateway, request: ActionRequest, position: DoorPosition): Availability {
  const availability = gateway.evaluate(request);
  if (availability.enabled || availability.reason !== 'not-applicable') return availability;
  if (MOVING_POSITIONS.has(position)) return { ...availability, message: DOOR_MOVING_REASON };
  // A state HA covers do not define (for example "stopped") reads "Position unknown"; the precondition text
  // ("Already open", "Already closed") would contradict that label, so the unknown-position copy explains it.
  if (position === 'unknown') return { ...availability, message: GARAGE_STATE_UNKNOWN_COPY };
  return availability;
}

function selectVehicle(input: SelectorInput, vehicle: VehicleConfig): VehicleVM {
  const formatter = input.reader.formatter();
  const battery = normalizeEntity(input.store, vehicle.battery);
  const range = normalizeEntity(input.store, vehicle.range);
  const charger = selectCharger(input, vehicle, formatter);
  return {
    name: vehicle.name,
    battery: numericDisplay(battery, readState, (value) => formatPercent(formatter, value)),
    batteryPct: batteryPercent(battery),
    range: numericDisplay(range, readState, (value) => formatSensor(formatter, range, value)),
    ...(vehicle.chargeLimitPct !== undefined && { chargeLimitPct: vehicle.chargeLimitPct }),
    ...(charger !== undefined && { charger }),
  };
}

/**
 * The charger line exists when a charger status or power sensor is configured. Power is shown only while energy
 * is flowing (a parked car's "0 kW" is noise), or when charging cannot be determined, so a real reading is never
 * hidden behind an unknown status. Session energy needs one of the other two to give it context.
 */
function selectCharger(
  input: SelectorInput,
  vehicle: VehicleConfig,
  formatter: Formatter,
): VehicleVM['charger'] | undefined {
  if (vehicle.chargerStatus === undefined && vehicle.chargerPower === undefined) return undefined;
  const power = vehicle.chargerPower !== undefined ? normalizeEntity(input.store, vehicle.chargerPower) : undefined;
  const status = vehicle.chargerStatus !== undefined ? normalizeEntity(input.store, vehicle.chargerStatus) : undefined;
  const charging = status !== undefined ? isChargingStatus(status) : isDrawingPower(power);
  const statusDisplay =
    status !== undefined ? textDisplay(status, (e) => chargerStatusText(formatter, e)) : powerStatusDisplay(power);
  const showPower = power !== undefined && (charging || statusDisplay.kind === 'absent');
  const session = vehicle.sessionEnergy !== undefined ? normalizeEntity(input.store, vehicle.sessionEnergy) : undefined;
  return {
    status: statusDisplay,
    charging,
    ...(showPower && { power: numericDisplay(power, readState, (value) => formatSensor(formatter, power, value)) }),
    ...(session !== undefined && {
      session: numericDisplay(session, readState, (value) => formatSensor(formatter, session, value)),
    }),
  };
}

function readState(entity: HassEntityLike): string {
  return entity.state;
}

/** Live or last known battery percentage for the bar, clamped to the track; null draws the hatched empty track. */
function batteryPercent(battery: NormalizedEntity): number | null {
  if (battery.status !== 'available' && battery.status !== 'disconnected') return null;
  const value = parseNumericValue(battery.entity?.state);
  return value === null ? null : Math.min(PERCENT_MAX, Math.max(0, value));
}

function formatPercent(formatter: Formatter, value: number): string {
  return `${formatter.number(Math.round(value))}%`;
}

/** HA's own formatting (unit and display precision) when the entity is readable, else the bare number. */
function formatSensor(formatter: Formatter, sensor: NormalizedEntity, value: number): string {
  return sensor.entity !== undefined ? formatter.entityState(sensor.entity) : formatter.number(value);
}

function isChargingStatus(status: NormalizedEntity): boolean {
  if (status.status !== 'available' && status.status !== 'disconnected') return false;
  const state = (status.entity?.state ?? '').toLowerCase();
  return domainOf(status.id) === 'binary_sensor' ? state === 'on' : CHARGING_SENSOR_STATES.has(state);
}

function isDrawingPower(power: NormalizedEntity | undefined): boolean {
  if (power === undefined || (power.status !== 'available' && power.status !== 'disconnected')) return false;
  const value = parseNumericValue(power.entity?.state);
  return value !== null && value > 0;
}

/** Without a status sensor the line still says what the power reading means, derived from that reading only. */
function powerStatusDisplay(power: NormalizedEntity | undefined): Display {
  if (power === undefined) return absentDisplay('no-data');
  const reading = numericDisplay(power, readState, String);
  if (reading.kind === 'absent') return reading;
  return valueDisplay(isDrawingPower(power) ? BINARY_CHARGING_TEXT.on : BINARY_CHARGING_TEXT.off, power.stale);
}

/**
 * HA's translated state when the frontend provides one. The fallback formatter returns raw enum values
 * ("charging", "on"), so those are worded for people: a charging binary sensor reads "Charging"/"Not charging"
 * and a snake_case enum becomes a sentence-case phrase.
 */
function chargerStatusText(formatter: Formatter, entity: HassEntityLike): string {
  const formatted = formatter.entityState(entity);
  if (formatted !== entity.state) return formatted;
  if (domainOf(entity.entity_id) === 'binary_sensor') {
    if (entity.state === 'on') return BINARY_CHARGING_TEXT.on;
    if (entity.state === 'off') return BINARY_CHARGING_TEXT.off;
  }
  const words = entity.state.replaceAll('_', ' ').trim();
  return words === '' ? words : words.charAt(0).toUpperCase() + words.slice(1);
}
