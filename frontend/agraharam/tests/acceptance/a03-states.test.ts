/**
 * ACCEPTANCE check 3 (§12.1 row 3): missing, unknown, unavailable and offline stay distinct, and null numeric data
 * is never shown as 0.
 *
 * The degraded scenario puts every honest state on screen at once; the targeted cases bind one sensor and walk it
 * through each status, so a regression that merges two of them cannot hide behind another panel's copy.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  deepQueryAll,
  liveInput,
  mountLive,
  renderedText,
  revealAll,
  section,
  shadowOf,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const RANGE = 'sensor.demo_sedan_range';
const BATTERY = 'sensor.demo_sedan_battery';
const SESSION = 'sensor.demo_sedan_session_energy';
const CHARGER_POWER = 'sensor.demo_sedan_charger_power';
const VACUUM_BATTERY = 'sensor.demo_pebble_battery';
const WEATHER = 'weather.demo_home';
const CLIMATE = 'climate.demo_bedroom';
const MISSING_RANGE = 'sensor.demo_sedan_range_gone';
const ZERO_READING = /(^|[^\d.])0(\.0+)?\s?(%|mi|km|kWh|kW|°)/;

beforeEach(() => {
  useAcceptanceTimers();
});

function text(card: LiveCard, tag: string): string {
  return renderedText(shadowOf(section(card, tag)));
}

/** The rendered text of each camera tile, in order. */
function cameraTiles(card: LiveCard): string[] {
  return deepQueryAll(shadowOf(section(card, 'agr-cameras')), 'agr-camera-tile').map((tile) => renderedText(tile));
}

function vehicleText(card: LiveCard): string {
  return renderedText(deepQueryAll(shadowOf(section(card, 'agr-garage')), 'agr-vehicle')[0] as Element);
}

/** Inline sizes of every progress fill on the card (a 0 % fill would read as an empty battery). */
function zeroFills(card: LiveCard): Element[] {
  return deepQueryAll(card.root, '[style]').filter((element) =>
    /(inline-size|width):\s*0(\.0+)?%/.test(element.getAttribute('style') ?? ''),
  );
}

describe('the degraded scenario shows every honest state, each in its own words', () => {
  it('camera tiles: offline, privacy status unavailable (unknown and unexpected), privacy on', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    revealAll();
    await advance(1_000);
    const [frontGate, sidePath, courtyard, hall] = cameraTiles(card);
    expect(frontGate).toContain('Front gate');
    expect(frontGate).toContain('Offline');
    expect(sidePath).toContain('Privacy status unavailable');
    expect(courtyard).toContain('Privacy status unavailable');
    expect(hall).toContain('Privacy on');
    expect(hall).not.toContain('Privacy status unavailable');
  });

  it('devices: unavailable, not found, unknown remaining time and an unknown door position', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    await advance(1_000);
    expect(text(card, 'agr-comfort')).toMatch(/Purifier Unavailable/);
    expect(text(card, 'agr-home')).toMatch(/Dryer Not found/);
    expect(text(card, 'agr-home')).toMatch(/Time left unknown/);
    expect(text(card, 'agr-garage')).toContain('Position unknown');
    expect(vehicleText(card)).toMatch(/Range unavailable/);
    expect(text(card, 'agr-header')).toContain('Alarm state unknown');
  });

  it('the health panel lists problems by name and status, never as "All systems normal"', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    await advance(1_000);
    const health = text(card, 'agr-health');
    expect(health).toMatch(/3 of 4 monitored entry points closed/);
    expect(health).toMatch(/Back door Open/);
    expect(health).toMatch(/Purifier Unavailable/);
    expect(health).not.toMatch(/all systems normal/i);
  });

  it('a missing climate reading shows "No data", never 0', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    await advance(1_000);
    expect(text(card, 'agr-comfort')).toMatch(/currently \S+ No data/);
    expect(text(card, 'agr-comfort')).not.toMatch(ZERO_READING);
  });
});

describe('one sensor walked through every status keeps each one distinct', () => {
  it('available, unknown, unavailable, then not found and offline when the binding has no entity', async () => {
    const card = await mountLive();
    expect(vehicleText(card)).toContain('210 mi');

    card.fake.setState(RANGE, 'unknown');
    await advance(0);
    expect(vehicleText(card)).toMatch(/Range unknown/);

    card.fake.setState(RANGE, 'unavailable');
    await advance(0);
    expect(vehicleText(card)).toMatch(/Range unavailable/);

    const missing = await mountLive({
      input: liveInput('normal', { vehicle: { ...vehicleInput(), range_sensor: MISSING_RANGE } }),
    });
    expect(vehicleText(missing)).toMatch(/Range not found/);
    missing.fake.disconnect();
    await advance(0);
    expect(vehicleText(missing)).toMatch(/Range offline/);
  });

  it('a value seen before a disconnect stays visible but marked "last known"', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    expect(vehicleText(card)).toMatch(/Range 210 mi last known/);
    expect(text(card, 'agr-header')).toMatch(/Disarmed Last known/);
  });

  it('while Home Assistant is starting, an absent entity reads "Loading", never "Not found"', async () => {
    const card = await mountLive({
      scenario: 'starting',
      input: liveInput('starting', { vehicle: { ...vehicleInput('starting'), range_sensor: MISSING_RANGE } }),
    });
    await advance(1_000);
    expect(vehicleText(card)).not.toContain('Not found');
    expect(text(card, 'agr-health')).not.toContain('Not found');
  });
});

describe('null numeric data is absent, never 0', () => {
  it('unknown, empty, unavailable and null readings render no 0 %, 0 mi, 0 kW, 0 kWh or 0°, and no 0 % bars', async () => {
    const card = await mountLive();
    card.fake.setState(BATTERY, 'unknown');
    card.fake.setState(RANGE, '');
    card.fake.setState(SESSION, 'unavailable');
    card.fake.setState(CHARGER_POWER, 'unknown');
    card.fake.setState(VACUUM_BATTERY, 'unknown');
    card.fake.setState(WEATHER, 'sunny', {
      temperature: null,
      apparent_temperature: null,
      humidity: null,
      wind_speed: null,
    });
    card.fake.setState(CLIMATE, 'cool', { current_temperature: null });
    await advance(1_000);

    const all = renderedText(card.root);
    expect(all).not.toMatch(ZERO_READING);
    expect(vehicleText(card)).toMatch(/Battery unknown/);
    expect(vehicleText(card)).toMatch(/Range unknown/);
    expect(text(card, 'agr-today')).toContain('No data');
    expect(zeroFills(card)).toEqual([]);
  });

  it('NaN and Infinity in numeric attributes are absent too', async () => {
    const card = await mountLive();
    card.fake.setState(WEATHER, 'sunny', { temperature: Number.NaN, humidity: Number.POSITIVE_INFINITY });
    card.fake.setState(CLIMATE, 'cool', { current_temperature: Number.NaN });
    await advance(0);
    const today = text(card, 'agr-today');
    expect(today).toContain('No data');
    expect(today).not.toMatch(/NaN|Infinity/);
    expect(text(card, 'agr-comfort')).not.toMatch(/NaN|Infinity/);
  });

  it('a real zero is still shown as zero (session energy 0 kWh in the degraded scenario)', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    await advance(0);
    expect(vehicleText(card)).toMatch(/0 kWh this session/);
  });
});

function vehicleInput(scenario: 'normal' | 'starting' = 'normal'): Record<string, unknown> {
  return { ...(liveInput(scenario)['vehicle'] as Record<string, unknown>) };
}
