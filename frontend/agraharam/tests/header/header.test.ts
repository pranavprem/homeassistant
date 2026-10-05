import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/header/agr-header.ts';
import type { AgrHeader } from '../../src/components/header/agr-header.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import type { ConnectionInfo } from '../../src/ha/host.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { fakeStore, testEntity } from '../helpers/fake-store.ts';
import { liveStore } from '../helpers/live-store.ts';
import { mountCard } from '../helpers/mount.ts';
import {
  ALARM,
  ARUN,
  headerConfig,
  laFormatter,
  MEERA,
  mountInContainer,
  POLICY,
  shadowText,
  testServices,
  type ReaderOptions,
} from './support.ts';

const config = headerConfig();

function shadowOf(element: Element): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

async function mountHeader(services: DashboardServices | undefined) {
  const header = document.createElement('agr-header') as AgrHeader;
  if (services !== undefined) header.services = services;
  const mounted = mountInContainer(header);
  await settle();
  return mounted;
}

function storeWith(states: Readonly<Record<string, string>>, options = {}): StoreView {
  return fakeStore(
    Object.entries(states).map(([id, state]) => testEntity(id, state)),
    options,
  );
}

const NORMAL = { [MEERA]: 'home', [ARUN]: 'not_home', [ALARM]: 'armed_away', [POLICY]: 'Auto' };

async function headerFor(states = NORMAL, storeOptions = {}, readerOptions: ReaderOptions = {}) {
  return mountHeader(testServices(config, storeWith(states, storeOptions), readerOptions));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agr-header identity (§6.4)', () => {
  it('renders the title as the card h1 and the kolam mark as decoration', async () => {
    const { element } = await headerFor();
    const root = element.shadowRoot as ShadowRoot;
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(root.querySelector('h1')?.textContent).toBe('Agraharam');
    expect(root.querySelector('agr-kolam-mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.greeting')?.textContent).toMatch(/^Good (morning|afternoon|evening)$/);
  });

  it('paints the kolam in brass through the SVG, never as a text color', () => {
    const styles = (customElements.get('agr-kolam-mark') as unknown as { elementStyles: { cssText: string }[] })
      .elementStyles;
    const css = styles.map((style) => style.cssText).join('\n');
    expect(css).toMatch(/stroke:\s*var\(--agr-brass\)/);
    expect(css).toMatch(/fill:\s*var\(--agr-brass\)/);
    expect(css).not.toMatch(/(^|[^-])color:\s*var\(--agr-brass\)/);
  });

  it('shows the title and a skeleton before services carry a store', async () => {
    const { element } = await mountHeader({ config: { title: 'Preview home' } } as DashboardServices);
    const root = element.shadowRoot as ShadowRoot;
    expect(root.querySelector('h1')?.textContent).toBe('Preview home');
    expect(root.querySelector('.skeleton[aria-hidden="true"]')).not.toBeNull();
    // The pill's and the clock's shapes hold the header's composition, and say nothing to assistive technology.
    expect(root.querySelector('.status .pill-ghost')).not.toBeNull();
    expect(root.querySelector('.clock-ghost')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('agr-clock')).toBeNull();
  });
});

describe('agr-header presence (§6.4, WCAG 1.4.1)', () => {
  it('shows only Home, Away or Unknown, never a zone name', async () => {
    const { element } = await headerFor({ ...NORMAL, [MEERA]: 'Grandmother house', [ARUN]: 'unavailable' });
    const labels = deepQueryAll(shadowOf(element), 'agr-presence').map(
      (el) => el.shadowRoot?.querySelector('.state')?.textContent,
    );
    expect(labels).toEqual(['Away', 'Unknown']);
    expect(shadowText(element)).not.toContain('Grandmother');
  });

  it('carries the state by ring style and badge as well as text, and names each person for screen readers', async () => {
    const { element } = await headerFor({ ...NORMAL, [ARUN]: 'unknown' });
    const presences = deepQueryAll(shadowOf(element), 'agr-presence');
    const meera = presences[0]?.shadowRoot as ShadowRoot;
    const arun = presences[1]?.shadowRoot as ShadowRoot;
    expect(meera.querySelector('.avatar')?.getAttribute('data-presence')).toBe('home');
    expect(meera.querySelector('.avatar .badge')).not.toBeNull();
    expect(meera.querySelector('.visually-hidden')?.textContent).toContain('Meera');
    expect(arun.querySelector('.avatar')?.getAttribute('data-presence')).toBe('unknown');
    expect(arun.querySelector('.badge')?.textContent).toBe('?');
    const away = await headerFor();
    const arunAway = deepQueryAll(shadowOf(away.element), 'agr-presence')[1]?.shadowRoot as ShadowRoot;
    expect(arunAway.querySelector('.avatar')?.getAttribute('data-presence')).toBe('away');
    expect(arunAway.querySelector('.badge')).toBeNull();
  });

  it('keeps presence display only: nothing in it is focusable', async () => {
    const { element } = await headerFor();
    for (const presence of deepQueryAll(shadowOf(element), 'agr-presence')) {
      expect(presence.shadowRoot?.querySelector('button, [tabindex], a')).toBeNull();
    }
  });
});

describe('agr-header security pill (§6.4, §8.1)', () => {
  function pill(element: Element) {
    return deepQuery(shadowOf(element), 'agr-security-pill')?.shadowRoot as ShadowRoot;
  }

  it('shows the actual alarm state on line one and the policy as a separate element', async () => {
    const { element } = await headerFor();
    const root = pill(element);
    expect(root.querySelector('.label')?.textContent).toBe('Armed away');
    expect(root.querySelector('.policy')?.textContent).toBe('Policy: Auto');
    expect(root.querySelector('.label')?.textContent).not.toContain('Auto');
  });

  it('never reads Armed while the alarm is disarmed under an Auto policy', async () => {
    const { element } = await headerFor({ ...NORMAL, [ALARM]: 'disarmed' });
    expect(pill(element).querySelector('.label')?.textContent).toBe('Disarmed');
    expect(shadowText(pill(element))).not.toMatch(/\bArmed\b/);
  });

  it.each([
    ['disconnected', { connected: false }],
    ['resyncing', { connected: false, resyncing: true }],
  ])('while %s shows the last known label plus a separate "Last known" line', async (_phase, storeOptions) => {
    const { element } = await headerFor({ ...NORMAL, [ALARM]: 'armed_vacation' }, storeOptions);
    const root = pill(element);
    expect(root.querySelector('.label')?.textContent).toBe('Armed vacation');
    expect(root.querySelector('.stale')?.textContent).toBe('Last known');
    expect(root.querySelector('.policy')).toBeNull();
  });

  it('keeps the full label for the longest state ("Alarm state unknown"), never truncated', async () => {
    const { element } = await headerFor({ ...NORMAL, [ALARM]: 'unknown' });
    expect(pill(element).querySelector('.label')?.textContent).toBe('Alarm state unknown');
  });

  it('opens the security drawer with the pill button as the trigger', async () => {
    const { element, drawerRequests, triggers } = await headerFor();
    const button = pill(element).querySelector('button') as HTMLButtonElement;
    button.click();
    expect(drawerRequests).toEqual(['security']);
    expect(triggers[0]).toBe(button);
    expect(button.getAttribute('data-focus-key')).toBe('header:security');
  });

  it('renders no pill without a security config', async () => {
    const services = testServices(headerConfig({ security: undefined }), storeWith(NORMAL));
    const { element } = await mountHeader(services);
    expect(deepQuery(shadowOf(element), 'agr-security-pill')).toBeNull();
  });
});

describe('agr-header connection indicator (§9.1)', () => {
  function indicatorText(element: Element): string | null | undefined {
    return deepQuery(shadowOf(element), 'agr-connection-indicator')?.shadowRoot?.querySelector('.label')?.textContent;
  }

  it.each([
    [{ phase: 'connected', haState: 'RUNNING' }, 'hass', 'Connected'],
    [{ phase: 'resyncing' }, 'hass', 'Reconnecting'],
    [{ phase: 'disconnected' }, 'hass', 'Disconnected'],
    [{ phase: 'connected', haState: 'STARTING' }, 'hass', 'Starting'],
    [{ phase: 'connected', haState: 'RUNNING' }, 'demo', 'Demo'],
  ] as const)('%o (%s) reads %j', async (info, kind, label) => {
    const { element } = await headerFor(NORMAL, {}, { connection: () => info as ConnectionInfo, kind });
    expect(indicatorText(element)).toBe(label);
  });

  it('shows skeletons for presence and the pill while loading', async () => {
    const { element } = await headerFor(NORMAL, { ready: false }, { connection: () => ({ phase: 'loading' }) });
    expect(deepQuery(shadowOf(element), 'agr-presence')).toBeNull();
    expect(deepQuery(shadowOf(element), 'agr-security-pill')).toBeNull();
    expect(element.shadowRoot?.querySelector('.status .skeleton')).not.toBeNull();
    expect(indicatorText(element)).toBe('Connecting');
  });
});

describe('agr-header diagnostics and menu (§6.4)', () => {
  it('offers diagnostics only to admins with diagnostics enabled, and opens the drawer', async () => {
    const { element, drawerRequests } = await headerFor(NORMAL, {}, { admin: true });
    const button = element.shadowRoot?.querySelector('.diagnostics') as HTMLElement;
    expect(button).not.toBeNull();
    button.shadowRoot?.querySelector('button')?.click();
    expect(drawerRequests).toEqual(['diagnostics']);

    const nonAdmin = await headerFor(NORMAL, {}, { admin: false });
    expect(nonAdmin.element.shadowRoot?.querySelector('.diagnostics')).toBeNull();
    const disabled = await mountHeader(testServices(headerConfig({ diagnostics: false }), storeWith(NORMAL)));
    expect(disabled.element.shadowRoot?.querySelector('.diagnostics')).toBeNull();
  });

  it('always renders the menu button (shown by CSS in compact) and opens the household drawer', async () => {
    const { element, drawerRequests } = await headerFor(NORMAL, {}, { admin: false });
    const menu = element.shadowRoot?.querySelector('.menu') as HTMLElement;
    expect(menu).not.toBeNull();
    menu.shadowRoot?.querySelector('button')?.click();
    expect(drawerRequests).toEqual(['household']);
  });
});

describe('agr-header clock (§9.1: minute-aligned through the store clock meta)', () => {
  function clockText(element: Element): string {
    const clock = deepQuery(shadowOf(element), 'agr-clock')?.shadowRoot;
    return (clock?.querySelector('.time')?.textContent ?? '').replace(/\s+/g, '');
  }

  it('re-renders on a clock tick with no entity change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T17:51:30-07:00'));
    const live = liveStore(config, NORMAL);
    const { element } = await mountHeader(testServices(config, live.store));
    expect(clockText(element)).toBe('5:51PM');
    vi.setSystemTime(new Date('2026-09-30T17:52:00-07:00'));
    await settle();
    expect(clockText(element)).toBe('5:51PM');
    live.store.tick();
    await settle();
    expect(clockText(element)).toBe('5:52PM');
  });

  it('formats with the profile: 24-hour and the server time zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T17:51:00-07:00'));
    const formatter = laFormatter({ language: 'en-GB', time_format: '24' }, 'Europe/Berlin');
    const { element } = await headerFor(NORMAL, {}, { formatter });
    expect(clockText(element)).toBe('2:51');
    expect(deepQuery(shadowOf(element), 'agr-clock')?.shadowRoot?.querySelector('.period')).toBeNull();
  });
});

describe('agr-header error containment (§4.9)', () => {
  it('a throwing selector input is logged by code and the title still renders', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = storeWith(NORMAL);
    const broken = { ...testServices(config, store), reader: { ...testServices(config, store).reader } };
    broken.reader.formatter = () => {
      throw new Error('boom');
    };
    const { element } = await mountHeader(broken);
    expect(element.shadowRoot?.querySelector('h1')?.textContent).toBe('Agraharam');
    expect(error).toHaveBeenCalledWith('[agraharam]', 'header-select-failed');
  });

  it('renders runtime names as text, never markup', async () => {
    const hostile = headerConfig({ people: [{ entity: MEERA, name: '<img src=x onerror=alert(1)>' }] });
    const { element } = await mountHeader(testServices(hostile, storeWith(NORMAL)));
    expect(deepQueryAll(shadowOf(element), 'img')).toHaveLength(0);
    expect(shadowText(element)).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('people fixture through the demo card (§10.2)', () => {
  async function presenceLabels(scenario: string): Promise<{ labels: string[]; text: string }> {
    const { root } = await mountCard({ config: { demo: true, demo_scenario: scenario } });
    const header = root.querySelector('agr-header') as HTMLElement;
    const labels = deepQueryAll(shadowOf(header), 'agr-presence').map(
      (el) => el.shadowRoot?.querySelector('.state')?.textContent ?? '',
    );
    return { labels, text: shadowText(header) };
  }

  it('degraded shows a zone name as Away and an unavailable person as Unknown', async () => {
    const { labels, text } = await presenceLabels('degraded');
    expect(labels).toEqual(['Home', 'Away', 'Unknown']);
    expect(text).not.toContain('Studio');
  });

  it('normal shows two people; dense four; empty none', async () => {
    expect((await presenceLabels('normal')).labels).toEqual(['Home', 'Away']);
    expect((await presenceLabels('dense')).labels).toHaveLength(4);
    expect((await presenceLabels('empty')).labels).toEqual([]);
  });

  it('restricted (non-admin) hides diagnostics even though the card enables it', async () => {
    const admin = await mountCard({ config: { demo: true, diagnostics: true } });
    expect(admin.root.querySelector('agr-header')?.shadowRoot?.querySelector('.diagnostics')).not.toBeNull();
    const restricted = await mountCard({ config: { demo: true, demo_scenario: 'restricted', diagnostics: true } });
    expect(restricted.root.querySelector('agr-header')?.shadowRoot?.querySelector('.diagnostics')).toBeNull();
  });

  it("demo mode follows the card's own title and diagnostics flag (§4.2 rule 9)", async () => {
    const off = await mountCard({ config: { demo: true, title: 'Our home' } });
    const header = () => off.root.querySelector('agr-header')?.shadowRoot;
    expect(header()?.querySelector('h1')?.textContent).toContain('Our home');
    expect(header()?.querySelector('.diagnostics')).toBeNull();
    expect(off.services()?.config).toMatchObject({ title: 'Our home', diagnostics: false, controls: true });
  });
});
