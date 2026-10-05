/**
 * Diagnostics selector (§4.8, §5.1, §5.3). The diagnostics drawer is the ONLY place entity IDs appear, and only for
 * administrators of a dashboard configured with `diagnostics: true`; for anyone else this selector returns a view
 * with every entity-bearing list empty (defense in depth behind the header, which hides the entry point).
 *
 * It reads controller status lines from the StatusBoard, config warnings from DashboardServices and the last
 * tickets from gateway.recent(), so it needs no access to section internals. It never reads hass.config: the HA
 * version comes from the host's ConnectionInfo.
 */
import { domainOf } from '../config/entity-id.ts';
import type { BindingRole, EntityId, ResolvedConfig } from '../config/schema.ts';
import type { ConfigIssue } from '../config/validate.ts';
import type { ActionStatus } from '../ha/actions/types.ts';
import { cameraGateFor, type CameraBinding } from '../ha/camera-gate.ts';
import { deriveVacuumBatteries } from '../ha/derive.ts';
import type { StoreView } from '../ha/entity-store.ts';
import {
  CLIMATE_FEATURE,
  COVER_FEATURE,
  FAN_FEATURE,
  MEDIA_PLAYER_FEATURE,
  VACUUM_FEATURE,
  WEATHER_FEATURE,
} from '../ha/features.ts';
import type { HostReader } from '../ha/host.ts';
import { normalizeEntity } from '../ha/normalize.ts';
import type { StatusBoard } from '../ha/status-board.ts';
import { isDiagnosticsAvailable, selectConnection } from './header.ts';
import type { CameraGate } from '../ha/camera-gate.ts';
import type { DiagnosticsVM, SelectorInput } from './types.ts';

interface DiagnosticsInput extends SelectorInput {
  readonly status: Pick<StatusBoard, 'get'>;
  readonly warnings: readonly ConfigIssue[];
  readonly version: string;
  readonly gitSha: string;
}

type LiveView = NonNullable<DiagnosticsVM['liveView']>;

/** The §4.8 DiagnosticsVM plus the status lines it has no field for. */
export interface DiagnosticsView extends DiagnosticsVM {
  /** Admin and `diagnostics: true`; when false every entity-bearing list is empty. */
  readonly available: boolean;
  /** StatusBoard 'bundle': a version conflict reported by defineOnce (§11.3). */
  readonly bundle?: string;
  readonly calendar?: string;
  /** The full live-view line, for example "fallback (helpers-failed)". */
  readonly liveViewDetail?: string;
}

type BindingRow = DiagnosticsVM['bindings'][number];

const FORECAST_NOT_REPORTED = 'not started';
const LIVE_VIEWS: readonly LiveView[] = ['native', 'fallback', 'demo'];

/** Named feature bits per domain (§7.1), so the live capability review (§15 #6) reads names, not just numbers. */
const FEATURE_NAMES: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  climate: CLIMATE_FEATURE,
  fan: FAN_FEATURE,
  vacuum: VACUUM_FEATURE,
  cover: COVER_FEATURE,
  media_player: MEDIA_PLAYER_FEATURE,
  weather: WEATHER_FEATURE,
});

export function selectDiagnostics(input: DiagnosticsInput): DiagnosticsView {
  const { config, reader, store, gateway, status } = input;
  const available = isDiagnosticsAvailable(config, reader);
  const liveViewDetail = status.get('live-view');
  const base = {
    available,
    version: input.version,
    gitSha: input.gitSha,
    hostKind: reader.kind,
    connection: selectConnection(reader),
    controls: config.controls,
    forecast: status.get('forecast') ?? FORECAST_NOT_REPORTED,
    ...optional('haVersion', reader.connection().haVersion),
    ...optional('liveView', liveViewOf(liveViewDetail)),
    ...optional('liveViewDetail', liveViewDetail),
    ...optional('bundle', status.get('bundle')),
    ...optional('calendar', status.get('calendar')),
  };
  if (!available) return { ...base, bindings: [], cameras: [], recentActions: [], configWarnings: [] };
  return {
    ...base,
    bindings: [...configuredBindings(config, store), ...derivedBindings(config, reader, store)],
    cameras: cameraRows(config, reader, store),
    recentActions: gateway.recent().map(recentAction),
    configWarnings: input.warnings,
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** The first word of the status line names the path ("native", "fallback (helpers-failed)", "demo"). */
function liveViewOf(line: string | undefined): LiveView | undefined {
  const head = line?.split(/[\s(]/, 1)[0];
  return LIVE_VIEWS.find((view) => view === head);
}

function configuredBindings(config: ResolvedConfig, store: StoreView): BindingRow[] {
  return [...config.bindings].flatMap(([entity, roles]) => roles.map((role) => bindingRow(store, role, entity, false)));
}

/** Derived vacuum batteries (§4.2 rule 10): readable, labelled derived, and never actionable. */
function derivedBindings(config: ResolvedConfig, reader: HostReader, store: StoreView): BindingRow[] {
  return derivedBatteryIds(config, reader, store).map((id) => bindingRow(store, 'vacuum_battery', id, true));
}

/** The battery sensors derived for vacuums with no configured battery_sensor, as the store currently holds them. */
function derivedBatteryIds(config: ResolvedConfig, reader: HostReader, store: StoreView): EntityId[] {
  const vacuums = config.vacuums.filter((vacuum) => vacuum.batterySensor === undefined).map((vacuum) => vacuum.entity);
  if (vacuums.length === 0) return [];
  const batteries = deriveVacuumBatteries(vacuums, {
    registry: (id) => reader.registry(id),
    entitiesOnDevice: (deviceId) => reader.entitiesOnDevice(deviceId),
    state: (id) => store.get(id),
  });
  return [...batteries.values()].filter((id) => store.isDerived(id));
}

/**
 * Every entity the diagnostics drawer reads: the configured bindings plus the derived batteries. The derived set
 * changes with the registry, which the drawer also follows (CONTROL_META), and its controller re-reads this list on
 * every render, so a newly derived battery is subscribed from the next update on.
 */
export function diagnosticsEntityIds(config: ResolvedConfig, reader: HostReader, store: StoreView): EntityId[] {
  return [...new Set([...config.bindings.keys(), ...derivedBatteryIds(config, reader, store)])];
}

function bindingRow(store: StoreView, role: BindingRole, entity: EntityId, derived: boolean): BindingRow {
  const features = featureSummary(store, entity);
  return {
    role,
    entity,
    status: normalizeEntity(store, entity).status,
    derived,
    ...(features !== undefined && { features }),
  };
}

/** "61 (SET_SPEED, PRESET_MODE, TURN_OFF, TURN_ON)", or a light's color modes; undefined when not reported. */
function featureSummary(store: StoreView, entity: EntityId): string | undefined {
  const attributes = store.get(entity)?.attributes;
  if (attributes === undefined) return undefined;
  const domain = domainOf(entity);
  if (domain === 'light') {
    const modes = attributes['supported_color_modes'];
    return Array.isArray(modes)
      ? `color modes ${modes.filter((mode) => typeof mode === 'string').join(', ')}`
      : undefined;
  }
  const bits = attributes['supported_features'];
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits)) return undefined;
  const names = Object.entries(FEATURE_NAMES[domain] ?? {})
    .filter(([, mask]) => (bits & mask) === mask)
    .map(([name]) => name);
  return names.length > 0 ? `${bits} (${names.join(', ')})` : String(bits);
}

/** Each camera with the shared gate's decision (§9.3), read exactly as the camera tiles read it. */
function cameraRows(config: ResolvedConfig, reader: HostReader, store: StoreView): DiagnosticsVM['cameras'] {
  const phaseConnected = reader.connection().phase === 'connected';
  return config.cameras.map((camera) => ({
    name: camera.name,
    gate: cameraSummary(cameraGateFor(store, camera, phaseConnected), camera),
  }));
}

/** "allowed", "loading" or "closed: Privacy on", then the binding facts a reviewer needs (§15 #6). */
function cameraSummary(gate: CameraGate, camera: CameraBinding): string {
  const parts = [gateText(gate)];
  if (camera.privacy === undefined) parts.push('no privacy entity');
  if (!camera.thumbnails) parts.push('thumbnails off');
  return parts.join(', ');
}

function gateText(gate: CameraGate): string {
  if (gate.kind === 'allowed' || gate.kind === 'loading') return gate.kind;
  return `closed: ${gate.label}`;
}

function recentAction(ticket: ActionStatus): DiagnosticsVM['recentActions'][number] {
  return {
    kind: ticket.kind,
    phase: ticket.phase,
    ...(ticket.error !== undefined && { code: ticket.error.code }),
    ...(ticket.settledAt !== undefined && { ms: Math.round(ticket.settledAt - ticket.startedAt) }),
  };
}
