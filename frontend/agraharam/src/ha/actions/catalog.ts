/**
 * The action catalog (§7.1): one static spec per ActionKind, read by the gateway pipeline. A spec names the only
 * service the kind may call, the roles its target must hold, the capability it needs, its state precondition, the
 * data the gateway builds and the predicates that observe the outcome.
 *
 * By construction there is no entry for alarm panels, input helpers, selects, automations or cameras, no switch
 * service other than turn_on and turn_off for room lighting switches (§18), no script service other than turn_on, and
 * no script data at all (never `variables`). Tests enforce this.
 */
import type { ActionFamily, BindingRole } from '../../config/schema.ts';
import { temperatureStep } from '../../domain/steps.ts';
import {
  COVER_FEATURE,
  CLIMATE_FEATURE,
  FAN_FEATURE,
  MEDIA_PLAYER_FEATURE,
  supportsBrightness,
  VACUUM_FEATURE,
} from '../features.ts';
import type { ServiceDomain } from '../host.ts';
import { parseNumericValue } from '../normalize.ts';
import type { HassEntityLike } from '../types.ts';
import type { ActionKind, ActionRequest } from './types.ts';

type RequestOf<K extends ActionKind> = Extract<ActionRequest, { kind: K }>;

/** Where the gateway resolves the target(s) from: the request's own entity, or a configuration slot. */
type TargetSource = 'entity' | 'room' | 'garage' | 'security' | 'studio_monitors' | 'shortcut';

/** §7.1 "Unknown state": `allow` continues the pipeline for a target in state unknown, `deny` stops it. */
type UnknownStateRule = 'allow' | 'deny';

/** `unless-alarm-sounding` is Silence Sound: no confirmation only while the alarm is triggered or pending. */
type ConfirmRule = 'never' | 'always' | 'unless-alarm-sounding';
/** The only security role that may skip its confirmation, and only while the alarm sounds (§7.1, §8.2). */
const SILENCE_SOUND_ROLE = 'silence_sound';

/** Contextual `not-applicable` reasons; the copy lives in messages.ts. */
export type NotApplicableReason =
  | 'already-on'
  | 'already-off'
  | 'all-lights-on'
  | 'all-lights-off'
  | 'current-mode'
  | 'current-preset'
  | 'current-source'
  | 'already-cleaning'
  | 'not-cleaning'
  | 'already-docked'
  | 'already-returning'
  | 'already-open'
  | 'already-closed'
  | 'already-opening'
  | 'already-closing'
  | 'door-moving'
  | 'already-playing'
  | 'not-playing'
  | 'nothing-playing'
  | 'player-off'
  | 'already-running';

/**
 * One service call a request may make. Room specs make one call per part that has an available target, in this
 * order, because a ServiceCall has one domain: a room with lights and lighting switches is one light call and one
 * switch call under one ticket (§18). Single-target specs make exactly one call, their own domain.service.
 */
export interface ServicePart {
  readonly role: BindingRole;
  readonly domain: ServiceDomain;
  readonly service: string;
}

/** What observation predicates may read besides the target's current state. */
export interface ObservationContext<R extends ActionRequest = ActionRequest> {
  readonly req: R;
  /** The target's state object when the request was accepted. */
  readonly before: HassEntityLike | undefined;
  /** HA's context id for the call, once the promise resolved. */
  readonly contextId: string | undefined;
  /** hass.config.unit_system.temperature, for the climate tolerance. */
  readonly temperatureUnit: string;
}

export interface ActionSpec<R extends ActionRequest = ActionRequest> {
  readonly family: ActionFamily;
  readonly target: TargetSource;
  /** The binding roles the target must hold in config.bindings (the allowlist, §4.7 step 4). */
  readonly roles: readonly BindingRole[];
  readonly domain: ServiceDomain;
  readonly service: string;
  /** supported_features masks: the target needs ALL bits of ANY one mask (step 8). Empty requires nothing. */
  readonly requires: readonly number[];
  /** An extra capability test (brightness needs a brightness-capable color mode). */
  readonly capable?: (entity: HassEntityLike) => boolean;
  /** Covers with these device classes are refused with not-allowed (step 5a). */
  readonly refusedDeviceClasses?: readonly string[];
  /** Step 5b: switch-domain targets whose registry entity_category is one of these are never switched. */
  readonly refusedEntityCategories?: readonly string[];
  /** Target 'room' only: the calls, in order. `domain` and `service` equal parts[0]. */
  readonly parts?: readonly ServicePart[];
  readonly unknownState: UnknownStateRule;
  /** A rule, or a rule chosen per request: security actions share one spec but only Silence Sound may skip. */
  readonly confirm: ConfirmRule | ((req: R) => ConfirmRule);
  /** Step 7. Receives every resolved target's state; returns why the action does not apply right now. */
  readonly precondition?: (targets: readonly HassEntityLike[], req: R) => NotApplicableReason | undefined;
  /** The service data. Only validated request fields reach it; callers never supply data. */
  readonly data: (req: R) => Readonly<Record<string, unknown>>;
  /** True when this target's state shows the request took effect (every target must satisfy it). */
  readonly confirmed: (entity: HassEntityLike, ctx: ObservationContext<R>) => boolean;
  /** † progress: the target is visibly moving toward the requested state. */
  readonly progress?: (entity: HassEntityLike) => boolean;
  /** Garage only: after progress, the target moving or ending the other way settles the ticket as reversed. */
  readonly reversed?: (entity: HassEntityLike) => boolean;
}

type Catalog = { readonly [K in ActionKind]: ActionSpec<RequestOf<K>> };

const NO_DATA: Readonly<Record<string, unknown>> = Object.freeze({});
const noData = (): Readonly<Record<string, unknown>> => NO_DATA;

const GARAGE_LIKE_DEVICE_CLASSES: readonly string[] = Object.freeze(['garage', 'gate', 'door']);
/**
 * A plug's child lock, LED or power-on-behaviour switch carries one of these categories; a lamp's power switch has
 * none. Refused at runtime behind validation, which cannot see the registry (§18).
 */
const SETTINGS_ENTITY_CATEGORIES: readonly string[] = Object.freeze(['config', 'diagnostic']);
const HA_BRIGHTNESS_PER_PERCENT = 2.55;
const BRIGHTNESS_TOLERANCE_PCT = 2;
const VOLUME_TOLERANCE = 0.02;
const VOLUME_DECIMALS_SCALE = 100;
const FAN_MIN_TOLERANCE_PCT = 1;
const POSITION_OPEN = 100;
const POSITION_CLOSED = 0;

const stateIs =
  (...states: readonly string[]) =>
  (entity: HassEntityLike): boolean =>
    states.includes(entity.state);

const attribute = (entity: HassEntityLike, name: string): unknown => entity.attributes[name];

/** A precondition on the single resolved target. */
function onTarget<R extends ActionRequest>(
  check: (entity: HassEntityLike, req: R) => NotApplicableReason | undefined,
): (targets: readonly HassEntityLike[], req: R) => NotApplicableReason | undefined {
  return (targets, req) => {
    const [entity] = targets;
    return entity === undefined ? undefined : check(entity, req);
  };
}

const unless = (blocked: boolean, reason: NotApplicableReason): NotApplicableReason | undefined =>
  blocked ? reason : undefined;

/** A different track: media_title or media_content_id changed since the request. */
function trackChanged(entity: HassEntityLike, before: HassEntityLike | undefined): boolean {
  return (
    attribute(entity, 'media_title') !== attribute(before ?? entity, 'media_title') ||
    attribute(entity, 'media_content_id') !== attribute(before ?? entity, 'media_content_id')
  );
}

/** Scripts: a new last_triggered, a running state, or the entity carrying the call's own context. */
function scriptRan(entity: HassEntityLike, ctx: ObservationContext): boolean {
  if (entity.state === 'on') return true;
  if (ctx.before !== undefined && attribute(entity, 'last_triggered') !== attribute(ctx.before, 'last_triggered')) {
    return true;
  }
  return ctx.contextId !== undefined && ctx.contextId !== '' && entity.context.id === ctx.contextId;
}

const scriptPrecondition = onTarget((entity) => unless(entity.state === 'on', 'already-running'));

const garageMoving = (state: string): NotApplicableReason | undefined =>
  state === 'opening' || state === 'closing' ? 'door-moving' : undefined;

/** Every target that is not already in the requested state. */
const allTargetsAre =
  (state: string, reason: NotApplicableReason) =>
  (targets: readonly HassEntityLike[]): NotApplicableReason | undefined =>
    unless(
      targets.every((target) => target.state === state),
      reason,
    );

/** A room's calls for one service name: its lights first, then its lighting switches (§18). */
function roomParts(service: 'turn_on' | 'turn_off'): readonly ServicePart[] {
  return [
    { role: 'room_light', domain: 'light', service },
    { role: 'room_switch', domain: 'switch', service },
  ];
}

/** Deep-freezes the specs, so no code path can widen a role list, a feature mask or a call at runtime. */
function freezeCatalog(catalog: Catalog): Catalog {
  for (const spec of Object.values<ActionSpec<never>>(catalog)) {
    Object.freeze(spec.roles);
    Object.freeze(spec.requires);
    if (spec.parts !== undefined) {
      for (const part of spec.parts) Object.freeze(part);
      Object.freeze(spec.parts);
    }
    Object.freeze(spec);
  }
  return Object.freeze(catalog);
}

export const ACTION_CATALOG: Catalog = freezeCatalog({
  'light.turn_on': {
    family: 'light',
    target: 'entity',
    roles: ['room_light'],
    domain: 'light',
    service: 'turn_on',
    requires: [],
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'on', 'already-on')),
    data: noData,
    confirmed: stateIs('on'),
  },
  'light.turn_off': {
    family: 'light',
    target: 'entity',
    roles: ['room_light'],
    domain: 'light',
    service: 'turn_off',
    requires: [],
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'off', 'already-off')),
    data: noData,
    confirmed: stateIs('off'),
  },
  'light.set_brightness': {
    family: 'light',
    target: 'entity',
    roles: ['room_light'],
    domain: 'light',
    service: 'turn_on',
    requires: [],
    capable: (entity) => supportsBrightness(entity.attributes),
    unknownState: 'deny',
    confirm: 'never',
    data: (req) => ({ brightness_pct: req.pct }),
    confirmed: (entity, { req }) => {
      const brightness = parseNumericValue(attribute(entity, 'brightness'));
      return (
        entity.state === 'on' &&
        brightness !== null &&
        Math.abs(Math.round(brightness / HA_BRIGHTNESS_PER_PERCENT) - req.pct) <= BRIGHTNESS_TOLERANCE_PCT
      );
    },
  },
  // Lighting switches (lamps on smart plugs) in rooms: on and off only, never a settings switch (step 5b).
  'switch.turn_on': {
    family: 'switch',
    target: 'entity',
    roles: ['room_switch'],
    domain: 'switch',
    service: 'turn_on',
    requires: [],
    refusedEntityCategories: SETTINGS_ENTITY_CATEGORIES,
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'on', 'already-on')),
    data: noData,
    confirmed: stateIs('on'),
  },
  'switch.turn_off': {
    family: 'switch',
    target: 'entity',
    roles: ['room_switch'],
    domain: 'switch',
    service: 'turn_off',
    requires: [],
    refusedEntityCategories: SETTINGS_ENTITY_CATEGORIES,
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'off', 'already-off')),
    data: noData,
    confirmed: stateIs('off'),
  },
  // Room actions target the room's AVAILABLE lights and lighting switches only; unknown ones are left out of the
  // target (§7.1). One call per part with a target, so every lighting item reaches the same desired state.
  'room.lights_on': {
    family: 'room',
    target: 'room',
    roles: ['room_light', 'room_switch'],
    domain: 'light',
    service: 'turn_on',
    parts: roomParts('turn_on'),
    requires: [],
    refusedEntityCategories: SETTINGS_ENTITY_CATEGORIES,
    unknownState: 'deny',
    confirm: 'never',
    precondition: allTargetsAre('on', 'all-lights-on'),
    data: noData,
    confirmed: stateIs('on'),
  },
  'room.lights_off': {
    family: 'room',
    target: 'room',
    roles: ['room_light', 'room_switch'],
    domain: 'light',
    service: 'turn_off',
    parts: roomParts('turn_off'),
    requires: [],
    refusedEntityCategories: SETTINGS_ENTITY_CATEGORIES,
    unknownState: 'deny',
    confirm: 'never',
    precondition: allTargetsAre('off', 'all-lights-off'),
    data: noData,
    confirmed: stateIs('off'),
  },
  'climate.set_temperature': {
    family: 'climate',
    target: 'entity',
    roles: ['climate'],
    domain: 'climate',
    service: 'set_temperature',
    requires: [CLIMATE_FEATURE.TARGET_TEMPERATURE],
    unknownState: 'deny',
    confirm: 'never',
    data: (req) => ({ temperature: req.temperature }),
    confirmed: (entity, { req, before, temperatureUnit }) => {
      const target = parseNumericValue(attribute(entity, 'temperature'));
      const step = temperatureStep((before ?? entity).attributes, temperatureUnit);
      return target !== null && Math.abs(target - req.temperature) < step / 2;
    },
  },
  'climate.set_hvac_mode': {
    family: 'climate',
    target: 'entity',
    roles: ['climate'],
    domain: 'climate',
    service: 'set_hvac_mode',
    requires: [],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity, req) => unless(entity.state === req.mode, 'current-mode')),
    data: (req) => ({ hvac_mode: req.mode }),
    confirmed: (entity, { req }) => entity.state === req.mode,
  },
  'fan.turn_on': {
    family: 'fan',
    target: 'entity',
    roles: ['air', 'room_purifier'],
    domain: 'fan',
    service: 'turn_on',
    requires: [FAN_FEATURE.TURN_ON],
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'on', 'already-on')),
    data: noData,
    confirmed: stateIs('on'),
  },
  'fan.turn_off': {
    family: 'fan',
    target: 'entity',
    roles: ['air', 'room_purifier'],
    domain: 'fan',
    service: 'turn_off',
    requires: [FAN_FEATURE.TURN_OFF],
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'off', 'already-off')),
    data: noData,
    confirmed: stateIs('off'),
  },
  'fan.set_percentage': {
    family: 'fan',
    target: 'entity',
    roles: ['air', 'room_purifier'],
    domain: 'fan',
    service: 'set_percentage',
    requires: [FAN_FEATURE.SET_SPEED],
    unknownState: 'deny',
    confirm: 'never',
    data: (req) => ({ percentage: req.percentage }),
    confirmed: (entity, { req }) => {
      const percentage = parseNumericValue(attribute(entity, 'percentage'));
      const step = parseNumericValue(attribute(entity, 'percentage_step')) ?? 0;
      return percentage !== null && Math.abs(percentage - req.percentage) <= Math.max(FAN_MIN_TOLERANCE_PCT, step / 2);
    },
  },
  'fan.set_preset_mode': {
    family: 'fan',
    target: 'entity',
    roles: ['air', 'room_purifier'],
    domain: 'fan',
    service: 'set_preset_mode',
    requires: [FAN_FEATURE.SET_SPEED, FAN_FEATURE.PRESET_MODE],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity, req) => unless(attribute(entity, 'preset_mode') === req.preset, 'current-preset')),
    data: (req) => ({ preset_mode: req.preset }),
    confirmed: (entity, { req }) => attribute(entity, 'preset_mode') === req.preset,
  },
  'vacuum.start': {
    family: 'vacuum',
    target: 'entity',
    roles: ['vacuum'],
    domain: 'vacuum',
    service: 'start',
    requires: [VACUUM_FEATURE.START],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'cleaning', 'already-cleaning')),
    data: noData,
    confirmed: stateIs('cleaning'),
  },
  'vacuum.pause': {
    family: 'vacuum',
    target: 'entity',
    roles: ['vacuum'],
    domain: 'vacuum',
    service: 'pause',
    requires: [VACUUM_FEATURE.PAUSE],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(!['cleaning', 'returning'].includes(entity.state), 'not-cleaning')),
    data: noData,
    confirmed: stateIs('paused', 'idle'),
  },
  'vacuum.return_to_base': {
    family: 'vacuum',
    target: 'entity',
    roles: ['vacuum'],
    domain: 'vacuum',
    service: 'return_to_base',
    requires: [VACUUM_FEATURE.RETURN_HOME],
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => {
      if (entity.state === 'docked') return 'already-docked';
      return unless(entity.state === 'returning', 'already-returning');
    }),
    data: noData,
    confirmed: stateIs('returning', 'docked'),
  },
  'garage.open': {
    family: 'garage',
    target: 'garage',
    roles: ['garage_cover'],
    domain: 'cover',
    service: 'open_cover',
    requires: [COVER_FEATURE.OPEN],
    unknownState: 'deny',
    confirm: 'always',
    precondition: onTarget((entity) => {
      if (entity.state === 'closed') return undefined;
      return garageMoving(entity.state) ?? 'already-open';
    }),
    data: noData,
    confirmed: stateIs('open'),
    progress: stateIs('opening'),
    reversed: stateIs('closing', 'closed'),
  },
  'garage.close': {
    family: 'garage',
    target: 'garage',
    roles: ['garage_cover'],
    domain: 'cover',
    service: 'close_cover',
    requires: [COVER_FEATURE.CLOSE],
    unknownState: 'deny',
    confirm: 'always',
    precondition: onTarget((entity) => {
      if (entity.state === 'open') return undefined;
      return garageMoving(entity.state) ?? 'already-closed';
    }),
    data: noData,
    confirmed: stateIs('closed'),
    progress: stateIs('closing'),
    reversed: stateIs('opening', 'open'),
  },
  'curtain.open': {
    family: 'curtain',
    target: 'entity',
    roles: ['room_curtain'],
    domain: 'cover',
    service: 'open_cover',
    requires: [COVER_FEATURE.OPEN],
    refusedDeviceClasses: GARAGE_LIKE_DEVICE_CLASSES,
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => {
      if (entity.state === 'open') return 'already-open';
      return unless(entity.state === 'opening', 'already-opening');
    }),
    data: noData,
    confirmed: (entity) =>
      entity.state === 'open' || parseNumericValue(attribute(entity, 'current_position')) === POSITION_OPEN,
    progress: stateIs('opening'),
  },
  'curtain.close': {
    family: 'curtain',
    target: 'entity',
    roles: ['room_curtain'],
    domain: 'cover',
    service: 'close_cover',
    requires: [COVER_FEATURE.CLOSE],
    refusedDeviceClasses: GARAGE_LIKE_DEVICE_CLASSES,
    unknownState: 'allow',
    confirm: 'never',
    precondition: onTarget((entity) => {
      if (entity.state === 'closed') return 'already-closed';
      return unless(entity.state === 'closing', 'already-closing');
    }),
    data: noData,
    confirmed: (entity) =>
      entity.state === 'closed' || parseNumericValue(attribute(entity, 'current_position')) === POSITION_CLOSED,
    progress: stateIs('closing'),
  },
  'media.play': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'media_play',
    requires: [MEDIA_PLAYER_FEATURE.PLAY],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => {
      if (['paused', 'idle', 'on'].includes(entity.state)) return undefined;
      return ['playing', 'buffering'].includes(entity.state) ? 'already-playing' : 'player-off';
    }),
    data: noData,
    confirmed: stateIs('playing'),
  },
  'media.pause': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'media_pause',
    requires: [MEDIA_PLAYER_FEATURE.PAUSE],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(!['playing', 'buffering'].includes(entity.state), 'not-playing')),
    data: noData,
    confirmed: stateIs('paused', 'idle'),
  },
  'media.next': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'media_next_track',
    requires: [MEDIA_PLAYER_FEATURE.NEXT_TRACK],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(!['playing', 'paused'].includes(entity.state), 'nothing-playing')),
    data: noData,
    confirmed: (entity, { before }) => trackChanged(entity, before),
  },
  'media.previous': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'media_previous_track',
    requires: [MEDIA_PLAYER_FEATURE.PREVIOUS_TRACK],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(!['playing', 'paused'].includes(entity.state), 'nothing-playing')),
    data: noData,
    confirmed: (entity, { before }) => trackChanged(entity, before),
  },
  'media.volume_set': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'volume_set',
    requires: [MEDIA_PLAYER_FEATURE.VOLUME_SET],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'off', 'player-off')),
    data: (req) => ({ volume_level: Math.round(req.level * VOLUME_DECIMALS_SCALE) / VOLUME_DECIMALS_SCALE }),
    confirmed: (entity, { req }) => {
      const level = parseNumericValue(attribute(entity, 'volume_level'));
      return level !== null && Math.abs(level - req.level) <= VOLUME_TOLERANCE;
    },
  },
  'media.volume_mute': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'volume_mute',
    requires: [MEDIA_PLAYER_FEATURE.VOLUME_MUTE],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity) => unless(entity.state === 'off', 'player-off')),
    data: (req) => ({ is_volume_muted: req.muted }),
    confirmed: (entity, { req }) => attribute(entity, 'is_volume_muted') === req.muted,
  },
  'media.select_source': {
    family: 'media',
    target: 'entity',
    roles: ['media'],
    domain: 'media_player',
    service: 'select_source',
    requires: [MEDIA_PLAYER_FEATURE.SELECT_SOURCE],
    unknownState: 'deny',
    confirm: 'never',
    precondition: onTarget((entity, req) => unless(attribute(entity, 'source') === req.source, 'current-source')),
    data: (req) => ({ source: req.source }),
    confirmed: (entity, { req }) => attribute(entity, 'source') === req.source,
  },
  // Security actions run ONLY the guarded script bound to the role, through script.turn_on with no data.
  'security.run': {
    family: 'security',
    target: 'security',
    roles: ['security_action'],
    domain: 'script',
    service: 'turn_on',
    requires: [],
    unknownState: 'deny',
    // Every other role (disarm, holds, resume, departure) confirms always, even while the alarm is sounding.
    confirm: (req) => (req.role === SILENCE_SOUND_ROLE ? 'unless-alarm-sounding' : 'always'),
    precondition: scriptPrecondition,
    data: noData,
    confirmed: scriptRan,
  },
  'studio_monitors.run': {
    family: 'studio_monitors',
    target: 'studio_monitors',
    roles: ['studio_monitors'],
    domain: 'script',
    service: 'turn_on',
    requires: [],
    unknownState: 'deny',
    confirm: 'never',
    precondition: scriptPrecondition,
    data: noData,
    confirmed: scriptRan,
  },
  // Whole-house shortcuts run ONLY the script bound to the role, with no data, and ALWAYS confirm: a toggle script's
  // direction is unknowable, and no configuration can lower this floor (§18).
  'shortcut.run': {
    family: 'shortcut',
    target: 'shortcut',
    roles: ['house_shortcut'],
    domain: 'script',
    service: 'turn_on',
    requires: [],
    unknownState: 'deny',
    confirm: 'always',
    precondition: scriptPrecondition,
    data: noData,
    confirmed: scriptRan,
  },
});

/**
 * The spec for a request. The cast is sound by construction: the catalog is keyed by kind, so the entry for
 * `req.kind` is always the spec of `req`'s own variant.
 */
export function specFor<R extends ActionRequest>(req: R): ActionSpec<R> {
  return ACTION_CATALOG[req.kind] as unknown as ActionSpec<R>;
}

/** The confirmation rule that applies to this request (step 11). */
export function confirmRuleFor<R extends ActionRequest>(req: R): ConfirmRule {
  const rule = specFor(req).confirm;
  return typeof rule === 'function' ? rule(req) : rule;
}
