/**
 * Sky radar geometry (AIRSPACE.md §6): pure and North-up, with home at the unlabelled centre. The viewBox is
 * `-100 -100 200 200` and the outer ring (radius RADAR_OUTER_R) maps to the collector's nearby radius. Inputs are
 * already validated by the parser, so nothing here can produce NaN, and SVG geometry is built only from numbers.
 */
import type { Formatter, LengthUnit } from '../ha/host.ts';
import type { Aircraft } from './airspace.ts';

export interface RadarRingVM {
  readonly r: number;
  readonly label: string;
  readonly overhead: boolean;
}

export interface RadarMarkVM {
  readonly key: string; // validated hex
  readonly x: number;
  readonly y: number;
  readonly rotation?: number; // ground track, clockwise from north; undefined ⇒ a dot
  readonly overhead: boolean;
  readonly expanded: boolean;
  readonly clamped: boolean; // beyond the outer ring, drawn on it
  readonly label?: string; // only the expanded aircraft and overhead aircraft (at most RADAR_MAX_LABELS)
}

export interface RadarVM {
  readonly rings: readonly RadarRingVM[];
  readonly marks: readonly RadarMarkVM[]; // nearby only, at most AIRCRAFT_MAX
  readonly live: boolean; // false ⇒ hollow grey marks, no chevrons
  readonly summary: string; // the role="img" name
}

export const RADAR_VIEWBOX = '-100 -100 200 200';
export const RADAR_OUTER_R = 90;
/** Invisible hit circles around marks, in viewBox units. */
export const RADAR_HIT_R = 8;
/** Mark labels are kept to a calm few rather than collision-solved. */
const RADAR_MAX_LABELS = 3;
/** Cardinal letters sit just outside the outer ring. */
export const RADAR_CARDINALS: readonly {
  readonly label: 'N' | 'E' | 'S' | 'W';
  readonly x: number;
  readonly y: number;
}[] = Object.freeze([
  Object.freeze({ label: 'N', x: 0, y: -95 } as const),
  Object.freeze({ label: 'E', x: 95, y: 0 } as const),
  Object.freeze({ label: 'S', x: 0, y: 95 } as const),
  Object.freeze({ label: 'W', x: -95, y: 0 } as const),
]);

/** Statute miles per kilometre (HA's US customary length unit). */
export const MILES_PER_KM = 0.621371;
/** Rings closer than this (viewBox units) to another ring or the rim are skipped, so labels never crowd. */
const RING_MIN_GAP = 8;
/** The most ordinary rings drawn besides the overhead ring. */
const MAX_STEP_RINGS = 3;
/** "Nice" ring steps: 1-2-5 times powers of ten, from 0.1 to 500 in the display unit. */
const NICE_STEPS: readonly number[] = Object.freeze(
  [0.1, 1, 10, 100].flatMap((power) => [1, 2, 5].map((mantissa) => Number((power * mantissa).toPrecision(1)))),
);
const DEGREES_TO_RADIANS = Math.PI / 180;
const ROUNDING = 10; // one decimal place

/** θ = bearing·π/180; r = min(d/radius, 1)·R; x = r·sin θ; y = −r·cos θ; rounded to 0.1. Inputs are validated. */
export function radarPoint(
  distanceKm: number,
  bearingDeg: number,
  radiusKm: number,
): { x: number; y: number; clamped: boolean } {
  const ratio = distanceKm / radiusKm;
  const r = Math.min(ratio, 1) * RADAR_OUTER_R;
  const theta = bearingDeg * DEGREES_TO_RADIANS;
  return { x: round(r * Math.sin(theta)), y: round(-r * Math.cos(theta)), clamped: ratio > 1 };
}

/**
 * The overhead ring (emphasised, always kept) plus up to three rings at the largest-count "nice" 1-2-5 step in the
 * HA length unit; a ring within RING_MIN_GAP of the overhead ring, the rim or another ring is skipped. Labels use
 * `formatNumber` (the card formatter's `number`), so they follow the profile locale like every other distance.
 */
export function radarRings(
  radiusKm: number,
  overheadKm: number,
  lengthUnit: LengthUnit,
  formatNumber: Formatter['number'],
): RadarVM['rings'] {
  const factor = lengthUnit === 'mi' ? MILES_PER_KM : 1;
  const radius = radiusKm * factor;
  const label = (value: number): string => ringLabel(value, lengthUnit, formatNumber);
  const overheadRing: RadarRingVM = {
    r: round((overheadKm / radiusKm) * RADAR_OUTER_R),
    label: label(overheadKm * factor),
    overhead: true,
  };
  const rings: RadarRingVM[] = [overheadRing];
  const step = NICE_STEPS.find((candidate) => Math.floor(radius / candidate) <= MAX_STEP_RINGS);
  if (step !== undefined) {
    for (let index = 1; index * step < radius; index += 1) {
      const r = round(((index * step) / radius) * RADAR_OUTER_R);
      const crowded = RADAR_OUTER_R - r < RING_MIN_GAP || rings.some((ring) => Math.abs(ring.r - r) < RING_MIN_GAP);
      if (!crowded) rings.push({ r, label: label(index * step), overhead: false });
    }
  }
  return Object.freeze(rings.sort((a, b) => a.r - b.r).map((ring) => Object.freeze(ring)));
}

/**
 * Marks for the nearby aircraft (never the recent list). Not live: no track chevrons and no overhead emphasis.
 * Labels go to the expanded aircraft first, then (live only) overhead ones nearest first, at most RADAR_MAX_LABELS.
 * Emphasised marks come last so they paint on top.
 */
export function radarMarks(
  aircraft: readonly Aircraft[],
  radiusKm: number,
  options: { readonly live: boolean; readonly expanded?: string },
): readonly RadarMarkVM[] {
  const labelled = new Set<string>();
  if (options.expanded !== undefined && aircraft.some((item) => item.hex === options.expanded)) {
    labelled.add(options.expanded);
  }
  for (const item of aircraft) {
    if (labelled.size >= RADAR_MAX_LABELS) break;
    if (options.live && item.overhead) labelled.add(item.hex);
  }
  const marks = aircraft.map((item): RadarMarkVM => {
    const point = radarPoint(item.distanceKm, item.bearingDeg, radiusKm);
    const rotation = options.live ? item.trackDeg : undefined;
    return Object.freeze({
      key: item.hex,
      x: point.x,
      y: point.y,
      ...(rotation !== undefined && { rotation }),
      overhead: options.live && item.overhead,
      expanded: item.hex === options.expanded,
      clamped: point.clamped,
      ...(labelled.has(item.hex) && { label: item.label }),
    });
  });
  const emphasis = (mark: RadarMarkVM): number => (mark.expanded ? 2 : mark.overhead ? 1 : 0);
  return Object.freeze(marks.sort((a, b) => emphasis(a) - emphasis(b)));
}

/** "3 km", "1.9 mi" ("1,9 mi" in a comma-decimal locale): integral values bare, others to one decimal. */
function ringLabel(value: number, unit: LengthUnit, formatNumber: Formatter['number']): string {
  const rounded = round(value);
  const digits = Number.isInteger(rounded) ? 0 : 1;
  return `${formatNumber(rounded, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
}

/** One decimal place, and never −0. */
function round(value: number): number {
  return Math.round(value * ROUNDING) / ROUNDING + 0;
}
