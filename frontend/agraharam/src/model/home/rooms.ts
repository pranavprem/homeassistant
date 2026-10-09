/**
 * Home rooms (§4.8, §7.1, §18): each room's lights, lighting switches, curtains and purifier, its summary and tone,
 * and the explicit room actions. Pure: every Availability comes from gateway.evaluate() and every ticket from
 * gateway.status().
 *
 * A room's "lighting items" are its lights plus every switch that may be a lamp; a settings switch (registry
 * entity_category config or diagnostic) is shown read-only and never counted.
 */
import type { EntityId, ResolvedConfig } from '../../config/schema.ts';
import { ACTION_CATALOG } from '../../ha/actions/catalog.ts';
import { GARAGE_LIKE_COVER_COPY, REGISTRY_PENDING_COPY, SETTINGS_SWITCH_COPY } from '../../ha/actions/messages.ts';
import type { ActionKey, Availability } from '../../ha/actions/types.ts';
import type { StoreView } from '../../ha/entity-store.ts';
import { supportsBrightness } from '../../ha/features.ts';
import {
  absentFor,
  normalizeEntity,
  parseNumericValue,
  readableEntity,
  type NormalizedEntity,
} from '../../ha/normalize.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { selectAirTile } from '../air.ts';
import { friendlyName, type EntityStatus, type Tone } from '../display.ts';
import type { CurtainVM, LightVM, RoomVM, SelectorInput, SwitchVM } from '../types.ts';

export interface HomeLightVM extends LightVM {
  /** Unknown state: two explicit buttons instead of a toggle (§7.2); both light kinds allow an unknown state. */
  readonly explicit?: { readonly on: Availability; readonly off: Availability };
}

export interface HomeSwitchVM extends SwitchVM {
  /** Unknown state: two explicit buttons instead of a toggle (§7.2); both switch kinds allow an unknown state. */
  readonly explicit?: { readonly on: Availability; readonly off: Availability };
  /** A settings or diagnostic switch (§4.7 step 5b): read-only, `reason` says why, and never counted as lighting. */
  readonly readOnly: boolean;
  readonly reason?: string;
}

export interface HomeCurtainVM extends CurtainVM {
  /** Garage, gate and door covers render read-only in a room (§4.7 step 5a); `reason` says why. */
  readonly readOnly: boolean;
  readonly reason?: string;
}

/** 'loading' before the first state arrives, 'stale' while showing last known values, else 'live'. */
type Freshness = 'loading' | 'live' | 'stale';

export interface HomeRoomVM extends RoomVM {
  readonly lights: readonly HomeLightVM[];
  readonly switches: readonly HomeSwitchVM[];
  readonly curtains: readonly HomeCurtainVM[];
  readonly freshness: Freshness;
  /** The explicit room actions the room drawer offers next to the quick toggle. */
  readonly allOn?: Availability;
  readonly allOff?: Availability;
  /** Set only while waiting for HA's device list is why the room's actions are disabled (§18). */
  readonly registryNotice?: string;
}

/** What room counts read from a light or a lighting switch. */
type LightingItem = Pick<LightVM, 'status' | 'on'>;

/** HA brightness is 0–255; the UI and light.set_brightness speak percent. */
const BRIGHTNESS_PER_PERCENT = 255 / 100;
const FULL_BRIGHTNESS_PCT = 100;

/**
 * Covers that room controls never move (§4.7 step 5a). Read from the action catalog, so the room drawer and the
 * gateway's step-5a refusal can never disagree about which covers they are.
 */
const GARAGE_CLASS_COVERS: ReadonlySet<string> = new Set([
  ...(ACTION_CATALOG['curtain.open'].refusedDeviceClasses ?? []),
  ...(ACTION_CATALOG['curtain.close'].refusedDeviceClasses ?? []),
]);
const FULLY_OPEN_PCT = 100;
/** Read from the catalog, so the room drawer and the gateway's step-5b refusal can never disagree. */
const SETTINGS_SWITCH_CATEGORIES: ReadonlySet<string> = new Set(
  ACTION_CATALOG['switch.turn_on'].refusedEntityCategories ?? [],
);
const NOT_REPORTING: ReadonlySet<EntityStatus> = new Set(['unavailable', 'missing-binding', 'unknown']);
const MISSING_LIGHT_NAME = 'Light';
const MISSING_SWITCH_NAME = 'Switch';

export function roomEntityIds(config: ResolvedConfig, index: number): EntityId[] {
  const room = config.rooms[index];
  if (room === undefined) return [];
  return [...room.lights, ...room.switches, ...room.curtains, ...(room.purifier === undefined ? [] : [room.purifier])];
}

/** Ticket keys the room drawer watches: the room, each light, switch and curtain, and the purifier. */
export function roomActionKeys(config: ResolvedConfig, index: number): ActionKey[] {
  if (config.rooms[index] === undefined) return [];
  const entityKeys = roomEntityIds(config, index).map((id): ActionKey => `entity:${id}`);
  return [`room:${index}`, ...entityKeys];
}

/** One room for the room drawer; undefined when the index is not configured (a config change closed it). */
export function selectRoom(input: SelectorInput, index: number): HomeRoomVM | undefined {
  return input.config.rooms[index] === undefined ? undefined : buildRoom(input, index);
}

export function buildRoom(input: SelectorInput, index: number): HomeRoomVM {
  const room = input.config.rooms[index];
  if (room === undefined) throw new RangeError('room index out of range');
  const lights = room.lights.map((id, position) => buildLight(input, id, position));
  const switches = room.switches.map((id, position) => buildSwitch(input, id, position));
  const curtains = room.curtains.map((id) => buildCurtain(input, id));
  const lighting: readonly LightingItem[] = [...lights, ...switches.filter((item) => !item.readOnly)];
  const freshness = roomFreshness(input);
  const counts = countLights(lighting, freshness);
  const lightsOn = counts.on;
  const pending = input.gateway.status(`room:${index}`);
  const actions = lighting.length > 0 ? roomActions(input, index, lightsOn) : undefined;
  const registryNotice = switches.length > 0 ? roomRegistryNotice(input, actions) : undefined;
  return {
    index,
    name: room.name,
    summary: roomSummary(lighting, counts, freshness),
    tone: roomTone(lighting, counts, freshness),
    lightsOn,
    lightsTotal: lighting.length,
    lightsUnavailable: lighting.filter((item) => item.status === 'unavailable' || item.status === 'missing-binding')
      .length,
    lights,
    switches,
    curtains,
    freshness,
    ...actions,
    ...(registryNotice !== undefined && { registryNotice }),
    ...(room.purifier !== undefined && { purifier: selectAirTile(input, { entity: room.purifier }, 'room_purifier') }),
    ...(pending !== undefined && { pending }),
  };
}

/**
 * The registry notice, only when it is the effective reason the room's actions are disabled (§18): with controls
 * off, in preview or while disconnected the shared notice already says why, and a second line would flash on every
 * page load. While HA's registry is pending, the gateway refuses a room with switches at step 5b, before any state
 * check, so `state-unknown` there can only be that wait.
 */
function roomRegistryNotice(
  input: SelectorInput,
  actions: Pick<HomeRoomVM, 'allOn' | 'allOff'> | undefined,
): string | undefined {
  if (input.reader.registryLoaded() || actions === undefined) return undefined;
  const waiting = [actions.allOn, actions.allOff].some(
    (availability) => availability !== undefined && !availability.enabled && availability.reason === 'state-unknown',
  );
  return waiting ? REGISTRY_PENDING_COPY.notice : undefined;
}

function roomActions(
  input: SelectorInput,
  room: number,
  lightsOn: number,
): Pick<HomeRoomVM, 'quickToggle' | 'allOn' | 'allOff'> {
  const allOn = input.gateway.evaluate({ kind: 'room.lights_on', room });
  const allOff = input.gateway.evaluate({ kind: 'room.lights_off', room });
  // One explicit call, never a per-light toggle: any light on turns the room's available lights off (§7.1).
  const next = lightsOn > 0 ? 'off' : 'on';
  return { quickToggle: { next, availability: next === 'off' ? allOff : allOn }, allOn, allOff };
}

function roomFreshness(input: SelectorInput): Freshness {
  if (!input.store.isReady()) return 'loading';
  return input.store.isConnected() ? 'live' : 'stale';
}

/** How a room's lighting items split by what is actually known about them (ACCEPTANCE item 3: states stay distinct). */
interface LightCounts {
  /** Items known to be on (live, or last known while the whole connection is down). */
  readonly on: number;
  /** Items HA has not delivered yet while it starts: "Loading", never "Off". */
  readonly loading: number;
  /** Items that exist in the configuration but are not reporting a usable state right now. */
  readonly notReporting: readonly LightingItem[];
}

function countLights(lights: readonly LightingItem[], freshness: Freshness): LightCounts {
  return {
    on: lights.filter((light) => light.on === true).length,
    loading: lights.filter((light) => light.status === 'loading').length,
    notReporting: lights.filter((light) => isNotReporting(light, freshness)),
  };
}

/**
 * Unavailable, missing and unknown lights are not reporting. So is a light that is still 'disconnected' while the
 * store is live: the post-reconnect snapshot did not replace it (§16.10), so HA no longer reports it.
 */
function isNotReporting(light: LightingItem, freshness: Freshness): boolean {
  return NOT_REPORTING.has(light.status) || (freshness === 'live' && light.status === 'disconnected');
}

function roomSummary(lights: readonly LightingItem[], counts: LightCounts, freshness: Freshness): string {
  if (freshness === 'loading') return 'Loading';
  if (lights.length === 0) return 'No lights';
  // While HA starts, lights that have not arrived read "Loading": never "Off" for a light nobody has reported.
  if (counts.loading === lights.length) return 'Loading';
  const { notReporting } = counts;
  if (notReporting.length === lights.length) return allNotReportingLabel(notReporting);
  const caveats = [
    ...(notReporting.length > 0 ? [`${notReporting.length} ${notReportingWord(notReporting)}`] : []),
    ...(counts.loading > 0 ? [`${counts.loading} loading`] : []),
  ];
  if (caveats.length > 0) return [counts.on === 0 ? 'Off' : `${counts.on} on`, ...caveats].join(', ');
  if (counts.on === 0) return 'Off';
  if (counts.on === lights.length) return lights.length === 1 ? 'On' : 'All on';
  return `${counts.on} of ${lights.length} on`;
}

function notReportingWord(lights: readonly LightingItem[]): string {
  return lights.every((light) => light.status === 'unavailable' || light.status === 'missing-binding')
    ? 'unavailable'
    : 'not reporting';
}

function allNotReportingLabel(lights: readonly LightingItem[]): string {
  const first = lights[0]?.status;
  if (lights.every((light) => light.status === first)) {
    if (first === 'missing-binding') return 'Not found';
    if (first === 'unknown') return 'Unknown';
    if (first === 'unavailable') return 'Unavailable';
  }
  return 'Not reporting';
}

/** Muted whenever the room's lights are not all known; attention only for lights that stopped reporting. */
function roomTone(lights: readonly LightingItem[], counts: LightCounts, freshness: Freshness): Tone {
  if (freshness !== 'live') return 'muted';
  if (lights.length === 0) return 'neutral';
  if (counts.loading === lights.length || counts.notReporting.length === lights.length) return 'muted';
  if (counts.notReporting.length > 0) return 'attention';
  if (counts.loading > 0) return 'muted';
  return counts.on > 0 ? 'ok' : 'neutral';
}

function buildLight(input: SelectorInput, id: EntityId, position: number): HomeLightVM {
  const normalized = normalizeEntity(input.store, id);
  const entity = lightReading(input.store, normalized);
  const on = entity === undefined ? null : onOff(entity.state);
  const brightnessPct = on === true && entity !== undefined ? brightnessPercent(entity) : null;
  const pending = input.gateway.status(`entity:${id}`);
  const base = {
    key: id,
    name: friendlyName(input.store, id, undefined, `${MISSING_LIGHT_NAME} ${position + 1}`),
    status: normalized.status,
    on,
    brightnessPct,
    toggle: input.gateway.evaluate({ kind: on === true ? 'light.turn_off' : 'light.turn_on', entity: id }),
    ...(entity !== undefined &&
      supportsBrightness(entity.attributes) && {
        brightness: {
          availability: input.gateway.evaluate({
            kind: 'light.set_brightness',
            entity: id,
            pct: brightnessPct ?? FULL_BRIGHTNESS_PCT,
          }),
        },
      }),
    ...(pending !== undefined && { pending }),
  };
  if (normalized.status !== 'unknown') return base;
  return {
    ...base,
    explicit: {
      on: input.gateway.evaluate({ kind: 'light.turn_on', entity: id }),
      off: input.gateway.evaluate({ kind: 'light.turn_off', entity: id }),
    },
  };
}

function buildSwitch(input: SelectorInput, id: EntityId, position: number): HomeSwitchVM {
  const normalized = normalizeEntity(input.store, id);
  const entity = lightReading(input.store, normalized);
  const on = entity === undefined ? null : onOff(entity.state);
  const pending = input.gateway.status(`entity:${id}`);
  const refusal = settingsSwitchRefusal(input, id);
  const base = {
    key: id,
    name: friendlyName(input.store, id, undefined, `${MISSING_SWITCH_NAME} ${position + 1}`),
    status: normalized.status,
    on,
    toggle: refusal ?? input.gateway.evaluate({ kind: on === true ? 'switch.turn_off' : 'switch.turn_on', entity: id }),
    readOnly: refusal !== undefined,
    ...(refusal !== undefined && { reason: refusal.message }),
    ...(pending !== undefined && { pending }),
  };
  if (normalized.status !== 'unknown' || refusal !== undefined) return base;
  return {
    ...base,
    explicit: {
      on: input.gateway.evaluate({ kind: 'switch.turn_on', entity: id }),
      off: input.gateway.evaluate({ kind: 'switch.turn_off', entity: id }),
    },
  };
}

/**
 * The gateway's step-5b refusal for a settings switch, whatever else holds (as garage-class curtains are refused):
 * it is never a lamp, so it stays read-only with its reason even while controls are off. Before HA's registry
 * arrives the category is unknown, so the switch is not read-only yet; the gateway's own wait applies instead.
 */
function settingsSwitchRefusal(
  input: SelectorInput,
  id: EntityId,
): Extract<Availability, { enabled: false }> | undefined {
  if (!input.reader.registryLoaded()) return undefined;
  const category = input.reader.registry(id)?.entity_category;
  if (typeof category !== 'string' || !SETTINGS_SWITCH_CATEGORIES.has(category)) return undefined;
  return Object.freeze({ enabled: false, reason: 'not-allowed', message: SETTINGS_SWITCH_COPY });
}

/** The observed brightness of a light that is on, else null: what a held brightness draft is compared with. */
export function observedBrightnessPct(store: StoreView, id: EntityId): number | null {
  const entity = lightReading(store, normalizeEntity(store, id));
  return entity?.state === 'on' ? brightnessPercent(entity) : null;
}

function onOff(state: string): boolean | null {
  if (state === 'on') return true;
  if (state === 'off') return false;
  return null;
}

function brightnessPercent(entity: HassEntityLike): number | null {
  const brightness = parseNumericValue(entity.attributes['brightness']);
  if (brightness === null) return null;
  return Math.min(FULL_BRIGHTNESS_PCT, Math.max(1, Math.round(brightness / BRIGHTNESS_PER_PERCENT)));
}

function buildCurtain(input: SelectorInput, id: EntityId): HomeCurtainVM {
  const normalized = normalizeEntity(input.store, id);
  const entity = readableEntity(normalized) ?? (normalized.status === 'unknown' ? normalized.entity : undefined);
  const pending = input.gateway.status(`entity:${id}`);
  // Whatever the status: the gateway refuses on the stored attributes too, so an unavailable or stale garage
  // cover stays read-only rather than rendering as an ordinary curtain with a garage reason.
  const deviceClass = input.store.get(id)?.attributes['device_class'];
  const readOnly = typeof deviceClass === 'string' && GARAGE_CLASS_COVERS.has(deviceClass);
  const refusal = readOnly ? garageClassRefusal(input.config, id) : undefined;
  return {
    key: id,
    name: friendlyName(input.store, id, undefined, 'Curtain'),
    status: normalized.status,
    label: curtainLabel(input, normalized, entity),
    open: refusal ?? input.gateway.evaluate({ kind: 'curtain.open', entity: id }),
    close: refusal ?? input.gateway.evaluate({ kind: 'curtain.close', entity: id }),
    readOnly,
    ...(refusal !== undefined && { reason: refusal.message }),
    ...(pending !== undefined && { pending }),
  };
}

/** The same refusal the gateway gives at step 5a, worded for this cover (the garage cover has a panel). */
function garageClassRefusal(config: ResolvedConfig, id: EntityId): Extract<Availability, { enabled: false }> {
  const where = config.garage?.cover === id ? 'garage-panel' : 'elsewhere';
  return Object.freeze({ enabled: false, reason: 'not-allowed', message: GARAGE_LIKE_COVER_COPY[where] });
}

function curtainLabel(input: SelectorInput, normalized: NormalizedEntity, entity: HassEntityLike | undefined): string {
  if (normalized.status === 'unknown') return 'Position unknown';
  if (entity === undefined) return absentFor(normalized.status).label;
  switch (entity.state) {
    case 'open': {
      const position = parseNumericValue(entity.attributes['current_position']);
      return position !== null && position > 0 && position < FULLY_OPEN_PCT
        ? `Open ${input.reader.formatter().number(position)}%`
        : 'Open';
    }
    case 'closed':
      return 'Closed';
    case 'opening':
      return 'Opening';
    case 'closing':
      return 'Closing';
    default:
      return input.reader.formatter().entityState(entity);
  }
}

/**
 * A light's or switch's state as far as it is known. Last known values are kept only while the whole connection is
 * down; once the store is live again, an entity the snapshot did not replace (§16.10) has no known state, so it is
 * never counted as on and never offers brightness.
 */
function lightReading(store: StoreView, normalized: NormalizedEntity): HassEntityLike | undefined {
  if (normalized.status === 'disconnected' && store.isConnected()) return undefined;
  return readableEntity(normalized);
}
