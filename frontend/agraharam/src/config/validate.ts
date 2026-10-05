/**
 * Config validation (§4.2). Pure; imports only src/config/* and uses erasable syntax only, so Node type stripping
 * can run it from the private-config generator. No demo substitution happens here (rule 9): with `demo: true` the
 * bindings are validated but ignored, and the root validates demoCardInput(scenario) separately.
 */
import { domainOf, isValidEntityId } from './entity-id.ts';
import { LIMITS } from './limits.ts';
import {
  ACTIONABLE_ROLE_FAMILY,
  DOMAINS_BY_ROLE,
  type ActionFamily,
  type BindingRole,
  type DemoScenarioId,
  type EntityId,
  type Ref,
  type ResolvedConfig,
  type SecurityActionRole,
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
const MS_PER_SECOND = 1000;
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
] as const;
const REF_KEYS = ['entity', 'name'] as const;
const ROOM_KEYS = ['name', 'lights', 'curtains', 'purifier'] as const;
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
  checkCurtainConflicts(c);
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
  return parts;
}

// ---------------------------------------------------------------------------------------------------------------
// Sections

function readRoom(c: Collector, value: unknown, path: string): ResolvedConfig['rooms'][number] | undefined {
  const room = readMapping(c, value, path, ROOM_KEYS);
  if (!room) return undefined;
  const name = readRequiredName(c, room, 'name', path);
  const lights = readRequiredList(c, room, 'lights', path, LIMITS.lightsPerRoom, (v, p) =>
    readEntity(c, v, p, 'room_light'),
  );
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
  return { name, lights, curtains, ...(purifier && { purifier }) };
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
  if (name === undefined || !battery || !range) return undefined;
  return {
    name,
    battery,
    range,
    ...(chargerStatus && { chargerStatus }),
    ...(chargerPower && { chargerPower }),
    ...(sessionEnergy && { sessionEnergy }),
    ...(chargeLimitPct !== undefined && { chargeLimitPct }),
  };
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
  if (value === undefined) return {};
  const path = 'security.actions';
  const actions = readMapping(c, value, path, SECURITY_ROLES);
  if (!actions) return {};
  const resolved: Partial<Record<SecurityActionRole, EntityId>> = {};
  const roleByScript = new Map<EntityId, SecurityActionRole>();
  for (const role of SECURITY_ROLES) {
    const script = readOptionalEntity(c, actions, role, path, 'security_action');
    if (!script) continue;
    const earlier = roleByScript.get(script);
    if (earlier !== undefined) {
      addIssue(
        c,
        join(path, role),
        'duplicate-security-script',
        `${script} is already bound to ${earlier}. Each security role needs its own script.`,
      );
      continue;
    }
    roleByScript.set(script, role);
    resolved[role] = script;
  }
  return resolved;
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

/** What a curtain must never also be, and how the message names it (rule 4a). */
const CURTAIN_CONFLICTS: Readonly<Partial<Record<BindingRole, string>>> = Object.freeze({
  garage_cover: 'the garage door',
  perimeter: 'a monitored entry point',
});

/**
 * Rule 4a: a curtain control moves its cover at once, without confirmation, so the garage door or a monitored entry
 * point (security.perimeter) must never also be a room curtain. The garage case is also `duplicate-actionable`; the
 * perimeter case is not, because perimeter is read-only. The gateway's device_class refusal (§4.7 step 5a) stays as
 * the runtime backstop for a garage, gate or door cover listed only as a curtain.
 */
function checkCurtainConflicts(c: Collector): void {
  for (const [entity, uses] of c.uses) {
    const conflict = uses.find((use) => CURTAIN_CONFLICTS[use.role] !== undefined);
    if (conflict === undefined) continue;
    for (const use of uses) {
      if (use.role !== 'room_curtain') continue;
      addIssue(
        c,
        use.path,
        'curtain-conflict',
        `${entity} is ${CURTAIN_CONFLICTS[conflict.role]} (${conflict.path}). Curtain controls move without confirmation, so it can't also be a curtain.`,
      );
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

function readOptionalName(c: Collector, from: Mapping, key: string, path: string): string | undefined {
  return readName(c, from[key], join(path, key), LIMITS.nameChars);
}

function readRequiredName(c: Collector, from: Mapping, key: string, path: string): string | undefined {
  if (from[key] === undefined) {
    addIssue(c, join(path, key), 'required', 'required.');
    return undefined;
  }
  return readOptionalName(c, from, key, path);
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
  const listed =
    domains.length === 1 ? (domains[0] ?? '') : `${domains.slice(0, -1).join(', ')} or ${domains[domains.length - 1]}`;
  return `${/^[aeiou]/.test(listed) ? 'an' : 'a'} ${listed}`;
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
