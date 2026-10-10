/**
 * The Sky panel, drawer and radar (AIRSPACE.md §4–§6, ARCHITECTURE.md §19): every panel status and the selector
 * failure line, Details as always-enabled read-only navigation, the drawer's views, sorts, search (kept while it holds
 * text) and Escape, keyed disclosure rows, focus recovery for every control that can disappear, radar marks as live
 * positions, label placement clear of the marks, the outbound links and their demo hiding, sources, escaping, and the
 * sky clock's liveness bounds with no entity update ever arriving. Fixtures are the fictional builders from
 * src/demo/fixtures/sky.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/sky/agr-sky.ts';
import '../../src/components/sky/agr-sky-drawer.ts';
import type { AgrSky } from '../../src/components/sky/agr-sky.ts';
import type { AgrSkyDrawer } from '../../src/components/sky/agr-sky-drawer.ts';
import type { AgrSkyRadar } from '../../src/components/sky/agr-sky-radar.ts';
import { SKY_TICK_MS } from '../../src/components/sky/sky-clock.ts';
import type { DrawerRequest } from '../../src/components/shell/overlay-types.ts';
import type { AgrChoiceGroup } from '../../src/components/primitives/agr-choice-group.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { DEMO_SKY_AIRSPACE, skyAttributes, type SkyFixtureKind } from '../../src/demo/fixtures/sky.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import { SKY_SOURCES } from '../../src/model/airspace.ts';
import type { RadarMarkVM, RadarRingVM, RadarVM } from '../../src/model/radar.ts';
import { deepActive, deepQueryAll, settle } from '../helpers/dom.ts';
import { fakeStore } from '../helpers/fake-store.ts';
import { liveStore, type LiveStore } from '../helpers/live-store.ts';
import { configFrom } from '../helpers/services.ts';
import { mountInContainer, PINNED_NOW, shadowText, testServices, type ReaderOptions } from '../header/support.ts';

const config = configFrom({ airspace: { entity: DEMO_SKY_AIRSPACE } });
const weatherConfig = configFrom({ airspace: { entity: DEMO_SKY_AIRSPACE }, weather: 'weather.demo_home' });
/** The fixture's nearest aircraft, overhead with a reported route. */
const NEAREST = '001a2b';
const AIRCRAFT_LINK_RE = /^https:\/\/globe\.adsb\.lol\/\?icao=[0-9a-f]{6}$/;
/** The fixture builders date their snapshot this long before their clock (FRESH_UPDATE_MIN). */
const FIXTURE_LEAD_MS = 15_000;

type SkyAttributes = Readonly<Record<string, unknown>>;

function attributes(kind: SkyFixtureKind, nowMs: number = Date.now()): SkyAttributes {
  return skyAttributes(kind, fixtureClock(nowMs));
}

function publish(live: LiveStore, payload: SkyAttributes): void {
  const aircraft = payload['aircraft'];
  live.set(DEMO_SKY_AIRSPACE, String(Array.isArray(aircraft) ? aircraft.length : 0), payload);
}

/** A notifying store holding the sky sensor with one fixture payload (or nothing, for `missing`). */
function skyStore(payload?: SkyAttributes, storeConfig = config): LiveStore {
  const live = liveStore(storeConfig, {});
  if (payload !== undefined) publish(live, payload);
  return live;
}

interface MountOptions extends ReaderOptions {
  readonly mode?: 'live' | 'demo';
  readonly preview?: boolean;
  readonly config?: typeof config;
}

async function mountPanel(store: StoreView, options: MountOptions = {}) {
  const panel = document.createElement('agr-sky') as AgrSky;
  const services = testServices(options.config ?? config, store, options);
  panel.services = { ...services, preview: options.preview ?? false };
  const mounted = mountInContainer(panel);
  await settle();
  return { ...mounted, panel, root: panel.shadowRoot as ShadowRoot };
}

async function mountDrawer(
  store: StoreView,
  request: Extract<DrawerRequest, { id: 'sky' }> = { id: 'sky' },
  options: MountOptions = {},
) {
  const drawer = document.createElement('agr-sky-drawer') as AgrSkyDrawer;
  drawer.services = testServices(options.config ?? config, store, options);
  drawer.request = request;
  mountInContainer(drawer);
  await settle();
  return { drawer, root: drawer.shadowRoot as ShadowRoot };
}

function text(root: ParentNode, selector: string): string {
  return (root.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function rowButton(root: ShadowRoot, key: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`button[data-focus-key="sky:aircraft:${key}"]`);
}

function rowKeys(root: ShadowRoot): string[] {
  return [...root.querySelectorAll('li.aircraft')].map((row) => row.getAttribute('data-key') ?? '');
}

async function choose(root: ShadowRoot, group: 'Show' | 'Sort', value: string): Promise<void> {
  const element = root.querySelector<AgrChoiceGroup>(`agr-choice-group[label="${group}"]`);
  const prefix = group === 'Show' ? 'sky:view' : 'sky:sort';
  element?.shadowRoot?.querySelector<HTMLButtonElement>(`button[data-focus-key="${prefix}:${value}"]`)?.click();
  await settle();
}

function choiceButton(root: ShadowRoot, focusKey: string): HTMLButtonElement | null {
  return deepQueryAll<HTMLButtonElement>(root, `button[data-focus-key="${focusKey}"]`)[0] ?? null;
}

function searchInput(root: ShadowRoot): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('input[type="search"]');
}

async function typeSearch(root: ShadowRoot, value: string): Promise<void> {
  const input = searchInput(root) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await settle();
}

async function clickMark(root: ShadowRoot, key: string): Promise<void> {
  const radar = root.querySelector('agr-sky-radar')?.shadowRoot;
  radar?.querySelector(`g.aircraft[data-key="${key}"] .hit`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
}

/** The payload with only its first `count` nearby aircraft (nearest first). */
function firstNearby(payload: SkyAttributes, count: number): SkyAttributes {
  return { ...payload, aircraft: (payload['aircraft'] as readonly unknown[]).slice(0, count) };
}

function choiceLabels(root: ShadowRoot, group: 'Show' | 'Sort'): string[] {
  const element = root.querySelector<AgrChoiceGroup>(`agr-choice-group[label="${group}"]`);
  return (element?.options ?? []).map((option) => `${option.label}${option.pressed ? ' (pressed)' : ''}`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agr-sky panel (§11.1)', () => {
  it('renders nothing when no airspace entity is configured', async () => {
    const { root } = await mountPanel(fakeStore([]), { config: configFrom({}) });
    expect(root.querySelector('agr-panel')).toBeNull();
  });

  it('live: the serif count beside its label, the meta line, and the nearest overhead aircraft', async () => {
    const { root } = await mountPanel(skyStore(attributes('normal')).store);
    const panel = root.querySelector('agr-panel');
    expect(panel?.heading).toBe('Sky');
    expect(panel?.getAttribute('surface')).toBe('raised');
    expect(panel?.pill).toBeUndefined();
    expect(panel?.hasAttribute('fit')).toBe(false);
    expect(text(root, '.count')).toBe('8');
    expect(root.querySelector('.count')?.classList.contains('t-value')).toBe(true);
    expect(text(root, '.count-label')).toMatch(/^aircraft within \d/);
    expect(text(root, '.meta')).toBe('Updated just now · 1 overhead');
    const nearest = root.querySelector('.nearest') as HTMLElement;
    expect(nearest.hasAttribute('data-overhead')).toBe(true);
    expect(text(nearest, '.callsign')).toBe('DEMO214');
    expect(text(nearest, '.type')).toBe('B738');
    expect(text(nearest, '.chip')).toBe('Overhead');
    expect(text(nearest, '.card-meta')).toMatch(/ft baro/);
    // The picture is hidden; assistive technology reads the accessible name.
    expect(nearest.querySelector('.card')?.getAttribute('aria-hidden')).toBe('true');
    expect(text(nearest, '.visually-hidden')).toMatch(/^Nearest: DEMO214, B738, .*feet barometric.*overhead$/);
  });

  it('empty: "0" with Quiet skies, no nearest aircraft', async () => {
    const { root } = await mountPanel(skyStore(attributes('empty')).store);
    expect(text(root, '.count')).toBe('0');
    expect(text(root, '.count-label')).toMatch(/^Quiet skies within \d/);
    expect(text(root, '.meta')).toBe('Updated just now');
    expect(root.querySelector('.nearest')).toBeNull();
  });

  it('stale: a Not live pill and the state line with the age, never a count or an aircraft', async () => {
    const { root } = await mountPanel(skyStore(attributes('degraded')).store);
    const panel = root.querySelector('agr-panel');
    expect(panel?.pill?.label).toBe('Not live');
    expect(panel?.hasAttribute('fit')).toBe(true);
    expect(text(root, '.state-line')).toBe('No fresh aircraft data');
    expect(text(root, '.state .meta')).toBe('Last update 7 min ago');
    expect(root.querySelector('.count')).toBeNull();
    expect(root.querySelector('.nearest')).toBeNull();
  });

  it('offline: the shared Offline pill over live data, which is no longer shown as live', async () => {
    const live = skyStore(attributes('normal'));
    const { root } = await mountPanel(live.store);
    live.setConnected(false);
    await settle();
    expect(root.querySelector('agr-panel')?.pill).toEqual({ label: 'Offline', tone: 'muted', icon: 'wifi-off' });
    expect(text(root, '.state-line')).toBe('Not live while Home Assistant is offline');
    expect(root.querySelector('.nearest')).toBeNull();
  });

  it.each([
    ['missing', undefined, undefined, 'Sky sensor not found'],
    ['unavailable', 'unavailable', {}, 'Aircraft data unavailable'],
    ['unsupported', '3', { schema_version: 2 }, 'Unsupported sky data'],
  ] as const)('%s: one honest state line', async (_status, state, payload, line) => {
    const live = liveStore(config, {});
    if (state !== undefined) live.set(DEMO_SKY_AIRSPACE, state, payload);
    const { root } = await mountPanel(live.store);
    expect(text(root, '.state-line')).toBe(line);
    expect(root.querySelector('.count, .nearest')).toBeNull();
  });

  it('loading: placeholders shaped like the loaded panel, hidden from assistive technology', async () => {
    const { root } = await mountPanel(fakeStore([], { ready: false }));
    expect(root.querySelector('.ghost-summary')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.nearest-ghost')).not.toBeNull();
    expect(root.querySelector('.count')).toBeNull();
  });

  it('a selector failure shows one calm line, not a skeleton that reads as loading forever', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = skyStore(attributes('normal')).store;
    const broken = testServices(config, store);
    const panel = document.createElement('agr-sky') as AgrSky;
    panel.services = {
      ...broken,
      reader: {
        ...broken.reader,
        formatter: () => {
          throw new Error('boom');
        },
      },
    };
    mountInContainer(panel);
    await settle();
    const root = panel.shadowRoot as ShadowRoot;
    expect(root.querySelector('.state')?.getAttribute('data-status')).toBe('failed');
    expect(text(root, '.state-line')).toBe("The sky couldn't be shown.");
    expect(root.querySelector('.ghost-summary, .nearest-ghost, .count')).toBeNull();
    expect(shadowText(root)).not.toContain('Loading the sky');
    expect(root.querySelector('agr-panel')?.hasAttribute('fit')).toBe(true);
    expect(root.querySelector('[data-focus-key="sky:details"]')).not.toBeNull();
    expect(error).toHaveBeenCalledWith('[agraharam]', 'sky-select-failed');
  });

  it('Details opens the drawer with the nearest aircraft selected', async () => {
    const { root, element } = await mountPanel(skyStore(attributes('normal')).store);
    const requests: DrawerRequest[] = [];
    element.addEventListener('agr-open-drawer', (event) => requests.push(event.detail.request));
    const details = root.querySelector<HTMLButtonElement>('[data-focus-key="sky:details"]') as HTMLButtonElement;
    expect(details.getAttribute('aria-label')).toBe('Sky details');
    expect(details.getAttribute('aria-haspopup')).toBe('dialog');
    expect(details.getAttribute('slot')).toBe('actions');
    details.click();
    expect(requests).toEqual([{ id: 'sky', select: NEAREST }]);
  });

  it('Details stays enabled with controls off, for a non-admin, in the editor preview, and while offline', async () => {
    const live = skyStore(attributes('normal'));
    const { root, drawerRequests, panel } = await mountPanel(live.store, { admin: false, preview: true });
    expect(panel.services?.config.controls).toBe(false);
    live.setConnected(false);
    await settle();
    const details = root.querySelector<HTMLButtonElement>('[data-focus-key="sky:details"]') as HTMLButtonElement;
    expect(details.hasAttribute('aria-disabled')).toBe(false);
    expect(details.disabled).toBe(false);
    details.click();
    expect(drawerRequests).toEqual(['sky']);
    expect(panel.services?.gateway).toBeDefined();
    expect((panel.services?.gateway as unknown as { calls: unknown[] }).calls).toEqual([]);
  });
});

describe('agr-sky-drawer (§12)', () => {
  it('opens with the selected aircraft expanded: captions, the reported route, and the tracking link', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store, { id: 'sky', select: NEAREST });
    expect(root.querySelector('agr-drawer')?.heading).toBe('Sky');
    const button = rowButton(root, NEAREST) as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const detail = root.getElementById(button.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(detail.hidden).toBe(false);
    // The detail follows its own row, inside the same list item.
    expect(button.nextElementSibling).toBe(detail);
    const captions = [...detail.querySelectorAll('dt')].map((dt) => dt.textContent?.trim());
    expect(captions).toEqual(expect.arrayContaining(['Barometric altitude', 'Ground track', 'From home']));
    expect(shadowText(detail)).toContain('Reported route · unverified · VRS via ADSB.lol');
    expect(text(detail, '.route-codes')).toBe('XAAA → XBBB');
    const link = detail.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`https://globe.adsb.lol/?icao=${NEAREST}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer external');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(shadowText(link)).toBe('Track on ADSB.lol , opens in a new tab');
    // Only one row is expanded.
    expect(root.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(1);
  });

  it('never renders the tracking link in demo mode, and no anchor ever targets the globe without one hex', async () => {
    const demo = await mountDrawer(
      skyStore(attributes('normal')).store,
      { id: 'sky', select: NEAREST },
      { mode: 'demo' },
    );
    expect(deepQueryAll(demo.root, 'a[href*="globe"]')).toEqual([]);
    const live = await mountDrawer(skyStore(attributes('dense')).store, { id: 'sky', select: '001000' });
    const allowed = new Set(SKY_SOURCES.map((source) => source.href));
    for (const anchor of deepQueryAll<HTMLAnchorElement>(document.body, 'a[href]')) {
      const href = anchor.getAttribute('href') ?? '';
      expect(allowed.has(href) || AIRCRAFT_LINK_RE.test(href), href).toBe(true);
    }
    expect(deepQueryAll(live.root, 'a[href*="globe"]')).toHaveLength(1);
  });

  it('lists the two constant sources and the payload attribution', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store);
    const other = await mountDrawer(skyStore(attributes('normal')).store);
    // Each drawer names its Sources heading with its own id prefix, as it does Conditions.
    const headings = [root, other.root].map((drawerRoot) => {
      const section = drawerRoot.querySelector('.source-links')?.closest('section') as HTMLElement;
      const id = section.getAttribute('aria-labelledby') ?? '';
      expect(drawerRoot.getElementById(id)?.textContent).toBe('Sources');
      return id;
    });
    expect(headings[0]).toMatch(/^agr-sky-\d+-sources$/);
    expect(headings[0]).not.toBe(headings[1]);
    const links = [...root.querySelectorAll<HTMLAnchorElement>('.source-links a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(SKY_SOURCES.map((source) => source.href));
    for (const link of links) {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer external');
      expect(shadowText(link)).toMatch(/, opens in a new tab$/);
    }
    expect(text(root, '.attribution')).toMatch(/^Aircraft positions: ADSB\.lol/);
  });

  it('switches views and sorts: Latest only in Recent, where it is the default', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store);
    expect(choiceLabels(root, 'Show')).toEqual(['Nearby 8 (pressed)', 'Overhead 1', 'Recent 3']);
    expect(choiceLabels(root, 'Sort')).toEqual(['Distance (pressed)', 'Altitude', 'Name']);
    expect(rowKeys(root)).toHaveLength(8);
    await choose(root, 'Show', 'overhead');
    expect(rowKeys(root)).toEqual([NEAREST]);
    await choose(root, 'Show', 'recent');
    expect(choiceLabels(root, 'Sort')).toEqual(['Latest (pressed)', 'Distance', 'Altitude', 'Name']);
    expect(rowKeys(root)).toHaveLength(3);
    expect(text(root, '.footnotes')).toMatch(/Fast flyovers can be missed/);
    await choose(root, 'Sort', 'name');
    expect(choiceLabels(root, 'Sort')).toContain('Name (pressed)');
    await choose(root, 'Show', 'nearby');
    expect(choiceLabels(root, 'Sort')).toContain('Name (pressed)');
  });

  it('re-sorting keeps focus on the same aircraft', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store);
    const keys = rowKeys(root);
    const focusedKey = keys[3] as string;
    rowButton(root, focusedKey)?.focus();
    // The group's own event, so focus stays on the row while the list re-orders under it.
    const sort = root.querySelector<AgrChoiceGroup>('agr-choice-group[label="Sort"]');
    sort?.dispatchEvent(new CustomEvent('agr-choose', { detail: { value: 'altitude' } }));
    await settle();
    expect(rowKeys(root)).not.toEqual(keys);
    expect(deepActive()?.getAttribute('data-focus-key')).toBe(`sky:aircraft:${focusedKey}`);
  });

  it('moves focus to the next row when the focused row disappears, then the previous, then the heading', async () => {
    const now = Date.now();
    const live = skyStore(attributes('normal', now));
    const { root } = await mountDrawer(live.store);
    const keys = rowKeys(root);
    const gone = keys[2] as string;
    rowButton(root, gone)?.focus();
    expect(deepActive()).toBe(rowButton(root, gone));
    const payload = attributes('normal', now);
    const without = (hexes: readonly string[]): SkyAttributes => ({
      ...payload,
      aircraft: (payload['aircraft'] as readonly { hex: string }[]).filter((row) => !hexes.includes(row.hex)),
    });
    publish(live, without([gone]));
    await settle();
    expect(deepActive()?.getAttribute('data-focus-key')).toBe(`sky:aircraft:${keys[3]}`);
    // The last row: focus falls back to the previous one.
    const last = keys[keys.length - 1] as string;
    rowButton(root, last)?.focus();
    publish(live, without([gone, last]));
    await settle();
    expect(deepActive()?.getAttribute('data-focus-key')).toBe(`sky:aircraft:${keys[keys.length - 2]}`);
    // The whole list goes: focus returns to the drawer heading, never to the page.
    publish(live, attributes('empty', now));
    await settle();
    expect(rowKeys(root)).toEqual([]);
    expect(deepActive()?.tagName).toBe('H2');
  });

  it('an expanded aircraft that leaves the view collapses silently', async () => {
    const now = Date.now();
    const live = skyStore(attributes('normal', now));
    const { root } = await mountDrawer(live.store, { id: 'sky', select: NEAREST });
    expect(rowButton(root, NEAREST)?.getAttribute('aria-expanded')).toBe('true');
    const payload = attributes('normal', now);
    publish(live, {
      ...payload,
      aircraft: (payload['aircraft'] as readonly { hex: string }[]).filter((row) => row.hex !== NEAREST),
    });
    await settle();
    expect(rowButton(root, NEAREST)).toBeNull();
    publish(live, payload);
    await settle();
    expect(rowButton(root, NEAREST)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('searches from 16 rows; Escape clears a non-empty search first and refuses that one close request', async () => {
    const { root } = await mountDrawer(skyStore(attributes('dense')).store);
    const input = root.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    expect(root.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Find aircraft');
    input.value = 'demo10';
    input.dispatchEvent(new Event('input'));
    await settle();
    const matches = rowKeys(root).length;
    expect(matches).toBeGreaterThan(0);
    expect(matches).toBeLessThan(50);
    expect(text(root, '.matches')).toBe(`${matches} aircraft match`);
    expect(root.querySelector('.matches')?.getAttribute('role')).toBe('status');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    const cancel = new CustomEvent('agr-drawer-cancel', { cancelable: true });
    root.querySelector('agr-drawer')?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await settle();
    expect(input.value).toBe('');
    expect(rowKeys(root)).toHaveLength(50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const close = new CustomEvent('agr-drawer-cancel', { cancelable: true });
    root.querySelector('agr-drawer')?.dispatchEvent(close);
    expect(close.defaultPrevented).toBe(false);
  });

  it('offers no search below 16 rows', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store);
    expect(root.querySelector('input[type="search"]')).toBeNull();
  });

  it('a radar mark expands its row; one not in the current view shows Nearby first', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store);
    await choose(root, 'Show', 'overhead');
    const radar = root.querySelector('agr-sky-radar')?.shadowRoot as ShadowRoot;
    const svg = radar.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toMatch(/^8 aircraft within .*1 overhead/);
    const marks = [...radar.querySelectorAll('g.aircraft')];
    expect(marks).toHaveLength(8);
    const other = marks.find((mark) => mark.getAttribute('data-key') !== NEAREST) as Element;
    const key = other.getAttribute('data-key') as string;
    other.querySelector('.hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(choiceLabels(root, 'Show')[0]).toBe('Nearby 8 (pressed)');
    expect(rowButton(root, key)?.getAttribute('aria-expanded')).toBe('true');
    // Marks are never focusable; the list is the keyboard path.
    expect(radar.querySelectorAll('[tabindex]')).toHaveLength(0);
  });

  it('stale but drawable: a Not live banner, muted rows, hollow marks and Last known details', async () => {
    const { root } = await mountDrawer(skyStore(attributes('degraded')).store, { id: 'sky', select: NEAREST });
    expect(text(root, '.sentence')).toBe('Not live. Positions have changed since the last update.');
    expect(root.querySelector('.sentence')?.getAttribute('role')).toBe('status');
    expect(text(root, '.age')).toBe('Last update 7 min ago');
    expect(root.querySelector('.age')?.closest('[role="status"]')).toBeNull();
    expect(root.querySelector('button.aircraft-row:not([data-muted])')).toBeNull();
    expect(root.querySelector('.chip')).toBeNull();
    const radar = root.querySelector('agr-sky-radar')?.shadowRoot as ShadowRoot;
    expect(radar.querySelector('svg')?.getAttribute('data-live')).toBe('false');
    expect(radar.querySelectorAll('path.mark')).toHaveLength(0);
    expect(text(root, '.detail-note')).toBe('Last known');
    expect(text(root, '.footnote')).toMatch(/could not be shown/);
  });

  it('shows the Conditions strip only when weather is configured', async () => {
    const without = await mountDrawer(skyStore(attributes('normal')).store);
    expect(shadowText(without.root)).not.toContain('Conditions');
    document.body.replaceChildren();
    const live = skyStore(attributes('normal'), weatherConfig);
    live.set('weather.demo_home', 'cloudy', { cloud_coverage: 75, wind_speed: 6, wind_speed_unit: 'mph' });
    const withWeather = await mountDrawer(live.store, { id: 'sky' }, { config: weatherConfig });
    expect(text(withWeather.root, '.group h3')).toBe('Conditions');
    expect(withWeather.root.querySelectorAll('.strip-item').length).toBeGreaterThan(0);
  });

  it('renders a hostile payload as text, with no injected elements and no positions', async () => {
    const panel = await mountPanel(skyStore(attributes('hostile')).store);
    const drawer = await mountDrawer(skyStore(attributes('hostile')).store);
    for (const root of [panel.root, drawer.root]) {
      expect(deepQueryAll(root, 'script, img, iframe, object')).toEqual([]);
      expect(shadowText(root)).not.toMatch(/\blat(?:itude)?\b|\blon(?:gitude)?\b/i);
    }
  });
});

describe('agr-sky-drawer focus and search across live updates', () => {
  it.each(['sky:view:overhead', 'sky:sort:altitude'])(
    'focus on %s moves to the drawer heading when the sensor turns unavailable and the controls unmount',
    async (focusKey) => {
      const live = skyStore(attributes('normal'));
      const { root } = await mountDrawer(live.store);
      const choice = choiceButton(root, focusKey) as HTMLButtonElement;
      choice.focus();
      expect(deepActive()).toBe(choice);
      live.set(DEMO_SKY_AIRSPACE, 'unavailable', {});
      await settle();
      expect(root.querySelector('agr-choice-group')).toBeNull();
      expect(deepActive()?.tagName).toBe('H2');
      expect(deepActive()?.textContent?.trim()).toBe('Sky');
    },
  );

  it('focus on a Show choice that survives an update stays on that choice', async () => {
    const now = Date.now();
    const live = skyStore(attributes('normal', now));
    const { root } = await mountDrawer(live.store);
    choiceButton(root, 'sky:view:recent')?.focus();
    publish(live, firstNearby(attributes('normal', now), 5));
    await settle();
    expect(choiceLabels(root, 'Show')[0]).toBe('Nearby 5 (pressed)');
    expect(deepActive()?.getAttribute('data-focus-key')).toBe('sky:view:recent');
  });

  it('a typed search, and focus in it, survive the count dropping below 16; Escape still clears it', async () => {
    const now = Date.now();
    const live = skyStore(attributes('dense', now));
    const { root } = await mountDrawer(live.store);
    const input = searchInput(root) as HTMLInputElement;
    input.focus();
    await typeSearch(root, 'demo1');
    const filtered = rowKeys(root);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(50);
    publish(live, firstNearby(attributes('dense', now), 15));
    await settle();
    expect(choiceLabels(root, 'Show')[0]).toBe('Nearby 15 (pressed)');
    // The same field, its text and its focus: the search is never hidden while it filters the list.
    expect(searchInput(root)).toBe(input);
    expect(input.value).toBe('demo1');
    expect(deepActive()).toBe(input);
    const stillFiltered = rowKeys(root);
    expect(stillFiltered.length).toBeGreaterThan(0);
    expect(stillFiltered.length).toBeLessThan(15);
    expect(text(root, '.matches')).toBe(`${stillFiltered.length} aircraft match`);
    // Escape clears it first; with 15 aircraft the field then goes, and focus moves to the heading, not the page.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await settle();
    expect(rowKeys(root)).toHaveLength(15);
    expect(searchInput(root)).toBeNull();
    expect(deepActive()?.tagName).toBe('H2');
  });

  it('focus in an empty search field moves to the heading when the count drops and the field goes', async () => {
    const now = Date.now();
    const live = skyStore(attributes('dense', now));
    const { root } = await mountDrawer(live.store);
    searchInput(root)?.focus();
    publish(live, firstNearby(attributes('dense', now), 15));
    await settle();
    expect(searchInput(root)).toBeNull();
    expect(deepActive()?.tagName).toBe('H2');
  });

  it('focus on an expanded row’s link moves to the next row when that aircraft leaves', async () => {
    const now = Date.now();
    const live = skyStore(attributes('normal', now));
    const { root } = await mountDrawer(live.store, { id: 'sky', select: NEAREST });
    const keys = rowKeys(root);
    const link = root.querySelector<HTMLAnchorElement>(`a[data-focus-key="sky:link:${NEAREST}"]`) as HTMLAnchorElement;
    link.focus();
    expect(deepActive()).toBe(link);
    const payload = attributes('normal', now);
    publish(live, {
      ...payload,
      aircraft: (payload['aircraft'] as readonly { hex: string }[]).filter((row) => row.hex !== NEAREST),
    });
    await settle();
    expect(deepActive()?.getAttribute('data-focus-key')).toBe(`sky:aircraft:${keys[keys.indexOf(NEAREST) + 1]}`);
  });
});

describe('agr-sky-drawer radar marks are live positions', () => {
  it('a mark chosen in Recent switches to Nearby and expands the current aircraft, not its past pass', async () => {
    const { root } = await mountDrawer(skyStore(attributes('normal')).store);
    await choose(root, 'Show', 'recent');
    // The nearest aircraft is both nearby now and in the recent list.
    expect(rowKeys(root)).toContain(NEAREST);
    await clickMark(root, NEAREST);
    expect(choiceLabels(root, 'Show')[0]).toBe('Nearby 8 (pressed)');
    const button = rowButton(root, NEAREST) as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const detail = root.getElementById(button.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(shadowText(detail)).not.toMatch(/last overhead pass/i);
    expect(detail.querySelector('.detail-note')).toBeNull();
  });

  it('a mark hidden by the search clears it; a mark the search still lists keeps it', async () => {
    const { root } = await mountDrawer(skyStore(attributes('dense')).store);
    const nearestFirst = rowKeys(root);
    // Index 1 is TEST101 and index 2 is DEMO102 (fixture naming), so "demo10" hides the first and lists the second.
    const hidden = nearestFirst[1] as string;
    const listed = nearestFirst[2] as string;
    await typeSearch(root, 'demo10');
    expect(rowKeys(root)).toContain(listed);
    expect(rowKeys(root)).not.toContain(hidden);
    // From Recent, which lists neither: Nearby, and the search stays because it lists this aircraft.
    await choose(root, 'Show', 'recent');
    await clickMark(root, listed);
    expect(choiceLabels(root, 'Show')[0]).toMatch(/^Nearby \d+ \(pressed\)$/);
    expect(searchInput(root)?.value).toBe('demo10');
    expect(rowButton(root, listed)?.getAttribute('aria-expanded')).toBe('true');
    // A mark the search hides: the search is cleared so its row can show.
    await clickMark(root, hidden);
    expect(searchInput(root)?.value).toBe('');
    expect(rowKeys(root)).toHaveLength(50);
    expect(rowButton(root, hidden)?.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('agr-sky-radar labels', () => {
  const mark = (key: string, x: number, y: number, extra: Partial<RadarMarkVM> = {}): RadarMarkVM => ({
    key,
    x,
    y,
    overhead: false,
    expanded: false,
    clamped: false,
    ...extra,
  });
  const ring = (r: number, label: string, overhead = false): RadarRingVM => ({ r, label, overhead });

  async function mountRadar(vm: Partial<RadarVM>): Promise<ShadowRoot> {
    const radar = document.createElement('agr-sky-radar') as AgrSkyRadar;
    radar.vm = { rings: [], marks: [], live: true, summary: 'Radar', ...vm };
    document.body.append(radar);
    await settle();
    return radar.shadowRoot as ShadowRoot;
  }

  function label(root: ShadowRoot, role: 'ring' | 'mark'): SVGTextElement | null {
    return root.querySelector<SVGTextElement>(`text[data-role="${role}"]`);
  }

  it('paints the ring labels above the marks and the mark labels above both', async () => {
    const root = await mountRadar({
      rings: [ring(10, '1 km', true), ring(60, '10 km')],
      marks: [mark('000001', 50, 50), mark('000002', -40, 20, { expanded: true, label: 'DEMO1' })],
    });
    const order = [...(root.querySelector('svg')?.children ?? [])].map((child) =>
      child.matches('g.aircraft') ? 'aircraft' : `${child.getAttribute('data-role') ?? child.tagName}`,
    );
    expect(order.lastIndexOf('aircraft')).toBeLessThan(order.indexOf('ring'));
    expect(order.lastIndexOf('ring')).toBeLessThan(order.indexOf('mark'));
    // The dashed overhead ring has no label; the caption names it.
    expect(root.querySelectorAll('text[data-role="ring"]')).toHaveLength(1);
  });

  it('moves a ring label off a mark beside the north axis, and leaves it out when every spot is taken', async () => {
    const clear = await mountRadar({ rings: [ring(60, '10 km')] });
    expect(label(clear, 'ring')?.getAttribute('text-anchor')).toBe('start');
    expect(label(clear, 'ring')?.getAttribute('y')).toBe(String(-60 + 9));
    document.body.replaceChildren();

    const blockedNorthEast = await mountRadar({ rings: [ring(60, '10 km')], marks: [mark('000001', 20, -45)] });
    expect(label(blockedNorthEast, 'ring')?.getAttribute('text-anchor')).toBe('end');
    expect(label(blockedNorthEast, 'ring')?.getAttribute('x')).toBe('-3');
    document.body.replaceChildren();

    const blockedNorth = await mountRadar({
      rings: [ring(60, '10 km')],
      marks: [mark('000001', 20, -45), mark('000002', -20, -45)],
    });
    expect(label(blockedNorth, 'ring')?.getAttribute('y')).toBe(String(60 - 9));
    expect(label(blockedNorth, 'ring')?.getAttribute('dominant-baseline')).toBe('auto');
    document.body.replaceChildren();

    const everywhere = await mountRadar({
      rings: [ring(60, '10 km')],
      marks: [mark('000001', 20, -45), mark('000002', -20, -45), mark('000003', 20, 45), mark('000004', -20, 45)],
    });
    expect(label(everywhere, 'ring')).toBeNull();
    expect(everywhere.querySelectorAll('g.aircraft')).toHaveLength(4);
  });

  it('puts a mark label on the side away from home, else the other side, keeping clear of other marks', async () => {
    const away = await mountRadar({ marks: [mark('000001', -40, 40, { expanded: true, label: 'DEMO1' })] });
    expect(label(away, 'mark')?.getAttribute('text-anchor')).toBe('end');
    expect(label(away, 'mark')?.getAttribute('x')).toBe(String(-40 - 9));
    expect(label(away, 'mark')?.getAttribute('data-key')).toBe('000001');
    document.body.replaceChildren();

    const flipped = await mountRadar({
      marks: [mark('000001', -40, 40, { expanded: true, label: 'DEMO1' }), mark('000002', -70, 40)],
    });
    expect(label(flipped, 'mark')?.getAttribute('text-anchor')).toBe('start');
    expect(label(flipped, 'mark')?.getAttribute('x')).toBe(String(-40 + 9));
  });

  it('keeps a boxed-in mark label on the side away from home rather than dropping the name', async () => {
    const root = await mountRadar({
      marks: [
        mark('000001', -40, 40, { overhead: true, label: 'DEMO1' }),
        mark('000002', -70, 40),
        mark('000003', -10, 40),
        mark('000004', -40, 22),
        mark('000005', -40, 58),
      ],
    });
    expect(label(root, 'mark')?.getAttribute('text-anchor')).toBe('end');
    expect(label(root, 'mark')?.textContent).toBe('DEMO1');
  });
});

describe('the sky clock keeps the freshness gates honest without entity updates (§5.2)', () => {
  /** The snapshot is dated exactly `startMs`, so the bounds below are measured from updated_at. */
  async function atStart(kind: SkyFixtureKind = 'normal') {
    vi.useFakeTimers();
    const startMs = PINNED_NOW.getTime();
    vi.setSystemTime(startMs);
    const live = skyStore(attributes(kind, startMs + FIXTURE_LEAD_MS));
    return { live, startMs };
  }

  async function advance(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    await settle();
  }

  it('turns the panel stale within 190 s of updated_at with no update ever arriving', async () => {
    const { live } = await atStart();
    const { root } = await mountPanel(live.store);
    expect(text(root, '.count')).toBe('8');
    await advance(179_000);
    expect(text(root, '.count')).toBe('8');
    await advance(12_000);
    expect(root.querySelector('.count')).toBeNull();
    expect(text(root, '.state-line')).toBe('No fresh aircraft data');
  });

  it('stays live through the bound when an update arrives mid-interval', async () => {
    const { live, startMs } = await atStart();
    const { root } = await mountPanel(live.store);
    await advance(100_000);
    publish(live, attributes('normal', startMs + 100_000 + FIXTURE_LEAD_MS));
    await settle();
    await advance(91_000);
    expect(text(root, '.count')).toBe('8');
  });

  it('stops drawing the drawer list and radar 15 min 10 s after updated_at, leaving the banner', async () => {
    const { live } = await atStart();
    const { root } = await mountDrawer(live.store);
    expect(rowKeys(root)).toHaveLength(8);
    await advance(15 * 60_000);
    expect(rowKeys(root)).toHaveLength(8);
    expect(root.querySelector('button.aircraft-row:not([data-muted])')).toBeNull();
    await advance(SKY_TICK_MS + 1_000);
    expect(rowKeys(root)).toEqual([]);
    expect(root.querySelector('agr-sky-radar')).toBeNull();
    expect(text(root, '.sentence')).toBe('No fresh aircraft data.');
  });

  it('stops ticking when the panel is removed', async () => {
    const { live } = await atStart();
    const { panel } = await mountPanel(live.store);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    panel.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never ticks without an airspace entity', async () => {
    vi.useFakeTimers();
    await mountPanel(fakeStore([]), { config: configFrom({}) });
    expect(vi.getTimerCount()).toBe(0);
  });
});
