/** The page-wide in-flight registry (§4.7): locks by target entity, monotonic expiry, pruned on read. */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { createInflightRegistry, INFLIGHT } from '../../src/ha/actions/inflight.ts';

const GARAGE = 'cover.demo_garage' as EntityId;
const LAMP = 'light.demo_reading_lamp' as EntityId;

describe('createInflightRegistry', () => {
  it('is busy from mark until the expiry, exclusive', () => {
    const registry = createInflightRegistry();
    registry.mark([GARAGE], 1_060);
    expect(registry.isBusy(GARAGE, 1_000)).toBe(true);
    expect(registry.isBusy(GARAGE, 1_059.9)).toBe(true);
    expect(registry.isBusy(GARAGE, 1_060)).toBe(false);
    expect(registry.isBusy(GARAGE, 1_000)).toBe(false); // pruned on the expired read
  });

  it('locks each target independently and clears only the given ones', () => {
    const registry = createInflightRegistry();
    registry.mark([GARAGE, LAMP], 500);
    registry.clear([LAMP]);
    expect(registry.isBusy(LAMP, 0)).toBe(false);
    expect(registry.isBusy(GARAGE, 0)).toBe(true);
  });

  it('never shortens an existing lock', () => {
    const registry = createInflightRegistry();
    registry.mark([GARAGE], 900);
    registry.mark([GARAGE], 300);
    expect(registry.isBusy(GARAGE, 600)).toBe(true);
    registry.mark([GARAGE], 1_200);
    expect(registry.isBusy(GARAGE, 1_000)).toBe(true);
  });

  it('is not busy for an unknown target', () => {
    expect(createInflightRegistry().isBusy(LAMP, 0)).toBe(false);
  });

  it('exposes one frozen page-wide singleton', () => {
    expect(Object.isFrozen(INFLIGHT)).toBe(true);
    expect(INFLIGHT).not.toBe(createInflightRegistry());
  });
});
