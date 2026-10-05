/**
 * Entity-state normalization and null-safe display builders (§4.6). Missing, unknown, unavailable and offline
 * stay distinct, and a null or non-numeric value is never shown as 0.
 */
import type { EntityId } from '../config/schema.ts';
import type { StoreView } from './entity-store.ts';
import type { HassEntityLike } from './types.ts';

export type EntityStatus =
  | 'available'
  | 'unavailable'
  | 'unknown'
  | 'missing-binding'
  | 'privacy'
  | 'disconnected'
  | 'loading'
  | 'permission-denied';

export interface NormalizedEntity {
  readonly id: EntityId;
  readonly status: EntityStatus;
  readonly entity?: HassEntityLike; // present for available/unknown, and for disconnected when last known exists
  readonly stale: boolean; // true when disconnected and showing last known values
}

export type Tone = 'neutral' | 'ok' | 'attention' | 'danger' | 'muted';
export type Display =
  | { readonly kind: 'value'; readonly text: string; readonly stale: boolean }
  | {
      readonly kind: 'absent';
      readonly reason: Exclude<EntityStatus, 'available'> | 'no-data';
      readonly label: string;
    };

type AbsentReason = Extract<Display, { kind: 'absent' }>['reason'];

/** Visible labels for absent values (§4.6). 'loading' renders as a skeleton bar; the label is for assistive text. */
export const ABSENT_LABELS: Readonly<Record<AbsentReason, string>> = Object.freeze({
  unavailable: 'Unavailable',
  unknown: 'Unknown',
  'missing-binding': 'Not found',
  disconnected: 'Offline',
  loading: 'Loading',
  'permission-denied': 'No access',
  privacy: 'Privacy on',
  'no-data': 'No data',
});

const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Precedence, first match wins (§4.6, plus the §16.10 rule that an entity the snapshot did not replace is stale). */
export function normalizeEntity(store: StoreView, id: EntityId): NormalizedEntity {
  if (!store.isReady()) return { id, status: 'loading', stale: false };
  const entity = store.get(id);
  if (entity === undefined) return { id, status: absentEntityStatus(store), stale: false };
  if (!store.isConnected() || !store.freshSinceResync(id)) {
    return { id, status: 'disconnected', entity, stale: true };
  }
  if (entity.state === 'unavailable') return { id, status: 'unavailable', stale: false };
  if (entity.state === 'unknown' || entity.state === '') {
    return { id, status: 'unknown', entity, stale: false };
  }
  return { id, status: 'available', entity, stale: false };
}

function absentEntityStatus(store: StoreView): EntityStatus {
  if (!store.isConnected()) return 'disconnected';
  const haState = store.haState();
  // Integrations are still setting up, so HA restarts must not list every device as "Not found".
  if (haState === 'NOT_RUNNING' || haState === 'STARTING') return 'loading';
  return 'missing-binding';
}

/**
 * A finite number, or a string that is a plain decimal number; everything else (null, '', 'unknown', NaN,
 * Infinity, '1e3', objects) is null. Shared by every selector so "no data" is never coerced to 0.
 */
export function parseNumericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC_STRING_RE.test(value)) return Number(value);
  return null;
}

export function numericDisplay(
  n: NormalizedEntity,
  read: (e: HassEntityLike) => unknown,
  format: (v: number) => string,
): Display {
  const entity = readableEntity(n);
  if (entity === undefined) return absentFor(n.status);
  const value = parseNumericValue(read(entity));
  if (value === null) return noValueFor(n);
  return { kind: 'value', text: format(value), stale: n.stale };
}

export function textDisplay(n: NormalizedEntity, read: (e: HassEntityLike) => string | undefined): Display {
  const entity = readableEntity(n);
  if (entity === undefined) return absentFor(n.status);
  const text = read(entity);
  if (text === undefined || text === '') return noValueFor(n);
  return { kind: 'value', text, stale: n.stale };
}

/**
 * The entity whose values may be shown: a live available one, or the last known one while disconnected. The one
 * definition every display builder and selector reads values through.
 */
export function readableEntity(n: NormalizedEntity): HassEntityLike | undefined {
  return n.status === 'available' || n.status === 'disconnected' ? n.entity : undefined;
}

/** The absent Display for a status with no value to show; 'available' with nothing readable is "No data". */
export function absentFor(status: EntityStatus | 'no-data'): Extract<Display, { kind: 'absent' }> {
  const reason: AbsentReason = status === 'available' ? 'no-data' : status;
  return { kind: 'absent', reason, label: ABSENT_LABELS[reason] };
}

/**
 * The absent Display for a readable entity whose value is unusable (null, non-numeric, an unparseable time): "Offline"
 * when it is the stale last known entity, else "No data".
 */
export function noValueFor(n: NormalizedEntity): Extract<Display, { kind: 'absent' }> {
  return absentFor(n.stale ? 'disconnected' : 'no-data');
}
