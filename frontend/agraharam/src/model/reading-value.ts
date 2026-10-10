/**
 * The value text of one house reading (§18). HA's own formatting (translations, units, display precision) wherever it
 * reads well; compact household wording for durations, times, dates and events; and, where HA's formatter is absent
 * (demo, tests, older frontends), an English fallback with registry display precision and HA's binary-sensor words.
 *
 * Read-only by construction. Attributes are read only through `readAttribute`, and only the READ_ATTRIBUTES names, so
 * no picture, URL, release note or media field can ever reach a row. Every text is plain and capped; Lit escapes it
 * when rendered.
 */
import { domainOf } from '../config/entity-id.ts';
import { dateStart, dayStart } from '../ha/format.ts';
import type { Formatter } from '../ha/host.ts';
import { parseNumericValue } from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { durationSeconds, formatReadingDuration } from './duration.ts';

/** The only attributes a reading reads. */
const READ_ATTRIBUTES = [
  'friendly_name',
  'unit_of_measurement',
  'device_class',
  'event_type',
  'brightness',
  'percentage',
  'current_position',
  'current_temperature',
  'has_date',
  'has_time',
] as const;
type ReadAttribute = (typeof READ_ATTRIBUTES)[number];

export function readAttribute(entity: HassEntityLike, name: ReadAttribute): unknown {
  return entity.attributes[name];
}

/** The live context a value is worded in. `displayPrecision` is the registry's, for the fallback formatter. */
export interface ReadingValueContext {
  readonly formatter: Formatter;
  readonly now: Date;
  readonly displayPrecision?: number;
}

/** A value's text, or `valid: false` when a time, date or event state cannot be read ("No reading"). */
type ReadingValue = { readonly valid: true; readonly text: string } | { readonly valid: false };

/** §18: every reading text is capped, so one runaway state can never take over the drawer. */
const READING_TEXT_MAX_CHARS = 120;
const EVENT_TYPE_MAX_CHARS = 40;
const ELLIPSIS = '…';
const MS_PER_DAY = 86_400_000;
/** "Oct 3, 7:40 PM" for times within this many days; further away the day alone is shown. */
const NEAR_DAYS = 6;
const HA_BRIGHTNESS_PER_PERCENT = 2.55;
const POSITION = Object.freeze({ closed: 0, open: 100 });
const FALLBACK_FRACTION_DIGITS = 2;
const INVALID: ReadingValue = Object.freeze({ valid: false });

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
/** Timestamp-like states as HA writes them (ISO 8601 with a zone), so Date.parse never guesses a local time. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** HA's English binary-sensor words by device class: [on, off]. */
const BINARY_SENSOR_WORDS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  door: ['Open', 'Closed'],
  window: ['Open', 'Closed'],
  opening: ['Open', 'Closed'],
  garage_door: ['Open', 'Closed'],
  moisture: ['Wet', 'Dry'],
  motion: ['Detected', 'Clear'],
  occupancy: ['Detected', 'Clear'],
  presence: ['Detected', 'Clear'],
  sound: ['Detected', 'Clear'],
  vibration: ['Detected', 'Clear'],
  smoke: ['Detected', 'Clear'],
  gas: ['Detected', 'Clear'],
  carbon_monoxide: ['Detected', 'Clear'],
  battery: ['Low', 'Normal'],
  problem: ['Problem', 'OK'],
  connectivity: ['Connected', 'Disconnected'],
  lock: ['Unlocked', 'Locked'],
  plug: ['Plugged in', 'Unplugged'],
  running: ['Running', 'Not running'],
  safety: ['Unsafe', 'Safe'],
  update: ['Update available', 'Up-to-date'],
});
const ON_OFF_WORDS: readonly [string, string] = ['On', 'Off'];
const UPDATE_WORDS: readonly [string, string] = ['Update available', 'Up to date'];
const COVER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  closed: 'Closed',
  opening: 'Opening',
  closing: 'Closing',
});

/** The value of an entity whose state is readable (live, or the last known one while disconnected). */
export function readingValue(entity: HassEntityLike, ctx: ReadingValueContext): ReadingValue {
  const value = rawReadingValue(entity, ctx);
  return value.valid ? { valid: true, text: capText(value.text, READING_TEXT_MAX_CHARS) } : value;
}

function rawReadingValue(entity: HassEntityLike, ctx: ReadingValueContext): ReadingValue {
  const domain = domainOf(entity.entity_id);
  const deviceClass = readAttribute(entity, 'device_class');
  if ((domain === 'sensor' || domain === 'number') && deviceClass === 'duration') return durationValue(entity, ctx);
  if (domain === 'sensor' && deviceClass === 'timestamp') return instantValue(entity.state, ctx, '');
  // core 2026.9's uptime class: the moment the device came up, as an ISO timestamp.
  if (domain === 'sensor' && deviceClass === 'uptime') return instantValue(entity.state, ctx, 'Since ');
  if (domain === 'sensor' && deviceClass === 'date') return dateValue(entity.state, ctx);
  switch (domain) {
    case 'input_datetime':
      return dateTimeValue(entity, ctx);
    case 'event':
      return eventValue(entity, ctx);
    case 'light':
      return text(levelValue(entity, ctx, lightPercent(entity)));
    case 'fan':
      return text(levelValue(entity, ctx, parseNumericValue(readAttribute(entity, 'percentage'))));
    case 'cover':
      return text(coverValue(entity, ctx));
    case 'climate':
      return text(climateValue(entity, ctx));
    case 'input_text':
      return text(entity.state);
    default:
      return text(stateText(entity, ctx));
  }
}

function text(value: string): ReadingValue {
  return { valid: true, text: value };
}

/** A numeric duration in a known unit ("1 h 25 min"); anything else is worded by HA. */
function durationValue(entity: HassEntityLike, ctx: ReadingValueContext): ReadingValue {
  const seconds = durationSeconds(entity.state, readAttribute(entity, 'unit_of_measurement'));
  const formatted = seconds === undefined ? undefined : formatReadingDuration(seconds, ctx.formatter.number);
  return text(formatted ?? stateText(entity, ctx));
}

function instantValue(state: string, ctx: ReadingValueContext, prefix: string): ReadingValue {
  const ms = isoInstantMs(state);
  return ms === undefined ? INVALID : text(`${prefix}${whenText(new Date(ms), ctx)}`);
}

/**
 * The epoch ms of a strict ISO instant (ISO_INSTANT_RE: a date, a time and a zone), else undefined. The regex runs
 * before Date.parse, which would otherwise guess at strings such as "Oct 9" or a zone-less local time. Shared with
 * the Sky parser (AIRSPACE.md §2), so both read timestamps by one rule.
 */
export function isoInstantMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function dateValue(state: string, ctx: ReadingValueContext): ReadingValue {
  const day = dayText(state, ctx);
  return day === undefined ? INVALID : text(day);
}

/** HA stores input_datetime as local wall time with no zone, so it is shown exactly as set, never converted. */
function dateTimeValue(entity: HassEntityLike, ctx: ReadingValueContext): ReadingValue {
  const hasDate = readAttribute(entity, 'has_date') === true;
  const hasTime = readAttribute(entity, 'has_time') === true;
  if (hasDate && hasTime) {
    const match = DATE_TIME_RE.exec(entity.state);
    const day = match === null ? undefined : dayText(match[1] ?? '', ctx);
    if (match === null || day === undefined) return INVALID;
    return text(`${day}, ${ctx.formatter.wallTime(Number(match[2]), Number(match[3]))}`);
  }
  if (hasDate) return dateValue(entity.state, ctx);
  if (hasTime) {
    const match = WALL_TIME_RE.exec(entity.state);
    return match === null ? INVALID : text(ctx.formatter.wallTime(Number(match[1]), Number(match[2])));
  }
  return INVALID;
}

/** "Single press, 12 min ago" style: the event type, then when it last fired. */
function eventValue(entity: HassEntityLike, ctx: ReadingValueContext): ReadingValue {
  const when = instantValue(entity.state, ctx, '');
  if (!when.valid) return INVALID;
  const raw = readAttribute(entity, 'event_type');
  if (typeof raw !== 'string' || raw.trim() === '') return when;
  const formatted = ctx.formatter.attribute(entity, 'event_type');
  // HA's attribute formatter translates; without it the raw slug is worded for people.
  const eventType = capText(formatted !== raw ? formatted : humanize(raw), EVENT_TYPE_MAX_CHARS);
  return text(`${eventType}, ${when.text}`);
}

function lightPercent(entity: HassEntityLike): number | null {
  const brightness = parseNumericValue(readAttribute(entity, 'brightness'));
  return brightness === null ? null : Math.round(brightness / HA_BRIGHTNESS_PER_PERCENT);
}

/** "On, 71%" / "On" / "Off"; any other state in HA's words. */
function levelValue(entity: HassEntityLike, ctx: ReadingValueContext, percent: number | null): string {
  if (entity.state === 'off') return ON_OFF_WORDS[1];
  if (entity.state !== 'on') return stateText(entity, ctx);
  return percent === null
    ? ON_OFF_WORDS[0]
    : `${ON_OFF_WORDS[0]}, ${ctx.formatter.withUnit(ctx.formatter.number(percent), '%')}`;
}

/** "Open", "Open 40%" (partly open), "Closed", "Opening", "Closing"; any other state in HA's words. */
function coverValue(entity: HassEntityLike, ctx: ReadingValueContext): string {
  if (entity.state === 'open') {
    const position = parseNumericValue(readAttribute(entity, 'current_position'));
    return position !== null && position > POSITION.closed && position < POSITION.open
      ? `Open ${ctx.formatter.withUnit(ctx.formatter.number(position), '%')}`
      : 'Open';
  }
  return COVER_WORDS[entity.state] ?? stateText(entity, ctx);
}

/** The HVAC mode in HA's words, then the measured temperature: "Heat, 55° now". */
function climateValue(entity: HassEntityLike, ctx: ReadingValueContext): string {
  const mode = stateText(entity, ctx);
  const current = parseNumericValue(readAttribute(entity, 'current_temperature'));
  return current === null ? mode : `${mode}, ${ctx.formatter.temperature(current, undefined)} now`;
}

/** HA's own state text when the frontend provides it, else the English fallback (§18). */
function stateText(entity: HassEntityLike, ctx: ReadingValueContext): string {
  return ctx.formatter.translatesStates ? ctx.formatter.entityState(entity) : fallbackStateText(entity, ctx);
}

function fallbackStateText(entity: HassEntityLike, ctx: ReadingValueContext): string {
  const { formatter } = ctx;
  const numeric = parseNumericValue(entity.state);
  if (numeric !== null) {
    const precision = ctx.displayPrecision;
    const digits =
      precision === undefined
        ? { maximumFractionDigits: FALLBACK_FRACTION_DIGITS }
        : { minimumFractionDigits: precision, maximumFractionDigits: precision };
    const number = formatter.number(numeric, digits);
    const unit = readAttribute(entity, 'unit_of_measurement');
    return typeof unit === 'string' && unit !== '' ? formatter.withUnit(number, unit) : number;
  }
  const words = onOffWords(entity);
  if (words !== undefined && (entity.state === 'on' || entity.state === 'off')) {
    return entity.state === 'on' ? words[0] : words[1];
  }
  return humanize(entity.state);
}

function onOffWords(entity: HassEntityLike): readonly [string, string] | undefined {
  const domain = domainOf(entity.entity_id);
  if (domain === 'update') return UPDATE_WORDS;
  if (domain === 'binary_sensor') {
    const deviceClass = readAttribute(entity, 'device_class');
    return (typeof deviceClass === 'string' ? BINARY_SENSOR_WORDS[deviceClass] : undefined) ?? ON_OFF_WORDS;
  }
  if (domain === 'switch' || domain === 'input_boolean') return ON_OFF_WORDS;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Times and dates, in the formatter's zone (§18)

/**
 * "7:40 PM" today; "Tomorrow, 7:40 PM" or "Yesterday, 7:40 PM"; "Oct 3, 7:40 PM" within six days in the same year;
 * "Sep 12" further away in the same year; "Sep 12, 2025" in another year.
 */
function whenText(date: Date, ctx: ReadingValueContext): string {
  const { formatter, now } = ctx;
  const key = formatter.dayKey(date);
  const time = formatter.time(date);
  const relative = relativeDayWord(key, ctx);
  if (relative === 'Today') return time;
  if (relative !== undefined) return `${relative}, ${time}`;
  const today = formatter.dayKey(now);
  if (!sameYear(key, today)) return formatter.date(date, 'month-day-year');
  return Math.abs(dayDifference(key, today)) <= NEAR_DAYS
    ? `${formatter.date(date, 'month-day')}, ${time}`
    : formatter.date(date, 'month-day');
}

/**
 * A calendar date ('YYYY-MM-DD', as HA writes dates): "Today", "Tomorrow", "Yesterday", "Sep 12" or "Sep 12, 2025".
 * Never parsed with `new Date('YYYY-MM-DD')`, which is UTC midnight and can fall on the previous local day.
 */
function dayText(key: string, ctx: ReadingValueContext): string | undefined {
  if (!isCalendarDate(key)) return undefined;
  const relative = relativeDayWord(key, ctx);
  if (relative !== undefined) return relative;
  const start = dateStart(ctx.formatter, key);
  if (start === undefined) return undefined;
  const style = sameYear(key, ctx.formatter.dayKey(ctx.now)) ? 'month-day' : 'month-day-year';
  return ctx.formatter.date(start, style);
}

function relativeDayWord(key: string, ctx: ReadingValueContext): 'Today' | 'Tomorrow' | 'Yesterday' | undefined {
  const { formatter, now } = ctx;
  if (key === formatter.dayKey(now)) return 'Today';
  if (key === formatter.dayKey(dayStart(formatter, now, 1))) return 'Tomorrow';
  if (key === formatter.dayKey(dayStart(formatter, now, -1))) return 'Yesterday';
  return undefined;
}

/** A real calendar date: '2026-02-30' is refused rather than rolled over into March. */
function isCalendarDate(key: string): boolean {
  const match = DAY_KEY_RE.exec(key);
  if (match === null) return false;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return utc.toISOString().slice(0, key.length) === key;
}

function sameYear(a: string, b: string): boolean {
  return a.slice(0, 4) === b.slice(0, 4);
}

/** Whole calendar days from `b` to `a`; both are day keys, so UTC arithmetic on them is exact. */
function dayDifference(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------------------------------------------
// Text

/** "single_press" → "Single press". */
function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words === '' ? words : words.charAt(0).toUpperCase() + words.slice(1);
}

/** At most `max` characters (code points), with an ellipsis when cut. */
export function capText(value: string, max: number): string {
  const characters = [...value];
  return characters.length <= max
    ? value
    : `${characters
        .slice(0, max - 1)
        .join('')
        .trimEnd()}${ELLIPSIS}`;
}
