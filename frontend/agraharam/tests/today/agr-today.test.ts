/**
 * agr-today (§9.2): renders the hero, high/low, sunset and the strip from live store and forecast data,
 * refreshes on the 'clock' meta, writes the diagnostics status, escapes runtime text, and never acts. Also the
 * header's Weather details button and compact header, and the read-only weather drawer it opens (AIRSPACE.md §8).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/today/agr-today.ts';
import '../../src/components/today/agr-weather-drawer.ts';
import type { AgrToday } from '../../src/components/today/agr-today.ts';
import type { AgrWeatherDrawer } from '../../src/components/today/agr-weather-drawer.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import { WEATHER_FEATURE } from '../../src/ha/features.ts';
import type { ForecastHandlers, ForecastItem, ForecastType, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';
import { PANEL_CQ } from '../../src/styles/breakpoints.ts';
import { ManualStore } from './controller-host.ts';

const WEATHER = entityId('weather.demo_home');
const SUN = entityId('sun.demo_sun');
const FULL = WEATHER_FEATURE.FORECAST_DAILY | WEATHER_FEATURE.FORECAST_HOURLY;
const HOUR_MS = 3_600_000;

function weather(attributes: Readonly<Record<string, unknown>> = {}, state = 'partlycloudy'): HassEntityLike {
  return testEntity(WEATHER, state, {
    friendly_name: 'Home',
    temperature: 69,
    apparent_temperature: 68,
    humidity: 52,
    wind_speed: 5,
    temperature_unit: '°F',
    wind_speed_unit: 'mph',
    supported_features: FULL,
    ...attributes,
  });
}

function sun(): HassEntityLike {
  return testEntity(SUN, 'above_horizon', {
    next_setting: new Date(Date.now() + 46 * 60_000).toISOString(),
    next_rising: new Date(Date.now() + 13 * HOUR_MS).toISOString(),
  });
}

function hourly(): ForecastItem[] {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  return Array.from({ length: 12 }, (_, hour) => ({
    datetime: new Date(start.getTime() + hour * HOUR_MS).toISOString(),
    condition: 'cloudy',
    temperature: 69 - hour,
  }));
}

function daily(): ForecastItem[] {
  return Array.from({ length: 6 }, (_, day) => ({
    datetime: new Date(Date.now() + day * 24 * HOUR_MS).toISOString(),
    condition: 'sunny',
    temperature: 71 + day,
    templow: 58 + day,
  }));
}

async function mount(states: readonly HassEntityLike[], config = configFrom({ weather: WEATHER, sun: SUN })) {
  const manual = new ManualStore([WEATHER, SUN], states);
  const forecasts = new Map<ForecastType, ForecastHandlers>();
  const reader: HostReader = {
    ...fakeReader(manual.view, () => manual.phase()),
    subscribeForecast: (_id, type, handlers) => {
      forecasts.set(type, handlers);
      return () => forecasts.delete(type);
    },
  };
  const gateway = new FakeGateway();
  const services: DashboardServices = {
    config,
    reader,
    store: manual.view,
    gateway,
    status: createStatusBoard(),
    warnings: [],
    mode: 'live',
    preview: false,
    theme: 'light',
  };
  const element = document.createElement('agr-today') as AgrToday;
  element.services = services;
  document.body.append(element);
  await settle();
  const root = element.shadowRoot as ShadowRoot;
  return { element, root, manual, forecasts, services, gateway };
}

function text(root: ParentNode, selector: string): string {
  return (deepQuery(root, selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agr-today', () => {
  it('renders the hero, condition, high/low, sunset and metrics, then the hourly strip', async () => {
    const t = await mount([weather(), sun()]);
    t.forecasts.get('hourly')?.next({ type: 'hourly', forecast: hourly() });
    t.forecasts.get('daily')?.next({ type: 'daily', forecast: daily() });
    await settle();
    expect(text(t.root, '.temperature')).toBe('69°');
    expect(text(t.root, '.condition')).toBe('Partly cloudy');
    expect(text(t.root, '.range')).toBe('High 71° Low 58°');
    expect(text(t.root, '.sun')).toMatch(/^Sunset \d{1,2}:\d{2}/);
    expect(t.root.querySelector('.sun')?.getAttribute('slot')).toBe('actions');
    expect(text(t.root, '.metrics')).toBe('Feels like 68° Wind 5 mph Humidity 52%');
    const strip = deepQuery(t.root, 'agr-forecast-strip');
    const cells = deepQueryAll(strip?.shadowRoot as ShadowRoot, 'li.cell');
    expect(cells).toHaveLength(8);
    expect(cells[0]?.querySelector('.label')?.textContent).toBe('Now');
    expect(deepQuery(strip?.shadowRoot as ShadowRoot, 'ol')?.getAttribute('aria-label')).toBe('Hourly forecast');
  });

  it('shows the labelled daily fallback for a daily-only source', async () => {
    const t = await mount([weather({ supported_features: WEATHER_FEATURE.FORECAST_DAILY }), sun()]);
    expect([...t.forecasts.keys()]).toEqual(['daily']);
    t.forecasts.get('daily')?.next({ type: 'daily', forecast: daily() });
    await settle();
    const strip = deepQuery(t.root, 'agr-forecast-strip')?.shadowRoot as ShadowRoot;
    expect(deepQueryAll(strip, 'li.cell')).toHaveLength(5);
    expect(text(strip, '.note')).toBe("Hourly forecast isn't provided by this weather source.");
  });

  it('shows the no-forecast note for a source without forecast bits, with no subscription', async () => {
    const t = await mount([weather({ supported_features: 0 }), sun()]);
    expect(t.forecasts.size).toBe(0);
    const strip = deepQuery(t.root, 'agr-forecast-strip')?.shadowRoot as ShadowRoot;
    expect(text(strip, '.note')).toBe("This weather source doesn't provide a forecast.");
  });

  it('renders an unavailable weather entity as a dash placeholder with its reason, never 0', async () => {
    const t = await mount([testEntity(WEATHER, 'unavailable'), sun()]);
    // One muted "--" placeholder without a degree sign (never a long dash that reads as a divider rule), and the
    // reason as the condition in the serif title.
    expect(text(t.root, '.temperature')).toBe('--');
    expect(t.root.querySelector('.temperature')?.classList.contains('absent')).toBe(true);
    expect(t.root.querySelector('.temperature .placeholder')).not.toBeNull();
    expect(text(t.root, '.condition')).toBe('Weather unavailable');
    expect(t.root.querySelector('.condition')?.classList.contains('t-title')).toBe(true);
    expect(t.root.textContent).not.toMatch(/\b0°/);
    expect(t.forecasts.size).toBe(0);
  });

  it('states a missing weather binding as a reason in muted sans, never in the serif value style', async () => {
    const t = await mount([sun()]);
    expect(text(t.root, '.condition')).toBe('Not found');
    expect(t.root.querySelector('.condition')?.classList.contains('reason')).toBe(true);
    expect(t.root.querySelector('.condition')?.classList.contains('t-title')).toBe(false);
  });

  it('keeps a decimal reading but sets its fraction small and raised, so the whole degrees stay the anchor', async () => {
    const t = await mount([weather({ temperature: 70.5 }), sun()]);
    expect(text(t.root, '.temperature')).toBe('70.5°');
    expect(text(t.root, '.temperature .fraction')).toBe('.5');
    const whole = await mount([weather(), sun()]);
    expect(whole.root.querySelector('.temperature .fraction')).toBeNull();
  });

  it('keeps the metrics row of an absent reading with dashes, so the panel keeps its shape', async () => {
    const t = await mount([testEntity(WEATHER, 'unavailable', { friendly_name: 'Home' }), sun()]);
    const labels = [...t.root.querySelectorAll('.metrics dt')].map((dt) => dt.textContent?.trim());
    expect(labels).toEqual(['Feels like', 'Wind', 'Humidity']);
    expect([...t.root.querySelectorAll('.metrics dd')].map((dd) => dd.textContent?.trim())).toEqual([
      '—No data',
      '—No data',
      '—No data',
    ]);
  });

  it('gives "Feels like" a short visible label for narrow panels, as generated content (never read twice)', async () => {
    const t = await mount([weather(), sun()]);
    const feels = t.root.querySelector('.metrics dt[data-short]');
    expect(feels?.getAttribute('data-short')).toBe('Feels');
    expect(feels?.textContent?.trim()).toBe('Feels like');
  });

  it('says when no weather source is configured', async () => {
    const t = await mount([], configFrom({}));
    expect(deepQuery(t.root, 'agr-empty-state')?.getAttribute('heading')).toBe("Weather isn't set up");
  });

  it('re-renders on the clock meta with no entity change ("Now" moves with the hour)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 8, 30, 17, 51, 0);
    vi.setSystemTime(start);
    const t = await mount([weather(), sun()]);
    t.forecasts.get('hourly')?.next({ type: 'hourly', forecast: hourly() });
    await settle();
    const strip = () => deepQuery(t.root, 'agr-forecast-strip')?.shadowRoot as ShadowRoot;
    const firstHour = deepQueryAll(strip(), 'li.cell')[1]?.querySelector('.label')?.textContent;
    vi.setSystemTime(new Date(start.getTime() + HOUR_MS));
    t.manual.store.tick();
    await settle();
    expect(deepQueryAll(strip(), 'li.cell')[0]?.querySelector('.label')?.textContent).toBe('Now');
    expect(deepQueryAll(strip(), 'li.cell')[1]?.querySelector('.label')?.textContent).not.toBe(firstHour);
  });

  it('writes the forecast status for diagnostics', async () => {
    const t = await mount([weather(), sun()]);
    expect(t.services.status.get('forecast')).toBe('hourly subscribing, daily subscribing');
    t.forecasts.get('hourly')?.error({ code: 'unsupported', haCode: 'forecast_not_supported' });
    await settle();
    expect(t.services.status.get('forecast')).toBe('hourly unsupported, daily subscribing');
  });

  it('escapes runtime text from the entity', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const t = await mount([weather({ friendly_name: payload }), sun()]);
    expect(deepQueryAll(t.root, 'img, script')).toEqual([]);
    expect(t.root.textContent).toContain(payload);
  });

  it('stops its forecast subscriptions when removed and makes no requests to the gateway', async () => {
    const t = await mount([weather(), sun()]);
    expect(t.forecasts.size).toBe(2);
    t.element.remove();
    expect(t.forecasts.size).toBe(0);
    expect(t.gateway.calls).toEqual([]);
  });

  it('offers a Weather details button after the sun item, opening the weather drawer (AIRSPACE.md §8)', async () => {
    const t = await mount([weather(), sun()]);
    const requests: { id: string; trigger: HTMLElement }[] = [];
    t.element.addEventListener('agr-open-drawer', (event) => {
      requests.push({ id: event.detail.request.id, trigger: event.detail.trigger });
    });
    const slotted = [...t.root.querySelectorAll('agr-panel > [slot="actions"]')];
    expect(slotted.map((element) => element.className)).toEqual(['sun t-meta', 'header-action details']);
    const details = t.root.querySelector<HTMLButtonElement>('button.details') as HTMLButtonElement;
    expect(details.getAttribute('aria-label')).toBe('Weather details');
    expect(details.getAttribute('aria-haspopup')).toBe('dialog');
    expect(details.getAttribute('data-focus-key')).toBe('today:details');
    expect(details.querySelector('.details-text')?.textContent).toBe('Details');
    expect(details.querySelector('.details-icon')?.getAttribute('aria-hidden')).toBe('true');
    details.click();
    expect(requests).toEqual([{ id: 'weather', trigger: details }]);
    expect(t.gateway.calls).toEqual([]);
  });

  it('keeps the Details button while the weather is unavailable or offline, and has none without weather', async () => {
    const unavailable = await mount([testEntity(WEATHER, 'unavailable'), sun()]);
    expect(unavailable.root.querySelector('button.details')).not.toBeNull();
    unavailable.manual.setConnected(false);
    await settle();
    expect(unavailable.root.querySelector('button.details')).not.toBeNull();
    const none = await mount([], configFrom({}));
    expect(none.root.querySelector('button.details')).toBeNull();
  });

  it('compacts the header below PANEL_CQ.todayHeaderCompact: the sun word hidden, Details as an icon', async () => {
    const t = await mount([weather(), sun()]);
    // happy-dom has no layout: the rule itself is checked; the e2e header checks measure it in real engines.
    const css = (t.element.constructor as unknown as { elementStyles: { cssText: string }[] }).elementStyles
      .map((style) => style.cssText)
      .join('\n');
    const compact = css.slice(css.indexOf(`@container panel (width < ${PANEL_CQ.todayHeaderCompact}px)`));
    expect(compact.length).toBeLessThan(css.length);
    expect(compact).toMatch(/\.sun \.sun-label\s*\{[^}]*clip-path: inset\(50%\)/);
    expect(compact).toMatch(/\.details-text\s*\{\s*display: none;/);
    expect(compact).toMatch(/\.details-icon\s*\{\s*display: inline-flex;/);
    // The word stays in the text for assistive technology.
    expect(text(t.root, '.sun')).toMatch(/^Sunset \d{1,2}:\d{2}/);
  });

  it('dims last known values while disconnected and pauses the forecast', async () => {
    const t = await mount([weather(), sun()]);
    t.manual.setConnected(false);
    await settle();
    expect(t.root.querySelector('.temperature')?.classList.contains('stale')).toBe(true);
    expect(t.root.textContent).toContain('last known');
    const strip = deepQuery(t.root, 'agr-forecast-strip')?.shadowRoot as ShadowRoot;
    expect(text(strip, '.note')).toBe('Forecast resumes when Home Assistant reconnects.');
    expect(t.forecasts.size).toBe(0);
  });
});

describe('agr-weather-drawer (AIRSPACE.md §8)', () => {
  async function mountWeatherDrawer(
    states: readonly HassEntityLike[],
    config = configFrom({ weather: WEATHER, sun: SUN }),
  ) {
    const t = await mount(states, config);
    const drawer = document.createElement('agr-weather-drawer') as AgrWeatherDrawer;
    drawer.services = t.services;
    drawer.request = { id: 'weather' };
    document.body.append(drawer);
    await settle();
    return { ...t, drawer, drawerRoot: drawer.shadowRoot as ShadowRoot };
  }

  const EXTENDED = {
    dew_point: 51,
    cloud_coverage: 40,
    uv_index: 6,
    wind_bearing: 315,
    wind_gust_speed: 14,
    visibility: 10,
    visibility_unit: 'mi',
    pressure: 30.02,
    pressure_unit: 'inHg',
  };

  it('leads with the condition and temperature, then the reported conditions and the next sun events', async () => {
    const { drawerRoot } = await mountWeatherDrawer([weather(EXTENDED), sun()]);
    expect(drawerRoot.querySelector('agr-drawer')?.heading).toBe('Weather details');
    expect(text(drawerRoot, '.temperature')).toBe('69°F');
    expect(text(drawerRoot, '.condition')).toBe('Partly cloudy');
    const rows = [...drawerRoot.querySelectorAll('[aria-labelledby="weather-now"] .row')];
    const byKey = new Map(
      rows.map((row) => [row.getAttribute('data-key'), (row.textContent ?? '').replace(/\s+/g, ' ').trim()]),
    );
    expect(byKey.get('uv')).toMatch(/^UV.* 6 · High$/);
    expect(byKey.get('humidity')).toMatch(/52%$/);
    expect(byKey.has('cloud-cover')).toBe(true);
    const sunRows = [...drawerRoot.querySelectorAll('[aria-labelledby="weather-sun"] .row')].map((row) =>
      row.getAttribute('data-key'),
    );
    expect(sunRows.sort()).toEqual(['sunrise', 'sunset']);
    // The weather entity's friendly name is often a place: never shown.
    expect(drawerRoot.textContent).not.toContain('Home');
  });

  it('reads a null metric as No data, never 0, and omits one the source never reports', async () => {
    const { drawerRoot } = await mountWeatherDrawer([weather({ uv_index: null }), sun()]);
    const uv = drawerRoot.querySelector('[data-key="uv"]');
    expect(uv?.querySelector('.value')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('— No data');
    expect(drawerRoot.querySelector('[data-key="visibility"]')).toBeNull();
  });

  it('shows an unavailable entity as its state with no values', async () => {
    const { drawerRoot } = await mountWeatherDrawer([testEntity(WEATHER, 'unavailable'), sun()]);
    expect(text(drawerRoot, '.reason')).toBe('Weather unavailable');
    expect(drawerRoot.querySelector('[aria-labelledby="weather-now"]')).toBeNull();
  });

  it('dims the last known values while offline and says so', async () => {
    const { drawerRoot, manual } = await mountWeatherDrawer([weather(EXTENDED), sun()]);
    manual.setConnected(false);
    await settle();
    expect(drawerRoot.querySelector('.temperature')?.classList.contains('stale')).toBe(true);
    expect(text(drawerRoot, '.note')).toBe('Last known values while Home Assistant is offline.');
    expect(drawerRoot.textContent).toContain('last known');
  });

  it('escapes runtime text and never acts', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const { drawerRoot, gateway } = await mountWeatherDrawer([
      weather({ friendly_name: payload, visibility_unit: payload, visibility: 3 }),
      sun(),
    ]);
    expect(deepQueryAll(drawerRoot, 'img, script')).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });
});
