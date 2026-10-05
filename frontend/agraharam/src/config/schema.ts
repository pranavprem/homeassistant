/**
 * Card configuration contract (§4.1). Erasable syntax only and no imports outside src/config: the
 * private-config generator imports this file through Node type stripping.
 */

export type EntityId = string & { readonly __brand: 'EntityId' };
type EntityRefInput = string | { entity: string; name?: string };
export type DemoScenarioId =
  'normal' | 'degraded' | 'offline' | 'empty' | 'alert' | 'loading' | 'restricted' | 'starting' | 'dense';
export type SecurityActionRole =
  'disarm_hold' | 'silence_sound' | 'resume_auto' | 'hold_night' | 'hold_away' | 'hold_vacation' | 'prepare_departure';

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
  rooms?: { name: string; lights: string[]; curtains?: string[]; purifier?: string }[];
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
}

export type BindingRole =
  | 'person'
  | 'weather'
  | 'sun'
  | 'climate'
  | 'air'
  | 'bed_comfort'
  | 'room_light'
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
  | 'calendar';

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
});

/** Declared here (re-exported by src/ha/actions/types.ts) so src/config imports nothing outside itself. */
export type ActionFamily =
  'light' | 'room' | 'climate' | 'fan' | 'vacuum' | 'garage' | 'curtain' | 'media' | 'security' | 'studio_monitors';

/** Roles that can be targeted by the gateway, grouped by action family. Every other role is read-only. */
export const ACTIONABLE_ROLE_FAMILY: Readonly<Partial<Record<BindingRole, ActionFamily>>> = Object.freeze({
  climate: 'climate',
  air: 'fan',
  room_purifier: 'fan',
  room_light: 'light',
  room_curtain: 'curtain',
  vacuum: 'vacuum',
  media: 'media',
  garage_cover: 'garage',
  security_action: 'security',
  studio_monitors: 'studio_monitors',
});

export interface Ref {
  readonly entity: EntityId;
  readonly name?: string;
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
  /** Configured entity → roles. Built once, deeply frozen, never extended. It is the ONLY input to the gateway
   *  allowlist. Derived IDs (vacuum battery) live in EntityStore's separate derived set (§4.5). Empty when
   *  demo is true: the root validates demoCardInput(scenario) separately (§4.2 rule 9). */
  readonly bindings: ReadonlyMap<EntityId, readonly BindingRole[]>;
}
