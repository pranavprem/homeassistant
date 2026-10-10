/**
 * ACCEPTANCE check 11 (§12.1 row 11): runtime content is escaped. Markup arriving in entity names, room names,
 * media titles, calendar summaries, the security health text and Home Assistant error messages renders as literal
 * text, and no element is ever created from it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FakeHassObject } from '../../src/dev/fake-hass.ts';
import type { HassLike } from '../../src/ha/types.ts';
import {
  advance,
  control,
  deepQueryAll,
  liveInput,
  mountLive,
  overlays,
  press,
  renderedText,
  section,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';
import {
  chooseSky,
  openSkyDrawer,
  publishSky,
  skyPayload,
  skyRoot,
  skyRowButtons,
  type SkyPayload,
} from './sky-support.ts';

const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';
const PLAYER = 'media_player.demo_living_room';
const CLIMATE = 'climate.demo_bedroom';
const READING_LAMP = 'light.demo_reading_lamp';
const HEALTH_TEXT = 'input_text.demo_security_health';
const HOUR_MS = 3_600_000;

beforeEach(() => {
  useAcceptanceTimers();
});

/** No element anywhere in the page was created from runtime text. */
function expectNoInjectedElements(card: LiveCard): void {
  for (const root of [card.root, overlays(card)]) {
    expect(deepQueryAll(root, 'script')).toEqual([]);
    expect(deepQueryAll(root, '[onerror], [onload], [onclick]')).toEqual([]);
    for (const image of deepQueryAll<HTMLImageElement>(root, 'img')) {
      expect(image.getAttribute('src') ?? '').toMatch(/^blob:/);
    }
  }
}

/** Calendar reads answer with one event whose summary is markup. */
function hostileCalendar(hass: FakeHassObject): HassLike {
  return {
    ...hass,
    callApi: <T>(method: 'GET', path: string): Promise<T> => {
      if (!path.startsWith('calendars/')) return hass.callApi<T>(method, path);
      const start = new Date(Date.now() + HOUR_MS).toISOString();
      const end = new Date(Date.now() + 2 * HOUR_MS).toISOString();
      return Promise.resolve([
        { uid: 'demo-hostile', summary: SCRIPT_PAYLOAD, start: { dateTime: start }, end: { dateTime: end } },
      ] as T);
    },
  };
}

/** Every service call is rejected by "HA" with markup in its validation message. */
function hostileRejection(hass: FakeHassObject): HassLike {
  return {
    ...hass,
    callService: () => Promise.reject({ code: 'service_validation_error', message: IMG_PAYLOAD }),
  };
}

describe('markup in runtime text renders as text', () => {
  it('a room name and entity friendly names', async () => {
    const card = await mountLive({
      input: liveInput('normal', {
        rooms: [{ name: IMG_PAYLOAD, lights: [READING_LAMP] }],
        climate: [CLIMATE],
        media: [PLAYER],
      }),
    });
    card.fake.setState(CLIMATE, 'cool', { friendly_name: SCRIPT_PAYLOAD });
    card.fake.setState(PLAYER, 'playing', { friendly_name: IMG_PAYLOAD });
    await advance(1_000);
    expect(renderedText(shadowOf(section(card, 'agr-home')))).toContain(IMG_PAYLOAD);
    expect(renderedText(shadowOf(section(card, 'agr-comfort')))).toContain(SCRIPT_PAYLOAD);
    expect(renderedText(shadowOf(section(card, 'agr-media')))).toContain(IMG_PAYLOAD);
    await press(control(shadowOf(section(card, 'agr-home')), 'room:0:open'));
    expect(renderedText(shadowOf(topOverlay(card)))).toContain(IMG_PAYLOAD);
    expectNoInjectedElements(card);
  });

  it('a media title and artist', async () => {
    const card = await mountLive();
    card.fake.setState(PLAYER, 'playing', { media_title: SCRIPT_PAYLOAD, media_artist: IMG_PAYLOAD });
    await advance(0);
    const media = renderedText(shadowOf(section(card, 'agr-media')));
    expect(media).toContain(SCRIPT_PAYLOAD);
    expect(media).toContain(IMG_PAYLOAD);
    expectNoInjectedElements(card);
  });

  it('a calendar event summary', async () => {
    const card = await mountLive({ transform: hostileCalendar });
    await advance(2_000);
    expect(renderedText(shadowOf(section(card, 'agr-upcoming')))).toContain(SCRIPT_PAYLOAD);
    expectNoInjectedElements(card);
  });

  it('the security health text', async () => {
    const card = await mountLive();
    card.fake.setState(HEALTH_TEXT, IMG_PAYLOAD);
    await advance(0);
    await press(control(shadowOf(section(card, 'agr-header')), 'header:security'));
    expect(renderedText(shadowOf(topOverlay(card)))).toContain(IMG_PAYLOAD);
    expectNoInjectedElements(card);
  });

  it("Home Assistant's rejection message", async () => {
    const card = await mountLive({ transform: hostileRejection });
    await press(control(shadowOf(section(card, 'agr-home')), 'room:1:toggle'));
    await advance(1_000);
    const home = renderedText(shadowOf(section(card, 'agr-home')));
    expect(home).toContain("Home Assistant didn't accept the request");
    expect(home).toContain(IMG_PAYLOAD);
    expectNoInjectedElements(card);
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Sky (AIRSPACE.md §2): the sensor's attributes are untrusted. Strings carrying markup are refused by the
// parser (the label charset excludes < > " { } \\), so what can still arrive is punctuation and entity-like text: it
// must render exactly as sent. If any of it went through an HTML parser, "&lt;" would decode to "<" and the text
// would differ, so comparing the rendered text with the raw string proves a text binding.

const ENTITY_TEXT = '&lt;img src=x onerror=alert(1)&gt;';
const HOSTILE_ATTRIBUTION = `Positions & routes: ${ENTITY_TEXT} 'quoted' a=b`;
const HOSTILE_AIRLINE = '&lt;b&gt;Example Air&lt;/b&gt;';
const HOSTILE_ORIGIN_NAME = "Example International' onmouseover='alert(1)";
const HOSTILE_SOURCE = 'VRS &amp; ADSB.lol';

/** The fixture's first (nearest, overhead) aircraft with a reported route whose labels are hostile but valid. */
function hostileRoutePayload(): SkyPayload {
  const payload = skyPayload('normal');
  const rows = payload['aircraft'] as readonly Readonly<Record<string, unknown>>[];
  const first = rows[0] as Readonly<Record<string, unknown>>;
  const route = {
    ...(first['route'] as Readonly<Record<string, unknown>>),
    airline: HOSTILE_AIRLINE,
    origin_name: HOSTILE_ORIGIN_NAME,
    source: HOSTILE_SOURCE,
  };
  return { ...payload, attribution: HOSTILE_ATTRIBUTION, aircraft: [{ ...first, route }, ...rows.slice(1)] };
}

describe('sky: untrusted sensor text renders as text', () => {
  it('entity-like text and quotes in the attribution and route render exactly as sent, as text nodes', async () => {
    const card = await mountLive({ scenario: 'sky' });
    await publishSky(card, hostileRoutePayload());
    const drawer = await openSkyDrawer(card);

    expect(drawer.querySelector('.attribution')?.textContent).toBe(HOSTILE_ATTRIBUTION);
    expect(drawer.querySelector('.route-airline')?.textContent).toBe(HOSTILE_AIRLINE);
    expect(drawer.querySelector('.route-names')?.textContent).toBe(`${HOSTILE_ORIGIN_NAME} → Sample Regional`);
    expect(renderedText(drawer.querySelector('.route-caption') as Element)).toBe(
      `Reported route · unverified · ${HOSTILE_SOURCE}`,
    );
    for (const selector of ['.attribution', '.route-airline', '.route-names']) {
      expect(drawer.querySelector(selector)?.children.length, `${selector} has element children`).toBe(0);
    }
    expect(deepQueryAll(drawer, '[onmouseover], [onerror], b, img')).toEqual([]);
    expectNoInjectedElements(card);
  });

  it('the hostile builder payload: markup, bidi and zero-width strings never reach the screen, nothing is injected', async () => {
    const card = await mountLive({ scenario: 'sky' });
    await publishSky(card, skyPayload('hostile'));
    const drawer = await openSkyDrawer(card);
    // Open every row in every view, so each surviving label, route and caption is rendered.
    const listed: Record<string, number> = {};
    const texts = [renderedText(skyRoot(card))];
    for (const view of ['nearby', 'overhead', 'recent']) {
      await chooseSky(drawer, 'view', view);
      listed[view] = skyRowButtons(drawer).length;
      for (const row of skyRowButtons(drawer)) {
        row.click();
        await advance(0);
        texts.push(renderedText(drawer));
      }
    }
    const text = texts.join(' ');

    // Valid rows survive (and are capped); the recent entry without last_seen is dropped.
    expect(listed).toEqual({ nearby: expect.any(Number), overhead: expect.any(Number), recent: 0 });
    expect(listed['nearby']).toBeGreaterThan(0);
    expect(listed['nearby']).toBeLessThanOrEqual(50);
    expect(text).not.toMatch(/<|>|script|alert/);
    expect(text).not.toMatch(/[\u200b\u202e\u2028\u00a0]/);
    expect(text).not.toMatch(/\b(lat|lon|latitude|longitude)\b/i);
    // The payload's own valid attribution keeps its ampersand and quotes literally.
    expect(drawer.querySelector('.attribution')?.textContent).toBe("Example positions & 'routes'");
    // Prototype keys in the payload never reach Object.prototype.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    // Identifiers, keys and ids are built from the validated six-digit hex only.
    for (const element of deepQueryAll(drawer, '[data-key], [aria-controls]')) {
      const key = element.getAttribute('data-key') ?? element.getAttribute('aria-controls') ?? '';
      expect(key).toMatch(/(^|-)[0-9a-f]{6}$|^(cloud|visibility|wind)/);
    }
    expectNoInjectedElements(card);
  });
});
