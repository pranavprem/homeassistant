/**
 * One entry per §7.1 catalog row: the request, the state that makes it applicable, the exact ServiceCall the gateway
 * must build, and the inputs that exercise its precondition, unknown-state rule, capability, arguments, observation
 * and timeout. Shared by the table-driven gateway tests and the controls-off sweep.
 */
import type { EntityId } from '../../src/config/schema.ts';
import type { ActionKind, ActionRequest } from '../../src/ha/actions/types.ts';
import { FEATURES, IDS, type Harness } from './harness.ts';
import { FAN_FEATURE, MEDIA_PLAYER_FEATURE, VACUUM_FEATURE, COVER_FEATURE } from '../../src/ha/features.ts';

type Attributes = Readonly<Record<string, unknown>>;
export type StateSpec = readonly [state: string, attributes?: Attributes];

export interface Row {
  readonly req: ActionRequest;
  /** States (merged over BASE_STATES) that make the precondition hold. */
  readonly ready?: Readonly<Record<string, StateSpec>>;
  readonly call: {
    readonly domain: string;
    readonly service: string;
    readonly data: Attributes;
    readonly entity_id: string | readonly string[];
  };
  readonly confirm: boolean;
  /** States (attributes merged into the current ones) that fail the precondition, and the contextual message. */
  readonly notApplicable?: { readonly states: Readonly<Record<string, StateSpec>>; readonly message: string };
  readonly unknown: 'allow' | 'deny';
  /** The entity (or entities) whose state goes 'unknown' for the unknown-state rule. */
  readonly unknownTargets: readonly string[];
  /** An attribute patch that removes the needed capability. */
  readonly withoutCapability?: { readonly id: string; readonly attributes: Attributes };
  readonly badArguments?: readonly ActionRequest[];
  /** Moves the target(s) into the observed (confirmed) state. */
  readonly observe: (h: Harness) => void;
  /** Moves the target(s) into the † progress state, where the row has one. */
  readonly progress?: (h: Harness) => void;
  readonly timeoutMs: number;
}

const e = (id: string): EntityId => id as EntityId;
const without = (mask: number, bit: number): number => mask & ~bit;

const PAUSED_SPEAKER: StateSpec = [
  'paused',
  { supported_features: FEATURES.media, source_list: ['Radio'], source: 'Radio' },
];

export const ROWS: Readonly<Record<ActionKind, Row>> = {
  'light.turn_on': {
    req: { kind: 'light.turn_on', entity: e(IDS.kitchenLight) },
    call: { domain: 'light', service: 'turn_on', data: {}, entity_id: IDS.kitchenLight },
    confirm: false,
    notApplicable: { states: { [IDS.kitchenLight]: ['on'] }, message: 'Already on' },
    unknown: 'allow',
    unknownTargets: [IDS.kitchenLight],
    observe: (h) => h.patch(IDS.kitchenLight, {}, 'on'),
    timeoutMs: 10_000,
  },
  'light.turn_off': {
    req: { kind: 'light.turn_off', entity: e(IDS.kitchenLight) },
    ready: { [IDS.kitchenLight]: ['on', { supported_color_modes: ['brightness'], brightness: 255 }] },
    call: { domain: 'light', service: 'turn_off', data: {}, entity_id: IDS.kitchenLight },
    confirm: false,
    notApplicable: { states: { [IDS.kitchenLight]: ['off'] }, message: 'Already off' },
    unknown: 'allow',
    unknownTargets: [IDS.kitchenLight],
    observe: (h) => h.patch(IDS.kitchenLight, {}, 'off'),
    timeoutMs: 10_000,
  },
  'light.set_brightness': {
    req: { kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: 40 },
    call: { domain: 'light', service: 'turn_on', data: { brightness_pct: 40 }, entity_id: IDS.kitchenLight },
    confirm: false,
    unknown: 'deny',
    unknownTargets: [IDS.kitchenLight],
    withoutCapability: { id: IDS.kitchenLight, attributes: { supported_color_modes: ['onoff'] } },
    badArguments: [
      { kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: 0 },
      { kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: 101 },
      { kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: 40.5 },
      { kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: Number.NaN },
    ],
    // 102 / 2.55 = 40 %
    observe: (h) => h.patch(IDS.kitchenLight, { brightness: 102 }, 'on'),
    timeoutMs: 10_000,
  },
  'switch.turn_on': {
    req: { kind: 'switch.turn_on', entity: e(IDS.deskLamp) },
    call: { domain: 'switch', service: 'turn_on', data: {}, entity_id: IDS.deskLamp },
    confirm: false,
    notApplicable: { states: { [IDS.deskLamp]: ['on'] }, message: 'Already on' },
    unknown: 'allow',
    unknownTargets: [IDS.deskLamp],
    observe: (h) => h.patch(IDS.deskLamp, {}, 'on'),
    timeoutMs: 10_000,
  },
  'switch.turn_off': {
    req: { kind: 'switch.turn_off', entity: e(IDS.deskLamp) },
    ready: { [IDS.deskLamp]: ['on', { friendly_name: 'Desk lamp' }] },
    call: { domain: 'switch', service: 'turn_off', data: {}, entity_id: IDS.deskLamp },
    confirm: false,
    notApplicable: { states: { [IDS.deskLamp]: ['off'] }, message: 'Already off' },
    unknown: 'allow',
    unknownTargets: [IDS.deskLamp],
    observe: (h) => h.patch(IDS.deskLamp, {}, 'off'),
    timeoutMs: 10_000,
  },
  'room.lights_on': {
    req: { kind: 'room.lights_on', room: 0 },
    call: { domain: 'light', service: 'turn_on', data: {}, entity_id: [IDS.kitchenLight, IDS.kitchenStrip] },
    confirm: false,
    notApplicable: {
      states: { [IDS.kitchenLight]: ['on'], [IDS.kitchenStrip]: ['on'] },
      message: 'All lights are already on',
    },
    unknown: 'deny',
    unknownTargets: [IDS.kitchenLight, IDS.kitchenStrip],
    observe: (h) => {
      h.patch(IDS.kitchenLight, {}, 'on');
      h.patch(IDS.kitchenStrip, {}, 'on');
    },
    timeoutMs: 15_000,
  },
  'room.lights_off': {
    req: { kind: 'room.lights_off', room: 1 },
    call: { domain: 'light', service: 'turn_off', data: {}, entity_id: [IDS.courtyardLight] },
    confirm: false,
    notApplicable: { states: { [IDS.courtyardLight]: ['off'] }, message: 'All lights are already off' },
    unknown: 'deny',
    unknownTargets: [IDS.courtyardLight],
    observe: (h) => h.patch(IDS.courtyardLight, {}, 'off'),
    timeoutMs: 15_000,
  },
  'climate.set_temperature': {
    req: { kind: 'climate.set_temperature', entity: e(IDS.thermostat), temperature: 74 },
    call: { domain: 'climate', service: 'set_temperature', data: { temperature: 74 }, entity_id: IDS.thermostat },
    confirm: false,
    unknown: 'deny',
    unknownTargets: [IDS.thermostat],
    withoutCapability: { id: IDS.thermostat, attributes: { supported_features: 0 } },
    badArguments: [
      { kind: 'climate.set_temperature', entity: e(IDS.thermostat), temperature: 44 },
      { kind: 'climate.set_temperature', entity: e(IDS.thermostat), temperature: 96 },
      { kind: 'climate.set_temperature', entity: e(IDS.thermostat), temperature: 72.5 },
      { kind: 'climate.set_temperature', entity: e(IDS.thermostat), temperature: Number.NaN },
      { kind: 'climate.set_temperature', entity: e(IDS.thermostat), temperature: Number.POSITIVE_INFINITY },
    ],
    observe: (h) => h.patch(IDS.thermostat, { temperature: 74 }),
    timeoutMs: 20_000,
  },
  'climate.set_hvac_mode': {
    req: { kind: 'climate.set_hvac_mode', entity: e(IDS.thermostat), mode: 'heat' },
    call: { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: 'heat' }, entity_id: IDS.thermostat },
    confirm: false,
    notApplicable: {
      states: { [IDS.thermostat]: ['heat', { hvac_modes: ['off', 'cool', 'heat'] }] },
      message: 'Current mode',
    },
    unknown: 'deny',
    unknownTargets: [IDS.thermostat],
    badArguments: [
      { kind: 'climate.set_hvac_mode', entity: e(IDS.thermostat), mode: 'dry' },
      { kind: 'climate.set_hvac_mode', entity: e(IDS.thermostat), mode: 'Heat' },
    ],
    observe: (h) => h.patch(IDS.thermostat, {}, 'heat'),
    timeoutMs: 20_000,
  },
  'fan.turn_on': {
    req: { kind: 'fan.turn_on', entity: e(IDS.roomPurifier) },
    call: { domain: 'fan', service: 'turn_on', data: {}, entity_id: IDS.roomPurifier },
    confirm: false,
    notApplicable: {
      states: { [IDS.roomPurifier]: ['on', { supported_features: FEATURES.fan }] },
      message: 'Already on',
    },
    unknown: 'allow',
    unknownTargets: [IDS.roomPurifier],
    withoutCapability: {
      id: IDS.roomPurifier,
      attributes: { supported_features: without(FEATURES.fan, FAN_FEATURE.TURN_ON) },
    },
    observe: (h) => h.patch(IDS.roomPurifier, {}, 'on'),
    timeoutMs: 20_000,
  },
  'fan.turn_off': {
    req: { kind: 'fan.turn_off', entity: e(IDS.purifier) },
    call: { domain: 'fan', service: 'turn_off', data: {}, entity_id: IDS.purifier },
    confirm: false,
    notApplicable: {
      states: { [IDS.purifier]: ['off', { supported_features: FEATURES.fan }] },
      message: 'Already off',
    },
    unknown: 'allow',
    unknownTargets: [IDS.purifier],
    withoutCapability: {
      id: IDS.purifier,
      attributes: { supported_features: without(FEATURES.fan, FAN_FEATURE.TURN_OFF) },
    },
    observe: (h) => h.patch(IDS.purifier, {}, 'off'),
    timeoutMs: 20_000,
  },
  'fan.set_percentage': {
    req: { kind: 'fan.set_percentage', entity: e(IDS.purifier), percentage: 75 },
    call: { domain: 'fan', service: 'set_percentage', data: { percentage: 75 }, entity_id: IDS.purifier },
    confirm: false,
    unknown: 'deny',
    unknownTargets: [IDS.purifier],
    withoutCapability: {
      id: IDS.purifier,
      attributes: { supported_features: without(FEATURES.fan, FAN_FEATURE.SET_SPEED) },
    },
    badArguments: [
      { kind: 'fan.set_percentage', entity: e(IDS.purifier), percentage: 0 },
      { kind: 'fan.set_percentage', entity: e(IDS.purifier), percentage: 101 },
      { kind: 'fan.set_percentage', entity: e(IDS.purifier), percentage: 33.3 },
    ],
    observe: (h) => h.patch(IDS.purifier, { percentage: 75 }),
    timeoutMs: 20_000,
  },
  'fan.set_preset_mode': {
    req: { kind: 'fan.set_preset_mode', entity: e(IDS.purifier), preset: 'sleep' },
    call: { domain: 'fan', service: 'set_preset_mode', data: { preset_mode: 'sleep' }, entity_id: IDS.purifier },
    confirm: false,
    notApplicable: {
      states: {
        [IDS.purifier]: [
          'on',
          { supported_features: FEATURES.fan, preset_modes: ['auto', 'sleep'], preset_mode: 'sleep' },
        ],
      },
      message: 'Current preset',
    },
    unknown: 'deny',
    unknownTargets: [IDS.purifier],
    withoutCapability: {
      id: IDS.purifier,
      attributes: { supported_features: FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF },
    },
    badArguments: [
      { kind: 'fan.set_preset_mode', entity: e(IDS.purifier), preset: 'Sleep' },
      { kind: 'fan.set_preset_mode', entity: e(IDS.purifier), preset: 'eco' },
    ],
    observe: (h) => h.patch(IDS.purifier, { preset_mode: 'sleep' }),
    timeoutMs: 20_000,
  },
  'vacuum.start': {
    req: { kind: 'vacuum.start', entity: e(IDS.vacuum) },
    call: { domain: 'vacuum', service: 'start', data: {}, entity_id: IDS.vacuum },
    confirm: false,
    notApplicable: {
      states: { [IDS.vacuum]: ['cleaning', { supported_features: FEATURES.vacuum }] },
      message: 'Already cleaning',
    },
    unknown: 'deny',
    unknownTargets: [IDS.vacuum],
    withoutCapability: {
      id: IDS.vacuum,
      attributes: { supported_features: without(FEATURES.vacuum, VACUUM_FEATURE.START) },
    },
    observe: (h) => h.patch(IDS.vacuum, {}, 'cleaning'),
    timeoutMs: 30_000,
  },
  'vacuum.pause': {
    req: { kind: 'vacuum.pause', entity: e(IDS.vacuum) },
    ready: { [IDS.vacuum]: ['cleaning', { supported_features: FEATURES.vacuum }] },
    call: { domain: 'vacuum', service: 'pause', data: {}, entity_id: IDS.vacuum },
    confirm: false,
    notApplicable: {
      states: { [IDS.vacuum]: ['docked', { supported_features: FEATURES.vacuum }] },
      message: 'Not cleaning right now',
    },
    unknown: 'deny',
    unknownTargets: [IDS.vacuum],
    withoutCapability: {
      id: IDS.vacuum,
      attributes: { supported_features: without(FEATURES.vacuum, VACUUM_FEATURE.PAUSE) },
    },
    observe: (h) => h.patch(IDS.vacuum, {}, 'paused'),
    timeoutMs: 30_000,
  },
  'vacuum.return_to_base': {
    req: { kind: 'vacuum.return_to_base', entity: e(IDS.vacuum) },
    ready: { [IDS.vacuum]: ['cleaning', { supported_features: FEATURES.vacuum }] },
    call: { domain: 'vacuum', service: 'return_to_base', data: {}, entity_id: IDS.vacuum },
    confirm: false,
    notApplicable: {
      states: { [IDS.vacuum]: ['docked', { supported_features: FEATURES.vacuum }] },
      message: 'Already docked',
    },
    unknown: 'allow',
    unknownTargets: [IDS.vacuum],
    withoutCapability: {
      id: IDS.vacuum,
      attributes: { supported_features: without(FEATURES.vacuum, VACUUM_FEATURE.RETURN_HOME) },
    },
    observe: (h) => h.patch(IDS.vacuum, {}, 'returning'),
    timeoutMs: 30_000,
  },
  'garage.open': {
    req: { kind: 'garage.open' },
    call: { domain: 'cover', service: 'open_cover', data: {}, entity_id: IDS.garage },
    confirm: true,
    notApplicable: {
      states: { [IDS.garage]: ['open', { supported_features: FEATURES.cover }] },
      message: 'Already open',
    },
    unknown: 'deny',
    unknownTargets: [IDS.garage],
    withoutCapability: { id: IDS.garage, attributes: { supported_features: COVER_FEATURE.CLOSE } },
    progress: (h) => h.patch(IDS.garage, {}, 'opening'),
    observe: (h) => h.patch(IDS.garage, {}, 'open'),
    timeoutMs: 60_000,
  },
  'garage.close': {
    req: { kind: 'garage.close' },
    ready: { [IDS.garage]: ['open', { supported_features: FEATURES.cover, device_class: 'garage' }] },
    call: { domain: 'cover', service: 'close_cover', data: {}, entity_id: IDS.garage },
    confirm: true,
    notApplicable: {
      states: { [IDS.garage]: ['closed', { supported_features: FEATURES.cover }] },
      message: 'Already closed',
    },
    unknown: 'deny',
    unknownTargets: [IDS.garage],
    withoutCapability: { id: IDS.garage, attributes: { supported_features: COVER_FEATURE.OPEN } },
    progress: (h) => h.patch(IDS.garage, {}, 'closing'),
    observe: (h) => h.patch(IDS.garage, {}, 'closed'),
    timeoutMs: 60_000,
  },
  'curtain.open': {
    req: { kind: 'curtain.open', entity: e(IDS.blind) },
    call: { domain: 'cover', service: 'open_cover', data: {}, entity_id: IDS.blind },
    confirm: false,
    notApplicable: {
      states: { [IDS.blind]: ['open', { supported_features: FEATURES.cover }] },
      message: 'Already open',
    },
    unknown: 'allow',
    unknownTargets: [IDS.blind],
    withoutCapability: { id: IDS.blind, attributes: { supported_features: COVER_FEATURE.CLOSE } },
    progress: (h) => h.patch(IDS.blind, {}, 'opening'),
    observe: (h) => h.patch(IDS.blind, { current_position: 100 }),
    timeoutMs: 60_000,
  },
  'curtain.close': {
    req: { kind: 'curtain.close', entity: e(IDS.blind) },
    ready: {
      [IDS.blind]: ['open', { supported_features: FEATURES.cover, current_position: 100, device_class: 'blind' }],
    },
    call: { domain: 'cover', service: 'close_cover', data: {}, entity_id: IDS.blind },
    confirm: false,
    notApplicable: {
      states: { [IDS.blind]: ['closed', { supported_features: FEATURES.cover }] },
      message: 'Already closed',
    },
    unknown: 'allow',
    unknownTargets: [IDS.blind],
    withoutCapability: { id: IDS.blind, attributes: { supported_features: COVER_FEATURE.OPEN } },
    progress: (h) => h.patch(IDS.blind, {}, 'closing'),
    observe: (h) => h.patch(IDS.blind, { current_position: 0 }, 'closed'),
    timeoutMs: 60_000,
  },
  'media.play': {
    req: { kind: 'media.play', entity: e(IDS.speaker) },
    ready: { [IDS.speaker]: PAUSED_SPEAKER },
    call: { domain: 'media_player', service: 'media_play', data: {}, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: { [IDS.speaker]: ['playing', { supported_features: FEATURES.media }] },
      message: 'Already playing',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.PLAY) },
    },
    observe: (h) => h.patch(IDS.speaker, {}, 'playing'),
    timeoutMs: 10_000,
  },
  'media.pause': {
    req: { kind: 'media.pause', entity: e(IDS.speaker) },
    call: { domain: 'media_player', service: 'media_pause', data: {}, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: { [IDS.speaker]: ['paused', { supported_features: FEATURES.media }] },
      message: 'Not playing',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.PAUSE) },
    },
    observe: (h) => h.patch(IDS.speaker, {}, 'paused'),
    timeoutMs: 10_000,
  },
  'media.next': {
    req: { kind: 'media.next', entity: e(IDS.speaker) },
    call: { domain: 'media_player', service: 'media_next_track', data: {}, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: { [IDS.speaker]: ['off', { supported_features: FEATURES.media }] },
      message: 'Nothing is playing',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.NEXT_TRACK) },
    },
    observe: (h) => h.patch(IDS.speaker, { media_title: 'Monsoon theme' }),
    timeoutMs: 10_000,
  },
  'media.previous': {
    req: { kind: 'media.previous', entity: e(IDS.speaker) },
    call: { domain: 'media_player', service: 'media_previous_track', data: {}, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: { [IDS.speaker]: ['idle', { supported_features: FEATURES.media }] },
      message: 'Nothing is playing',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.PREVIOUS_TRACK) },
    },
    observe: (h) => h.patch(IDS.speaker, { media_content_id: 'demo-track-0' }),
    timeoutMs: 10_000,
  },
  'media.volume_set': {
    req: { kind: 'media.volume_set', entity: e(IDS.speaker), level: 0.456 },
    call: { domain: 'media_player', service: 'volume_set', data: { volume_level: 0.46 }, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: { [IDS.speaker]: ['off', { supported_features: FEATURES.media }] },
      message: 'The player is off',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.VOLUME_SET) },
    },
    badArguments: [
      { kind: 'media.volume_set', entity: e(IDS.speaker), level: -0.1 },
      { kind: 'media.volume_set', entity: e(IDS.speaker), level: 1.2 },
      { kind: 'media.volume_set', entity: e(IDS.speaker), level: Number.NaN },
    ],
    observe: (h) => h.patch(IDS.speaker, { volume_level: 0.46 }),
    timeoutMs: 10_000,
  },
  'media.volume_mute': {
    req: { kind: 'media.volume_mute', entity: e(IDS.speaker), muted: true },
    call: { domain: 'media_player', service: 'volume_mute', data: { is_volume_muted: true }, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: { [IDS.speaker]: ['off', { supported_features: FEATURES.media }] },
      message: 'The player is off',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.VOLUME_MUTE) },
    },
    observe: (h) => h.patch(IDS.speaker, { is_volume_muted: true }),
    timeoutMs: 10_000,
  },
  'media.select_source': {
    req: { kind: 'media.select_source', entity: e(IDS.speaker), source: 'Turntable' },
    call: { domain: 'media_player', service: 'select_source', data: { source: 'Turntable' }, entity_id: IDS.speaker },
    confirm: false,
    notApplicable: {
      states: {
        [IDS.speaker]: [
          'playing',
          { supported_features: FEATURES.media, source_list: ['Radio', 'Turntable'], source: 'Turntable' },
        ],
      },
      message: 'Current source',
    },
    unknown: 'deny',
    unknownTargets: [IDS.speaker],
    withoutCapability: {
      id: IDS.speaker,
      attributes: { supported_features: without(FEATURES.media, MEDIA_PLAYER_FEATURE.SELECT_SOURCE) },
    },
    badArguments: [
      { kind: 'media.select_source', entity: e(IDS.speaker), source: 'turntable' },
      { kind: 'media.select_source', entity: e(IDS.speaker), source: 'Vinyl' },
    ],
    observe: (h) => h.patch(IDS.speaker, { source: 'Turntable' }),
    timeoutMs: 10_000,
  },
  'security.run': {
    req: { kind: 'security.run', role: 'hold_away' },
    call: { domain: 'script', service: 'turn_on', data: {}, entity_id: IDS.holdAway },
    confirm: true,
    notApplicable: { states: { [IDS.holdAway]: ['on'] }, message: 'Already running' },
    unknown: 'deny',
    unknownTargets: [IDS.holdAway],
    observe: (h) => h.patch(IDS.holdAway, { last_triggered: '2026-09-30T17:22:00.000Z' }),
    timeoutMs: 10_000,
  },
  'shortcut.run': {
    req: { kind: 'shortcut.run', role: 'lights_toggle' },
    call: { domain: 'script', service: 'turn_on', data: {}, entity_id: IDS.lightsToggle },
    // A floor no configuration can lower (§18): the direction of a toggle script is unknowable in advance.
    confirm: true,
    notApplicable: { states: { [IDS.lightsToggle]: ['on'] }, message: 'Already running' },
    unknown: 'deny',
    unknownTargets: [IDS.lightsToggle],
    // Observed as security.run is: the script reports a new run.
    observe: (h) => h.patch(IDS.lightsToggle, { last_triggered: '2026-09-30T17:22:00.000Z' }),
    timeoutMs: 10_000,
  },
  'studio_monitors.run': {
    req: { kind: 'studio_monitors.run' },
    call: { domain: 'script', service: 'turn_on', data: {}, entity_id: IDS.studioMonitors },
    confirm: false,
    notApplicable: { states: { [IDS.studioMonitors]: ['on'] }, message: 'Already running' },
    unknown: 'deny',
    unknownTargets: [IDS.studioMonitors],
    // The FakePort resolves with this context id, and the script entity carries it.
    observe: (h) => h.set(IDS.studioMonitors, 'off', h.get(IDS.studioMonitors)?.attributes, 'demo-call-context'),
    timeoutMs: 10_000,
  },
};

export const ROW_ENTRIES = Object.entries(ROWS) as [ActionKind, Row][];
