/**
 * House health selectors (§4.8). Health is built only from NAMED, configured inputs: the monitored entry
 * points (security.perimeter) and the bound devices in the roles listed below. It never claims more than those
 * inputs show, so there is no blanket "everything is fine" sentence anywhere: the headline always counts, and the
 * word "monitored" marks that it is not proof of complete coverage.
 *
 * Entry points are mapped by the shared model/perimeter.ts, so this panel and the security drawer cannot disagree.
 */
import type { EntityId, ResolvedConfig } from '../config/schema.ts';
import type { StoreView } from '../ha/entity-store.ts';
import type { Formatter } from '../ha/host.ts';
import { ABSENT_LABELS, normalizeEntity, type EntityStatus, type Tone } from '../ha/normalize.ts';
import { CONTENT_BUDGET } from './budget.ts';
import { friendlyName } from './display.ts';
import { perimeterPosition, type PerimeterPosition } from './perimeter.ts';
import type { HealthVM, IconName, SelectorInput } from './types.ts';

type NotReportingStatus = HealthVM['devices']['notReporting'][number]['status'];

/** One configured device, named the way the household knows it (never by entity ID). */
interface MonitoredDevice {
  readonly key: EntityId;
  readonly name: string;
}

interface EntryPoint {
  readonly key: EntityId;
  readonly name: string;
  readonly status: EntityStatus;
  readonly position: PerimeterPosition;
  readonly label: string;
}

/** A drawer row for one entry point: its label plus the tone that label is shown in. */
interface HealthEntryPointVM extends EntryPoint {
  readonly tone: Tone;
}

/** A device's health bucket; 'loading' devices are neither reporting nor a problem (HA is still starting). */
type DeviceHealth =
  | { readonly kind: 'reporting' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-reporting'; readonly status: NotReportingStatus };

/**
 * 'paused' while Home Assistant is disconnected or resyncing: current statuses are unknown, so nothing is bucketed
 * as reporting or not reporting (only the dashboard's connection is down, not the devices).
 */
type HealthState = 'loading' | 'live' | 'paused';

export interface HealthFactVM {
  /** 'readings' comes from model/readings.ts and never feeds the health headline, devices or problems (§18). */
  readonly key: 'entry-points' | 'devices' | 'readings';
  /** The emphasized count ("4 of 4"); empty when there is nothing to count. */
  readonly count: string;
  /** The label beside the count, without a final period ("monitored entry points closed"). */
  readonly text: string;
  readonly tone: Tone;
  readonly icon: IconName;
}

interface HealthProblemVM {
  readonly key: EntityId;
  readonly name: string;
  readonly label: string;
}

/** The panel view: the §4.8 HealthVM plus its rendered facts and the budgeted problem list (§6.2.1). */
export interface HealthPanelVM extends HealthVM {
  readonly state: HealthState;
  readonly facts: readonly HealthFactVM[];
  readonly problems: readonly HealthProblemVM[];
  readonly problemsOverflow: number;
}

export interface HealthDetailsVM {
  readonly state: HealthState;
  readonly headline: string;
  readonly tone: Tone;
  readonly entryPoints: readonly HealthEntryPointVM[];
  /** The three status groups are filled only while live; they are empty while loading or paused. */
  readonly notReporting: readonly HealthProblemVM[];
  readonly loading: readonly MonitoredDevice[];
  readonly reporting: readonly MonitoredDevice[];
  /** Every monitored device by name, with no status: what the drawer lists while paused. */
  readonly monitored: readonly MonitoredDevice[];
}

const PAUSED_HEADLINE = Object.freeze({
  disconnected: 'Paused while Home Assistant is disconnected. House health resumes when it reconnects.',
  resyncing: 'Waiting for current states from Home Assistant before showing house health.',
});
const LOADING_HEADLINE = 'Loading house health.';
const NO_DEVICES_TEXT = 'No monitored devices are configured';
const ENTRY_POINT_FALLBACK = 'Entry point';
const WEATHER_NAME = 'Weather';
const OPEN_LABEL = 'Open';

/**
 * The bound devices health counts (§4.8 rule), in a fixed order and de-duplicated by entity, so an entity holding
 * several roles (a garage cover that is also an entry point) counts once under its first, most specific name.
 */
function monitoredDevices(config: ResolvedConfig, store: StoreView): MonitoredDevice[] {
  const seen = new Set<EntityId>();
  const devices: MonitoredDevice[] = [];
  const addNamed = (key: EntityId, name: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    devices.push({ key, name });
  };
  const add = (key: EntityId, configured: string | undefined, fallback: string): void =>
    addNamed(key, friendlyName(store, key, configured, fallback));
  // Always "Weather": weather friendly names are usually the home's place name, which never belongs in the UI.
  if (config.weather !== undefined) addNamed(config.weather, WEATHER_NAME);
  for (const ref of config.climate) add(ref.entity, ref.name, 'Climate');
  for (const ref of config.air) add(ref.entity, ref.name, 'Air purifier');
  for (const ref of config.bedComfort) add(ref.entity, ref.name, 'Bed climate');
  for (const room of config.rooms) {
    for (const light of room.lights) add(light, undefined, `${room.name} light`);
    // Lamp switches are room devices like lights; collection rows and shortcut scripts are not devices (§18).
    for (const lamp of room.switches) add(lamp, undefined, `${room.name} switch`);
    for (const curtain of room.curtains) add(curtain, undefined, `${room.name} curtain`);
    if (room.purifier !== undefined) add(room.purifier, undefined, `${room.name} purifier`);
  }
  for (const vacuum of config.vacuums) add(vacuum.entity, vacuum.name, 'Robot vacuum');
  // Appliance, camera and garage names are always set in the resolved config: the household's own words win.
  for (const appliance of config.appliances) addNamed(appliance.status, appliance.name);
  for (const ref of config.media) add(ref.entity, ref.name, 'Media player');
  for (const camera of config.cameras) {
    addNamed(camera.entity, camera.name);
    if (camera.privacy !== undefined) add(camera.privacy.entity, undefined, `${camera.name} privacy`);
  }
  if (config.garage !== undefined) addNamed(config.garage.cover, config.garage.name);
  addVehicle(config, addNamed);
  if (config.security !== undefined) {
    add(config.security.alarm, undefined, 'Alarm panel');
    config.security.perimeter.forEach((ref, index) =>
      add(ref.entity, ref.name, `${ENTRY_POINT_FALLBACK} ${index + 1}`),
    );
  }
  return devices;
}

/** Vehicle sensors are named after the vehicle ("Demo sedan range"), never by their sensor names. */
function addVehicle(config: ResolvedConfig, addNamed: (key: EntityId, name: string) => void): void {
  const vehicle = config.vehicle;
  if (vehicle === undefined) return;
  const sensors: readonly [EntityId | undefined, string][] = [
    [vehicle.battery, 'battery'],
    [vehicle.range, 'range'],
    [vehicle.chargerStatus, 'charger'],
    [vehicle.chargerPower, 'charger power'],
    [vehicle.sessionEnergy, 'session energy'],
  ];
  for (const [key, part] of sensors) if (key !== undefined) addNamed(key, `${vehicle.name} ${part}`);
}

function entryPoints(config: ResolvedConfig, store: StoreView): EntryPoint[] {
  return (config.security?.perimeter ?? []).map((ref, index) => {
    const normalized = normalizeEntity(store, ref.entity);
    return {
      key: ref.entity,
      name: friendlyName(store, ref.entity, ref.name, `${ENTRY_POINT_FALLBACK} ${index + 1}`),
      status: normalized.status,
      ...perimeterPosition(normalized),
    };
  });
}

/**
 * available → reporting; loading (store not ready, or absent while HA starts) → loading; unavailable and missing
 * keep their status; everything else, including an entity the post-reconnect snapshot did not replace, is unknown.
 */
function deviceHealth(status: EntityStatus): DeviceHealth {
  if (status === 'available') return { kind: 'reporting' };
  if (status === 'loading') return { kind: 'loading' };
  if (status === 'unavailable' || status === 'missing-binding') return { kind: 'not-reporting', status };
  return { kind: 'not-reporting', status: 'unknown' };
}

/** A view with no states: monitoredDevices reads a store only for names, so this yields the same keys. */
const EMPTY_STORE: StoreView = Object.freeze({
  get: () => undefined,
  isDerived: () => false,
  isReady: () => false,
  isConnected: () => false,
  isResyncing: () => false,
  freshSinceResync: () => false,
  haState: () => undefined,
  subscribe: () => () => undefined,
});

/** Every entity the health panel and drawer read, so their EntityControllers re-render on exactly these. */
export function healthEntityIds(config: ResolvedConfig): EntityId[] {
  const ids = new Set(monitoredDevices(config, EMPTY_STORE).map((device) => device.key));
  for (const ref of config.security?.perimeter ?? []) ids.add(ref.entity);
  return [...ids];
}

type NotReportingDevice = MonitoredDevice & { readonly status: NotReportingStatus };

interface DeviceBuckets {
  readonly reporting: readonly MonitoredDevice[];
  readonly loading: readonly MonitoredDevice[];
  readonly notReporting: readonly NotReportingDevice[];
}

const NO_BUCKETS: DeviceBuckets = Object.freeze({ reporting: [], loading: [], notReporting: [] });

interface HealthComputation extends DeviceBuckets {
  readonly state: HealthState;
  readonly entries: readonly EntryPoint[];
  /** Every monitored device, in every state; the buckets are filled only while live. */
  readonly monitored: readonly MonitoredDevice[];
  readonly facts: readonly HealthFactVM[];
  readonly headline: string;
  readonly tone: Tone;
}

function healthState(store: StoreView): HealthState {
  if (!store.isReady()) return 'loading';
  return store.isConnected() ? 'live' : 'paused';
}

function computeHealth(input: SelectorInput): HealthComputation {
  const { config, store } = input;
  const state = healthState(store);
  const entries = entryPoints(config, store);
  const monitored = monitoredDevices(config, store);
  // Only live statuses are bucketed: while paused every present entity normalizes to 'disconnected', which says
  // nothing about the device itself, so counting it as not reporting would blame devices for the dashboard's outage.
  const buckets = state === 'live' ? bucketDevices(store, monitored) : NO_BUCKETS;
  const facts = state === 'live' ? liveFacts(input.reader.formatter(), entries, buckets, monitored.length) : [];
  return {
    state,
    entries,
    monitored,
    ...buckets,
    facts,
    headline: headlineFor(state, store, facts),
    tone: state === 'live' ? overallTone(facts) : 'muted',
  };
}

function bucketDevices(store: StoreView, devices: readonly MonitoredDevice[]): DeviceBuckets {
  const reporting: MonitoredDevice[] = [];
  const loading: MonitoredDevice[] = [];
  const notReporting: NotReportingDevice[] = [];
  for (const device of devices) {
    const health = deviceHealth(normalizeEntity(store, device.key).status);
    if (health.kind === 'reporting') reporting.push(device);
    else if (health.kind === 'loading') loading.push(device);
    else notReporting.push({ ...device, status: health.status });
  }
  return { reporting, loading, notReporting };
}

type CountText = (part: number, whole: number) => string;

function liveFacts(
  formatter: Formatter,
  entries: readonly EntryPoint[],
  buckets: DeviceBuckets,
  total: number,
): HealthFactVM[] {
  const count: CountText = (part, whole) => `${formatter.number(part)} of ${formatter.number(whole)}`;
  const facts: HealthFactVM[] = [];
  if (entries.length > 0) facts.push(entryPointsFact(formatter, count, entries));
  if (total === 0) {
    facts.push({ key: 'devices', count: '', text: NO_DEVICES_TEXT, tone: 'muted', icon: 'info' });
    return facts;
  }
  const reporting = buckets.reporting.length;
  const loading = buckets.loading.length;
  facts.push({
    key: 'devices',
    count: count(reporting, total),
    text: `devices reporting${stillLoadingClause(formatter, loading)}`,
    ...devicesLook(buckets.notReporting.length, loading),
  });
  return facts;
}

/** ", 2 still loading" while HA starts, so a count short of the whole is not read as a problem; else empty. */
function stillLoadingClause(formatter: Formatter, loading: number): string {
  return loading > 0 ? `, ${formatter.number(loading)} still loading` : '';
}

function entryPointsFact(formatter: Formatter, count: CountText, entries: readonly EntryPoint[]): HealthFactVM {
  const closed = entries.filter((entry) => entry.position === 'closed').length;
  const loading = entries.filter((entry) => entry.status === 'loading').length;
  return {
    key: 'entry-points',
    count: count(closed, entries.length),
    text: `monitored entry points closed${stillLoadingClause(formatter, loading)}`,
    ...entryPointsLook(entries, closed, loading),
  };
}

/** Open first, then an unknown position worth naming; entry points only still loading while HA starts are muted. */
function entryPointsLook(
  entries: readonly EntryPoint[],
  closed: number,
  loading: number,
): Pick<HealthFactVM, 'tone' | 'icon'> {
  if (entries.some((entry) => entry.position === 'open')) return { tone: 'attention', icon: 'door-open' };
  if (closed + loading < entries.length) return { tone: 'attention', icon: 'circle-question-mark' };
  if (loading > 0) return { tone: 'muted', icon: 'info' };
  return { tone: 'ok', icon: 'door-closed' };
}

/** Devices not reporting need a look; devices still loading while HA starts are not a problem yet, only unknown. */
function devicesLook(notReporting: number, loading: number): Pick<HealthFactVM, 'tone' | 'icon'> {
  if (notReporting > 0) return { tone: 'attention', icon: 'circle-alert' };
  if (loading > 0) return { tone: 'muted', icon: 'info' };
  return { tone: 'ok', icon: 'circle-check' };
}

/** One fact as a sentence; joined, the facts are the headline the drawer leads with. */
function factSentence(fact: HealthFactVM): string {
  return `${fact.count === '' ? fact.text : `${fact.count} ${fact.text}`}.`;
}

function headlineFor(state: HealthState, store: StoreView, facts: readonly HealthFactVM[]): string {
  if (state === 'loading') return LOADING_HEADLINE;
  if (state === 'paused') return store.isResyncing() ? PAUSED_HEADLINE.resyncing : PAUSED_HEADLINE.disconnected;
  return facts.map(factSentence).join(' ');
}

/** Attention if any fact needs it, ok only when every fact is ok, otherwise muted (nothing counted, or loading). */
function overallTone(facts: readonly HealthFactVM[]): Tone {
  if (facts.some((fact) => fact.tone === 'attention')) return 'attention';
  return facts.length > 0 && facts.every((fact) => fact.tone === 'ok') ? 'ok' : 'muted';
}

/** An entry point whose position is unknown for a reason worth naming; still loading while HA starts is not one. */
function isUnknownEntry(entry: EntryPoint): boolean {
  return entry.position === 'unknown' && entry.status !== 'loading';
}

/** Open entry points first, then entry points in an unknown state, then devices not reporting; one row per entity. */
function problemsOf(health: HealthComputation): HealthProblemVM[] {
  if (health.state !== 'live') return [];
  const seen = new Set<EntityId>();
  const problems: HealthProblemVM[] = [];
  const add = (key: EntityId, name: string, label: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ key, name, label });
  };
  for (const entry of health.entries) if (entry.position === 'open') add(entry.key, entry.name, OPEN_LABEL);
  for (const entry of health.entries) if (isUnknownEntry(entry)) add(entry.key, entry.name, entry.label);
  for (const device of health.notReporting) add(device.key, device.name, ABSENT_LABELS[device.status]);
  return problems;
}

/**
 * The perimeter counts. While paused no entry point is listed as unknown: its position is unknown only because the
 * dashboard is disconnected, the same reason no device is listed as not reporting.
 */
function perimeterOf(health: HealthComputation): NonNullable<HealthVM['perimeter']> {
  const entries = health.entries;
  return {
    closed: entries.filter((entry) => entry.position === 'closed').length,
    total: entries.length,
    open: entries.filter((entry) => entry.position === 'open').map((entry) => entry.name),
    unknown: health.state === 'live' ? entries.filter(isUnknownEntry).map((entry) => entry.name) : [],
  };
}

export function selectHealth(input: SelectorInput): HealthPanelVM {
  const health = computeHealth(input);
  const problems = problemsOf(health);
  const budget = CONTENT_BUDGET.healthProblems;
  return {
    ...(health.entries.length > 0 && { perimeter: perimeterOf(health) }),
    devices: {
      reporting: health.reporting.length,
      total: health.monitored.length,
      notReporting: health.notReporting.map(({ name, status }) => ({ name, status })),
    },
    headline: health.headline,
    tone: health.tone,
    state: health.state,
    facts: health.facts,
    problems: problems.slice(0, budget),
    problemsOverflow: Math.max(0, problems.length - budget),
  };
}

/** Closed reads ok; open or unknown for a reason worth naming needs a look; loading or paused is only muted. */
function entryTone(entry: EntryPoint, state: HealthState): Tone {
  if (entry.position === 'closed') return 'ok';
  if (state !== 'live' || entry.status === 'loading') return 'muted';
  return 'attention';
}

/**
 * The health drawer (§5.3): every entry point, then (live) devices not reporting, still loading and reporting, or
 * (paused) the monitored device names alone.
 */
export function selectHealthDetails(input: SelectorInput): HealthDetailsVM {
  const health = computeHealth(input);
  return {
    state: health.state,
    headline: health.headline,
    tone: health.tone,
    entryPoints: health.entries.map((entry) => ({ ...entry, tone: entryTone(entry, health.state) })),
    notReporting: health.notReporting.map(({ key, name, status }) => ({ key, name, label: ABSENT_LABELS[status] })),
    loading: health.loading,
    reporting: health.reporting,
    monitored: health.monitored,
  };
}
