/**
 * Formatter implementations (§4.4). Entity states use HA's own formatEntityState when the frontend provides it
 * (units and display precision); everything else is Intl, configured from the user's HA locale profile. Intl
 * formatters are built once per Formatter (number formats once per options key), which lives until the 'locale'
 * meta changes.
 */
import type { ClockParts, Formatter } from './host.ts';
import type { HassEntityLike, LocaleLike } from './types.ts';

interface FormatterSource {
  /** The user's HA profile settings; undefined uses the browser's defaults. */
  readonly locale?: LocaleLike;
  /** hass.config.time_zone, used when the profile asks for server time. */
  readonly serverTimeZone?: string;
  readonly temperatureUnit: string;
  readonly formatEntityState?: (stateObj: HassEntityLike, state?: string) => string;
  readonly formatEntityAttributeValue?: (stateObj: HassEntityLike, attribute: string, value?: unknown) => string;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
/** A fixed Latin-digit locale for values the code parses (hour of day, day keys), whatever the user's language. */
const PARSEABLE_DIGITS_LOCALE = 'en-US-u-nu-latn';
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * Every zone in use is between UTC−12 and UTC+14, so the day a UTC midnight names starts within 14 hours before it
 * and 12 hours after it. The search window adds an hour on each side.
 */
const DAY_START_SEARCH_MINUTES = Object.freeze({ before: 15 * MINUTES_PER_HOUR, after: 13 * MINUTES_PER_HOUR });
/** HA puts no space before these units ("21%", "69°") and a space before every other unit ("21.5 °C"). */
const UNITS_WITHOUT_SPACE: ReadonlySet<string> = new Set(['%', '°']);

/** HA's number_format profile options mapped to the locales HA itself uses for them. */
const NUMBER_FORMAT_LOCALES: Readonly<Partial<Record<LocaleLike['number_format'], readonly string[]>>> = Object.freeze({
  comma_decimal: ['en-US', 'en'],
  decimal_comma: ['de', 'es', 'it'],
  space_comma: ['fr', 'sv', 'cs'],
  quote_decimal: ['de-CH'],
});

const DATE_STYLES: Readonly<Record<'long' | 'weekday-short' | 'month-day', Intl.DateTimeFormatOptions>> = {
  long: { weekday: 'long', month: 'long', day: 'numeric' }, // "Wednesday, September 30"
  'weekday-short': { weekday: 'short', month: 'short', day: 'numeric' }, // "Wed, Sep 30"
  'month-day': { month: 'short', day: 'numeric' }, // "Sep 30"
};

export function createFormatter(source: FormatterSource): Formatter {
  const language = source.locale?.language;
  const numberLocales = numberLocalesFor(source.locale);
  const useGrouping = source.locale?.number_format !== 'none';
  const hour12 = hour12For(source.locale);
  const timeZone = source.locale?.time_zone === 'server' ? source.serverTimeZone : undefined;
  const timeOptions: Intl.DateTimeFormatOptions = { timeZone, ...(hour12 !== undefined && { hour12 }) };
  const timeFormat = new Intl.DateTimeFormat(language, { ...timeOptions, hour: 'numeric', minute: '2-digit' });
  const hourFormat = new Intl.DateTimeFormat(language, { ...timeOptions, hour: 'numeric' });
  // A fixed Latin-digit locale and a 0–23 cycle, so the hour parses as a number whatever the user's language is.
  const hourOfDayFormat = new Intl.DateTimeFormat(PARSEABLE_DIGITS_LOCALE, {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const dayKeyFormat = new Intl.DateTimeFormat(PARSEABLE_DIGITS_LOCALE, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateFormats = {
    long: new Intl.DateTimeFormat(language, { timeZone, ...DATE_STYLES.long }),
    'weekday-short': new Intl.DateTimeFormat(language, { timeZone, ...DATE_STYLES['weekday-short'] }),
    'month-day': new Intl.DateTimeFormat(language, { timeZone, ...DATE_STYLES['month-day'] }),
  };

  // Selectors format numbers on every render; building an Intl.NumberFormat is far costlier than using one, so each
  // distinct options object is built once and reused for this Formatter's lifetime.
  const numberFormats = new Map<string, Intl.NumberFormat>();
  function number(value: number, options?: Intl.NumberFormatOptions): string {
    const key = options === undefined ? '' : JSON.stringify(options);
    let format = numberFormats.get(key);
    if (format === undefined) {
      format = new Intl.NumberFormat(numberLocales, { useGrouping, ...options });
      numberFormats.set(key, format);
    }
    return format.format(value);
  }

  return Object.freeze({
    temperatureUnit: source.temperatureUnit,
    entityState(entity: HassEntityLike): string {
      return source.formatEntityState?.(entity) ?? fallbackEntityState(entity, number);
    },
    attribute(entity: HassEntityLike, attribute: string): string {
      const value = entity.attributes[attribute];
      return source.formatEntityAttributeValue?.(entity, attribute, value) ?? fallbackAttribute(value, number);
    },
    number,
    /** "69°" without a unit (compact tiles); with a unit, HA's spacing rule: "21.5 °C". */
    temperature(value: number, unit: string | undefined): string {
      const formatted = number(value, { maximumFractionDigits: 1 });
      if (unit === undefined) return `${formatted}°`;
      return `${formatted}${UNITS_WITHOUT_SPACE.has(unit) ? '' : ' '}${unit}`;
    },
    time: (value: Date) => timeFormat.format(value),
    hour: (value: Date) => hourFormat.format(value),
    hourOfDay: (value: Date) => hourOfDay(hourOfDayFormat, value),
    dayKey: (value: Date) => dayKey(dayKeyFormat, value),
    clock(value: Date): ClockParts {
      return clockParts(timeFormat.formatToParts(value));
    },
    date: (value: Date, style: 'long' | 'weekday-short' | 'month-day') => dateFormats[style].format(value),
    duration: formatDuration,
  });
}

/** The hour (0–23) in the formatter's zone; falls back to the device's hour if the parts cannot be read. */
function hourOfDay(format: Intl.DateTimeFormat, value: Date): number {
  const hour = Number(format.formatToParts(value).find((part) => part.type === 'hour')?.value);
  return Number.isInteger(hour) ? hour % HOURS_PER_DAY : value.getHours();
}

/** 'YYYY-MM-DD' in the formatter's zone; falls back to the device's calendar day if the parts cannot be read. */
function dayKey(format: Intl.DateTimeFormat, value: Date): string {
  const parts = format.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
  const key = `${part('year')}-${part('month')}-${part('day')}`;
  return DAY_KEY_RE.test(key) ? key : utcDayKey(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
}

function utcDayKey(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------
// Calendar days in a formatter's time zone (§9.5). HA's profile may show server time in another zone than the
// device's, so day grouping and day windows follow Formatter.dayKey rather than the device clock. A day's first
// instant is found by searching on day keys, so DST days of 23 or 25 hours and zones whose clocks skip midnight
// need no offset arithmetic.

/** Same calendar day in the formatter's zone. */
export function sameDay(formatter: Pick<Formatter, 'dayKey'>, a: Date, b: Date): boolean {
  return formatter.dayKey(a) === formatter.dayKey(b);
}

/** The first instant of the calendar day `offsetDays` after the day of `at`, in the formatter's zone. */
export function dayStart(formatter: Pick<Formatter, 'dayKey'>, at: Date, offsetDays = 0): Date {
  const match = DAY_KEY_RE.exec(formatter.dayKey(at));
  const key = match === null ? undefined : shiftedDayKey(match, offsetDays);
  return (key === undefined ? undefined : dateStart(formatter, key)) ?? deviceDayStart(at, offsetDays);
}

/**
 * The first instant of the calendar date `date` ('YYYY-MM-DD', as HA sends all-day events) in the formatter's zone,
 * or undefined when `date` is not such a date. Out-of-range parts roll over as Date.UTC does ('2026-09-31' is
 * October 1), as the device-local reading did.
 */
export function dateStart(formatter: Pick<Formatter, 'dayKey'>, date: string): Date | undefined {
  const match = DAY_KEY_RE.exec(date);
  const key = match === null ? undefined : shiftedDayKey(match, 0);
  if (key === undefined) return undefined;
  const utcMidnightMinutes = Date.parse(`${key}T00:00:00Z`) / MS_PER_MINUTE;
  // Invariant: the day at `low` is before `key` and the day at `high` is `key` or later (keys compare as strings).
  let low = utcMidnightMinutes - DAY_START_SEARCH_MINUTES.before;
  let high = utcMidnightMinutes + DAY_START_SEARCH_MINUTES.after;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (formatter.dayKey(new Date(middle * MS_PER_MINUTE)) >= key) high = middle;
    else low = middle;
  }
  return new Date(high * MS_PER_MINUTE);
}

/** The day key `offsetDays` after the matched one, or undefined outside the four-digit years keys can express. */
function shiftedDayKey(match: RegExpExecArray, offsetDays: number): string | undefined {
  const utcMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays);
  if (!Number.isFinite(utcMs)) return undefined;
  const key = utcDayKey(utcMs);
  return DAY_KEY_RE.test(key) ? key : undefined;
}

/** Device-local midnight `days` after `at`'s day (calendar arithmetic, so DST keeps midnight). */
function deviceDayStart(at: Date, days: number): Date {
  const day = new Date(at.getTime());
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day;
}

function numberLocalesFor(locale: LocaleLike | undefined): string | readonly string[] | undefined {
  if (locale === undefined || locale.number_format === 'system') return undefined;
  return NUMBER_FORMAT_LOCALES[locale.number_format] ?? locale.language;
}

/**
 * The 12/24-hour cycle, as HA's own useAmPm decides it: '12' and '24' are explicit; 'system' follows the DEVICE's
 * locale (not the profile language), so a German profile on a US-English tablet still reads "7 PM"; 'language'
 * (and no profile) leaves it to the profile language's convention.
 */
function hour12For(locale: LocaleLike | undefined): boolean | undefined {
  if (locale?.time_format === '12') return true;
  if (locale?.time_format === '24') return false;
  if (locale?.time_format === 'system') return deviceHour12();
  return undefined;
}

/** The device locale's default cycle; undefined when the engine does not resolve it. */
function deviceHour12(): boolean | undefined {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
}

/** "5:51" plus "PM"; 24-hour locales have no period. */
function clockParts(parts: readonly Intl.DateTimeFormatPart[]): ClockParts {
  const period = parts.find((part) => part.type === 'dayPeriod')?.value;
  const hm = parts
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
  return period === undefined ? { hm } : { hm, period };
}

/** "35 min", "1 h", "1 h 10 min"; negative durations read as 0 min. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MS_PER_MINUTE));
  if (totalMinutes < MINUTES_PER_HOUR) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

function fallbackEntityState(entity: HassEntityLike, number: (value: number) => string): string {
  const unit = entity.attributes['unit_of_measurement'];
  const numeric = /^-?\d+(\.\d+)?$/.test(entity.state) ? number(Number(entity.state)) : entity.state;
  if (typeof unit !== 'string' || unit === '') return numeric;
  return `${numeric}${UNITS_WITHOUT_SPACE.has(unit) ? '' : ' '}${unit}`;
}

function fallbackAttribute(value: unknown, number: (value: number) => string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return number(value);
  if (typeof value === 'string') return value;
  return '';
}
