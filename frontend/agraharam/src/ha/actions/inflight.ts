/**
 * In-flight registry (§4.7). Module scope, shared by every gateway and card instance in the page, and keyed by the
 * resolved TARGET entity ID rather than the ActionKey: a new card instance after a route change, or a gateway rebuilt
 * by setConfig, must still see the garage door as busy while an earlier open_cover may be executing.
 *
 * Times are monotonic performance.now() values; Date.now() would freeze under e2e's pinned clock.
 */
import type { EntityId } from '../../config/schema.ts';
import type { InflightRegistry } from './types.ts';

/** A fresh registry. Production code uses the page-wide INFLIGHT singleton; tests inject their own. */
export function createInflightRegistry(): InflightRegistry {
  const busyUntil = new Map<EntityId, number>();
  return Object.freeze({
    mark(targets: readonly EntityId[], until: number): void {
      // Never shorten an existing lock: an uncertain call on the same target may still be executing.
      for (const target of targets) busyUntil.set(target, Math.max(busyUntil.get(target) ?? until, until));
    },
    clear(targets: readonly EntityId[]): void {
      for (const target of targets) busyUntil.delete(target);
    },
    isBusy(target: EntityId, now: number): boolean {
      const until = busyUntil.get(target);
      if (until === undefined) return false;
      if (now < until) return true;
      busyUntil.delete(target);
      return false;
    },
  });
}

/** The page-wide registry every gateway uses unless a test injects one. */
export const INFLIGHT: InflightRegistry = createInflightRegistry();
