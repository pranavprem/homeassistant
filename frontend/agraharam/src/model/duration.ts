/**
 * Durations for house readings (§18): a `sensor` or `number` whose device class is `duration` and whose state is
 * numeric, in one of HA's time units, shown compactly ("1 h 25 min", "3 d 4 h"). Pure. HA core requires a numeric
 * state for this device class, so no text form ("1:25:00") is ever parsed, and a row without the device class is
 * never reinterpreted (a time of day such as "07:30:00" stays text). Appliance remaining time keeps its own deployed
 * formatting (model/home/appliances.ts).
 */
import { parseNumericValue } from '../ha/normalize.ts';

const SECONDS_PER = Object.freeze({ day: 86_400, hour: 3_600, minute: 60, second: 1 });

/**
 * Microseconds as core writes them (UnitOfTime.MICROSECONDS, the Greek mu U+03BC) and as many integrations write them
 * (the micro sign U+00B5). Escaped, because the two look identical in source.
 */
const MICROSECOND_UNITS: readonly string[] = Object.freeze(['\u03bcs', '\u00b5s']);
const SECONDS_PER_MICROSECOND = 0.000_001;

/** Seconds per unit of HA's UnitOfTime. */
const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  d: SECONDS_PER.day,
  h: SECONDS_PER.hour,
  min: SECONDS_PER.minute,
  s: SECONDS_PER.second,
  ms: 0.001,
  ...Object.fromEntries(MICROSECOND_UNITS.map((unit) => [unit, SECONDS_PER_MICROSECOND])),
});

/** Larger units first; each shows with the next smaller one ("3 d 4 h", "1 h 25 min", "12 min 5 s"). */
const UNIT_STEPS: readonly {
  readonly seconds: number;
  readonly label: string;
  readonly next: number;
  readonly nextLabel: string;
}[] = Object.freeze([
  { seconds: SECONDS_PER.day, label: 'd', next: SECONDS_PER.hour, nextLabel: 'h' },
  { seconds: SECONDS_PER.hour, label: 'h', next: SECONDS_PER.minute, nextLabel: 'min' },
  { seconds: SECONDS_PER.minute, label: 'min', next: SECONDS_PER.second, nextLabel: 's' },
]);
const SUB_SECOND_DIGITS = 1;

/**
 * The reading in seconds, or undefined when it is not a numeric duration in a known time unit (the caller then shows
 * HA's own formatting). `state` and `unit` are the raw state and `unit_of_measurement`.
 */
export function durationSeconds(state: string, unit: unknown): number | undefined {
  const value = parseNumericValue(state);
  const perUnit = typeof unit === 'string' ? DURATION_UNIT_SECONDS[unit] : undefined;
  return value === null || perUnit === undefined ? undefined : value * perUnit;
}

/**
 * "45 s", "12 min 5 s", "1 h 25 min", "1 h", "3 d 4 h", "41 d"; under a second, "0.4 s". The value is rounded to the
 * smaller of its two units, and the larger unit is chosen again after rounding, so a value just short of an hour
 * carries over ("1 h", never "60 min"). Undefined for a negative or non-finite value: the caller falls back to HA's
 * own formatting rather than invent a duration.
 */
export function formatReadingDuration(
  seconds: number,
  number: (value: number, options?: Intl.NumberFormatOptions) => string,
): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  if (seconds < 1) return `${number(seconds, { maximumFractionDigits: SUB_SECOND_DIGITS })} s`;
  const rounded = Math.round(seconds);
  const first = largestStep(rounded);
  if (first === undefined) return `${number(rounded)} s`;
  const total = Math.round(rounded / first.next) * first.next;
  const step = largestStep(total) ?? first;
  const whole = Math.floor(total / step.seconds);
  const rest = (total % step.seconds) / step.next;
  const head = `${number(whole)} ${step.label}`;
  return rest === 0 ? head : `${head} ${number(rest)} ${step.nextLabel}`;
}

function largestStep(seconds: number): (typeof UNIT_STEPS)[number] | undefined {
  return UNIT_STEPS.find((step) => step.seconds <= seconds);
}
