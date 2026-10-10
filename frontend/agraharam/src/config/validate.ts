/**
 * Config validation (§4.2). Pure; imports only src/config/* and uses erasable syntax only, so Node type stripping
 * can run it from the private-config generator. No demo substitution happens here (rule 9): with `demo: true` the
 * bindings are validated but ignored, and the root validates demoCardInput(scenario) separately.
 */
import { domainOf, isValidEntityId } from './entity-id.ts';
import { LIMITS } from './limits.ts';
import {
  ACTIONABLE_ROLE_FAMILY,
  COLLECTION_ICONS,
  DOMAINS_BY_ROLE,
  SHORTCUT_ROLES,
  VEHICLE_MODELS,
  type ActionFamily,
  type AttentionRule,
  type BindingRole,
  type Collection,
  type CollectionIcon,
  type CollectionRow,
  type DemoScenarioId,
  type EntityId,
  type Ref,
  type ResolvedConfig,
  type SecurityActionRole,
  type ShortcutRole,
  type VehicleModel,
} from './schema.ts';

type ConfigIssueCode =
  | 'not-object'
  | 'unknown-key'
  | 'wrong-type'
  | 'required'
  | 'invalid-entity-id'
  | 'wrong-domain'
  | 'invalid-value'
  | 'too-many'
  | 'too-long'
  | 'out-of-range'
  | 'duplicate-actionable'
  | 'duplicate-security-script'
  | 'curtain-conflict'
  | 'switch-conflict'
  | 'ignored-in-demo'
  | 'demo-config-invalid'; // produced by the root only (rule 9), never by validateConfig
export interface ConfigIssue {
  readonly path: string;
  readonly code: ConfigIssueCode;
  readonly message: string;
}
export type ValidationResult =
  | { readonly ok: true; readonly config: ResolvedConfig; readonly warnings: readonly ConfigIssue[] }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const DEFAULT_TITLE = 'Agraharam';
const DEFAULT_GARAGE_NAME = 'Garage';
const DEFAULT_SCENARIO: DemoScenarioId = 'normal';
const DEFAULT_PRIVACY_ON_VALUE = 'on';
const SNAPSHOT_INTERVAL_S = { min: 5, max: 600, fallback: 10 } as const;
const CHARGE_LIMIT_PCT = { min: 50, max: 100 } as const;
const DEFAULT_VEHICLE_MODEL: VehicleModel = 'generic';
const MS_PER_SECOND = 1000;
/** Range rules compare numeric readings, which only these domains report (rule 15d). */
const RANGE_RULE_DOMAINS: ReadonlySet<string> = new Set(['sensor', 'number']);
/** These domains' state is a time, which an equals rule can never sensibly match (rule 15g). */
const TIME_STATE_DOMAINS: ReadonlySet<string> = new Set(['event', 'input_datetime']);
/** Readings in these states always count as unavailable, so an equals rule must not name them (rule 15f). */
const ALWAYS_UNAVAILABLE_STATES: ReadonlySet<string> = new Set(['unknown', 'unavailable']);
/** Unknown keys within this edit distance of an allowed key get a "did you mean" hint (rule 2). */
const MAX_SUGGESTION_DISTANCE = 2;
/** Offending values are quoted in messages, shortened so a pasted blob cannot flood the error panel. */
const MAX_QUOTED_CHARS = 60;

const DEMO_SCENARIOS: readonly DemoScenarioId[] = [
  'normal',
  'degraded',
  'offline',
  'empty',
  'alert',
  'loading',
  'restricted',
  'starting',
  'dense',
  'sky',
];
const SECURITY_ROLES: readonly SecurityActionRole[] = [
  'disarm_hold',
  'silence_sound',
  'resume_auto',
  'hold_night',
  'hold_away',
  'hold_vacation',
  'prepare_departure',
];

/** Keys HA itself may write into a card config. */
const HA_MANAGED_KEYS = ['type', 'view_layout', 'layout_options', 'grid_options', 'visibility'] as const;
/** Keys that still matter with `demo: true`; issues anywhere else become ignored-in-demo warnings (rule 9). */
const DEMO_KEYS: ReadonlySet<string> = new Set([...HA_MANAGED_KEYS, 'title', 'demo', 'demo_scenario', 'diagnostics']);
const TOP_LEVEL_KEYS = [
  ...HA_MANAGED_KEYS,
  'title',
  'demo',
  'demo_scenario',
  'controls',
  'diagnostics',
  'people',
  'weather',
  'sun',
  'climate',
  'air',
  'bed_comfort',
  'rooms',
  'vacuums',
  'appliances',
  'media',
  'cameras',
  'garage',
  'vehicle',
  'security',
  'studio_monitors_script',
  'calendars',
  'shortcuts',
  'collections',
  'airspace',
] as const;
const REF_KEYS = ['entity', 'name'] as const;
const ROOM_KEYS = ['name', 'lights', 'switches', 'curtains', 'purifier'] as const;
const VACUUM_KEYS = ['entity', 'name', 'battery_sensor'] as const;
const APPLIANCE_KEYS = ['name', 'status_sensor', 'remaining_sensor'] as const;
const CAMERA_KEYS = [
  'entity',
  'name',
  'privacy_entity',
  'privacy_on_value',
  'thumbnails',
  'snapshot_interval',
  'live',
] as const;
const GARAGE_KEYS = ['cover', 'name'] as const;
const VEHICLE_KEYS = [
  'name',
  'battery_sensor',
  'range_sensor',
  'charger_status',
  'charger_power',
  'session_energy',
  'charge_limit_pct',
  'model',
] as const;
const SECURITY_KEYS = [
  'alarm',
  'policy',
  'suggested_mode',
  'commissioning',
  'health_text',
  'perimeter',
  'actions',
] as const;
const COLLECTION_KEYS = ['name', 'icon', 'entities'] as const;
const ROW_KEYS = ['entity', 'name', 'attention'] as const;
const ATTENTION_KEYS = ['below', 'above', 'equals'] as const;
const AIRSPACE_KEYS = ['entity'] as const;

type Mapping = Readonly<Record<string, unknown>>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface BindingUse {
  readonly role: BindingRole;
  readonly path: string;
}

/** Accumulates issues and bindings while one config is read. */
interface Collector {
  readonly issues: ConfigIssue[];
  readonly uses: Map<EntityId, BindingUse[]>;
}

export function validateConfig(input: unknown): ValidationResult {
  if (!isMapping(input)) {
    return failure([{ path: '', code: 'not-object', message: 'The card configuration must be a mapping.' }]);
  }
  const c: Collector = { issues: [], uses: new Map() };
  checkKeys(c, input, '', TOP_LEVEL_KEYS);
  if ('type' in input) readString(c, input, 'type', '');
  const demo = readBoolean(c, input, 'demo', '') ?? false;
  const settings = {
    title: readName(c, input['title'], 'title', LIMITS.titleChars) ?? DEFAULT_TITLE,
    demoScenario: readScenario(c, input),
    diagnostics: readBoolean(c, input, 'diagnostics', '') ?? false,
    controls: readBoolean(c, input, 'controls', '') ?? false,
  };
  const parts = readBindings(c, input);
  checkDuplicateActionable(c);
  checkControlConflicts(c);
  if (demo) return demoResult(c, input, settings);
  if (c.issues.length > 0) return failure(c.issues);
  const config: ResolvedConfig = {
    ...settings,
    demo: false,
    ...parts,
    bindings: readonlyMapView(rolesByEntity(c.uses)),
  };
  return { ok: true, config: deepFreeze(config), warnings: Object.freeze([]) };
}

function failure(issues: readonly ConfigIssue[]): ValidationResult {
  return deepFreeze({ ok: false, issues: [...issues] });
}

/** Rule 9: bindings and `controls` are validated but ignored; their issues become warnings shown in diagnostics. */
function demoResult(
  c: Collector,
  input: Mapping,
  settings: { readonly title: string; readonly demoScenario: DemoScenarioId; readonly diagnostics: boolean },
): ValidationResult {
  const errors = c.issues.filter((issue) => DEMO_KEYS.has(rootKey(issue.path)) || isUnknownTopLevelKey(issue));
  if (errors.length > 0) return failure(errors);
  const warnings: ConfigIssue[] = c.issues.map((issue) => ({
    path: issue.path,
    code: 'ignored-in-demo',
    message: `${issue.message} Ignored in demo mode.`,
  }));
  if ('controls' in input) {
    warnings.push({
      path: 'controls',
      code: 'ignored-in-demo',
      message: 'controls: ignored in demo mode, where the fictional controls are always on.',
    });
  }
  const config: ResolvedConfig = {
    ...settings,
    demo: true,
    controls: false,
    ...emptyBindings(),
    bindings: readonlyMapView(new Map()),
  };
  return { ok: true, config: deepFreeze(config), warnings: deepFreeze(warnings) };
}

function rootKey(path: string): string {
  const match = /^[a-z_]+/.exec(path);
  return match ? match[0] : '';
}

function isUnknownTopLevelKey(issue: ConfigIssue): boolean {
  return issue.code === 'unknown-key' && /^[^.[]+$/.test(issue.path);
}

type BindingParts = Omit<ResolvedConfig, 'title' | 'demo' | 'demoScenario' | 'controls' | 'diagnostics' | 'bindings'>;

function emptyBindings(): BindingParts {
  return {
    people: [],
    climate: [],
    air: [],
    bedComfort: [],
    rooms: [],
    vacuums: [],
    appliances: [],
    media: [],
    cameras: [],
    calendars: [],
    shortcuts: {},
    collections: [],
  };
}

function readBindings(c: Collector, input: Mapping): BindingParts {
  const parts: Mutable<BindingParts> = {
    people: readList(c, input, 'people', LIMITS.people, (v, p) => readRef(c, v, p, 'person')),
    climate: readList(c, input, 'climate', LIMITS.climate, (v, p) => readRef(c, v, p, 'climate')),
    air: readList(c, input, 'air', LIMITS.air, (v, p) => readRef(c, v, p, 'air')),
    bedComfort: readList(c, input, 'bed_comfort', LIMITS.bed_comfort, (v, p) => readRef(c, v, p, 'bed_comfort')),
    rooms: readList(c, input, 'rooms', LIMITS.rooms, (v, p) => readRoom(c, v, p)),
    vacuums: readList(c, input, 'vacuums', LIMITS.vacuums, (v, p) => readVacuum(c, v, p)),
    appliances: readList(c, input, 'appliances', LIMITS.appliances, (v, p) => readAppliance(c, v, p)),
    media: readList(c, input, 'media', LIMITS.media, (v, p) => readRef(c, v, p, 'media')),
    cameras: readList(c, input, 'cameras', LIMITS.cameras, (v, p) => readCamera(c, v, p)),
    calendars: readList(c, input, 'calendars', LIMITS.calendars, (v, p) => readRef(c, v, p, 'calendar')),
    shortcuts: readShortcuts(c, input['shortcuts']),
    collections: readCollections(c, input),
  };
  const weather = readOptionalEntity(c, input, 'weather', '', 'weather');
  if (weather) parts.weather = weather;
  const sun = readOptionalEntity(c, input, 'sun', '', 'sun');
  if (sun) parts.sun = sun;
  const garage = readGarage(c, input['garage']);
  if (garage) parts.garage = garage;
  const vehicle = readVehicle(c, input['vehicle']);
  if (vehicle) parts.vehicle = vehicle;
  const security = readSecurity(c, input['security']);
  if (security) parts.security = security;
  const studioMonitors = readOptionalEntity(c, input, 'studio_monitors_script', '', 'studio_monitors');
  if (studioMonitors) parts.studioMonitors = studioMonitors;
  const airspace = readAirspace(c, input['airspace']);
  if (airspace) parts.airspace = airspace;
  return parts;
}

// ---------------------------------------------------------------------------------------------------------------
// Sections

function readRoom(c: Collector, value: unknown, path: string): ResolvedConfig['rooms'][number] | undefined {
  const room = readMapping(c, value, path, ROOM_KEYS);
  if (!room) return undefined;
  const name = readRequiredName(c, room, 'name', path);
  const readLight = (v: unknown, p: string): EntityId | undefined => readEntity(c, v, p, 'room_light');
  // Rule 11c: a room lit only by switched lamps needs no `lights` key; every other room still requires it.
  const lights =
    room['switches'] === undefined
      ? readRequiredList(c, room, 'lights', path, LIMITS.lightsPerRoom, readLight)
      : readList(c, room, 'lights', LIMITS.lightsPerRoom, readLight, path);
  const switches = readRoomSwitches(c, room, path);
  const curtains = readList(
    c,
    room,
    'curtains',
    LIMITS.curtainsPerRoom,
    (v, p) => readEntity(c, v, p, 'room_curtain'),
    path,
  );
  const purifier = readOptionalEntity(c, room, 'purifier', path, 'room_purifier');
  if (name === undefined || lights === undefined) return undefined;
  return { name, lights, switches, curtains, ...(purifier && { purifier }) };
}

/** Rules 11a and 11b: switch entities only, at most LIMITS.switchesPerRoom, each listed once in the room. */
function readRoomSwitches(c: Collector, room: Mapping, path: string): EntityId[] {
  const seen = new Set<EntityId>();
  return readList(
    c,
    room,
    'switches',
    LIMITS.switchesPerRoom,
    (v, p) => listedOnce(c, seen, readEntity(c, v, p, 'room_switch'), p, 'this room'),
    path,
  );
}

/** `entity` the first time it is seen in one list; a repeat is an `invalid-value` issue at `path`, and undefined. */
function listedOnce(
  c: Collector,
  seen: Set<EntityId>,
  entity: EntityId | undefined,
  path: string,
  where: string,
): EntityId | undefined {
  if (entity === undefined) return undefined;
  if (seen.has(entity)) {
    addIssue(c, path, 'invalid-value', `${entity} is already listed in ${where}.`);
    return undefined;
  }
  seen.add(entity);
  return entity;
}

function readVacuum(c: Collector, value: unknown, path: string): ResolvedConfig['vacuums'][number] | undefined {
  const vacuum = readMapping(c, value, path, VACUUM_KEYS);
  if (!vacuum) return undefined;
  const entity = readRequiredEntity(c, vacuum, 'entity', path, 'vacuum');
  const name = readOptionalName(c, vacuum, 'name', path);
  const batterySensor = readOptionalEntity(c, vacuum, 'battery_sensor', path, 'vacuum_battery');
  if (!entity) return undefined;
  return { entity, ...(name !== undefined && { name }), ...(batterySensor && { batterySensor }) };
}

function readAppliance(c: Collector, value: unknown, path: string): ResolvedConfig['appliances'][number] | undefined {
  const appliance = readMapping(c, value, path, APPLIANCE_KEYS);
  if (!appliance) return undefined;
  const name = readRequiredName(c, appliance, 'name', path);
  const status = readRequiredEntity(c, appliance, 'status_sensor', path, 'appliance_status');
  const remaining = readOptionalEntity(c, appliance, 'remaining_sensor', path, 'appliance_remaining');
  if (name === undefined || !status) return undefined;
  return { name, status, ...(remaining && { remaining }) };
}

function readCamera(c: Collector, value: unknown, path: string): ResolvedConfig['cameras'][number] | undefined {
  const camera = readMapping(c, value, path, CAMERA_KEYS);
  if (!camera) return undefined;
  const entity = readRequiredEntity(c, camera, 'entity', path, 'camera');
  const name = readRequiredName(c, camera, 'name', path);
  const privacy = readPrivacy(c, camera, path);
  const thumbnails = readBoolean(c, camera, 'thumbnails', path) ?? true;
  const intervalS =
    readInteger(c, camera, 'snapshot_interval', path, SNAPSHOT_INTERVAL_S) ?? SNAPSHOT_INTERVAL_S.fallback;
  const live = readBoolean(c, camera, 'live', path) ?? true;
  if (!entity || name === undefined) return undefined;
  const snapshotIntervalMs = intervalS * MS_PER_SECOND;
  return { entity, name, ...(privacy && { privacy }), thumbnails, snapshotIntervalMs, live };
}

/** Rule 7: the on value is exactly 'on' or 'off'; "On", "true" and "enabled" are rejected, never coerced. */
function readPrivacy(
  c: Collector,
  camera: Mapping,
  path: string,
): { readonly entity: EntityId; readonly onValue: 'on' | 'off' } | undefined {
  const entity = readOptionalEntity(c, camera, 'privacy_entity', path, 'camera_privacy');
  const onValuePath = join(path, 'privacy_on_value');
  const rawOnValue = camera['privacy_on_value'];
  let onValue: 'on' | 'off' = DEFAULT_PRIVACY_ON_VALUE;
  if (rawOnValue !== undefined) {
    if (rawOnValue === 'on' || rawOnValue === 'off') onValue = rawOnValue;
    else addIssue(c, onValuePath, 'invalid-value', `expected exactly "on" or "off", got ${quote(rawOnValue)}.`);
    // An on value without its entity is half a privacy binding; say so rather than silently showing the camera.
    if (!('privacy_entity' in camera)) {
      addIssue(c, join(path, 'privacy_entity'), 'required', 'required when privacy_on_value is set.');
    }
  }
  return entity ? { entity, onValue } : undefined;
}

function readGarage(c: Collector, value: unknown): ResolvedConfig['garage'] {
  if (value === undefined) return undefined;
  const garage = readMapping(c, value, 'garage', GARAGE_KEYS);
  if (!garage) return undefined;
  const cover = readRequiredEntity(c, garage, 'cover', 'garage', 'garage_cover');
  const name = readOptionalName(c, garage, 'name', 'garage') ?? DEFAULT_GARAGE_NAME;
  return cover ? { cover, name } : undefined;
}

/**
 * Airspace §4: a mapping with exactly `entity`, a sensor.* bound under the read-only `airspace` role. When the key is
 * absent nothing is added, so the resolved config of every existing card is unchanged (no `airspace` key at all).
 */
function readAirspace(c: Collector, value: unknown): ResolvedConfig['airspace'] {
  if (value === undefined) return undefined;
  const airspace = readMapping(c, value, 'airspace', AIRSPACE_KEYS);
  if (!airspace) return undefined;
  const entity = readRequiredEntity(c, airspace, 'entity', 'airspace', 'airspace');
  return entity ? { entity } : undefined;
}

function readVehicle(c: Collector, value: unknown): ResolvedConfig['vehicle'] {
  if (value === undefined) return undefined;
  const vehicle = readMapping(c, value, 'vehicle', VEHICLE_KEYS);
  if (!vehicle) return undefined;
  const path = 'vehicle';
  const name = readRequiredName(c, vehicle, 'name', path);
  const battery = readRequiredEntity(c, vehicle, 'battery_sensor', path, 'vehicle_battery');
  const range = readRequiredEntity(c, vehicle, 'range_sensor', path, 'vehicle_range');
  const chargerStatus = readOptionalEntity(c, vehicle, 'charger_status', path, 'vehicle_charger_status');
  const chargerPower = readOptionalEntity(c, vehicle, 'charger_power', path, 'vehicle_charger_power');
  const sessionEnergy = readOptionalEntity(c, vehicle, 'session_energy', path, 'vehicle_session_energy');
  const chargeLimitPct = readInteger(c, vehicle, 'charge_limit_pct', path, CHARGE_LIMIT_PCT);
  const model = readVehicleModel(c, vehicle, path);
  if (name === undefined || !battery || !range) return undefined;
  return {
    name,
    battery,
    range,
    ...(chargerStatus && { chargerStatus }),
    ...(chargerPower && { chargerPower }),
    ...(sessionEnergy && { sessionEnergy }),
    ...(chargeLimitPct !== undefined && { chargeLimitPct }),
    model,
  };
}

/** Rule 13: exactly one of VEHICLE_MODELS; anything else is refused, never coerced to the generic drawing. */
function readVehicleModel(c: Collector, vehicle: Mapping, path: string): VehicleModel {
  const value = vehicle['model'];
  if (value === undefined) return DEFAULT_VEHICLE_MODEL;
  const model = VEHICLE_MODELS.find((id) => id === value);
  if (model !== undefined) return model;
  addIssue(c, join(path, 'model'), 'invalid-value', `expected ${orList(VEHICLE_MODELS)}, got ${quote(value)}.`);
  return DEFAULT_VEHICLE_MODEL;
}

function readSecurity(c: Collector, value: unknown): ResolvedConfig['security'] {
  if (value === undefined) return undefined;
  const path = 'security';
  const security = readMapping(c, value, path, SECURITY_KEYS);
  if (!security) return undefined;
  const alarm = readRequiredEntity(c, security, 'alarm', path, 'alarm');
  const policy = readRequiredEntity(c, security, 'policy', path, 'policy');
  const suggested = readOptionalEntity(c, security, 'suggested_mode', path, 'suggested_mode');
  const commissioning = readOptionalEntity(c, security, 'commissioning', path, 'commissioning');
  const healthText = readOptionalEntity(c, security, 'health_text', path, 'health_text');
  const perimeter = readList(c, security, 'perimeter', LIMITS.perimeter, (v, p) => readRef(c, v, p, 'perimeter'), path);
  const actions = readSecurityActions(c, security['actions']);
  if (!alarm || !policy) return undefined;
  return {
    alarm,
    policy,
    ...(suggested && { suggested }),
    ...(commissioning && { commissioning }),
    ...(healthText && { healthText }),
    perimeter,
    actions,
  };
}

/** Rules 5 and 6: script entities only, and one script per role, so Silence Sound can never name a disarm script. */
function readSecurityActions(c: Collector, value: unknown): Partial<Record<SecurityActionRole, EntityId>> {
  return readRoleScripts(c, value, 'security.actions', SECURITY_ROLES, 'security_action', (script, earlier) => ({
    code: 'duplicate-security-script',
    detail: `${script} is already bound to ${earlier}. Each security role needs its own script.`,
  }));
}

/**
 * Rules 12a and 12b: only the two fixed shortcut roles, script entities only, and one script per role, so the lights
 * button can never run the curtains script. Rule 4 separately refuses a shortcut that is also a security or studio
 * monitors script (another action family).
 */
function readShortcuts(c: Collector, value: unknown): Partial<Record<ShortcutRole, EntityId>> {
  return readRoleScripts(c, value, 'shortcuts', SHORTCUT_ROLES, 'house_shortcut', (script, earlier, path) => ({
    code: 'duplicate-actionable',
    detail: `${script} is already the ${earlier} shortcut (${join(path, earlier)}). Each shortcut needs its own script.`,
  }));
}

/**
 * A mapping from fixed role names to script entities. A script named under a second role is reported through
 * `duplicate` and left out, so one script can never answer to two roles.
 */
function readRoleScripts<R extends string>(
  c: Collector,
  value: unknown,
  path: string,
  roles: readonly R[],
  bindingRole: BindingRole,
  duplicate: (
    script: EntityId,
    earlier: R,
    path: string,
  ) => { readonly code: ConfigIssueCode; readonly detail: string },
): Partial<Record<R, EntityId>> {
  if (value === undefined) return {};
  const mapping = readMapping(c, value, path, roles);
  if (!mapping) return {};
  const resolved: Partial<Record<R, EntityId>> = {};
  const roleByScript = new Map<EntityId, R>();
  for (const role of roles) {
    const script = readOptionalEntity(c, mapping, role, path, bindingRole);
    if (!script) continue;
    const earlier = roleByScript.get(script);
    if (earlier !== undefined) {
      const issue = duplicate(script, earlier, path);
      addIssue(c, join(path, role), issue.code, issue.detail);
      continue;
    }
    roleByScript.set(script, role);
    resolved[role] = script;
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------------------------
// Collections (rules 14 and 15): read-only readings, bound under the `collection` role only

function readCollections(c: Collector, input: Mapping): Collection[] {
  // Group names are unique case-insensitively, so the drawer never shows two indistinguishable headings.
  const names = new Set<string>();
  return readList(c, input, 'collections', LIMITS.collections, (v, p) => readCollection(c, v, p, names));
}

function readCollection(c: Collector, value: unknown, path: string, names: Set<string>): Collection | undefined {
  const group = readMapping(c, value, path, COLLECTION_KEYS);
  if (!group) return undefined;
  const name = readRequiredName(c, group, 'name', path, LIMITS.collectionNameChars);
  if (name !== undefined) {
    const folded = name.toLowerCase();
    if (names.has(folded)) {
      addIssue(c, join(path, 'name'), 'invalid-value', `another collection is already named ${quote(name)}.`);
    }
    names.add(folded);
  }
  const icon = readCollectionIcon(c, group, path);
  const rows = readCollectionRows(c, group, path);
  if (name === undefined || rows === undefined) return undefined;
  return { name, ...(icon !== undefined && { icon }), rows };
}

function readCollectionIcon(c: Collector, group: Mapping, path: string): CollectionIcon | undefined {
  const value = group['icon'];
  if (value === undefined) return undefined;
  const icon = COLLECTION_ICONS.find((name) => name === value);
  if (icon === undefined) {
    addIssue(
      c,
      join(path, 'icon'),
      'invalid-value',
      `expected one of ${COLLECTION_ICONS.join(', ')}, got ${quote(value)}.`,
    );
  }
  return icon;
}

/** Rules 14d and 14e: 1 to LIMITS.collectionRows rows, each entity once per group (repeats across groups are fine). */
function readCollectionRows(c: Collector, group: Mapping, path: string): CollectionRow[] | undefined {
  const seen = new Set<EntityId>();
  const rows = readRequiredList(c, group, 'entities', path, LIMITS.collectionRows, (v, p) =>
    readCollectionRow(c, v, p, seen),
  );
  if (Array.isArray(group['entities']) && group['entities'].length === 0) {
    addIssue(c, join(path, 'entities'), 'invalid-value', 'add at least one entity.');
  }
  return rows;
}

/** A row is an entity ID, or a mapping with the entity, an optional short name and an optional attention rule. */
function readCollectionRow(c: Collector, value: unknown, path: string, seen: Set<EntityId>): CollectionRow | undefined {
  if (typeof value === 'string') {
    const entity = listedOnce(c, seen, readEntity(c, value, path, 'collection'), path, 'this collection');
    return entity === undefined ? undefined : { entity };
  }
  const row = readMapping(c, value, path, ROW_KEYS);
  if (!row) return undefined;
  const entityPath = join(path, 'entity');
  const entity = listedOnce(
    c,
    seen,
    readRequiredEntity(c, row, 'entity', path, 'collection'),
    entityPath,
    'this collection',
  );
  const name = readOptionalName(c, row, 'name', path, LIMITS.collectionNameChars);
  const attention =
    row['attention'] === undefined ? undefined : readAttention(c, row['attention'], join(path, 'attention'), entity);
  if (entity === undefined) return undefined;
  return { entity, ...(name !== undefined && { name }), ...(attention !== undefined && { attention }) };
}

/**
 * Rule 15. `below` and `above` are strict (the bounds themselves are in range) and compare the raw numeric state in
 * the entity's own unit; `equals` compares the raw state exactly. Domain checks run only when the row's entity is
 * valid, because an invalid entity is already an issue of its own.
 */
function readAttention(
  c: Collector,
  value: unknown,
  path: string,
  entity: EntityId | undefined,
): AttentionRule | undefined {
  const attention = readMapping(c, value, path, ATTENTION_KEYS);
  if (!attention) return undefined;
  const hasRange = attention['below'] !== undefined || attention['above'] !== undefined;
  const hasEquals = attention['equals'] !== undefined;
  if (!hasRange && !hasEquals) {
    addIssue(c, path, 'required', 'set below, above or equals.');
    return undefined;
  }
  if (hasRange && hasEquals) {
    addIssue(c, path, 'invalid-value', 'use either equals, or below and above.');
    return undefined;
  }
  const domain = entity === undefined ? undefined : domainOf(entity);
  return hasRange ? readRangeRule(c, attention, path, domain) : readEqualsRule(c, attention, path, domain);
}

function readRangeRule(
  c: Collector,
  attention: Mapping,
  path: string,
  domain: string | undefined,
): AttentionRule | undefined {
  const issues = c.issues.length;
  const below = readFiniteNumber(c, attention, 'below', path);
  const above = readFiniteNumber(c, attention, 'above', path);
  if (below !== undefined && above !== undefined && below >= above) {
    addIssue(c, path, 'invalid-value', 'below must be less than above. Readings from below to above are in range.');
  }
  if (domain !== undefined && !RANGE_RULE_DOMAINS.has(domain)) {
    addIssue(c, path, 'invalid-value', `below and above compare numeric readings; for a ${domain} entity use equals.`);
  }
  if (c.issues.length > issues || (below === undefined && above === undefined)) return undefined;
  return { kind: 'range', ...(below !== undefined && { below }), ...(above !== undefined && { above }) };
}

function readEqualsRule(
  c: Collector,
  attention: Mapping,
  path: string,
  domain: string | undefined,
): AttentionRule | undefined {
  const equalsPath = join(path, 'equals');
  if (domain !== undefined && TIME_STATE_DOMAINS.has(domain)) {
    addIssue(c, equalsPath, 'invalid-value', "equals can't match a time; this row shows the time only.");
    return undefined;
  }
  const value = attention['equals'];
  if (!Array.isArray(value)) {
    const single = readAttentionValue(c, value, equalsPath);
    return single === undefined ? undefined : { kind: 'equals', values: [single] };
  }
  if (value.length === 0) {
    addIssue(c, equalsPath, 'invalid-value', 'add at least one value.');
    return undefined;
  }
  const issues = c.issues.length;
  const seen = new Set<string>();
  const values = readArray(c, value, equalsPath, LIMITS.attentionValues, (item, p) => {
    const text = readAttentionValue(c, item, p);
    if (text === undefined) return undefined;
    if (seen.has(text)) {
      addIssue(c, p, 'invalid-value', `${quote(text)} is already listed.`);
      return undefined;
    }
    seen.add(text);
    return text;
  });
  return values === undefined || c.issues.length > issues ? undefined : { kind: 'equals', values };
}

/** Rules 15e and 15f: one raw state to match, as text. YAML reads a bare on/off as a boolean, so say how to quote it. */
function readAttentionValue(c: Collector, value: unknown, path: string): string | undefined {
  if (typeof value === 'boolean') {
    addIssue(c, path, 'wrong-type', "expected text; write 'on' or 'off' in quotes.");
    return undefined;
  }
  if (typeof value !== 'string') {
    addIssue(c, path, 'wrong-type', `expected text, got ${quote(value)}.`);
    return undefined;
  }
  if (value === '') {
    addIssue(c, path, 'invalid-value', 'must not be empty.');
    return undefined;
  }
  if (value.length > LIMITS.attentionValueChars) {
    addIssue(c, path, 'too-long', `at most ${LIMITS.attentionValueChars} characters, got ${value.length}.`);
    return undefined;
  }
  if (ALWAYS_UNAVAILABLE_STATES.has(value)) {
    addIssue(
      c,
      path,
      'invalid-value',
      'unknown and unavailable readings are always counted as unavailable; leave them out.',
    );
    return undefined;
  }
  return value;
}

/** Rule 4: an entity may be controlled from one action family only; read-only roles may overlap freely. */
function checkDuplicateActionable(c: Collector): void {
  for (const [entity, uses] of c.uses) {
    let first: { readonly family: ActionFamily; readonly path: string } | undefined;
    for (const use of uses) {
      const family = ACTIONABLE_ROLE_FAMILY[use.role];
      if (family === undefined) continue;
      if (first === undefined) {
        first = { family, path: use.path };
      } else if (family !== first.family) {
        addIssue(
          c,
          use.path,
          'duplicate-actionable',
          `${entity} is already a ${first.family} control at ${first.path}. An entity can be controlled from one place only.`,
        );
      }
    }
  }
}

/**
 * What a control acting without confirmation must never also be (rules 4a and 4b): for each such control role, the
 * roles it conflicts with (each describing itself from its config path), the issue code and the consequence line.
 */
interface ControlConflict {
  readonly code: ConfigIssueCode;
  readonly conflicts: Readonly<Partial<Record<BindingRole, (path: string) => string>>>;
  readonly consequence: string;
}
const CONTROL_CONFLICTS: readonly (readonly [BindingRole, ControlConflict])[] = Object.freeze([
  [
    'room_curtain',
    {
      code: 'curtain-conflict',
      conflicts: { garage_cover: () => 'the garage door', perimeter: () => 'a monitored entry point' },
      consequence: "Curtain controls move without confirmation, so it can't also be a curtain.",
    },
  ],
  [
    'room_switch',
    {
      code: 'switch-conflict',
      // The conflicting use sits at cameras[n].privacy_entity; the message names the camera, cameras[n].
      conflicts: { camera_privacy: (path) => `the privacy switch for ${path.slice(0, path.lastIndexOf('.'))}` },
      consequence: "Room switches toggle without confirmation, so it can't also be a room switch.",
    },
  ],
]);

/**
 * Rule 4a: a curtain control moves its cover at once, without confirmation, so the garage door or a monitored entry
 * point (security.perimeter) must never also be a room curtain. The garage case is also `duplicate-actionable`; the
 * perimeter case is not, because perimeter is read-only. The gateway's device_class refusal (§4.7 step 5a) stays as
 * the runtime backstop for a garage, gate or door cover listed only as a curtain.
 *
 * Rule 4b: a room switch toggles at once, so a camera's privacy switch must never also be one; otherwise "All on"
 * for a room could turn a camera's privacy off. Camera privacy is read-only, so rule 4 cannot catch this.
 */
function checkControlConflicts(c: Collector): void {
  for (const [entity, uses] of c.uses) {
    for (const [controlRole, rule] of CONTROL_CONFLICTS) {
      const conflict = uses.find((use) => rule.conflicts[use.role] !== undefined);
      const describe = conflict === undefined ? undefined : rule.conflicts[conflict.role];
      if (conflict === undefined || describe === undefined) continue;
      for (const use of uses) {
        if (use.role !== controlRole) continue;
        addIssue(
          c,
          use.path,
          rule.code,
          `${entity} is ${describe(conflict.path)} (${conflict.path}). ${rule.consequence}`,
        );
      }
    }
  }
}

function rolesByEntity(uses: ReadonlyMap<EntityId, readonly BindingUse[]>): Map<EntityId, readonly BindingRole[]> {
  const roles = new Map<EntityId, readonly BindingRole[]>();
  for (const [entity, entityUses] of uses) roles.set(entity, [...new Set(entityUses.map((use) => use.role))]);
  return roles;
}

// ---------------------------------------------------------------------------------------------------------------
// Primitive readers

function readScenario(c: Collector, input: Mapping): DemoScenarioId {
  const value = input['demo_scenario'];
  if (value === undefined) return DEFAULT_SCENARIO;
  const scenario = DEMO_SCENARIOS.find((id) => id === value);
  if (scenario !== undefined) return scenario;
  addIssue(c, 'demo_scenario', 'invalid-value', `expected one of ${DEMO_SCENARIOS.join(', ')}, got ${quote(value)}.`);
  return DEFAULT_SCENARIO;
}

function readRef(c: Collector, value: unknown, path: string, role: BindingRole): Ref | undefined {
  if (typeof value === 'string') {
    const entity = readEntity(c, value, path, role);
    return entity ? { entity } : undefined;
  }
  const ref = readMapping(c, value, path, REF_KEYS);
  if (!ref) return undefined;
  const entity = readRequiredEntity(c, ref, 'entity', path, role);
  const name = readOptionalName(c, ref, 'name', path);
  if (!entity) return undefined;
  return name === undefined ? { entity } : { entity, name };
}

function readEntity(c: Collector, value: unknown, path: string, role: BindingRole): EntityId | undefined {
  if (typeof value !== 'string') {
    addIssue(c, path, 'wrong-type', `expected an entity ID string, got ${quote(value)}.`);
    return undefined;
  }
  if (!isValidEntityId(value)) {
    addIssue(c, path, 'invalid-entity-id', `expected an entity ID like "domain.object_id", got ${quote(value)}.`);
    return undefined;
  }
  const domains = DOMAINS_BY_ROLE[role];
  if (!domains.includes(domainOf(value))) {
    addIssue(c, path, 'wrong-domain', `expected ${describeDomains(domains)} entity, got ${quote(value)}.`);
    return undefined;
  }
  const entity = value as EntityId;
  const uses = c.uses.get(entity) ?? [];
  uses.push({ role, path });
  c.uses.set(entity, uses);
  return entity;
}

function readRequiredEntity(
  c: Collector,
  from: Mapping,
  key: string,
  path: string,
  role: BindingRole,
): EntityId | undefined {
  if (from[key] === undefined) {
    addIssue(c, join(path, key), 'required', 'required.');
    return undefined;
  }
  return readEntity(c, from[key], join(path, key), role);
}

function readOptionalEntity(
  c: Collector,
  from: Mapping,
  key: string,
  path: string,
  role: BindingRole,
): EntityId | undefined {
  return from[key] === undefined ? undefined : readEntity(c, from[key], join(path, key), role);
}

function readList<T>(
  c: Collector,
  from: Mapping,
  key: string,
  limit: number,
  readItem: (value: unknown, path: string) => T | undefined,
  parentPath = '',
): T[] {
  return from[key] === undefined ? [] : (readArray(c, from[key], join(parentPath, key), limit, readItem) ?? []);
}

function readRequiredList<T>(
  c: Collector,
  from: Mapping,
  key: string,
  parentPath: string,
  limit: number,
  readItem: (value: unknown, path: string) => T | undefined,
): T[] | undefined {
  if (from[key] === undefined) {
    addIssue(c, join(parentPath, key), 'required', 'required.');
    return undefined;
  }
  return readArray(c, from[key], join(parentPath, key), limit, readItem);
}

function readArray<T>(
  c: Collector,
  value: unknown,
  path: string,
  limit: number,
  readItem: (value: unknown, path: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(c, path, 'wrong-type', `expected a list, got ${quote(value)}.`);
    return undefined;
  }
  if (value.length > limit) {
    addIssue(c, path, 'too-many', `at most ${limit} entries are supported, got ${value.length}.`);
  }
  const items: T[] = [];
  value.forEach((item: unknown, index) => {
    const read = readItem(item, `${path}[${index}]`);
    if (read !== undefined) items.push(read);
  });
  return items;
}

function readMapping(c: Collector, value: unknown, path: string, allowed: readonly string[]): Mapping | undefined {
  if (!isMapping(value)) {
    addIssue(c, path, 'wrong-type', `expected a mapping, got ${quote(value)}.`);
    return undefined;
  }
  checkKeys(c, value, path, allowed);
  return value;
}

/** Rule 2: unknown keys are rejected, with a "did you mean" hint when an allowed key is close. */
function checkKeys(c: Collector, value: Mapping, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const suggestion = closestKey(key, allowed);
    const hint = suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`;
    addIssue(c, join(path, key), 'unknown-key', `unknown key.${hint}`);
  }
}

function readBoolean(c: Collector, from: Mapping, key: string, path: string): boolean | undefined {
  const value = from[key];
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  addIssue(c, join(path, key), 'wrong-type', `expected true or false, got ${quote(value)}.`);
  return undefined;
}

function readString(c: Collector, from: Mapping, key: string, path: string): string | undefined {
  const value = from[key];
  if (typeof value === 'string') return value;
  addIssue(c, join(path, key), 'wrong-type', `expected text, got ${quote(value)}.`);
  return undefined;
}

function readInteger(
  c: Collector,
  from: Mapping,
  key: string,
  path: string,
  range: { readonly min: number; readonly max: number },
): number | undefined {
  const value = from[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    addIssue(c, join(path, key), 'wrong-type', `expected a whole number, got ${quote(value)}.`);
    return undefined;
  }
  if (value < range.min || value > range.max) {
    addIssue(c, join(path, key), 'out-of-range', `expected ${range.min} to ${range.max}, got ${value}.`);
    return undefined;
  }
  return value;
}

/** Rule 8: names are trimmed, non-empty and limited in length. */
function readName(c: Collector, value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    addIssue(c, path, 'wrong-type', `expected text, got ${quote(value)}.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    addIssue(c, path, 'invalid-value', 'must not be empty.');
    return undefined;
  }
  if (trimmed.length > maxChars) {
    addIssue(c, path, 'too-long', `at most ${maxChars} characters, got ${trimmed.length}.`);
    return undefined;
  }
  return trimmed;
}

function readOptionalName(
  c: Collector,
  from: Mapping,
  key: string,
  path: string,
  maxChars: number = LIMITS.nameChars,
): string | undefined {
  return readName(c, from[key], join(path, key), maxChars);
}

function readRequiredName(
  c: Collector,
  from: Mapping,
  key: string,
  path: string,
  maxChars: number = LIMITS.nameChars,
): string | undefined {
  if (from[key] === undefined) {
    addIssue(c, join(path, key), 'required', 'required.');
    return undefined;
  }
  return readOptionalName(c, from, key, path, maxChars);
}

/** Rule 15b: a YAML number. `.nan` and `.inf` parse as numbers but can never be a limit, so they are refused. */
function readFiniteNumber(c: Collector, from: Mapping, key: string, path: string): number | undefined {
  const value = from[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    addIssue(c, join(path, key), 'wrong-type', `expected a number, got ${quote(value)}.`);
    return undefined;
  }
  if (!Number.isFinite(value)) {
    addIssue(c, join(path, key), 'invalid-value', 'expected a finite number.');
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function addIssue(c: Collector, path: string, code: ConfigIssueCode, detail: string): void {
  c.issues.push({ path, code, message: path === '' ? detail : `${path}: ${detail}` });
}

function join(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

function isMapping(value: unknown): value is Mapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** "a person", "a switch, binary_sensor or input_boolean", "an alarm_control_panel". */
function describeDomains(domains: readonly string[]): string {
  const listed = orList(domains);
  return `${/^[aeiou]/.test(listed) ? 'an' : 'a'} ${listed}`;
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
  return items.length === 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function quote(value: unknown): string {
  if (value === undefined) return 'nothing';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const shortened = text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text;
  return typeof value === 'string' ? `"${shortened}"` : shortened;
}

function closestKey(key: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of allowed) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Levenshtein distance; keys are short, so the quadratic table is fine. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * A read-only view of `source`: a frozen Map would still accept set(), and `bindings` is the gateway allowlist,
 * so it must not be extendable after validation (rule 10).
 */
function readonlyMapView<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = {
    get size() {
      return source.size;
    },
    get: (key) => source.get(key),
    has: (key) => source.has(key),
    forEach(callback, thisArg?: unknown) {
      source.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  };
  return view;
}

/** Freezes plain objects and arrays recursively; map values are frozen through the view's source. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (isReadonlyMapView(value)) {
    for (const item of value.values()) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function isReadonlyMapView(value: object): value is ReadonlyMap<unknown, unknown> {
  return typeof (value as { values?: unknown }).values === 'function' && 'size' in value;
}
