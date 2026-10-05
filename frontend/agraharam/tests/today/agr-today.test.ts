/**
 * agr-today (§9.2): renders the hero, high/low, sunset and the strip from live store and forecast data,
 * refreshes on the 'clock' meta, writes the diagnostics status, escapes runtime text, and never acts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/today/agr-today.ts';
import type { AgrToday } from '../../src/components/today/agr-today.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import { WEATHER_FEATURE } from '../../src/ha/features.ts';
import type { ForecastHandlers, ForecastItem, ForecastType, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import type { HassEntityLike } from '../../src/ha/types.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';
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
