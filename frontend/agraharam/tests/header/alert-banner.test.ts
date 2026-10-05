import { describe, expect, it } from 'vitest';
import '../../src/components/shell/agr-alert-banner.ts';
import type { AgrAlertBanner } from '../../src/components/shell/agr-alert-banner.ts';
import type { ConnectionInfo } from '../../src/ha/host.ts';
import { settle } from '../helpers/dom.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { liveStore } from '../helpers/live-store.ts';
import { ALARM, headerConfig, mountInContainer, POLICY, shadowText, testServices } from './support.ts';

const config = headerConfig();
const CONNECTED: ConnectionInfo = { phase: 'connected', haState: 'RUNNING' };

async function mountBanner(alarm: string, connection: ConnectionInfo = CONNECTED, storeOptions: FakeStoreOptions = {}) {
  const store = fakeStore([testEntity(ALARM, alarm), testEntity(POLICY, 'Auto')], storeOptions);
  const banner = document.createElement('agr-alert-banner') as AgrAlertBanner;
  banner.services = testServices(config, store, { connection: () => connection });
  const mounted = mountInContainer(banner);
  await settle();
  const root = banner.shadowRoot as ShadowRoot;
  return {
    ...mounted,
    alert: root.querySelector('[role="alert"]') as HTMLElement,
    status: root.querySelector('[role="status"]') as HTMLElement,
  };
}

describe('agr-alert-banner (§9.1)', () => {
  it('keeps both live regions in the DOM and takes no space when there is nothing to say', async () => {
    const { element, alert, status } = await mountBanner('disarmed');
    expect(alert.children).toHaveLength(0);
    expect(status.children).toHaveLength(0);
    expect(element.hasAttribute('data-empty')).toBe(true);
  });

  it('shows the disconnected banner as a polite status in danger styling', async () => {
    const { element, status, alert } = await mountBanner('disarmed', { phase: 'disconnected' }, { connected: false });
    expect(element.hasAttribute('data-empty')).toBe(false);
    expect(alert.children).toHaveLength(0);
    expect(status.querySelector('.banner')?.getAttribute('data-tone')).toBe('danger');
    expect(shadowText(status)).toBe(
      'Connection to Home Assistant lost. Showing last known values. Controls are paused until it reconnects.',
    );
  });

  it('shows "Reconnecting" during the resync barrier', async () => {
    const { status } = await mountBanner('disarmed', { phase: 'resyncing' }, { connected: false, resyncing: true });
    expect(shadowText(status)).toBe(
      'Reconnecting to Home Assistant. Showing last known values until current states arrive.',
    );
  });

  it('shows the starting banner while HA starts', async () => {
    const { status } = await mountBanner('disarmed', { phase: 'connected', haState: 'STARTING' });
    expect(shadowText(status)).toBe('Home Assistant is starting. Some devices may show as unavailable.');
  });

  it('raises a live triggered alarm in role="alert" with an Open Security button', async () => {
    const { alert, drawerRequests } = await mountBanner('triggered');
    // The title and the button say it all: no sentence repeating the button, and no cause (§16.14).
    expect(alert.querySelector('p')?.textContent?.trim()).toBe('Alarm triggered.');
    const button = alert.querySelector('agr-button');
    expect(button?.label).toBe('Open Security');
    button?.shadowRoot?.querySelector('button')?.click();
    expect(drawerRequests).toEqual(['security']);
  });

  it('never claims a stale triggered alarm; the connection banner explains instead', async () => {
    const { alert, status } = await mountBanner('triggered', { phase: 'disconnected' }, { connected: false });
    expect(alert.children).toHaveLength(0);
    expect(shadowText(status)).toContain('Connection to Home Assistant lost.');
  });

  it('shows nothing while loading', async () => {
    const { element } = await mountBanner('triggered', { phase: 'loading' }, { ready: false });
    expect(element.hasAttribute('data-empty')).toBe(true);
  });

  it('appears and clears as the alarm entity changes', async () => {
    const live = liveStore(config, { [ALARM]: 'armed_away', [POLICY]: 'Auto' });
    const banner = document.createElement('agr-alert-banner') as AgrAlertBanner;
    banner.services = testServices(config, live.store);
    mountInContainer(banner);
    await settle();
    const alert = banner.shadowRoot?.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.children).toHaveLength(0);
    live.set(ALARM, 'triggered');
    await settle();
    expect(alert.children).toHaveLength(1);
    live.set(ALARM, 'disarmed');
    await settle();
    expect(alert.children).toHaveLength(0);
  });
});
