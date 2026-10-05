/**
 * Header and shell-status selectors (§4.8, §6.4, §9.1). Pure functions of the selector input: presence, the alarm
 * summary for the security pill, the connection indicator and the full-width alert banners.
 *
 * Presence only ever reads Home, Away or Unknown: the raw person state (a zone name, coordinates) is never shown.
 * The pill reports the alarm panel's ACTUAL state; the policy is a separate value and never changes that label.
 */
import type { EntityId, Ref, ResolvedConfig } from '../config/schema.ts';
import { alarmDisplayFor } from '../domain/alarm.ts';
import type { HostReader } from '../ha/host.ts';
import { normalizeEntity, textDisplay, type Tone } from '../ha/normalize.ts';
import { friendlyName } from './display.ts';
import type { ConnectionVM, HeaderVM, PresenceVM, SecuritySummaryVM, SelectorInput } from './types.ts';

type ConnectionStatus = ConnectionVM['status'];

const CONNECTION_COPY: Readonly<Record<ConnectionStatus, { readonly label: string; readonly tone: Tone }>> =
  Object.freeze({
    loading: { label: 'Connecting', tone: 'muted' },
    connected: { label: 'Connected', tone: 'ok' },
    resyncing: { label: 'Reconnecting', tone: 'attention' },
    // Red is reserved for a triggered alarm, the disconnected banner and failed actions (§6.5).
    disconnected: { label: 'Disconnected', tone: 'attention' },
    starting: { label: 'Starting', tone: 'attention' },
    demo: { label: 'Demo', tone: 'neutral' },
  });

/** HA reports these while integrations are still setting up; the header and banner say "Starting". */
const STARTING_HA_STATES: ReadonlySet<string> = new Set(['NOT_RUNNING', 'STARTING']);

/** Hours at which each greeting begins; anything before MORNING_FROM is still evening. */
const MORNING_FROM_HOUR = 5;
const AFTERNOON_FROM_HOUR = 12;
const EVENING_FROM_HOUR = 17;

const PERSON_FALLBACK_NAME = 'Person';
const MAX_INITIALS = 2;

/** The connection indicator: phase first, then HA starting, then the demo label (§9.1, §10.1). */
export function selectConnection(reader: HostReader): ConnectionVM {
  const status = connectionStatus(reader);
  return { status, ...CONNECTION_COPY[status] };
}

function connectionStatus(reader: HostReader): ConnectionStatus {
  const info = reader.connection();
  if (info.phase !== 'connected') return info.phase;
  if (info.haState !== undefined && STARTING_HA_STATES.has(info.haState)) return 'starting';
  return reader.kind === 'demo' ? 'demo' : 'connected';
}

/**
 * "Good morning", "Good afternoon" or "Good evening" for an hour of the day (0–23); a short static greeting (DESIGN).
 * The hour comes from Formatter.hourOfDay, so it follows the same time zone as the clock and date beside it.
 */
export function greetingFor(hour: number): string {
  if (hour >= MORNING_FROM_HOUR && hour < AFTERNOON_FROM_HOUR) return 'Good morning';
  if (hour >= AFTERNOON_FROM_HOUR && hour < EVENING_FROM_HOUR) return 'Good afternoon';
  return 'Good evening';
}

/** A word that can give an initial: it holds a letter, so the numbered fallback "Person 2" reads "P", not "P2". */
const HAS_LETTER_RE = /\p{L}/u;

/** Up to two initials from the first and last lettered words ("Meera" → "M", "Asha Rao" → "AR"); never empty. */
export function initialsFor(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => HAS_LETTER_RE.test(word));
  const picked = words.length <= 1 ? words : [words[0], words[words.length - 1]];
  const initials = picked
    .slice(0, MAX_INITIALS)
    .map((word) => Array.from(word ?? '')[0] ?? '')
    .join('')
    .toLocaleUpperCase();
  return initials === '' ? '?' : initials;
}

/**
 * home → Home; unknown, unavailable or a missing binding → Unknown; ANY other live state (not_home or a zone name)
 * → Away. A stale or loading value is Unknown too: presence carries no "last known" marker, so it never claims it.
 */
function selectPresence(input: SelectorInput, ref: Ref, index: number): PresenceVM {
  const normalized = normalizeEntity(input.store, ref.entity);
  const name = friendlyName(input.store, ref.entity, ref.name, `${PERSON_FALLBACK_NAME} ${index + 1}`);
  const presence =
    normalized.status !== 'available' ? 'unknown' : normalized.entity?.state === 'home' ? 'home' : 'away';
  return {
    key: ref.entity,
    name,
    initials: initialsFor(name),
    presence,
    label: presence === 'home' ? 'Home' : presence === 'away' ? 'Away' : 'Unknown',
  };
}

/** The alarm's actual state and, separately, the policy value as HA formats it (option text verbatim, §8.1). */
function selectSecuritySummary(input: SelectorInput): SecuritySummaryVM | undefined {
  const security = input.config.security;
  if (security === undefined) return undefined;
  const formatter = input.reader.formatter();
  return {
    alarm: alarmDisplayFor(input.store, security.alarm),
    policy: textDisplay(normalizeEntity(input.store, security.policy), (entity) => formatter.entityState(entity)),
  };
}

export function selectHeader(input: SelectorInput): HeaderVM {
  const { config, reader, now } = input;
  const formatter = reader.formatter();
  const security = selectSecuritySummary(input);
  return {
    title: config.title,
    greeting: greetingFor(formatter.hourOfDay(now)),
    date: formatter.date(now, 'weekday-short'),
    clock: formatter.clock(now),
    people: config.people.map((ref, index) => selectPresence(input, ref, index)),
    ...(security !== undefined && { security }),
    connection: selectConnection(reader),
    demo: reader.kind === 'demo',
    diagnosticsAvailable: isDiagnosticsAvailable(config, reader),
  };
}

/** The compact header's household drawer: presence, the long date, the connection and the diagnostics link. */
export interface HouseholdVM {
  readonly people: readonly PresenceVM[];
  readonly date: string;
  readonly connection: ConnectionVM;
  /** Why the connection needs attention, in the banner's words; absent while connected. */
  readonly connectionDetail?: string;
  readonly diagnosticsAvailable: boolean;
}

export function selectHousehold(input: SelectorInput): HouseholdVM {
  const { config, reader, now } = input;
  const formatter = reader.formatter();
  const connection = selectConnection(reader);
  const banner = connectionBannerFor(connection.status);
  return {
    people: config.people.map((ref, index) => selectPresence(input, ref, index)),
    date: formatter.date(now, 'long'),
    connection,
    ...(banner !== undefined && { connectionDetail: `${banner.title} ${banner.message}` }),
    diagnosticsAvailable: isDiagnosticsAvailable(config, reader),
  };
}

/** Diagnostics are admin-only and opt-in (`diagnostics: true`), so entity IDs never reach a household account. */
export function isDiagnosticsAvailable(config: ResolvedConfig, reader: HostReader): boolean {
  return config.diagnostics && reader.isAdmin();
}

/** The entities the header and household drawer read: people, the alarm and the policy. */
export function headerEntityIds(config: ResolvedConfig): EntityId[] {
  const security = config.security;
  return [
    ...config.people.map((ref) => ref.entity),
    ...(security === undefined ? [] : [security.alarm, security.policy]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Alert banners (§9.1): full width above the columns.

type AlertBannerKind = 'alarm' | 'disconnected' | 'resyncing' | 'starting';
export interface AlertBannerVM {
  readonly kind: AlertBannerKind;
  readonly title: string;
  /** The sentence after the title; empty when the banner's own button says the rest. */
  readonly message: string;
  readonly tone: Tone;
  /** role="alert" (assertive) for a sounding alarm; every other banner is a polite status. */
  readonly urgent: boolean;
}

const CONNECTION_BANNERS: Readonly<Record<Exclude<AlertBannerKind, 'alarm'>, AlertBannerVM>> = Object.freeze({
  disconnected: {
    kind: 'disconnected',
    title: 'Connection to Home Assistant lost.',
    message: 'Showing last known values. Controls are paused until it reconnects.',
    tone: 'danger',
    urgent: false,
  },
  resyncing: {
    kind: 'resyncing',
    title: 'Reconnecting to Home Assistant.',
    message: 'Showing last known values until current states arrive.',
    tone: 'attention',
    urgent: false,
  },
  starting: {
    kind: 'starting',
    title: 'Home Assistant is starting.',
    message: 'Some devices may show as unavailable.',
    tone: 'attention',
    urgent: false,
  },
});

/**
 * "Alarm triggered." beside the "Open Security" button, and nothing more: the button already says where to go, and
 * the security controller's health text is never offered as the cause (alarm state and health are separate, §8.1).
 */
const ALARM_BANNER: AlertBannerVM = Object.freeze({
  kind: 'alarm',
  title: 'Alarm triggered.',
  message: '',
  tone: 'danger',
  urgent: true,
});

/**
 * At most one alarm banner (only for a LIVE triggered state: a stale one cannot be claimed) followed by at most one
 * connection banner. Loading shows none: skeletons already say it.
 */
export function selectAlertBanners(input: SelectorInput): readonly AlertBannerVM[] {
  const banners: AlertBannerVM[] = [];
  const summary = selectSecuritySummary(input);
  if (summary !== undefined && !summary.alarm.stale && summary.alarm.state === 'triggered') banners.push(ALARM_BANNER);
  const connection = connectionBannerFor(connectionStatus(input.reader));
  if (connection !== undefined) banners.push(connection);
  return banners;
}

function connectionBannerFor(status: ConnectionStatus): AlertBannerVM | undefined {
  return status === 'disconnected' || status === 'resyncing' || status === 'starting'
    ? CONNECTION_BANNERS[status]
    : undefined;
}

/** The entities the banner reads: only the alarm. */
export function bannerEntityIds(config: ResolvedConfig): EntityId[] {
  return config.security === undefined ? [] : [config.security.alarm];
}
