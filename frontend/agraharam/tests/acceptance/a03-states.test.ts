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
import {
  closeOverlays,
  openSkyDrawer,
  publishSky,
  SKY,
  skyBanner,
  skyPanelLine,
  skyPanelPill,
  skyPayload,
  skyRoot,
  skyRowButtons,
  withoutSkyAttributes,
  type SkyPayload,
} from './sky-support.ts';

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

// -----------------------------------------------------------------------------------------------------------------
// Sky (AIRSPACE.md §4): every status in its own words, nothing aircraft-related outside live data, and no
// leftover from an earlier payload. FakeHass's unit system is US customary, so the 25 km radius reads 15.5 mi.

interface SkySeen {
  readonly status: string;
  readonly panel: string;
  readonly banner: string;
}

/** The status the panel and drawer agree on (data-status), the panel line and the drawer banner. */
async function seeSky(card: LiveCard): Promise<SkySeen> {
  const panelStatus = skyRoot(card).querySelector('.state')?.getAttribute('data-status');
  const drawer = await openSkyDrawer(card);
  const status = drawer.querySelector('.banner')?.getAttribute('data-status') ?? 'none';
  if (panelStatus !== null && panelStatus !== undefined) expect(panelStatus, 'panel and drawer status').toBe(status);
  const seen = { status, panel: skyPanelLine(card), banner: skyBanner(drawer) };
  await closeOverlays(card);
  return seen;
}

/** Nothing aircraft-related is on screen: no count, no nearest aircraft, no rows, no radar. */
async function expectNoAircraft(card: LiveCard): Promise<void> {
  const panel = skyRoot(card);
  expect(panel.querySelector('.count, .nearest'), 'panel count or nearest aircraft').toBeNull();
  const drawer = await openSkyDrawer(card);
  expect(skyRowButtons(drawer), 'drawer rows').toEqual([]);
  expect(drawer.querySelector('agr-sky-radar'), 'radar').toBeNull();
  await closeOverlays(card);
}

function withPayload(changes: Readonly<Record<string, unknown>>): SkyPayload {
  return { ...skyPayload('normal'), ...changes };
}

describe('sky: every status keeps its own words, and only live data is depicted live', () => {
  it('one sensor walked through live, empty, stale, unavailable, unsupported, malformed and clock skew, then live', async () => {
    const card = await mountLive({ scenario: 'sky' });
    const seen: SkySeen[] = [];

    expect(renderedText(skyRoot(card).querySelector('.count') ?? skyRoot(card))).toBe('8');
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toEqual({ status: 'live', panel: 'aircraft within 15.5 mi', banner: '' });

    await publishSky(card, skyPayload('empty'));
    expect(renderedText(skyRoot(card).querySelector('.count') ?? skyRoot(card))).toBe('0');
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toMatchObject({ status: 'empty', panel: 'Quiet skies within 15.5 mi' });

    await publishSky(card, skyPayload('normal', 4));
    expect(skyPanelPill(card)).toEqual({ label: 'Not live', tone: 'attention' });
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toMatchObject({ status: 'stale', panel: 'No fresh aircraft data' });

    card.fake.setState(SKY, 'unavailable');
    await advance(0);
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toMatchObject({ status: 'unavailable', panel: 'Aircraft data unavailable' });
    await expectNoAircraft(card);

    await publishSky(card, withPayload({ schema_version: 2 }));
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toMatchObject({ status: 'unsupported', panel: 'Unsupported sky data' });
    await expectNoAircraft(card);

    await publishSky(card, withPayload({ aircraft: 'eight aircraft' }));
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toMatchObject({ status: 'malformed', panel: 'Sky data could not be read' });
    await expectNoAircraft(card);

    await publishSky(card, skyPayload('normal', -5));
    seen.push(await seeSky(card));
    expect(seen.at(-1)).toMatchObject({ status: 'malformed', panel: "Sky data is ahead of this device's clock" });
    await expectNoAircraft(card);

    // Nothing sticks: the next valid payload is live again, with its own count.
    await publishSky(card, skyPayload('dense'));
    expect(renderedText(skyRoot(card).querySelector('.count') ?? skyRoot(card))).toBe('50');
    expect(skyPanelPill(card)).toBeUndefined();

    expect(new Set(seen.map((entry) => entry.panel)).size, 'panel lines').toBe(seen.length);
    expect(new Set(seen.filter((entry) => entry.banner !== '').map((entry) => entry.banner)).size).toBe(
      seen.length - 2,
    );
  });

  it('rows that were sent but none of which can be read are malformed, never "Quiet skies" or 0', async () => {
    const card = await mountLive({ scenario: 'sky' });
    const unreadable = [
      { hex: 'not-hex', distance_km: 4, bearing_deg: 10, overhead: false },
      { hex: '002f00', distance_km: '5.5', bearing_deg: 400, overhead: 'no' },
    ];
    await publishSky(card, withPayload({ aircraft: unreadable }));
    expect(skyPanelLine(card)).toBe('Sky data could not be read');
    // A count with no rows at all is malformed too.
    card.fake.setState(SKY, '3', withPayload({ aircraft: [] }));
    await advance(0);
    expect(skyPanelLine(card)).toBe('Sky data could not be read');
    expect(renderedText(skyRoot(card))).not.toMatch(/Quiet skies|^0\b/);
    await expectNoAircraft(card);
  });

  it('a sensor HA restored without attributes waits, then reads "no aircraft data" once its update is old', async () => {
    const waiting = await mountLive({ scenario: 'sky', transform: withoutSkyAttributes() });
    const restored = await seeSky(waiting);
    expect(restored).toMatchObject({ status: 'waiting', panel: 'Waiting for aircraft data' });
    await expectNoAircraft(waiting);

    const noData = await mountLive({ scenario: 'sky', transform: withoutSkyAttributes(10) });
    const old = await seeSky(noData);
    expect(old).toMatchObject({ status: 'malformed', panel: 'No aircraft data from the sky sensor' });
    expect(old.banner).toBe(
      "The sky sensor reports a value but no aircraft data. Check the collector and the card's airspace entity.",
    );
    await expectNoAircraft(noData);
  });

  it('a configured sensor HA does not have reads "not found"; while HA starts it is loading instead', async () => {
    const missing = await mountLive({
      scenario: 'sky',
      input: liveInput('sky', { airspace: { entity: 'sensor.demo_sky_gone' } }),
    });
    expect(await seeSky(missing)).toMatchObject({ status: 'missing', panel: 'Sky sensor not found' });
    await expectNoAircraft(missing);

    const starting = await mountLive({
      scenario: 'starting',
      input: liveInput('starting', { airspace: { entity: SKY } }),
    });
    await advance(1_000);
    const panel = skyRoot(starting);
    expect(panel.querySelector('.ghost-summary')?.getAttribute('aria-hidden')).toBe('true');
    expect(renderedText(panel)).not.toContain('not found');
    expect(await seeSky(starting)).toMatchObject({ status: 'loading', banner: 'Loading the sky.' });
  });

  it("follows Home Assistant's metric length unit end to end: the radius, distances and radar rings in km", async () => {
    const card = await mountLive({
      scenario: 'sky',
      transform: (hass) => ({ ...hass, config: { ...hass.config, unit_system: { temperature: '°C', length: 'km' } } }),
    });
    expect(skyPanelLine(card)).toBe('aircraft within 25 km');
    const drawer = await openSkyDrawer(card);
    const caption = renderedText(drawer.querySelector('.radar-caption') as Element);
    expect(caption).toBe('Within 25 km · Dashed ring: overhead within 3 km');
    expect(renderedText(skyRowButtons(drawer)[0] as Element)).toMatch(/^DEMO214 B738 .*1\.4 km NW/);
    expect(renderedText(drawer)).not.toMatch(/\bmi\b/);
  });

  it('an aircraft without altitude or speed shows neither, never 0 ft or 0 kn', async () => {
    const card = await mountLive({ scenario: 'sky' });
    const payload = skyPayload('normal');
    const rows = payload['aircraft'] as readonly Readonly<Record<string, unknown>>[];
    const first = { ...rows[0], altitude_ft: null, speed_kts: Number.NaN, vertical_rate_fpm: '900' };
    await publishSky(card, { ...payload, aircraft: [first, ...rows.slice(1)] });
    const drawer = await openSkyDrawer(card);
    const detail = drawer.querySelector('.detail:not([hidden])');
    expect(detail, 'the nearest aircraft opens expanded').not.toBeNull();
    const text = renderedText(detail as Element);
    expect(text).toContain('From home');
    expect(text).not.toMatch(/Barometric altitude|Ground speed|Vertical speed|NaN|(^|\D)0 (ft|kn)/);
    expect(renderedText(skyRoot(card))).not.toMatch(/(^|\D)0 ft/);
  });
});

describe('sky: the freshness gates clear within their bounds with no entity update ever arriving (§5.2)', () => {
  beforeEach(() => {
    useAcceptanceTimers({ fakeDate: true });
  });

  it('a sensor restored without attributes stops "Waiting" within 190 s of its last update, on the sky clock alone', async () => {
    const card = await mountLive({ scenario: 'sky', transform: withoutSkyAttributes() });
    expect(skyPanelLine(card)).toBe('Waiting for aircraft data');
    const pushes = card.fake.calls.length;

    // HA's last_updated is the fixture's, 15 s before mount: still waiting at +150 s, never past +190 s.
    await advance(150_000);
    expect(skyPanelLine(card)).toBe('Waiting for aircraft data');
    await advance(40_000);
    expect(skyPanelLine(card)).toBe('No aircraft data from the sky sensor');
    expect(card.fake.calls.slice(pushes).filter((call) => call.method === 'callService')).toEqual([]);
  });

  it('data timestamped ahead of the device clock turns live within 10 s of coming within 60 s, same entity object', async () => {
    const card = await mountLive({ scenario: 'sky' });
    // The snapshot is dated 105 s ahead (2 min less the builders' 15 s lead): within tolerance after 45 s.
    await publishSky(card, skyPayload('normal', -2));
    expect(skyPanelLine(card)).toBe("Sky data is ahead of this device's clock");
    await advance(40_000);
    expect(skyPanelLine(card)).toBe("Sky data is ahead of this device's clock");
    await advance(15_000);
    expect(renderedText(skyRoot(card).querySelector('.count') ?? skyRoot(card))).toBe('8');
  });

  it('live data turns stale within 190 s and the open drawer stops drawing it within 15 min 10 s', async () => {
    const card = await mountLive({ scenario: 'sky' });
    const drawer = await openSkyDrawer(card);
    expect(skyRowButtons(drawer)).toHaveLength(8);
    // The fixture snapshot is 15 s old at mount.
    await advance(175_000);
    expect(skyPanelPill(card)).toEqual({ label: 'Not live', tone: 'attention' });
    expect(skyBanner(drawer)).toBe('Not live. Positions have changed since the last update.');
    await advance(15 * 60_000 - 190_000 + 10_000);
    expect(skyRowButtons(drawer)).toEqual([]);
    expect(skyBanner(drawer)).toBe('No fresh aircraft data.');
  });
});

function vehicleInput(scenario: 'normal' | 'starting' = 'normal'): Record<string, unknown> {
  return { ...(liveInput(scenario)['vehicle'] as Record<string, unknown>) };
}
