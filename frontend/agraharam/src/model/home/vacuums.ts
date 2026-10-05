/**
 * Home robot vacuums (§4.8, §7.1, §6.2.1): activity, battery (configured or derived from the device, §4.4) and the
 * actions a vacuum's state and feature bits offer. Pure: the gateway decides every Availability.
 */
import type { EntityId, ResolvedConfig } from '../../config/schema.ts';
import type { Availability } from '../../ha/actions/types.ts';
import { deriveVacuumBatteries, vacuumDeviceEntities, type DeriveSources } from '../../ha/derive.ts';
import type { StoreView } from '../../ha/entity-store.ts';
import { hasFeatures, VACUUM_FEATURE } from '../../ha/features.ts';
import type { HostReader } from '../../ha/host.ts';
import {
  absentFor,
  normalizeEntity,
  numericDisplay,
  parseNumericValue,
  readableEntity,
  type NormalizedEntity,
} from '../../ha/normalize.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { friendlyName, type Display, type Tone } from '../display.ts';
import { selectConnection } from '../header.ts';
import type { SelectorInput, VacuumVM } from '../types.ts';

export interface HomeVacuumVM extends VacuumVM {
  /** Battery percentage for the progress bar; null when absent, never 0 (§4.6). */
  readonly batteryPct: number | null;
  readonly startLabel: 'Start' | 'Resume';
  readonly stale: boolean;
}

const VACUUM_ACTIVITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  docked: 'Docked',
  cleaning: 'Cleaning',
  returning: 'Returning to dock',
  paused: 'Paused',
  idle: 'Idle',
});
/** The error label when the vacuum does not say what is wrong. */
const VACUUM_ERROR_FALLBACK = 'Needs attention';
/**
 * The device's own error text is always shown when it gives one (the row wraps it to two lines); only a runaway
 * message is cut, at a word-agnostic code-point limit with an ellipsis, so it can never take over the panel.
 */
export const VACUUM_ERROR_MAX_CHARS = 120;
const ELLIPSIS = '…';
/**
 * While Home Assistant is still starting, a vacuum service that is not offered yet will be once it finishes; the
 * row says that in one short line instead of the general "isn't offering this control" sentence.
 */
export const VACUUM_STARTING_REASON = 'Available once Home Assistant finishes starting.';
const VACUUM_MOVING_STATES: ReadonlySet<string> = new Set(['cleaning', 'returning']);
const VACUUM_PRIORITY_ERROR = 0;
const VACUUM_PRIORITY_MOVING = 1;
const VACUUM_PRIORITY_REST = 2;

const VACUUM_FALLBACK_NAME = 'Robot vacuum';
/** A battery level is a percentage. */
const FULL_BATTERY_PCT = 100;

/**
 * Every vacuum entity Home reads, including the devices' own entities, so a battery sensor derived later (its state
 * arrives after the registry, §4.4) re-renders the section.
 */
export function vacuumEntityIds(config: ResolvedConfig, reader: HostReader | undefined): EntityId[] {
  const ids = config.vacuums.flatMap((vacuum) =>
    vacuum.batterySensor === undefined ? [vacuum.entity] : [vacuum.entity, vacuum.batterySensor],
  );
  if (reader !== undefined) {
    ids.push(...vacuumDeviceEntities(vacuumsWithoutBatterySensor(config), readerSources(reader, reader.store)));
  }
  return ids;
}

export function buildVacuum(input: SelectorInput, vacuum: ResolvedConfig['vacuums'][number]): HomeVacuumVM {
  const normalized = normalizeEntity(input.store, vacuum.entity);
  const entity = readableEntity(normalized) ?? (normalized.status === 'unknown' ? normalized.entity : undefined);
  const state = normalized.status === 'unknown' ? 'unknown' : entity?.state;
  const battery = vacuumBattery(input, vacuum);
  const pending = input.gateway.status(`entity:${vacuum.entity}`);
  const actions = state === undefined ? {} : vacuumActions(input, vacuum.entity, state, entity);
  return {
    key: vacuum.entity,
    name: friendlyName(input.store, vacuum.entity, vacuum.name, VACUUM_FALLBACK_NAME),
    status: normalized.status,
    activity: state ?? normalized.status,
    activityLabel: vacuumActivityLabel(input, normalized, entity),
    tone: vacuumTone(normalized, state),
    ...(battery !== undefined && { battery: battery.display }),
    batteryPct: battery?.pct ?? null,
    batteryDerived: battery?.derived ?? false,
    startLabel: state === 'paused' ? 'Resume' : 'Start',
    stale: normalized.stale,
    ...actions,
    ...(pending !== undefined && { pending }),
  };
}

/**
 * Actions by state and feature bits (§7.1). A missing bit hides the action; a state where it makes no sense hides
 * it too, and the gateway still decides availability (connection, preview, services, locks).
 */
function vacuumActions(
  input: SelectorInput,
  id: EntityId,
  state: string,
  entity: HassEntityLike | undefined,
): Pick<VacuumVM, 'start' | 'pause' | 'returnHome'> {
  const features = entity?.attributes['supported_features'];
  const offers = (bit: number, relevant: boolean): boolean => relevant && hasFeatures(features, [bit]);
  const starting = selectConnection(input.reader).status === 'starting';
  const evaluate = (kind: 'vacuum.start' | 'vacuum.pause' | 'vacuum.return_to_base'): Availability => {
    const availability = input.gateway.evaluate({ kind, entity: id });
    return starting && !availability.enabled && availability.reason === 'service-missing'
      ? { ...availability, message: VACUUM_STARTING_REASON }
      : availability;
  };
  // With an unknown state every supported action is shown: the gateway denies start and pause with the
  // state-unknown reason and allows return to dock (§7.1 "Unknown state"), and a disabled control that says why
  // is clearer than a missing one (§7.2).
  const unknown = state === 'unknown';
  return {
    ...(offers(VACUUM_FEATURE.START, state !== 'cleaning') && { start: evaluate('vacuum.start') }),
    ...(offers(VACUUM_FEATURE.PAUSE, unknown || VACUUM_MOVING_STATES.has(state)) && {
      pause: evaluate('vacuum.pause'),
    }),
    ...(offers(VACUUM_FEATURE.RETURN_HOME, state !== 'docked' && state !== 'returning') && {
      returnHome: evaluate('vacuum.return_to_base'),
    }),
  };
}

function vacuumActivityLabel(
  input: SelectorInput,
  normalized: NormalizedEntity,
  entity: HassEntityLike | undefined,
): string {
  if (normalized.status === 'unknown') return 'Status unknown';
  if (entity === undefined) return absentFor(normalized.status).label;
  if (entity.state === 'error') return vacuumErrorText(entity) ?? VACUUM_ERROR_FALLBACK;
  return VACUUM_ACTIVITY_LABELS[entity.state] ?? input.reader.formatter().entityState(entity);
}

/**
 * What is wrong, when the integration says ("Bin full", "Stuck"): many robot integrations put it in an `error`
 * attribute. Free text from the device, so it is trimmed, length-capped and only ever rendered as escaped text.
 */
function vacuumErrorText(entity: HassEntityLike): string | undefined {
  const raw = entity.attributes['error'];
  if (typeof raw !== 'string') return undefined;
  // Code points, not UTF-16 units, so a cut never splits an emoji into a lone surrogate.
  const characters = Array.from(raw.trim());
  if (characters.length === 0) return undefined;
  const capped =
    characters.length <= VACUUM_ERROR_MAX_CHARS
      ? characters.join('')
      : characters
          .slice(0, VACUUM_ERROR_MAX_CHARS - ELLIPSIS.length)
          .join('')
          .trimEnd() + ELLIPSIS;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function vacuumTone(normalized: NormalizedEntity, state: string | undefined): Tone {
  if (normalized.status !== 'available') return 'muted';
  if (state === 'error') return 'attention';
  return state !== undefined && VACUUM_MOVING_STATES.has(state) ? 'ok' : 'neutral';
}

/** Overview priority (§6.2.1): error, then cleaning or returning, then the rest. */
export function vacuumPriority(vacuum: HomeVacuumVM): number {
  if (vacuum.activity === 'error') return VACUUM_PRIORITY_ERROR;
  return VACUUM_MOVING_STATES.has(vacuum.activity) ? VACUUM_PRIORITY_MOVING : VACUUM_PRIORITY_REST;
}

interface VacuumBattery {
  readonly display: Display;
  readonly pct: number | null;
  readonly derived: boolean;
}

/** The configured battery sensor, else the vacuum device's own battery sensor (derived, §4.4); undefined when
 *  there is neither, so the row shows no battery rather than 0. */
function vacuumBattery(input: SelectorInput, vacuum: ResolvedConfig['vacuums'][number]): VacuumBattery | undefined {
  const derivedId =
    vacuum.batterySensor === undefined
      ? deriveVacuumBatteries([vacuum.entity], deriveSources(input)).get(vacuum.entity)
      : undefined;
  const sensor = vacuum.batterySensor ?? derivedId;
  if (sensor === undefined) return undefined;
  const normalized = normalizeEntity(input.store, sensor);
  const formatter = input.reader.formatter();
  const display = numericDisplay(
    normalized,
    (entity) => entity.state,
    (value) => `${formatter.number(value, { maximumFractionDigits: 0 })}%`,
  );
  const value = readableEntity(normalized) === undefined ? null : parseNumericValue(normalized.entity?.state);
  const pct = value === null ? null : Math.min(FULL_BATTERY_PCT, Math.max(0, value));
  return { display, pct, derived: derivedId !== undefined };
}

function deriveSources(input: SelectorInput): DeriveSources {
  return readerSources(input.reader, input.store);
}

function readerSources(reader: HostReader, store: StoreView): DeriveSources {
  return {
    registry: (id) => reader.registry(id),
    entitiesOnDevice: (deviceId) => reader.entitiesOnDevice(deviceId),
    // Only IDs the host bound or derived are readable, so derivation here agrees with the host's derived set.
    state: (id) => store.get(id),
  };
}

function vacuumsWithoutBatterySensor(config: ResolvedConfig): EntityId[] {
  return config.vacuums.filter((vacuum) => vacuum.batterySensor === undefined).map((vacuum) => vacuum.entity);
}
