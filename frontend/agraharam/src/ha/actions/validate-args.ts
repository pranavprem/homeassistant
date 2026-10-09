/**
 * Request validation for the action gateway (§4.7 steps 1 and 10, §7.1 "Arg validation").
 *
 * Step 1 is a strict runtime shape check: a request must be a plain object with exactly the data properties of its
 * kind's variant, so extra keys such as `domain`, `service`, `data` or `entity_id` can never reach a service call,
 * even from untyped code. Step 10 checks argument values against the target's live attributes; temperatures accept
 * exactly the values `stepValue` produces, so the stepper and the gateway cannot disagree.
 */
import { isValidEntityId } from '../../config/entity-id.ts';
import { SHORTCUT_ROLES, type SecurityActionRole } from '../../config/schema.ts';
import { isStepValue, temperatureGrid } from '../../domain/steps.ts';
import type { HassEntityLike } from '../types.ts';
import type { ActionKind, ActionRequest } from './types.ts';

type FieldType = 'entity' | 'number' | 'string' | 'boolean' | 'room-index' | 'security-role' | 'shortcut-role';
type FieldSpec = Readonly<Record<string, FieldType>>;

const ENTITY_ONLY: FieldSpec = Object.freeze({ entity: 'entity' });
const NO_FIELDS: FieldSpec = Object.freeze({});

/** The data properties of every request variant besides `kind` (mirrors ActionRequest in types.ts). */
const REQUEST_FIELDS: Readonly<Record<ActionKind, FieldSpec>> = Object.freeze({
  'light.turn_on': ENTITY_ONLY,
  'light.turn_off': ENTITY_ONLY,
  'light.set_brightness': Object.freeze({ entity: 'entity', pct: 'number' }),
  'switch.turn_on': ENTITY_ONLY,
  'switch.turn_off': ENTITY_ONLY,
  'room.lights_on': Object.freeze({ room: 'room-index' }),
  'room.lights_off': Object.freeze({ room: 'room-index' }),
  'climate.set_temperature': Object.freeze({ entity: 'entity', temperature: 'number' }),
  'climate.set_hvac_mode': Object.freeze({ entity: 'entity', mode: 'string' }),
  'fan.turn_on': ENTITY_ONLY,
  'fan.turn_off': ENTITY_ONLY,
  'fan.set_percentage': Object.freeze({ entity: 'entity', percentage: 'number' }),
  'fan.set_preset_mode': Object.freeze({ entity: 'entity', preset: 'string' }),
  'vacuum.start': ENTITY_ONLY,
  'vacuum.pause': ENTITY_ONLY,
  'vacuum.return_to_base': ENTITY_ONLY,
  'garage.open': NO_FIELDS,
  'garage.close': NO_FIELDS,
  'curtain.open': ENTITY_ONLY,
  'curtain.close': ENTITY_ONLY,
  'media.play': ENTITY_ONLY,
  'media.pause': ENTITY_ONLY,
  'media.next': ENTITY_ONLY,
  'media.previous': ENTITY_ONLY,
  'media.volume_set': Object.freeze({ entity: 'entity', level: 'number' }),
  'media.volume_mute': Object.freeze({ entity: 'entity', muted: 'boolean' }),
  'media.select_source': Object.freeze({ entity: 'entity', source: 'string' }),
  'security.run': Object.freeze({ role: 'security-role' }),
  'studio_monitors.run': NO_FIELDS,
  'shortcut.run': Object.freeze({ role: 'shortcut-role' }),
});

const SECURITY_ROLES: ReadonlySet<string> = new Set<SecurityActionRole>([
  'disarm_hold',
  'silence_sound',
  'resume_auto',
  'hold_night',
  'hold_away',
  'hold_vacation',
  'prepare_departure',
]);
const SHORTCUT_ROLE_NAMES: ReadonlySet<string> = new Set<string>(SHORTCUT_ROLES);

/** Brightness and fan percentages are whole percents (§7.1). */
const PERCENT_RANGE = Object.freeze({ min: 1, max: 100 });
const VOLUME_RANGE = Object.freeze({ min: 0, max: 1 });

function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && Object.hasOwn(REQUEST_FIELDS, value);
}

/**
 * Step 1: a plain object whose own properties are exactly `kind` plus its variant's fields, each a plain data
 * property of the right type. Only ever applied to the plain copy copyActionRequest made, never to the caller's
 * object; accessors were refused while copying, because a getter could answer differently after validation.
 */
function isActionRequest(value: unknown): value is ActionRequest {
  if (!isPlainObject(value)) return false;
  const kind = dataProperty(value, 'kind');
  if (!isActionKind(kind)) return false;
  const fields = REQUEST_FIELDS[kind];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== Object.keys(fields).length + 1) return false;
  return keys.every((key) => {
    if (key === 'kind') return true;
    if (typeof key !== 'string' || !Object.hasOwn(fields, key)) return false;
    const type = fields[key];
    return type !== undefined && fieldMatches(type, dataProperty(value, key));
  });
}

/**
 * A frozen copy of a well-formed request, or undefined. The caller's object is read exactly once (its prototype, its
 * key list and each property's descriptor) into a plain object, and only that copy is validated and returned. A
 * Proxy or getter therefore cannot answer step 1 one way and the gateway another, and a later mutation of the
 * caller's object can never change what the gateway sends or observes. May throw if a Proxy trap throws.
 */
export function copyActionRequest(value: unknown): ActionRequest | undefined {
  if (!isPlainObject(value)) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    // defineProperty, not assignment: an own "__proto__" key must stay a key (and fail validation below).
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return isActionRequest(copy) ? (Object.freeze(copy) as unknown as ActionRequest) : undefined;
}

interface ArgumentContext {
  /** hass.config.unit_system.temperature, for the default climate step. */
  readonly temperatureUnit: string;
}

/** Step 10: the §7.1 "Arg validation" column. `entity` is the (single) target's current state. */
export function argumentsValid(req: ActionRequest, entity: HassEntityLike | undefined, ctx: ArgumentContext): boolean {
  const attributes = entity?.attributes ?? {};
  switch (req.kind) {
    case 'light.set_brightness':
      return isIntegerInRange(req.pct, PERCENT_RANGE);
    case 'climate.set_temperature':
      return isAcceptedTemperature(req.temperature, attributes, ctx.temperatureUnit);
    case 'climate.set_hvac_mode':
      return listIncludes(attributes['hvac_modes'], req.mode);
    case 'fan.set_percentage':
      return isIntegerInRange(req.percentage, PERCENT_RANGE);
    case 'fan.set_preset_mode':
      return listIncludes(attributes['preset_modes'], req.preset);
    case 'media.volume_set':
      return Number.isFinite(req.level) && req.level >= VOLUME_RANGE.min && req.level <= VOLUME_RANGE.max;
    case 'media.volume_mute':
      return typeof req.muted === 'boolean';
    case 'media.select_source':
      return listIncludes(attributes['source_list'], req.source);
    default:
      // The remaining kinds take no arguments; room indexes and security and shortcut roles are resolved as targets
      // (step 4).
      return true;
  }
}

function isAcceptedTemperature(value: number, attributes: Readonly<Record<string, unknown>>, unit: string): boolean {
  const grid = temperatureGrid(attributes, unit);
  return grid !== undefined && isStepValue(value, grid);
}

function isIntegerInRange(value: number, range: { readonly min: number; readonly max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** Exact membership in an attribute list: no trimming, case folding or coercion. */
function listIncludes(list: unknown, value: string): boolean {
  return Array.isArray(list) && list.some((item) => item === value);
}

function fieldMatches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'entity':
      return typeof value === 'string' && isValidEntityId(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'room-index':
      return Number.isSafeInteger(value) && (value as number) >= 0;
    case 'security-role':
      return typeof value === 'string' && SECURITY_ROLES.has(value);
    case 'shortcut-role':
      return typeof value === 'string' && SHORTCUT_ROLE_NAMES.has(value);
  }
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The value of an own data property, or undefined for a missing or accessor property. */
function dataProperty(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
