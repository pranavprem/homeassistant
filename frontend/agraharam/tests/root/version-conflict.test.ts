import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgraharamDashboard } from '../../src/agraharam-dashboard.ts';
import { recordedConflicts } from '../../src/util/define.ts';
import { APP_VERSION } from '../../src/version.ts';
import { settle } from '../helpers/dom.ts';
import { FakeHass, mountCard } from '../helpers/mount.ts';

const STALE_VERSION = '9.9.9';

/** Loads define.ts as a second bundle of another version would, and lets it try to register the card tag. */
async function loadSecondBundle(): Promise<void> {
  vi.resetModules();
  vi.doMock('../../src/version.ts', () => ({ APP_VERSION: STALE_VERSION, GIT_SHA: 'stale' }));
  const secondBundle = await import('../../src/util/define.ts');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  secondBundle.defineOnce('agraharam-dashboard', class extends HTMLElement {});
}

afterAll(() => {
  vi.doUnmock('../../src/version.ts');
  vi.resetModules();
});

describe('version conflicts (§11.3)', () => {
  it('a later bundle of another version records the conflict on the running constructor, never redefining it', async () => {
    await loadSecondBundle();
    expect(customElements.get('agraharam-dashboard')).toBe(AgraharamDashboard);
    expect(recordedConflicts(AgraharamDashboard)).toEqual([
      { tag: 'agraharam-dashboard', running: APP_VERSION, loaded: STALE_VERSION },
    ]);
  });

  it('the running card shows a one-line notice to admins only, and reports it to diagnostics', async () => {
    const mounted = await mountCard({ config: { demo: true } });
    expect(mounted.root.querySelector('.notice')).toBeNull();
    mounted.card.hass = new FakeHass('normal').hass;
    await settle();
    expect(mounted.root.querySelector('.notice')?.textContent).toContain(`Agraharam ${STALE_VERSION} was also loaded`);
    expect(mounted.services()?.status.get('bundle')).toBe(`version-conflict ignored ${STALE_VERSION}`);
  });
});
