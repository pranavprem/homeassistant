import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/header/agr-household-drawer.ts';
import type { AgrHouseholdDrawer } from '../../src/components/header/agr-household-drawer.ts';
import type { ConnectionInfo } from '../../src/ha/host.ts';
import { settle } from '../helpers/dom.ts';
import { fakeStore, testEntity } from '../helpers/fake-store.ts';
import {
  ARUN,
  headerConfig,
  MEERA,
  mountInContainer,
  PINNED_NOW,
  shadowText,
  testServices,
  type ReaderOptions,
} from './support.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});

async function mountDrawer(readerOptions: ReaderOptions = {}, extra: Record<string, unknown> = {}) {
  const store = fakeStore([testEntity(MEERA, 'home'), testEntity(ARUN, 'Studio')]);
  const drawer = document.createElement('agr-household-drawer') as AgrHouseholdDrawer;
  drawer.services = testServices(headerConfig(extra), store, { mode: 'demo', ...readerOptions });
  drawer.request = { id: 'household' };
  const mounted = mountInContainer(drawer);
  await settle();
  return { ...mounted, shell: drawer.shadowRoot?.querySelector('agr-drawer') };
}

describe('agr-household-drawer (§5.3)', () => {
  it('is a bottom sheet titled Household, labelled Demo in demo mode', async () => {
    const { shell } = await mountDrawer();
    expect(shell?.sheet).toBe('bottom');
    expect(shell?.heading).toBe('Household');
    expect(shell?.demo).toBe(true);
  });

  it('lists each person by name with Home, Away or Unknown only, plus the long date (the header shows the time)', async () => {
    const { element } = await mountDrawer();
    const rows = [...(element.shadowRoot?.querySelectorAll('.person') ?? [])].map((row) => shadowText(row));
    expect(rows).toEqual(['M Meera Home', 'A Arun Away']);
    const text = shadowText(element);
    expect(text).not.toContain('Studio');
    expect(text).toContain('Wednesday, September 30');
    expect(text).not.toContain('5:51 PM');
  });

  it('shows the connection state, with the banner wording when it needs attention', async () => {
    const connection = (): ConnectionInfo => ({ phase: 'disconnected' });
    const { element } = await mountDrawer({ connection });
    const text = shadowText(element);
    expect(text).toContain('Disconnected');
    expect(text).toContain('Connection to Home Assistant lost.');
  });

  it('links to diagnostics for admins with diagnostics enabled; the link replaces this drawer', async () => {
    const { element, drawerRequests } = await mountDrawer({ admin: true });
    const link = element.shadowRoot?.querySelector('agr-button');
    expect(link?.label).toBe('Diagnostics');
    link?.shadowRoot?.querySelector('button')?.click();
    expect(drawerRequests).toEqual(['diagnostics']);
  });

  it('has no diagnostics link for other users or when diagnostics are off', async () => {
    expect((await mountDrawer({ admin: false })).element.shadowRoot?.querySelector('agr-button')).toBeNull();
    const off = await mountDrawer({ admin: true }, { diagnostics: false });
    expect(off.element.shadowRoot?.querySelector('agr-button')).toBeNull();
  });
});
