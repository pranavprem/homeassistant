import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineOnce, recordedConflicts } from '../../src/util/define.ts';
import { APP_VERSION } from '../../src/version.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defineOnce', () => {
  it('registers a new tag and stamps it with the bundle version', () => {
    class FirstElement extends HTMLElement {}
    defineOnce('agr-test-first', FirstElement);
    expect(customElements.get('agr-test-first')).toBe(FirstElement);
    expect((FirstElement as unknown as { version: string }).version).toBe(APP_VERSION);
  });

  it('ignores a second definition from a bundle with the same version', () => {
    class Original extends HTMLElement {}
    class SameVersionCopy extends HTMLElement {}
    defineOnce('agr-test-same', Original);
    defineOnce('agr-test-same', SameVersionCopy);
    expect(customElements.get('agr-test-same')).toBe(Original);
    expect(recordedConflicts(Original)).toEqual([]);
  });

  it('never redefines a tag registered by a different version, and records the conflict', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The running bundle's constructor, as its own defineOnce stamped it: a version and a conflict list.
    class StaleBundleElement extends HTMLElement {
      static readonly version = '0.0.1';
      static readonly agrVersionConflicts: unknown[] = [];
    }
    customElements.define('agr-test-stale', StaleBundleElement);
    defineOnce('agr-test-stale', class extends HTMLElement {});
    expect(customElements.get('agr-test-stale')).toBe(StaleBundleElement);
    expect(recordedConflicts(StaleBundleElement)).toContainEqual({
      tag: 'agr-test-stale',
      running: '0.0.1',
      loaded: APP_VERSION,
    });
    expect(warn).toHaveBeenCalledWith('[agraharam]', 'version-conflict', 'agr-test-stale', '0.0.1', APP_VERSION);
  });
});
