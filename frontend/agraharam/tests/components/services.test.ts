import { describe, expect, it } from 'vitest';
import { memoizeServices, type DashboardServices } from '../../src/components/services.ts';

/** Identity is all memoizeServices compares, so opaque stand-ins are enough for each field. */
function services(overrides: Partial<DashboardServices> = {}): DashboardServices {
  return {
    config: {} as DashboardServices['config'],
    reader: {} as DashboardServices['reader'],
    store: {} as DashboardServices['store'],
    gateway: {} as DashboardServices['gateway'],
    status: {} as DashboardServices['status'],
    warnings: [],
    mode: 'demo',
    preview: false,
    theme: 'light',
    ...overrides,
  };
}

describe('memoizeServices', () => {
  it('returns a frozen copy on first publish', () => {
    const next = services();
    const published = memoizeServices(undefined, next);
    expect(published).toEqual(next);
    expect(published).not.toBe(next);
    expect(Object.isFrozen(published)).toBe(true);
  });

  it('returns the previous object when nothing changed', () => {
    const first = memoizeServices(undefined, services());
    expect(memoizeServices(first, { ...first })).toBe(first);
  });

  it.each<[string, Partial<DashboardServices>]>([
    ['gateway', { gateway: {} as DashboardServices['gateway'] }],
    ['store (runtime)', { store: {} as DashboardServices['store'] }],
    ['warnings', { warnings: [] }],
    ['preview', { preview: true }],
    ['theme', { theme: 'dark' }],
    ['mode', { mode: 'live' }],
  ])('publishes a new object when %s changes', (_field, change) => {
    const first = memoizeServices(undefined, services());
    const next = memoizeServices(first, { ...first, ...change });
    expect(next).not.toBe(first);
    expect(Object.isFrozen(next)).toBe(true);
  });
});
