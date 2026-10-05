/**
 * Pure mapping from the private candidates file (and optional private overrides) to the Agraharam dashboard
 * config (§13.4). Generic rules only: no household data lives in this file. The CLI
 * (`scripts/generate-private-config.mjs`) owns all file access and the output guards.
 *
 * Every rule failure throws `PrivateConfigError` before anything is written. Messages name paths, tokens and
 * counts, never entity IDs or names, so terminal output and logs stay free of household data.
 */
import { domainOf, isValidEntityId } from '../../src/config/entity-id.ts';
import { DOMAINS_BY_ROLE } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';

export const OUTPUT_FILE_NAME = 'agraharam-next.dashboard.yaml';
export const CANDIDATES_FILE_NAME = 'bindings.candidates.json';
export const OVERRIDES_FILE_NAME = 'agraharam.overrides.json';
export const DASHBOARD_TITLE = 'Agraharam';
export const VIEW_PATH = 'home';
export const CARD_TYPE = 'custom:agraharam-dashboard';
/** Without overrides.rooms, every light and curtain candidate lands in this one room. */
export const DEFAULT_ROOM_NAME = 'Lights';

/** Exact guarded-action labels → security role (or the studio monitors key). No fuzzy matching, ever. */
export const ACTION_LABELS = Object.freeze({
  'Disarm & Hold': 'disarm_hold',
  'Silence Sound': 'silence_sound',
  'Resume Auto Arming': 'resume_auto',
  'Hold Night': 'hold_night',
  'Hold Away': 'hold_away',
  'Hold Vacation': 'hold_vacation',
  'Prepare garage departure': 'prepare_departure',
  'Monitors On/Off': 'studio_monitors_script',
});
const STUDIO_MONITORS_ROLE = 'studio_monitors_script';

/**
 * Security helpers: allowed domains (§4.1) plus an object-ID token. Each must match exactly one candidate,
 * because a wrong helper bound as policy or commissioning would mislabel security state.
 */
export const SECURITY_HELPERS = Object.freeze([
  { key: 'policy', role: 'policy', token: 'policy', pattern: /policy/ },
  { key: 'suggested_mode', role: 'suggested_mode', token: 'suggested', pattern: /suggested/ },
  { key: 'commissioning', role: 'commissioning', token: '(^|_)commissioning$', pattern: /(^|_)commissioning$/ },
  { key: 'health_text', role: 'health_text', token: 'health', pattern: /health/ },
]);

/** Vehicle fields by object-ID suffix; each suffix must match at most one candidate. */
export const VEHICLE_SUFFIXES = Object.freeze([
  { suffix: '_battery_level', key: 'battery_sensor', required: true },
  { suffix: '_battery_range', key: 'range_sensor', required: true },
  { suffix: '_status', key: 'charger_status', required: false },
  { suffix: '_power', key: 'charger_power', required: false },
  { suffix: '_session_energy', key: 'session_energy', required: false },
]);
const APPLIANCE_STATUS_SUFFIX = '_current_status';
/** Every line break a text can carry, including the Unicode separators some editors and parsers honour. */
const LINE_BREAK_RE = /\r\n|[\n\r\u2028\u2029]/;
const APPLIANCE_REMAINING_SUFFIX = '_remaining_time';

/** Candidate groups the generator reads; any other group is reported in the header, never silently used. */
const KNOWN_GROUPS = Object.freeze([
  'people',
  'today',
  'climate',
  'air',
  'bed_comfort_optional',
  'vacuum_candidates',
  'media_candidates',
  'garage',
  'vehicle_read_only',
  'appliances_read_only',
  'lights',
  'curtains',
  'security_read_only',
  'perimeter_read_only',
  'upcoming_optional',
  'todo_optional',
]);
const OVERRIDE_KEYS = Object.freeze([
  'exclude',
  'names',
  'camera_thumbnails',
  'camera_live',
  'rooms',
  'vehicle_name',
  'charge_limit_pct',
  'vacuum_battery_sensors',
]);

/** Thrown for any rule failure; `problems` lists every message when several were found at once. */
export class PrivateConfigError extends Error {
  /** @param {readonly string[]} problems */
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'PrivateConfigError';
    this.problems = problems;
  }
}

/** @param {string} message */
function fail(message) {
  return new PrivateConfigError([message]);
}

/**
 * @typedef {{ entity_id: string, role: string, privacy_entity?: unknown, privacy_enabled_value?: unknown }} CameraCandidate
 * @typedef {{ label: unknown, entity_id: unknown, invocation: unknown }} GuardedAction
 * @typedef {{ preparedAt?: string, groups: Record<string, string[]>, notInInventory: string[], unknownGroups: string[],
 *             cameras: CameraCandidate[], guardedActions: GuardedAction[], knownAmbiguities: string[] }} Candidates
 * @typedef {{ name: string, lights: unknown, curtains?: unknown, purifier?: unknown }} RoomOverride
 * @typedef {{ exclude: string[], names: Record<string, string>, cameraThumbnails: Record<string, boolean>,
 *             cameraLive: Record<string, boolean>, rooms?: unknown[], vehicleName?: string,
 *             chargeLimitPct?: unknown, vacuumBatterySensors: Record<string, string> }} Overrides
 * @typedef {{ verifyBeforeEnabling: string[], thumbnailsOff: string[], liveOff: string[], unassigned: string[],
 *             notes: string[] }} Notes
 */

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the candidates file's shape and returns the groups as plain ID lists.
 * @param {unknown} data
 * @returns {Candidates}
 */
export function parseCandidates(data) {
  if (!isRecord(data) || !isRecord(/** @type {Record<string, unknown>} */ (data).groups)) {
    throw fail(`${CANDIDATES_FILE_NAME}: expected an object with a "groups" object.`);
  }
  const record = /** @type {Record<string, unknown>} */ (data);
  const rawGroups = /** @type {Record<string, unknown>} */ (record.groups);
  /** @type {Record<string, string[]>} */
  const groups = {};
  /** @type {string[]} */
  const notInInventory = [];
  for (const name of KNOWN_GROUPS) {
    const entries = rawGroups[name] ?? [];
    if (!Array.isArray(entries)) throw fail(`groups.${name} must be an array.`);
    groups[name] = entries.map((entry, index) => {
      const id = isRecord(entry) ? /** @type {Record<string, unknown>} */ (entry).entity_id : undefined;
      if (typeof id !== 'string' || !isValidEntityId(id)) {
        throw fail(`groups.${name}[${index}].entity_id is not a valid entity ID.`);
      }
      if (/** @type {Record<string, unknown>} */ (entry).known_in_saved_inventory === false) notInInventory.push(id);
      return id;
    });
  }
  const cameras = arrayField(record, 'camera_candidates').map((entry, index) => {
    const path = `camera_candidates[${index}]`;
    if (!isRecord(entry)) throw fail(`${path} must be an object.`);
    const camera = /** @type {Record<string, unknown>} */ (entry);
    if (typeof camera.entity_id !== 'string' || !isValidEntityId(camera.entity_id)) {
      throw fail(`${path}.entity_id is not a valid entity ID.`);
    }
    if (typeof camera.role !== 'string' || camera.role.trim() === '') throw fail(`${path}.role must be a string.`);
    return /** @type {CameraCandidate} */ (camera);
  });
  const guardedActions = arrayField(record, 'guarded_actions').map((entry, index) => {
    if (!isRecord(entry)) throw fail(`guarded_actions[${index}] must be an object.`);
    return /** @type {GuardedAction} */ (entry);
  });
  const knownAmbiguities = arrayField(record, 'known_ambiguities').map((entry, index) => {
    if (typeof entry !== 'string') throw fail(`known_ambiguities[${index}] must be a string.`);
    return entry;
  });
  return {
    preparedAt: typeof record.prepared_at === 'string' ? record.prepared_at : undefined,
    groups,
    notInInventory,
    unknownGroups: Object.keys(rawGroups).filter((name) => !KNOWN_GROUPS.includes(name)),
    cameras,
    guardedActions,
    knownAmbiguities,
  };
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {unknown[]}
 */
function arrayField(record, key) {
  const value = record[key] ?? [];
  if (!Array.isArray(value)) throw fail(`${CANDIDATES_FILE_NAME}: ${key} must be an array.`);
  return value;
}

/**
 * Validates the optional private overrides. Unknown keys and malformed maps fail loudly: a typo in a private file
 * must never silently change what the dashboard binds.
 * @param {unknown} data undefined when the overrides file does not exist
 * @returns {Overrides}
 */
export function parseOverrides(data) {
  if (data === undefined) {
    return { exclude: [], names: {}, cameraThumbnails: {}, cameraLive: {}, vacuumBatterySensors: {} };
  }
  if (!isRecord(data)) throw fail(`${OVERRIDES_FILE_NAME}: expected an object.`);
  const record = /** @type {Record<string, unknown>} */ (data);
  for (const key of Object.keys(record)) {
    if (!OVERRIDE_KEYS.includes(key)) {
      throw fail(`${OVERRIDES_FILE_NAME}: unknown key "${key}". Allowed: ${OVERRIDE_KEYS.join(', ')}.`);
    }
  }
  const exclude = record.exclude ?? [];
  if (!Array.isArray(exclude) || !exclude.every((id) => typeof id === 'string' && isValidEntityId(id))) {
    throw fail('overrides.exclude must be an array of valid entity IDs.');
  }
  if (record.rooms !== undefined && !Array.isArray(record.rooms)) throw fail('overrides.rooms must be an array.');
  if (record.vehicle_name !== undefined && typeof record.vehicle_name !== 'string') {
    throw fail('overrides.vehicle_name must be a string.');
  }
  return {
    exclude,
    names: idMap(record, 'names', (value) => typeof value === 'string' && value.trim() !== '', 'a non-empty string'),
    cameraThumbnails: idMap(record, 'camera_thumbnails', (value) => typeof value === 'boolean', 'true or false'),
    cameraLive: idMap(record, 'camera_live', (value) => typeof value === 'boolean', 'true or false'),
    rooms: /** @type {unknown[] | undefined} */ (record.rooms),
    vehicleName: /** @type {string | undefined} */ (record.vehicle_name),
    chargeLimitPct: record.charge_limit_pct,
    vacuumBatterySensors: idMap(
      record,
      'vacuum_battery_sensors',
      (value) => typeof value === 'string' && isValidEntityId(value),
      'a valid entity ID',
    ),
  };
}

/**
 * @template T
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @param {(value: unknown) => boolean} isValid
 * @param {string} expected
 * @returns {Record<string, T>}
 */
function idMap(record, key, isValid, expected) {
  const value = record[key] ?? {};
  if (!isRecord(value)) throw fail(`overrides.${key} must be an object keyed by entity ID.`);
  Object.entries(/** @type {Record<string, unknown>} */ (value)).forEach(([id, item], index) => {
    if (!isValidEntityId(id)) throw fail(`overrides.${key} entry ${index + 1}: the key is not a valid entity ID.`);
    if (!isValid(item)) throw fail(`overrides.${key} entry ${index + 1}: the value must be ${expected}.`);
  });
  return /** @type {Record<string, T>} */ (value);
}

/** @param {string} id */
function objectOf(id) {
  return id.slice(id.indexOf('.') + 1);
}

/**
 * "front_gate" → "Front Gate". Used only for names that the card requires (cameras, appliances, the vehicle).
 * @param {string} text
 */
export function titleCase(text) {
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Builds the card config from parsed inputs, validates it with `validateConfig`, and asserts the camera privacy
 * post-condition.
 * @param {Candidates} candidates
 * @param {Overrides} overrides
 * @returns {{ card: Record<string, unknown>, notes: Notes }}
 */
export function buildCard(candidates, overrides) {
  /** @type {Notes} */
  const notes = { verifyBeforeEnabling: [], thumbnailsOff: [], liveOff: [], unassigned: [], notes: [] };
  const excluded = new Set(overrides.exclude);
  assertExcludesAreCandidates(candidates, overrides.exclude);
  /** @type {Set<string>} */
  const namedIds = new Set();
  const nameFor = (/** @type {string} */ id) => {
    const name = overrides.names[id];
    if (name !== undefined) namedIds.add(id);
    return name;
  };
  const pick = (/** @type {string} */ group) =>
    /** @type {string[]} */ (candidates.groups[group]).filter((id) => !excluded.has(id));
  const ref = (/** @type {string} */ id) => {
    const name = nameFor(id);
    return name === undefined ? id : { entity: id, name };
  };

  /** @type {Record<string, unknown>} */
  const card = { type: CARD_TYPE, demo: false, controls: false };
  setList(card, 'people', pick('people').map(ref));
  Object.assign(card, mapToday(pick('today'), notes));
  setList(card, 'climate', pick('climate').map(ref));
  setList(card, 'air', pick('air').map(ref));
  setList(card, 'bed_comfort', pick('bed_comfort_optional').map(ref));
  setList(card, 'rooms', mapRooms(pick, excluded, overrides.rooms, notes));
  setList(card, 'vacuums', mapVacuums(pick('vacuum_candidates'), overrides, nameFor, notes));
  setList(card, 'appliances', mapAppliances(pick('appliances_read_only'), nameFor, notes));
  setList(card, 'media', pick('media_candidates').map(ref));
  setList(card, 'cameras', mapCameras(candidates.cameras, overrides, excluded, nameFor, notes));
  const garage = mapGarage(pick('garage'), nameFor, notes);
  if (garage) card.garage = garage;
  const vehicle = mapVehicle(pick('vehicle_read_only'), overrides, notes);
  if (vehicle) card.vehicle = vehicle;
  const { actions, studioMonitors } = mapGuardedActions(candidates.guardedActions, excluded, notes);
  card.security = mapSecurity(pick('security_read_only'), pick('perimeter_read_only').map(ref), actions, notes);
  if (studioMonitors) card.studio_monitors_script = studioMonitors;
  setList(card, 'calendars', pick('upcoming_optional').map(ref));

  const unusedNames = Object.keys(overrides.names).filter((id) => !namedIds.has(id)).length;
  if (unusedNames > 0) {
    throw fail(`overrides.names: ${unusedNames} key(s) are not emitted entities. Remove them or fix the IDs.`);
  }
  for (const id of candidates.notInInventory) {
    if (!excluded.has(id)) notes.verifyBeforeEnabling.push(`${id} (not in the saved inventory)`);
  }
  if (candidates.unknownGroups.length > 0) {
    notes.notes.push(`Ignored candidate groups: ${candidates.unknownGroups.join(', ')}.`);
  }

  const result = validateConfig(card);
  if (!result.ok) {
    throw new PrivateConfigError([
      'The generated config failed validation (nothing was written):',
      ...result.issues.map((issue) => `  ${issue.path}: ${issue.code}`),
    ]);
  }
  assertCameraPrivacyKept(candidates.cameras, excluded, card);
  return { card, notes };
}

/**
 * @param {Record<string, unknown>} card
 * @param {string} key
 * @param {readonly unknown[]} items empty lists are omitted to keep the file readable
 */
function setList(card, key, items) {
  if (items.length > 0) card[key] = items;
}

/**
 * @param {Candidates} candidates
 * @param {readonly string[]} exclude
 */
function assertExcludesAreCandidates(candidates, exclude) {
  const known = new Set(Object.values(candidates.groups).flat());
  for (const camera of candidates.cameras) {
    known.add(camera.entity_id);
    if (typeof camera.privacy_entity === 'string') known.add(camera.privacy_entity);
  }
  for (const action of candidates.guardedActions) {
    if (typeof action.entity_id === 'string') known.add(action.entity_id);
  }
  exclude.forEach((id, index) => {
    if (!known.has(id)) throw fail(`overrides.exclude[${index}] is not a candidate. Remove it or fix the ID.`);
  });
}

/**
 * Weather and sun by domain; several of either is ambiguous and never resolved by order.
 * @param {readonly string[]} ids
 * @param {Notes} notes
 */
function mapToday(ids, notes) {
  /** @type {Record<string, string>} */
  const today = {};
  for (const domain of ['weather', 'sun']) {
    const matches = ids.filter((id) => domainOf(id) === domain);
    if (matches.length > 1) {
      throw fail(`today: ${matches.length} ${domain} candidates (expected at most one). Exclude the others.`);
    }
    if (matches[0] !== undefined) today[domain] = matches[0];
  }
  const unused = ids.filter((id) => !['weather', 'sun'].includes(domainOf(id))).length;
  if (unused > 0) notes.notes.push(`${unused} today candidate(s) are neither weather nor sun and were not bound.`);
  return today;
}

/** Each `overrides.rooms` field and the candidate group its IDs must come from. */
const ROOM_MEMBERS = Object.freeze([
  { field: 'lights', group: 'lights', kind: 'light' },
  { field: 'curtains', group: 'curtains', kind: 'curtain' },
  { field: 'purifier', group: 'air', kind: 'purifier' },
]);

/**
 * @param {(group: string) => string[]} pick a group's candidates minus `overrides.exclude`
 * @param {ReadonlySet<string>} excluded
 * @param {readonly unknown[] | undefined} rooms
 * @param {Notes} notes
 */
function mapRooms(pick, excluded, rooms, notes) {
  const lights = pick('lights');
  const curtains = pick('curtains');
  if (rooms === undefined) {
    if (lights.length === 0 && curtains.length === 0) return [];
    notes.notes.push(
      `One default room "${DEFAULT_ROOM_NAME}" holds every light and curtain candidate. ` +
        'Add overrides.rooms to group them by room.',
    );
    return [{ name: DEFAULT_ROOM_NAME, lights: [...lights], curtains: [...curtains] }];
  }
  const placedLights = new Set();
  const placedCurtains = new Set();
  rooms.forEach((room, index) => {
    if (!isRecord(room)) throw fail(`overrides.rooms[${index}] must be an object.`);
    const record = /** @type {Record<string, unknown>} */ (room);
    assertRoomMembers(record, index, pick, excluded);
    if (Array.isArray(record.lights)) record.lights.forEach((id) => placedLights.add(id));
    if (Array.isArray(record.curtains)) record.curtains.forEach((id) => placedCurtains.add(id));
  });
  for (const id of lights) if (!placedLights.has(id)) notes.unassigned.push(`${id} (unassigned light)`);
  for (const id of curtains) if (!placedCurtains.has(id)) notes.unassigned.push(`${id} (unassigned curtain)`);
  return rooms.map((room) => structuredClone(room));
}

/**
 * A room may bind only candidates of the matching kind that are not excluded: a typo or an excluded ID must be
 * loud, never a silent binding. Entries that are not strings are left to `validateConfig`, which reports shapes.
 * @param {Record<string, unknown>} room
 * @param {number} index
 * @param {(group: string) => string[]} pick
 * @param {ReadonlySet<string>} excluded
 */
function assertRoomMembers(room, index, pick, excluded) {
  for (const { field, group, kind } of ROOM_MEMBERS) {
    const value = room[field];
    const allowed = new Set(pick(group));
    const entries = Array.isArray(value) ? value.map((id, position) => [id, `[${position}]`]) : [[value, '']];
    for (const [id, position] of entries) {
      if (typeof id !== 'string') continue;
      const path = `overrides.rooms[${index}].${field}${position}`;
      if (excluded.has(id)) {
        throw fail(`${path} is excluded by overrides.exclude. Remove it from the room or from exclude.`);
      }
      if (!allowed.has(id)) {
        throw fail(`${path} is not a ${kind} candidate (groups.${group}). Fix the ID or remove it.`);
      }
    }
  }
}

/**
 * @param {readonly string[]} ids
 * @param {Overrides} overrides
 * @param {(id: string) => string | undefined} nameFor
 * @param {Notes} notes
 */
function mapVacuums(ids, overrides, nameFor, notes) {
  const emitted = new Set(ids);
  const unknownBatteryKeys = Object.keys(overrides.vacuumBatterySensors).filter((id) => !emitted.has(id)).length;
  if (unknownBatteryKeys > 0) {
    throw fail(`overrides.vacuum_battery_sensors: ${unknownBatteryKeys} key(s) are not emitted vacuums.`);
  }
  return ids.map((id) => {
    notes.verifyBeforeEnabling.push(`${id} (vacuum candidates may be renamed or replaced devices)`);
    const name = nameFor(id);
    const battery = overrides.vacuumBatterySensors[id];
    return {
      entity: id,
      ...(name !== undefined && { name }),
      ...(battery !== undefined && { battery_sensor: battery }),
    };
  });
}

/**
 * Pairs `<p>_current_status` with `<p>_remaining_time`.
 * @param {readonly string[]} ids
 * @param {(id: string) => string | undefined} nameFor
 * @param {Notes} notes
 */
function mapAppliances(ids, nameFor, notes) {
  const used = new Set();
  const appliances = [];
  for (const status of ids) {
    const object = objectOf(status);
    if (!object.endsWith(APPLIANCE_STATUS_SUFFIX) || object === APPLIANCE_STATUS_SUFFIX.slice(1)) continue;
    const prefix = object.slice(0, -APPLIANCE_STATUS_SUFFIX.length);
    const remaining = ids.find((id) => objectOf(id) === `${prefix}${APPLIANCE_REMAINING_SUFFIX}`);
    used.add(status);
    if (remaining !== undefined) used.add(remaining);
    appliances.push({
      name: nameFor(status) ?? titleCase(prefix),
      status_sensor: status,
      ...(remaining !== undefined && { remaining_sensor: remaining }),
    });
  }
  const unpaired = ids.filter((id) => !used.has(id)).length;
  if (unpaired > 0) notes.notes.push(`${unpaired} appliance candidate(s) had no "${APPLIANCE_STATUS_SUFFIX}" pair.`);
  return appliances;
}

/**
 * Words in a camera's role, name or entity object ID that place it outdoors. Live view fails CLOSED (§9.4, §13.4):
 * the generator cannot see the picture, so a camera keeps live view only with positive outdoor evidence and none of
 * the indoor kind. A camera the list misses is written with `live: false`, which is the safe mistake.
 */
const OUTDOOR_WORDS = new Set([
  'backyard',
  'carport',
  'courtyard',
  'deck',
  'doorbell',
  'driveway',
  'exterior',
  'frontdoor',
  'frontyard',
  'garage',
  'garden',
  'gate',
  'lawn',
  'outdoor',
  'outdoors',
  'outside',
  'path',
  'pathway',
  'patio',
  'porch',
  'sidewalk',
  'street',
  'walkway',
  'yard',
]);
/** Two-word outdoor evidence: "door" alone is not (a bedroom door), but a front, back or side door is. */
const OUTDOOR_PAIRS = new Set(['front door', 'back door', 'side door']);
/**
 * Words that suggest a space inside the home. Any of them vetoes live view, whatever outdoor word sits beside it
 * ("garage entry", "porch hallway"); so does any word ending in "room" ("livingroom", "mudroom").
 */
const INDOOR_WORDS = new Set([
  'attic',
  'baby',
  'basement',
  'bath',
  'bathroom',
  'bed',
  'bedroom',
  'cellar',
  'closet',
  'corridor',
  'crib',
  'den',
  'dining',
  'downstairs',
  'entry',
  'entryway',
  'family',
  'fireplace',
  'foyer',
  'guest',
  'gym',
  'hall',
  'hallway',
  'indoor',
  'indoors',
  'inside',
  'interior',
  'kids',
  'kitchen',
  'landing',
  'laundry',
  'library',
  'living',
  'loft',
  'lounge',
  'mezzanine',
  'nursery',
  'office',
  'pantry',
  'playroom',
  'stair',
  'stairs',
  'staircase',
  'stairway',
  'studio',
  'study',
  'upstairs',
]);
const ROOM_SUFFIX = 'room';

/**
 * @param {string} text
 * @returns {string[]} the lowercase words of `text`, split on anything but letters
 */
function wordsOf(text) {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** @param {readonly string[]} words */
function hasIndoorWord(words) {
  return words.some((word) => INDOOR_WORDS.has(word) || word.endsWith(ROOM_SUFFIX));
}

/** @param {readonly string[]} words the words of ONE text, so a pair never spans two texts */
function hasOutdoorWord(words) {
  return words.some((word, index) => OUTDOOR_WORDS.has(word) || OUTDOOR_PAIRS.has(`${word} ${words[index + 1]}`));
}

/**
 * The §13.4 live-view rule for one camera, first match wins: an explicit `overrides.camera_live` entry; a privacy
 * binding (a camera someone wanted to switch off is treated as indoor); an indoor word; no outdoor word. Words come
 * from the candidate role, the emitted name and the entity object ID.
 * @param {CameraCandidate} camera
 * @param {string} name
 * @param {boolean} hasPrivacy
 * @param {Overrides} overrides
 * @returns {{ live: true } | { live: false, reason: string }}
 */
function cameraLive(camera, name, hasPrivacy, overrides) {
  const override = overrides.cameraLive[camera.entity_id];
  if (override === true) return { live: true };
  if (override === false) return { live: false, reason: 'overrides.camera_live' };
  if (hasPrivacy) return { live: false, reason: 'privacy binding: treated as indoor' };
  const texts = [camera.role, name, objectOf(camera.entity_id)].map(wordsOf);
  if (texts.some(hasIndoorWord)) return { live: false, reason: 'indoor word in its role, name or entity ID' };
  if (!texts.some(hasOutdoorWord)) return { live: false, reason: 'no outdoor word in its role, name or entity ID' };
  return { live: true };
}

/**
 * Fails on a camera override keyed by something that is not a candidate camera: a typo must be loud.
 * @param {Record<string, boolean>} map
 * @param {string} key
 * @param {ReadonlySet<string>} candidateIds
 */
function assertCameraKeys(map, key, candidateIds) {
  const unknown = Object.keys(map).filter((id) => !candidateIds.has(id)).length;
  if (unknown > 0) throw fail(`overrides.${key}: ${unknown} key(s) are not candidate cameras.`);
}

/**
 * §13.4 camera rules, in order. Privacy fields are never dropped; thumbnails and live view both default fail-closed,
 * and both are written explicitly for every camera.
 * @param {readonly CameraCandidate[]} cameras
 * @param {Overrides} overrides
 * @param {ReadonlySet<string>} excluded
 * @param {(id: string) => string | undefined} nameFor
 * @param {Notes} notes
 */
function mapCameras(cameras, overrides, excluded, nameFor, notes) {
  const candidateIds = new Set(cameras.map((camera) => camera.entity_id));
  assertCameraKeys(overrides.cameraThumbnails, 'camera_thumbnails', candidateIds);
  assertCameraKeys(overrides.cameraLive, 'camera_live', candidateIds);
  const mapped = [];
  for (const [index, camera] of cameras.entries()) {
    const path = `camera_candidates[${index}]`;
    const privacy = cameraPrivacy(camera, path);
    if (excluded.has(camera.entity_id)) continue; // the camera goes, and its privacy entity with it
    if (privacy && excluded.has(privacy.entity)) {
      throw fail(
        `${path}: its privacy entity is excluded while the camera stays. The privacy gate can never be removed ` +
          'on its own; exclude the camera too, or keep the privacy entity.',
      );
    }
    const optIn = overrides.cameraThumbnails[camera.entity_id];
    const thumbnails = optIn === false ? false : privacy !== undefined || optIn === true;
    if (!privacy && !thumbnails) notes.thumbnailsOff.push(camera.entity_id);
    const name = nameFor(camera.entity_id) ?? titleCase(camera.role);
    const live = cameraLive(camera, name, privacy !== undefined, overrides);
    if (!live.live) notes.liveOff.push(`${camera.entity_id} (${live.reason})`);
    mapped.push({
      entity: camera.entity_id,
      name,
      ...(privacy && { privacy_entity: privacy.entity, privacy_on_value: privacy.onValue }),
      thumbnails,
      live: live.live,
    });
  }
  return mapped;
}

/**
 * @param {CameraCandidate} camera
 * @param {string} path
 * @returns {{ entity: string, onValue: 'on' | 'off' } | undefined}
 */
function cameraPrivacy(camera, path) {
  const hasEntity = camera.privacy_entity !== undefined && camera.privacy_entity !== null;
  const hasValue = camera.privacy_enabled_value !== undefined && camera.privacy_enabled_value !== null;
  if (!hasEntity && !hasValue) return undefined;
  if (hasEntity !== hasValue) {
    throw fail(`${path}: privacy_entity and privacy_enabled_value must be set together; half a binding is broken.`);
  }
  const entity = camera.privacy_entity;
  if (typeof entity !== 'string' || !isValidEntityId(entity)) {
    throw fail(`${path}.privacy_entity is not a valid entity ID.`);
  }
  if (!DOMAINS_BY_ROLE.camera_privacy.includes(domainOf(entity))) {
    throw fail(`${path}.privacy_entity must be a ${DOMAINS_BY_ROLE.camera_privacy.join(', ')} entity.`);
  }
  const value = camera.privacy_enabled_value;
  // Exactly these strings: no trimming, lowercasing or boolean coercion ("On", "true" and true all fail).
  if (value !== 'on' && value !== 'off') throw fail(`${path}.privacy_enabled_value must be exactly "on" or "off".`);
  return { entity, onValue: value };
}

/**
 * Asserted before writing: every kept candidate camera with a privacy binding is emitted with exactly that binding.
 * @param {readonly CameraCandidate[]} cameras
 * @param {ReadonlySet<string>} excluded
 * @param {Record<string, unknown>} card
 */
function assertCameraPrivacyKept(cameras, excluded, card) {
  const emitted = /** @type {Array<Record<string, unknown>>} */ (card.cameras ?? []);
  cameras.forEach((camera, index) => {
    if (excluded.has(camera.entity_id) || camera.privacy_entity == null) return;
    const output = emitted.find((item) => item.entity === camera.entity_id);
    if (
      !output ||
      output.privacy_entity !== camera.privacy_entity ||
      output.privacy_on_value !== camera.privacy_enabled_value
    ) {
      throw fail(`camera_candidates[${index}]: the privacy binding was not carried into the output. Nothing written.`);
    }
  });
}

/**
 * @param {readonly string[]} ids
 * @param {(id: string) => string | undefined} nameFor
 * @param {Notes} notes
 */
function mapGarage(ids, nameFor, notes) {
  const [cover, ...others] = ids;
  if (cover === undefined) return undefined;
  if (others.length > 0) notes.notes.push(`${others.length} further garage candidate(s) were not bound.`);
  const name = nameFor(cover);
  return { cover, ...(name !== undefined && { name }) };
}

/**
 * Vehicle fields by suffix; several matches for any suffix exit, a missing battery or range omits the vehicle.
 * @param {readonly string[]} ids
 * @param {Overrides} overrides
 * @param {Notes} notes
 */
function mapVehicle(ids, overrides, notes) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const { suffix, key } of VEHICLE_SUFFIXES) {
    const matches = ids.filter((id) => objectOf(id).endsWith(suffix));
    if (matches.length > 1) {
      throw fail(
        `vehicle suffix "${suffix}": ${matches.length} candidates match (expected exactly one). ` +
          'Exclude the extra ones through overrides.exclude.',
      );
    }
    if (matches[0] !== undefined) fields[key] = matches[0];
  }
  const battery = fields.battery_sensor;
  if (battery === undefined || fields.range_sensor === undefined) {
    if (ids.length > 0) notes.notes.push('Vehicle omitted: no single battery-level and battery-range candidate.');
    return undefined;
  }
  const derivedName = titleCase(objectOf(battery).slice(0, -'_battery_level'.length));
  return {
    name: overrides.vehicleName ?? (derivedName || 'Car'),
    ...fields,
    ...(overrides.chargeLimitPct !== undefined && { charge_limit_pct: overrides.chargeLimitPct }),
  };
}

/**
 * Guarded actions through the exact label map; the invocation must be exactly a script.turn_on of the same script.
 * @param {readonly GuardedAction[]} guarded
 * @param {ReadonlySet<string>} excluded
 * @param {Notes} notes
 */
function mapGuardedActions(guarded, excluded, notes) {
  /** @type {Record<string, string>} */
  const actions = {};
  /** @type {string | undefined} */
  let studioMonitors;
  guarded.forEach((action, index) => {
    const path = `guarded_actions[${index}]`;
    const role =
      typeof action.label === 'string' && Object.hasOwn(ACTION_LABELS, action.label)
        ? ACTION_LABELS[/** @type {keyof typeof ACTION_LABELS} */ (action.label)]
        : undefined;
    if (role === undefined) {
      throw fail(`${path}.label is not in the label map. Known labels: ${Object.keys(ACTION_LABELS).join(' | ')}.`);
    }
    if (!isExactScriptInvocation(action)) {
      throw fail(
        `${path}.invocation must be exactly {domain: "script", service: "turn_on", data: {entity_id: <its ` +
          'entity_id>}} with a script.* entity_id.',
      );
    }
    const script = /** @type {string} */ (action.entity_id);
    if (excluded.has(script)) {
      notes.notes.push(`${path} (${role}) is excluded by overrides and was not bound.`);
      return;
    }
    if (role === STUDIO_MONITORS_ROLE ? studioMonitors !== undefined : actions[role] !== undefined) {
      throw fail(`${path}: role "${role}" is already held by an earlier guarded action.`);
    }
    if (role === STUDIO_MONITORS_ROLE) studioMonitors = script;
    else actions[role] = script;
  });
  return { actions, studioMonitors };
}

/** @param {GuardedAction} action */
function isExactScriptInvocation(action) {
  const { entity_id: id, invocation } = action;
  if (typeof id !== 'string' || !isValidEntityId(id) || domainOf(id) !== 'script' || !isRecord(invocation)) {
    return false;
  }
  const call = /** @type {Record<string, unknown>} */ (invocation);
  const data = call.data;
  return (
    hasExactKeys(call, ['data', 'domain', 'service']) &&
    call.domain === 'script' &&
    call.service === 'turn_on' &&
    isRecord(data) &&
    hasExactKeys(/** @type {Record<string, unknown>} */ (data), ['entity_id']) &&
    /** @type {Record<string, unknown>} */ (data).entity_id === id
  );
}

/**
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} keys sorted
 */
function hasExactKeys(record, keys) {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/**
 * The alarm plus four helpers, each exactly one candidate; ambiguity is never resolved by order.
 * @param {readonly string[]} ids security_read_only candidates
 * @param {readonly unknown[]} perimeter
 * @param {Record<string, string>} actions
 * @param {Notes} notes
 */
function mapSecurity(ids, perimeter, actions, notes) {
  const alarms = ids.filter((id) => domainOf(id) === 'alarm_control_panel');
  if (alarms.length !== 1) {
    throw fail(
      `security alarm: ${alarms.length} alarm_control_panel candidates in security_read_only (expected exactly one).`,
    );
  }
  const helpers = ids.filter((id) => domainOf(id) !== 'alarm_control_panel');
  /** @type {Record<string, unknown>} */
  const security = { alarm: alarms[0] };
  const bound = new Set();
  for (const { key, role, token, pattern } of SECURITY_HELPERS) {
    const domains = DOMAINS_BY_ROLE[/** @type {keyof typeof DOMAINS_BY_ROLE} */ (role)];
    const matches = helpers.filter((id) => domains.includes(domainOf(id)) && pattern.test(objectOf(id)));
    if (matches.length !== 1) {
      throw fail(
        `security helper token "${token}": ${matches.length} candidates match (expected exactly one). ` +
          'Exclude the wrong ones through overrides.exclude; nothing was written.',
      );
    }
    const id = /** @type {string} */ (matches[0]);
    if (bound.has(id))
      throw fail(`security helper token "${token}" matched a candidate already bound to another helper.`);
    bound.add(id);
    security[key] = id;
  }
  const unused = helpers.filter((id) => !bound.has(id)).length;
  if (unused > 0) notes.notes.push(`${unused} security_read_only candidate(s) matched no role and were not bound.`);
  if (perimeter.length > 0) security.perimeter = perimeter;
  if (Object.keys(actions).length > 0) security.actions = actions;
  return security;
}

/**
 * Renders the private file: a `#` comment header followed by the pretty-printed JSON dashboard config (JSON is
 * valid YAML 1.2, so it pastes into HA's raw configuration editor; stripping the comment lines gives a
 * lovelace/config/save payload).
 * @param {{ card: Record<string, unknown>, notes: Notes, candidates: Candidates, generatedAt: string,
 *           overridesUsed: boolean }} input
 * @returns {{ text: string, dashboard: Record<string, unknown> }}
 */
export function renderPrivateConfig({ card, notes, candidates, generatedAt, overridesUsed }) {
  const dashboard = {
    title: DASHBOARD_TITLE,
    views: [{ title: 'Home', path: VIEW_PATH, type: 'panel', cards: [card] }],
  };
  const lines = [
    'Agraharam: private dashboard configuration for url_path agraharam-next (generated). Never commit or publish it.',
    `Generated: ${generatedAt}`,
    `Source: .dashboard-local/${CANDIDATES_FILE_NAME}${candidates.preparedAt ? ` (prepared ${candidates.preparedAt})` : ''}`,
    `Overrides: ${overridesUsed ? `.dashboard-local/${OVERRIDES_FILE_NAME}` : 'none'}`,
    '',
    'Candidates only. Verify every ID in live HA before enabling actions.',
    ...section('Known ambiguities (verbatim from the candidates file):', candidates.knownAmbiguities),
    ...section('Verify before enabling:', notes.verifyBeforeEnabling),
    ...section(
      'Cameras with thumbnails: false because they have no privacy binding ("Live view on request"); opt an ' +
        'outdoor camera in through overrides.camera_thumbnails after checking it:',
      notes.thumbnailsOff,
    ),
    ...section(
      'Cameras with live: false (no live view from this dashboard), each with its reason. Live view stays on only ' +
        'for a camera with an outdoor word (front door, porch, driveway, yard, garage and so on) in its role, name ' +
        'or entity ID, no indoor word and no privacy binding. Check what a camera shows, then set it in ' +
        'overrides.camera_live:',
      notes.liveOff,
    ),
    ...section('Unassigned (no room in overrides.rooms lists them):', notes.unassigned),
    ...section('Notes:', notes.notes),
    '',
    'Controls: this file always sets "controls": false, so every control renders disabled. After the read-only',
    'verification in install/README.md, set "controls": true in the raw configuration editor and save.',
  ];
  const header = lines.flatMap(commentLines).join('\n');
  return { text: `${header}\n${JSON.stringify(dashboard, null, 2)}\n`, dashboard };
}

/**
 * @param {string} title
 * @param {readonly string[]} items
 */
function section(title, items) {
  // Continuation lines of a multi-line item stay indented under its bullet.
  const bullet = (/** @type {string} */ item) => `  - ${item.split(LINE_BREAK_RE).join('\n    ')}`;
  return items.length === 0 ? [] : ['', title, ...items.map(bullet)];
}

/**
 * Turns one logical header line into comment lines. Every line break (including Unicode separators) starts a new
 * `#` line and control characters are dropped, so verbatim text can never escape the comment into the JSON body.
 * @param {string} line
 */
function commentLines(line) {
  return line
    .split(LINE_BREAK_RE)
    .map((part) => part.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''))
    .map((part) => (part === '' ? '#' : `# ${part}`));
}

/**
 * The whole pipeline: parse, map, validate, render.
 * @param {{ candidatesData: unknown, overridesData?: unknown, generatedAt: string }} input
 * @returns {{ text: string, dashboard: Record<string, unknown>, card: Record<string, unknown>, notes: Notes }}
 */
export function generatePrivateConfig({ candidatesData, overridesData, generatedAt }) {
  const candidates = parseCandidates(candidatesData);
  const overrides = parseOverrides(overridesData);
  const { card, notes } = buildCard(candidates, overrides);
  const { text, dashboard } = renderPrivateConfig({
    card,
    notes,
    candidates,
    generatedAt,
    overridesUsed: overridesData !== undefined,
  });
  return { text, dashboard, card, notes };
}
