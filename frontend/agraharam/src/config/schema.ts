/**
 * Card configuration contract (§4.1). Erasable syntax only and no imports outside src/config: the
 * private-config generator imports this file through Node type stripping.
 */

export type EntityId = string & { readonly __brand: 'EntityId' };
type EntityRefInput = string | { entity: string; name?: string };
export type DemoScenarioId =
  'normal' | 'degraded' | 'offline' | 'empty' | 'alert' | 'loading' | 'restricted' | 'starting' | 'dense' | 'sky';
export type SecurityActionRole =
  'disarm_hold' | 'silence_sound' | 'resume_auto' | 'hold_night' | 'hold_away' | 'hold_vacation' | 'prepare_departure';

/** The vehicle drawings the Garage panel offers (§18); 'generic' is the default and draws no make or model. */
export const VEHICLE_MODELS = Object.freeze(['generic', 'tesla-model-3'] as const);
export type VehicleModel = (typeof VEHICLE_MODELS)[number];

/**
 * The whole-house shortcuts (§18). A fixed pair rather than a generic list: a list of any script under any label
 * would let one tap run anything, and the household needs only these two guarded toggle scripts.
 */
export const SHORTCUT_ROLES = Object.freeze(['lights_toggle', 'curtains_toggle'] as const);
export type ShortcutRole = (typeof SHORTCUT_ROLES)[number];

/**
 * Group icons a collection may name. Config-local because src/config cannot import src/icons; a unit test asserts
 * every name is a key of ICONS or CUSTOM_ICONS, and src/model/readings.ts maps CollectionIcon → IconName with a plain
 * assignment, so a missing icon is also a compile error.
 */
export const COLLECTION_ICONS = Object.freeze([
  'house',
  'lightbulb',
  'plug',
  'printer',
  'robot-vacuum',
  'air-vent',
  'battery',
  'thermometer',
  'droplets',
  'wind',
  'leaf',
  'refrigerator',
  'washing-machine',
  'car',
  'heart-pulse',
  'router',
  'wifi',
  'lock',
  'tv',
  'clock',
] as const);
export type CollectionIcon = (typeof COLLECTION_ICONS)[number];

interface AttentionInput {
  below?: number;
  above?: number;
  equals?: string | string[];
}
type CollectionRowInput = string | { entity: string; name?: string; attention?: AttentionInput };
interface CollectionInput {
  name: string;
  icon?: CollectionIcon;
  entities: CollectionRowInput[];
}

/** As written in Lovelace YAML. Unknown keys are rejected (except HA-managed keys, see validate). */
export interface CardConfigInput {
  type: string; // 'custom:agraharam-dashboard'
  title?: string; // default 'Agraharam', ≤ 40 chars
  demo?: boolean; // default false
  demo_scenario?: DemoScenarioId; // default 'normal'; only meaningful with demo: true
  /** default false. While false every action is disabled with 'controls-off' (§4.7 step 2a); reads still work.
   *  Set true only after the read-only verification in §13.5. Ignored in demo mode (demo controls are on). */
  controls?: boolean;
  diagnostics?: boolean; // default false; drawer shown to admins only
  people?: EntityRefInput[]; // person.*
  weather?: string; // weather.*
  sun?: string; // sun.*
  climate?: EntityRefInput[]; // climate.* (controllable)
  air?: EntityRefInput[]; // fan.* purifiers (controllable)
  bed_comfort?: EntityRefInput[]; // climate.* (read-only, never actionable)
  /** `lights` is required unless `switches` (lighting switches only, switch.*) is present. */
  rooms?: { name: string; lights?: string[]; switches?: string[]; curtains?: string[]; purifier?: string }[];
  vacuums?: { entity: string; name?: string; battery_sensor?: string }[];
  appliances?: { name: string; status_sensor: string; remaining_sensor?: string }[];
  media?: EntityRefInput[]; // media_player.*
  cameras?: {
    entity: string;
    name: string;
    privacy_entity?: string;
    privacy_on_value?: 'on' | 'off'; // default 'on'; exactly these two strings (lowercase)
    thumbnails?: boolean; // default true; false = live view on request only
    snapshot_interval?: number; // seconds, integer 5..600, default 10
    live?: boolean; // default true; false = no live view from this dashboard (indoor cameras, §9.4)
  }[];
  garage?: { cover: string; name?: string };
  vehicle?: {
    name: string;
    battery_sensor: string;
    range_sensor: string;
    charger_status?: string;
    charger_power?: string;
    session_energy?: string;
    charge_limit_pct?: number; // 50..100, integer
    model?: VehicleModel; // default 'generic'
  };
  security?: {
    alarm: string; // alarm_control_panel.*
    policy: string; // input_select.* | select.*
    suggested_mode?: string; // input_select.* | select.* | sensor.*
    commissioning?: string; // input_boolean.* | binary_sensor.*
    health_text?: string; // input_text.* | text.* | sensor.*
    perimeter?: EntityRefInput[]; // binary_sensor.* | cover.*
    actions?: Partial<Record<SecurityActionRole, string>>; // script.* only
  };
  studio_monitors_script?: string; // script.*
  calendars?: EntityRefInput[]; // calendar.*
  shortcuts?: Partial<Record<ShortcutRole, string>>; // script.* only; each always asks for confirmation
  collections?: CollectionInput[]; // read-only readings, never actionable
  /** Optional Sky panel (AIRSPACE.md §1): the collector's one sensor.* entity. Read-only, never actionable. */
  airspace?: { entity: string };
}

export type BindingRole =
  | 'person'
  | 'weather'
  | 'sun'
  | 'climate'
  | 'air'
  | 'bed_comfort'
  | 'room_light'
  | 'room_switch'
  | 'room_curtain'
  | 'room_purifier'
  | 'vacuum'
  | 'vacuum_battery'
  | 'appliance_status'
  | 'appliance_remaining'
  | 'media'
  | 'camera'
  | 'camera_privacy'
  | 'garage_cover'
  | 'vehicle_battery'
  | 'vehicle_range'
  | 'vehicle_charger_status'
  | 'vehicle_charger_power'
  | 'vehicle_session_energy'
  | 'alarm'
  | 'policy'
  | 'suggested_mode'
  | 'commissioning'
  | 'health_text'
  | 'perimeter'
  | 'security_action'
  | 'studio_monitors'
  | 'calendar'
  | 'house_shortcut'
  | 'collection'
  | 'airspace';

function freezeDomainLists<K extends string>(
  table: Record<K, readonly string[]>,
): Readonly<Record<K, readonly string[]>> {
  for (const domains of Object.values<readonly string[]>(table)) Object.freeze(domains);
  return Object.freeze(table);
}

/** Allowed HA domains per role. Security actions and studio monitors are scripts only, so a raw alarm or helper
 *  entity can never be configured as an action (§4.2 rule 5). */
export const DOMAINS_BY_ROLE: Readonly<Record<BindingRole, readonly string[]>> = freezeDomainLists({
  person: ['person'],
  weather: ['weather'],
  sun: ['sun'],
  climate: ['climate'],
  air: ['fan'],
  bed_comfort: ['climate'],
  room_light: ['light'],
  room_switch: ['switch'],
  room_curtain: ['cover'],
  room_purifier: ['fan'],
  vacuum: ['vacuum'],
  vacuum_battery: ['sensor'],
  appliance_status: ['sensor'],
  appliance_remaining: ['sensor'],
  media: ['media_player'],
  camera: ['camera'],
  camera_privacy: ['switch', 'binary_sensor', 'input_boolean'],
  garage_cover: ['cover'],
  vehicle_battery: ['sensor'],
  vehicle_range: ['sensor'],
  vehicle_charger_status: ['sensor', 'binary_sensor'],
  vehicle_charger_power: ['sensor'],
  vehicle_session_energy: ['sensor'],
  alarm: ['alarm_control_panel'],
  policy: ['input_select', 'select'],
  suggested_mode: ['input_select', 'select', 'sensor'],
  commissioning: ['input_boolean', 'binary_sensor'],
  health_text: ['input_text', 'text', 'sensor'],
  perimeter: ['binary_sensor', 'cover'],
  security_action: ['script'],
  studio_monitors: ['script'],
  calendar: ['calendar'],
  house_shortcut: ['script'],
  // Read-only readings. Cameras, alarm panels, presence and anything that invites an action (scripts, scenes,
  // buttons) are left out on purpose: other sections own them, or they are private.
  collection: [
    'sensor',
    'binary_sensor',
    'number',
    'select',
    'light',
    'switch',
    'fan',
    'climate',
    'vacuum',
    'cover',
    'lock',
    'media_player',
    'update',
    'input_text',
    'input_datetime',
    'input_boolean',
    'input_select',
    'event',
  ],
  // The Sky collector publishes one MQTT sensor; nothing else carries its aircraft attributes (AIRSPACE.md §1).
  airspace: ['sensor'],
});

/** Declared here (re-exported by src/ha/actions/types.ts) so src/config imports nothing outside itself. */
export type ActionFamily =
  | 'light'
  | 'switch'
  | 'room'
  | 'climate'
  | 'fan'
  | 'vacuum'
  | 'garage'
  | 'curtain'
  | 'media'
  | 'security'
  | 'studio_monitors'
  | 'shortcut';

/**
 * Roles that can be targeted by the gateway, grouped by action family. Every other role is read-only; `collection`
 * in particular is never listed here, so a reading can never pass the gateway allowlist.
 */
export const ACTIONABLE_ROLE_FAMILY: Readonly<Partial<Record<BindingRole, ActionFamily>>> = Object.freeze({
  climate: 'climate',
  air: 'fan',
  room_purifier: 'fan',
  room_light: 'light',
  room_switch: 'switch',
  room_curtain: 'curtain',
  vacuum: 'vacuum',
  media: 'media',
  garage_cover: 'garage',
  security_action: 'security',
  studio_monitors: 'studio_monitors',
  house_shortcut: 'shortcut',
});

/**
 * A collection row's attention rule (§18). `range`: attention when the raw numeric state is strictly below `below`
 * or strictly above `above` (the bounds themselves are in range). `equals`: attention when the raw state is exactly
 * one of `values`.
 */
export type AttentionRule =
  | { readonly kind: 'range'; readonly below?: number; readonly above?: number }
  | { readonly kind: 'equals'; readonly values: readonly string[] };
export interface CollectionRow {
  readonly entity: EntityId;
  readonly name?: string;
  readonly attention?: AttentionRule;
}
export interface Collection {
  readonly name: string;
  readonly icon?: CollectionIcon;
  readonly rows: readonly CollectionRow[];
}

export interface Ref {
  readonly entity: EntityId;
  readonly name?: string;
}
/** The Sky panel's binding (AIRSPACE.md §1): read-only, so it has no action family. */
interface AirspaceBinding {
  readonly entity: EntityId;
}
export interface ResolvedConfig {
  readonly title: string;
  readonly demo: boolean;
  readonly demoScenario: DemoScenarioId;
  readonly controls: boolean;
  readonly diagnostics: boolean;
  readonly people: readonly Ref[];
  readonly weather?: EntityId;
  readonly sun?: EntityId;
  readonly climate: readonly Ref[];
  readonly air: readonly Ref[];
  readonly bedComfort: readonly Ref[];
  readonly rooms: readonly {
    readonly name: string;
    readonly lights: readonly EntityId[];
    /** Lighting switches (lamps on smart plugs); [] when none are configured. */
    readonly switches: readonly EntityId[];
    readonly curtains: readonly EntityId[];
    readonly purifier?: EntityId;
  }[];
  readonly vacuums: readonly {
    readonly entity: EntityId;
    readonly name?: string;
    readonly batterySensor?: EntityId;
  }[];
  readonly appliances: readonly {
    readonly name: string;
    readonly status: EntityId;
    readonly remaining?: EntityId;
  }[];
  readonly media: readonly Ref[];
  readonly cameras: readonly {
    readonly entity: EntityId;
    readonly name: string;
    readonly privacy?: { readonly entity: EntityId; readonly onValue: 'on' | 'off' };
    readonly thumbnails: boolean;
    readonly snapshotIntervalMs: number;
    readonly live: boolean;
  }[];
  readonly garage?: { readonly cover: EntityId; readonly name: string }; // name default 'Garage'
  readonly vehicle?: {
    readonly name: string;
    readonly battery: EntityId;
    readonly range: EntityId;
    readonly chargerStatus?: EntityId;
    readonly chargerPower?: EntityId;
    readonly sessionEnergy?: EntityId;
    readonly chargeLimitPct?: number;
    readonly model: VehicleModel; // default 'generic'
  };
  readonly security?: {
    readonly alarm: EntityId;
    readonly policy: EntityId;
    readonly suggested?: EntityId;
    readonly commissioning?: EntityId;
    readonly healthText?: EntityId;
    readonly perimeter: readonly Ref[];
    readonly actions: Readonly<Partial<Record<SecurityActionRole, EntityId>>>;
  };
  readonly studioMonitors?: EntityId;
  readonly calendars: readonly Ref[];
  readonly shortcuts: Readonly<Partial<Record<ShortcutRole, EntityId>>>; // {} when none are configured
  readonly collections: readonly Collection[]; // [] when none are configured
  /** Absent (the key itself, not just undefined) when not configured, so existing configs resolve unchanged. */
  readonly airspace?: AirspaceBinding;
  /** Configured entity → roles. Built once, deeply frozen, never extended. It is the ONLY input to the gateway
   *  allowlist. Derived IDs (vacuum battery) live in EntityStore's separate derived set (§4.5). Empty when
   *  demo is true: the root validates demoCardInput(scenario) separately (§4.2 rule 9). */
  readonly bindings: ReadonlyMap<EntityId, readonly BindingRole[]>;
}
