import { describe, expect, it } from 'vitest';
import '../../src/components/health/agr-health.ts';
import '../../src/components/health/agr-health-drawer.ts';
import type { AgrHealth } from '../../src/components/health/agr-health.ts';
import type { AgrHealthDrawer } from '../../src/components/health/agr-health-drawer.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import { deepQueryAll, settle } from '../helpers/dom.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { liveStore } from '../helpers/live-store.ts';
import { configFrom } from '../helpers/services.ts';
import { mountInContainer, shadowText, testServices } from '../header/support.ts';

const LIGHTS = ['light.demo_lamp_one', 'light.demo_lamp_two', 'light.demo_lamp_three', 'light.demo_lamp_four'];
const FRONT = 'binary_sensor.demo_front_door';
const BACK = 'binary_sensor.demo_back_door';
const config = configFrom({
  rooms: [{ name: 'Courtyard', lights: LIGHTS }],
  security: {
    alarm: 'alarm_control_panel.demo_home',
    policy: 'input_select.demo_security_policy',
    perimeter: [
      { entity: FRONT, name: 'Front door' },
      { entity: BACK, name: 'Back door' },
    ],
  },
});

function storeWith(states: Readonly<Record<string, string>>, options: FakeStoreOptions = {}): StoreView {
  const named = (id: string) => ({ friendly_name: id.replace('light.demo_', '').replace('_', ' ') });
  return fakeStore(
    Object.entries(states).map(([id, state]) => testEntity(id, state, named(id))),
    options,
  );
}

const GOOD = {
  ...Object.fromEntries(LIGHTS.map((id) => [id, 'on'])),
  'alarm_control_panel.demo_home': 'disarmed',
  [FRONT]: 'off',
  [BACK]: 'off',
};

async function mountPanel(store: StoreView) {
  const panel = document.createElement('agr-health') as AgrHealth;
  panel.services = testServices(config, store);
  const mounted = mountInContainer(panel);
  await settle();
  return { ...mounted, root: panel.shadowRoot as ShadowRoot };
}

describe('agr-health panel', () => {
  it('is a quiet House panel with counted facts and a Details button', async () => {
    const { root } = await mountPanel(storeWith(GOOD));
    const panel = root.querySelector('agr-panel');
    expect(panel?.getAttribute('surface')).toBe('quiet');
    expect(panel?.heading).toBe('House');
    const facts = [...root.querySelectorAll('.fact')].map((fact) => shadowText(fact));
    expect(facts).toEqual(['2 of 2 monitored entry points closed', '7 of 7 devices reporting']);
    expect(root.querySelector('agr-button')?.label).toBe('Details');
    expect(root.querySelector('.problems')).toBeNull();
  });

  it('opens the health drawer from Details', async () => {
    const { root, drawerRequests } = await mountPanel(storeWith(GOOD));
    root.querySelector('agr-button')?.shadowRoot?.querySelector('button')?.click();
    expect(drawerRequests).toEqual(['health']);
  });

  it('names at most three problems, open entry points first, then counts the rest', async () => {
    const { root } = await mountPanel(
      storeWith({
        ...GOOD,
        [BACK]: 'on',
        [LIGHTS[0] as string]: 'unavailable',
        [LIGHTS[1] as string]: 'unknown',
        [LIGHTS[2] as string]: 'unavailable',
      }),
    );
    const rows = [...root.querySelectorAll('.problem')].map((row) => shadowText(row));
    expect(rows).toEqual(['Back door Open', 'lamp one Unavailable', 'lamp two Unknown']);
    expect(root.querySelector('.more')?.textContent).toBe('1 more in Details');
  });

  it('shows two placeholder stat rows while loading and the paused sentence while disconnected', async () => {
    const loading = await mountPanel(storeWith(GOOD, { ready: false }));
    // The loading shell has the loaded panel's two stat rows, hidden from assistive technology (§6.2.1).
    expect(loading.root.querySelectorAll('.fact-ghost')).toHaveLength(2);
    expect(loading.root.querySelector('.summary')?.getAttribute('aria-hidden')).toBe('true');
    expect(loading.root.querySelector('agr-button')).toBeNull();
    const paused = await mountPanel(storeWith(GOOD, { connected: false }));
    // The banner carries "Paused while Home Assistant is disconnected."; the panel shows a pill and one short line.
    expect(paused.root.querySelector('.paused')?.textContent).toBe('Counts resume when Home Assistant reconnects.');
    expect(paused.root.querySelector('agr-panel')?.pill).toEqual({ label: 'Offline', tone: 'muted', icon: 'wifi-off' });
    expect(paused.root.querySelector('.fact')).toBeNull();
  });

  it('updates when a monitored entry point opens', async () => {
    const live = liveStore(config, GOOD);
    const { root } = await mountPanel(live.store);
    live.set(FRONT, 'on');
    await settle();
    expect(shadowText(root.querySelector('.fact') as Element)).toBe('1 of 2 monitored entry points closed');
  });

  it('renders hostile friendly names as text', async () => {
    const hostile = fakeStore([
      ...Object.entries(GOOD).map(([id, state]) => testEntity(id, state)),
      testEntity(LIGHTS[0] as string, 'unavailable', { friendly_name: '<img src=x onerror=alert(1)>' }),
    ]);
    const { root } = await mountPanel(hostile);
    expect(deepQueryAll(root, 'img')).toHaveLength(0);
    expect(shadowText(root)).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('agr-health-drawer (§5.3)', () => {
  async function mountDrawer(store: StoreView) {
    const drawer = document.createElement('agr-health-drawer') as AgrHealthDrawer;
    drawer.services = testServices(config, store, { mode: 'demo' });
    drawer.request = { id: 'health' };
    mountInContainer(drawer);
    await settle();
    return drawer.shadowRoot as ShadowRoot;
  }

  it('lists entry points, then devices not reporting, then reporting, each by name with its status', async () => {
    const root = await mountDrawer(storeWith({ ...GOOD, [BACK]: 'on', [LIGHTS[0] as string]: 'unavailable' }));
    expect(root.querySelector('agr-drawer')?.heading).toBe('House health');
    const groups = [...root.querySelectorAll('.group')].map((group) => group.querySelector('h3')?.textContent);
    expect(groups).toEqual(['Monitored entry points', 'Not reporting (1)', 'Reporting (6)']);
    const entryRows = [...(root.querySelector('.group')?.querySelectorAll('.row') ?? [])].map((row) => shadowText(row));
    expect(entryRows).toEqual(['Front door Closed', 'Back door Open']);
    expect(shadowText(root)).toContain('lamp one Unavailable');
    expect(shadowText(root)).toContain('It is not a full system check.');
    expect(shadowText(root)).toContain('A camera picture is not a monitored entry point.');
  });

  it('collapses the healthy devices behind a disclosure, by name only; problems are never collapsed', async () => {
    const root = await mountDrawer(storeWith({ ...GOOD, [LIGHTS[0] as string]: 'unavailable' }));
    const details = root.querySelector('[aria-labelledby="health-reporting"] details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent?.trim()).toBe('Show all 6');
    expect(details?.querySelectorAll('.row')).toHaveLength(6);
    expect(details?.querySelectorAll('.row .value')).toHaveLength(0);
    const notReporting = root.querySelector('[aria-labelledby="health-not-reporting"]');
    expect(notReporting?.querySelector('details')).toBeNull();
    expect(shadowText(notReporting as Element)).toContain('lamp one Unavailable');
  });

  it('opens with the same headline the panel shows', async () => {
    const root = await mountDrawer(storeWith(GOOD));
    expect(root.querySelector('.lead')?.textContent).toBe(
      '2 of 2 monitored entry points closed. 7 of 7 devices reporting.',
    );
  });

  it.each([
    ['disconnected', { connected: false }],
    ['resyncing', { connected: false, resyncing: true }],
  ])('while %s, lists monitored devices by name only and no Not reporting group', async (_, options) => {
    const root = await mountDrawer(storeWith(GOOD, options));
    const headings = [...root.querySelectorAll('h3')].map((heading) => heading.textContent);
    expect(headings).toEqual(['Monitored entry points', 'Monitored devices (7)']);
    expect(shadowText(root)).not.toMatch(/Not reporting|Unknown|Reporting/);
    const deviceGroup = root.querySelector('[aria-labelledby="health-monitored"]') as Element;
    expect(deviceGroup.querySelectorAll('.row .value')).toHaveLength(0);
    const entryValues = [...root.querySelectorAll('[aria-labelledby="health-entry-points"] .value')];
    expect(entryValues.map((value) => [value.textContent, value.getAttribute('data-tone')])).toEqual([
      ['Offline', 'muted'],
      ['Offline', 'muted'],
    ]);
    expect(shadowText(root)).toContain('It is not a full system check.');
  });

  it('an open drawer drops per-device status the moment the connection drops, and restores it on reconnect', async () => {
    const live = liveStore(config, GOOD);
    const root = await mountDrawer(live.store);
    const headings = () => [...root.querySelectorAll('h3')].map((heading) => heading.textContent);
    expect(headings()).toEqual(['Monitored entry points', 'Reporting (7)']);
    live.setConnected(false);
    await settle();
    expect(headings()).toEqual(['Monitored entry points', 'Monitored devices (7)']);
    expect(root.querySelector('.lead')?.textContent).toContain('Paused while Home Assistant is disconnected.');
    live.setConnected(true);
    await settle();
    expect(headings()).toEqual(['Monitored entry points', 'Reporting (7)']);
  });

  it('lists devices still loading while HA starts, never as Not found', async () => {
    const rest = Object.fromEntries(Object.entries(GOOD).filter(([id]) => id !== LIGHTS[3]));
    const root = await mountDrawer(storeWith(rest, { haState: 'STARTING' }));
    const headings = [...root.querySelectorAll('h3')].map((heading) => heading.textContent);
    expect(headings).toContain('Still loading (1)');
    expect(shadowText(root)).not.toContain('Not found');
  });
});
