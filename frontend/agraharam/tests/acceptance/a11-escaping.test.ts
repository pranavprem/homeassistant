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
