/**
 * The step grid shared by agr-stepper and the gateway's argument validation (§7.1), so the UI can only produce
 * values the gateway accepts, and the climate setpoint grid both read from an entity's attributes. The grid is the
 * multiples of `step`; `min` and `max` are always reachable as clamp results even when they are off the grid (a
 * converted min_temp of 7.2 °C with step 0.5).
 *
 * A domain module (§3): pure rules both the adapter (src/ha) and the view models (src/model) use. It imports nothing
 * from either.
 */

export interface StepGrid {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** §7.1: without `target_temp_step`, the grid is 1 degree in Fahrenheit and half a degree in Celsius. */
const FAHRENHEIT_UNIT = '°F';
const DEFAULT_STEP_FAHRENHEIT = 1;
const DEFAULT_STEP_CELSIUS = 0.5;

/** Values within this distance of a grid value count as on the grid (§7.1: tolerance 1e-6). */
const GRID_TOLERANCE = 1e-6;
/** Outputs are rounded to 6 decimals, so 0.1 × 3 yields 0.3 rather than 0.30000000000000004. */
const OUTPUT_SCALE = 1e6;

/**
 * The next grid value strictly above (+1) or below (−1) `base`, clamped to [min, max]. An off-grid base snaps to
 * the grid first: 22.3 with step 0.5 gives 22.5 going up and 22.0 going down.
 */
export function stepValue(base: number, direction: 1 | -1, grid: StepGrid): number {
  assertGrid(grid);
  if (!Number.isFinite(base)) throw new RangeError('stepValue: base must be a finite number.');
  // Round before clamping so the clamp result is min or max exactly, which validation accepts as-is.
  return clamp(gridValue(nextGridIndex(base, direction, grid.step), grid.step), grid.min, grid.max);
}

/** True for exactly the values stepValue can produce: a grid value within [min, max], or exactly min or max. */
export function isStepValue(value: number, grid: StepGrid): boolean {
  assertGrid(grid);
  if (!Number.isFinite(value) || value < grid.min || value > grid.max) return false;
  if (value === grid.min || value === grid.max) return true;
  return isOnGrid(value, grid.step);
}

/** The climate step (§7.1): `target_temp_step` when it is a positive number, else 1 °F or 0.5 °C. */
export function temperatureStep(attributes: Readonly<Record<string, unknown>>, unit: string): number {
  const step = attributes['target_temp_step'];
  if (isFiniteNumber(step) && step > 0) return step;
  return unit === FAHRENHEIT_UNIT ? DEFAULT_STEP_FAHRENHEIT : DEFAULT_STEP_CELSIUS;
}

/**
 * A climate entity's setpoint grid (§7.1), shared by the gateway's validation and the Comfort selector, so the
 * stepper is offered exactly when its values would be accepted. Undefined when min_temp/max_temp are missing, not
 * finite numbers or inverted (fail closed, no defaults).
 */
export function temperatureGrid(attributes: Readonly<Record<string, unknown>>, unit: string): StepGrid | undefined {
  const min = attributes['min_temp'];
  const max = attributes['max_temp'];
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || min > max) return undefined;
  return { min, max, step: temperatureStep(attributes, unit) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nextGridIndex(base: number, direction: 1 | -1, step: number): number {
  if (isOnGrid(base, step)) return Math.round(base / step) + direction;
  return direction === 1 ? Math.ceil(base / step) : Math.floor(base / step);
}

function isOnGrid(value: number, step: number): boolean {
  return Math.abs(value - gridValue(Math.round(value / step), step)) < GRID_TOLERANCE;
}

function gridValue(index: number, step: number): number {
  return Math.round(index * step * OUTPUT_SCALE) / OUTPUT_SCALE;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assertGrid({ min, max, step }: StepGrid): void {
  if (!(Number.isFinite(step) && step > 0)) {
    throw new RangeError('stepValue: step must be a positive number.');
  }
  if (!(Number.isFinite(min) && Number.isFinite(max) && min <= max)) {
    throw new RangeError('stepValue: min and max must be finite with min <= max.');
  }
}
