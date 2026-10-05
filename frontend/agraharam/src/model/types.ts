/**
 * View-model contract (§4.8). All VMs are readonly plain data built by pure selectors
 * `select<Section>(input): <Section>VM`; the input is a SelectorInput plus section-specific controller state.
 */
import type { BindingRole, EntityId, ResolvedConfig, SecurityActionRole } from '../config/schema.ts';
import type { ConfigIssue } from '../config/validate.ts';
import type { AlarmDisplay } from '../domain/alarm.ts';
import type {
  ActionErrorCode,
  ActionGateway,
  ActionKind,
  ActionPhase,
  ActionStatus,
  Availability,
} from '../ha/actions/types.ts';
import type { CameraGate } from '../ha/camera-gate.ts';
import type { StoreView } from '../ha/entity-store.ts';
import type { ClockParts, HostKind, HostReader } from '../ha/host.ts';
import type { Display, EntityStatus, Tone } from '../ha/normalize.ts';
import type { CUSTOM_ICONS } from '../icons/custom-icons.ts';
import type { ICONS } from '../icons/icons.ts';

export interface SelectorInput {
  readonly config: ResolvedConfig;
  readonly store: StoreView;
  readonly reader: HostReader;
  readonly gateway: ActionGateway;
  readonly now: Date;
}
/** Literal union, so an icon missing from the curated set (§6.5) is a compile error, not a blank glyph. */
export type IconName = keyof typeof ICONS | keyof typeof CUSTOM_ICONS; // src/icons/{icons,custom-icons}.ts

export interface ConnectionVM {
  readonly status: 'loading' | 'connected' | 'resyncing' | 'disconnected' | 'starting' | 'demo';
  readonly label: string;
  readonly tone: Tone;
} // resyncing → "Reconnecting"
export interface PresenceVM {
  readonly key: string;
  readonly name: string;
  readonly initials: string;
  readonly presence: 'home' | 'away' | 'unknown';
  readonly label: 'Home' | 'Away' | 'Unknown';
}
export interface SecuritySummaryVM {
  readonly alarm: AlarmDisplay;
  readonly policy?: Display;
}
export interface HeaderVM {
  readonly title: string;
  readonly greeting: string; // "Good evening" from local time
  readonly date: string;
  readonly clock: ClockParts;
  readonly people: readonly PresenceVM[];
  readonly security?: SecuritySummaryVM;
  readonly connection: ConnectionVM;
  readonly demo: boolean;
  readonly diagnosticsAvailable: boolean;
}

export interface MetricVM {
  readonly key: 'feels' | 'wind' | 'humidity';
  readonly label: string;
  readonly value: Display;
}
export interface ForecastItemVM {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly conditionLabel: string;
  readonly temperature: Display;
  readonly low?: Display;
  readonly precipitation?: string;
}
export type ForecastVM =
  | { readonly kind: 'loading' }
  | { readonly kind: 'hourly'; readonly items: readonly ForecastItemVM[] } // 8 items
  | { readonly kind: 'daily-fallback'; readonly items: readonly ForecastItemVM[]; readonly note: string } // 5
  | {
      readonly kind: 'unavailable';
      readonly reason: 'unsupported' | 'error' | 'disconnected' | 'entity';
      readonly note: string;
    };
export interface TodayVM {
  readonly status: EntityStatus;
  readonly name: string;
  readonly temperature: Display;
  readonly unit?: string;
  readonly condition: { readonly key: string; readonly label: string; readonly icon: IconName };
  readonly high?: Display;
  readonly low?: Display;
  readonly highLowDay?: 'today' | 'tomorrow'; // 'tomorrow' when the first daily item is not local today
  readonly metrics: readonly MetricVM[];
  readonly sun?: { readonly kind: 'sunset' | 'sunrise'; readonly time: string };
  readonly forecast: ForecastVM;
}

export interface StepperVM {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  readonly availability: Availability;
}
/** Rendered only by agr-choice-group (§5.5, §7.2). `pressed` follows the OBSERVED state, never an optimistic one;
 *  the current option's availability is disabled('not-applicable', "Current mode"), so activating it sends nothing. */
export interface ChoiceOptionVM {
  readonly value: string;
  readonly label: string;
  /** A second, quieter line under the label (the media drawer's player picker: "Playing"). */
  readonly detail?: string;
  readonly pressed: boolean;
  readonly availability: Availability;
}
export interface ChoiceVM {
  readonly label: string;
  readonly current?: string;
  readonly options: readonly ChoiceOptionVM[];
  readonly pending?: ActionStatus;
}
export interface ClimateTileVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly current: Display;
  readonly target?: Display;
  readonly modeLabel: string;
  readonly action?: string;
  readonly actionLabel?: string; // "Cooling to 72°"
  readonly setTemperature?: StepperVM;
  readonly hvacModes?: ChoiceVM;
  readonly pending?: ActionStatus;
}
export interface AirTileVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly power: 'on' | 'off' | 'unknown';
  readonly detail: Display; // preset or speed
  readonly toggle: Availability;
  readonly percentage?: StepperVM;
  readonly presets?: ChoiceVM;
  readonly pending?: ActionStatus;
}
export interface BedTileVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly current: Display;
  readonly target?: Display;
} // read-only by construction
export interface ComfortVM {
  readonly summary?: { readonly label: string; readonly tone: Tone };
  readonly climate: readonly ClimateTileVM[];
  readonly air: readonly AirTileVM[];
  readonly bed: readonly BedTileVM[];
  readonly overflow: number;
} // overflow: tiles beyond the budget (§6.2.1), listed in the climate drawer

export interface LightVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly on: boolean | null;
  readonly brightnessPct: number | null;
  readonly toggle: Availability;
  readonly brightness?: { readonly availability: Availability };
  readonly pending?: ActionStatus;
}
export interface CurtainVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly label: string;
  readonly open: Availability;
  readonly close: Availability;
  readonly pending?: ActionStatus;
}
export interface RoomVM {
  readonly index: number;
  readonly name: string;
  readonly summary: string;
  readonly tone: Tone;
  readonly lightsOn: number;
  readonly lightsTotal: number;
  readonly lightsUnavailable: number;
  readonly quickToggle?: { readonly next: 'on' | 'off'; readonly availability: Availability };
  readonly lights: readonly LightVM[];
  readonly curtains: readonly CurtainVM[];
  readonly purifier?: AirTileVM;
  readonly pending?: ActionStatus;
}
export interface VacuumVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly activity: string;
  readonly activityLabel: string;
  readonly tone: Tone;
  readonly battery?: Display;
  readonly batteryDerived: boolean;
  readonly start?: Availability;
  readonly pause?: Availability;
  readonly returnHome?: Availability;
  readonly pending?: ActionStatus;
}
export interface ApplianceVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly statusText: Display;
  readonly remaining?: Display;
  readonly active: boolean;
}
/** Overview lists are already cut to the §6.2.1 budget; the *Overflow counts open agr-home-drawer. */
export interface HomeVM {
  readonly rooms: readonly RoomVM[];
  readonly roomsOverflow: number;
  readonly vacuums: readonly VacuumVM[];
  readonly vacuumsOverflow: number;
  readonly appliances: readonly ApplianceVM[]; // active first; idle ones beyond the budget become idleCount
  readonly idleCount: number;
  readonly studioMonitors?: { readonly availability: Availability; readonly pending?: ActionStatus };
}

export interface CameraTileVM {
  readonly key: EntityId;
  readonly name: string;
  /** cameraBindingKey() of the configured camera: a binding change drops the picture (§9.3). */
  readonly binding: string;
  readonly gate: CameraGate;
  readonly thumbnails: boolean;
  readonly intervalMs: number;
  /** Undefined when the camera's config turns live view off (`live: false`): the tile offers none at all. */
  readonly live?: Availability;
}
export interface CamerasVM {
  readonly tiles: readonly CameraTileVM[]; // first 4
  readonly overflow: number;
  readonly privateCount: number;
}

export interface GarageDoorVM {
  readonly name: string;
  readonly status: EntityStatus;
  readonly position: 'open' | 'closed' | 'opening' | 'closing' | 'unknown';
  readonly label: string;
  readonly tone: Tone;
  readonly open?: Availability;
  readonly close?: Availability;
  readonly pending?: ActionStatus;
}
export interface VehicleVM {
  readonly name: string;
  readonly battery: Display;
  readonly batteryPct: number | null;
  readonly range: Display;
  readonly chargeLimitPct?: number;
  readonly charger?: {
    readonly status: Display;
    readonly power?: Display;
    readonly session?: Display;
    readonly charging: boolean;
  };
}
export interface GarageVM {
  readonly door?: GarageDoorVM;
  readonly vehicle?: VehicleVM;
}

export interface MediaPlayerVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly playback: string;
  readonly playbackLabel: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly app?: string;
  readonly source?: string;
  readonly play?: Availability;
  readonly pause?: Availability;
  readonly next?: Availability;
  readonly previous?: Availability;
  readonly volume?: { readonly level: number | null; readonly availability: Availability };
  readonly mute?: { readonly muted: boolean | null; readonly availability: Availability };
  readonly sources?: ChoiceVM;
  readonly pending?: ActionStatus;
}
/** active = first 'playing', else first 'paused', else first available, else first configured. */
export interface MediaVM {
  readonly players: readonly MediaPlayerVM[];
  readonly activeKey?: EntityId;
}

export interface UpcomingEventVM {
  readonly key: string;
  readonly time: string;
  readonly title: string;
  readonly allDay: boolean;
  readonly calendarName: string;
}
export interface UpcomingVM {
  readonly state: 'loading' | 'ready' | 'error' | 'disconnected';
  readonly groups: readonly { readonly label: string; readonly events: readonly UpcomingEventVM[] }[];
  readonly note?: string;
} // max 4 events, today + tomorrow

export interface PerimeterItemVM {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly position: 'closed' | 'open' | 'unknown';
  readonly label: string;
}
export interface SecurityActionVM {
  readonly role: SecurityActionRole;
  readonly group: 'sound' | 'disarm' | 'hold' | 'auto' | 'departure';
  readonly label: string; // from model/action-copy.ts, keyed by role
  readonly consequence: string; // from model/action-copy.ts, keyed by role
  readonly availability: Availability; // enabled → `confirm` decides the confirm route
}
export interface SecurityVM {
  readonly alarm: AlarmDisplay;
  readonly policy?: Display;
  readonly suggested?: Display;
  readonly commissioning?: {
    readonly status: EntityStatus;
    readonly on: boolean | null;
    readonly label: string;
  };
  readonly health?: Display;
  readonly perimeter: readonly PerimeterItemVM[];
  readonly actions: readonly SecurityActionVM[]; // only configured roles
}

export interface HealthVM {
  readonly perimeter?: {
    readonly closed: number;
    readonly total: number;
    readonly open: readonly string[];
    readonly unknown: readonly string[];
  };
  readonly devices: {
    readonly reporting: number;
    readonly total: number;
    readonly notReporting: readonly {
      readonly name: string;
      readonly status: 'unavailable' | 'missing-binding' | 'unknown';
    }[];
  };
  readonly headline: string; // never "All systems normal"
  readonly tone: Tone;
}
export interface DiagnosticsVM {
  readonly version: string;
  readonly gitSha: string;
  readonly hostKind: HostKind;
  readonly connection: ConnectionVM;
  readonly haVersion?: string;
  readonly controls: boolean; // config.controls
  readonly bindings: readonly {
    readonly role: BindingRole;
    readonly entity: EntityId;
    readonly status: EntityStatus;
    readonly derived: boolean;
    readonly features?: string;
  }[];
  readonly forecast: string; // from services.status ('forecast'), written by the forecast controller (§5.1)
  readonly liveView?: 'native' | 'fallback' | 'demo'; // from services.status ('live-view')
  readonly cameras: readonly { readonly name: string; readonly gate: string }[];
  readonly recentActions: readonly {
    readonly kind: ActionKind;
    readonly phase: ActionPhase;
    readonly code?: ActionErrorCode;
    readonly ms?: number;
  }[]; // gateway.recent()
  readonly configWarnings: readonly ConfigIssue[]; // services.warnings
}
