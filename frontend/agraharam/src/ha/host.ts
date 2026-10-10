/**
 * Host adapter contract (§4.4): everything UI code may read (HostReader), the single write path handed only
 * to the action gateway (ServicePort), and the runtime the root owns (HostRuntime).
 */
import type { EntityId } from '../config/schema.ts';
import type { StoreView } from './entity-store.ts';
import type { StatusBoard } from './status-board.ts';
import type { ConfigLike, HassEntityLike, RegistryEntryLike } from './types.ts';

export type HostKind = 'hass' | 'demo';
/** 'resyncing': the socket is open again but the post-reconnect state snapshot has not been ingested yet. Every
 *  consumer treats it exactly like 'disconnected' (stale values, controls paused, cameras closed, no forecast or
 *  calendar restart); only the labels differ ("Reconnecting"). */
export type ConnectionPhase = 'loading' | 'connected' | 'resyncing' | 'disconnected';
export interface ConnectionInfo {
  readonly phase: ConnectionPhase;
  readonly haState?: ConfigLike['state']; // 'STARTING' → header shows "Starting"
  readonly haVersion?: string; // diagnostics only
}
/** 'clock' is emitted by EntityStore.tick() from the root's minute-aligned ticker (§9.1), not by hass. */
export type MetaKind = 'connection' | 'locale' | 'theme' | 'registry' | 'services' | 'user' | 'clock';
export interface HostChange {
  readonly entities: ReadonlySet<EntityId>;
  readonly meta: ReadonlySet<MetaKind>;
}
export type Unsubscribe = () => void;

export interface ClockParts {
  readonly hm: string;
  readonly period?: string;
} // "5:51", "PM"
/** The two length units HA's unit systems use (hass.config.unit_system.length). */
export type LengthUnit = 'km' | 'mi';
export interface Formatter {
  readonly temperatureUnit: string; // hass.config.unit_system.temperature
  /** hass.config.unit_system.length: 'mi' for US customary, else 'km' (also when an older HA omits it). */
  readonly lengthUnit: LengthUnit;
  /** True when HA's own formatEntityState backs entityState(): translated, with registry precision. House readings
   *  word states themselves only when it is false (demo, tests, older frontends, §18). */
  readonly translatesStates: boolean;
  entityState(e: HassEntityLike): string; // hass.formatEntityState if present, else fallback
  attribute(e: HassEntityLike, attribute: string): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** `text` followed by `unit` with HA's spacing for the profile language: "15%", "15 %" (de), "41 °F", "1,180 ppm". */
  withUnit(text: string, unit: string): string;
  temperature(value: number, unit: string | undefined): string; // "69°" or "21.5 °C" per locale
  time(value: Date): string;
  hour(value: Date): string; // "7 PM" / "19": forecast cells (locale, 12/24 h, zone)
  hourOfDay(value: Date): number; // 0–23 in the same zone as clock() and date(): the greeting
  dayKey(value: Date): string; // 'YYYY-MM-DD' (Latin digits) in the same zone: day grouping (format.ts helpers)
  clock(value: Date): ClockParts;
  date(value: Date, style: DateStyle): string;
  /** A wall-clock time with no date and no zone ("7:30 AM" / "07:30"), never shifted: input_datetime times. */
  wallTime(hour: number, minute: number): string;
  duration(ms: number): string; // "35 min", "1 h 10 min"
}
/** "Wednesday, September 30" | "Wed, Sep 30" | "Sep 30" | "Sep 30, 2025". */
export type DateStyle = 'long' | 'weekday-short' | 'month-day' | 'month-day-year';

export type ForecastType = 'daily' | 'hourly' | 'twice_daily';
export interface ForecastItem {
  readonly datetime: string;
  readonly condition?: string;
  readonly temperature?: number | null;
  readonly templow?: number | null;
  readonly precipitation_probability?: number | null;
  readonly is_daytime?: boolean;
}
export interface ForecastPayload {
  readonly type: ForecastType;
  readonly forecast: readonly ForecastItem[] | null;
}
export interface ForecastHandlers {
  next(p: ForecastPayload): void;
  error(e: HostError): void;
}

export type HostErrorCode =
  | 'disconnected'
  | 'unsupported'
  | 'not-found'
  | 'permission-denied'
  | 'unavailable'
  | 'network'
  | 'aborted'
  | 'bad-response'
  | 'unknown';
/** No message field by design: errors carry codes, never URLs, entity IDs or HA messages (§4.9 rule 3). */
export interface HostError {
  readonly code: HostErrorCode;
  readonly status?: number;
  readonly haCode?: string;
}

export interface CameraSnapshotRequest {
  readonly width: number;
  readonly height: number;
  readonly signal: AbortSignal;
}
export type LiveStreamHandle =
  | {
      readonly kind: 'native';
      readonly element: HTMLElement;
      dispose(): void;
      /** Fires once if the embedded card fails after mounting (a contained ll-rebuild, §9.4). */
      onFail(listener: (reason: 'helpers-failed') => void): Unsubscribe;
    }
  | { readonly kind: 'demo'; readonly element: HTMLElement; dispose(): void }
  | { readonly kind: 'unsupported'; readonly reason: 'no-helpers' | 'helpers-failed' | 'timeout' };

export interface CalendarEventLike {
  readonly key: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean; // location/description are deliberately dropped at the adapter
}

/** Everything UI code may use. No mutation methods. */
export interface HostReader {
  readonly kind: HostKind;
  readonly store: StoreView; // read-only view; ingest/tick/setDerived are not reachable from UI code
  /** HassHost: 'connected' only if the last ingested hass.connected is true AND hass.connection.connected (live
   *  getter) is true right now AND the resync barrier is clear; 'resyncing' when both flags are true but the
   *  barrier is armed. The live getter catches a stale phase while the panel was detached or suspended. */
  connection(): ConnectionInfo;
  /** Socket generation, read from the connection's ResyncTracker. Increments on every hajs 'ready' and
   *  'disconnected' event, on every observed transition of the phase away from 'connected', and when the
   *  hass.connection object identity changes. A subscription is valid only while the generation it was created
   *  in is current (§9.2). DemoHost: increments on setConnected(false). */
  connectionGeneration(): number;
  registry(id: EntityId): RegistryEntryLike | undefined;
  /** True once HA has delivered its entity registry (hass.entities is an object, not the initial null). Changes only
   *  with the 'registry' meta. Until then no switch can be told from a settings switch (§18). DemoHost: always true. */
  registryLoaded(): boolean;
  entitiesOnDevice(deviceId: string): readonly EntityId[];
  hasService(domain: string, service: string): boolean;
  formatter(): Formatter; // stable until 'locale' meta changes
  isDarkMode(): boolean;
  isAdmin(): boolean;
  subscribeForecast(id: EntityId, type: ForecastType, h: ForecastHandlers): Unsubscribe;
  fetchCameraSnapshot(id: EntityId, req: CameraSnapshotRequest): Promise<Blob>; // rejects with HostError
  openLiveStream(id: EntityId): Promise<LiveStreamHandle>;
  fetchCalendarEvents(
    id: EntityId,
    range: { start: Date; end: Date },
    signal: AbortSignal,
  ): Promise<readonly CalendarEventLike[]>;
}

export type ServiceDomain = 'light' | 'switch' | 'climate' | 'fan' | 'vacuum' | 'cover' | 'media_player' | 'script';
export interface ServiceCall {
  readonly domain: ServiceDomain;
  readonly service: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly target: { readonly entity_id: EntityId | readonly EntityId[] };
}
export interface ServiceCallResult {
  readonly contextId: string;
}
/** Rejection used when the port refused to call (the request never left the browser). */
export interface PortNotSent {
  readonly portError: 'not-sent';
  readonly reason: 'disconnected' | 'disposed';
}
/** Handed ONLY to ActionGateway by the composition root. */
export interface ServicePort {
  invoke(call: ServiceCall): Promise<ServiceCallResult>;
}

export interface HostRuntime {
  readonly reader: HostReader;
  readonly port: ServicePort;
  /** Identity of the runtime: host kind, demo scenario and the sorted bound set (§9.1). */
  readonly key: string;
  readonly status: StatusBoard; // per runtime (§5.1)
  tick(): void; // EntityStore.tick(); the root's only store mutation
  dispose(): void;
}

/**
 * Runtime identity (§9.1): host kind, demo scenario and the sorted bound set. A setConfig that changes any of them
 * replaces the host, so a HassHost can never stay alive under the demo label, nor a DemoHost under a live one.
 * Live runtimes have no scenario.
 */
export function runtimeKey(kind: HostKind, scenario: string | undefined, bound: Iterable<EntityId>): string {
  return [kind, scenario ?? '-', ...[...bound].sort()].join('|');
}
