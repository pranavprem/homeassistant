/**
 * ACCEPTANCE check 8 (§12.1 row 8): climate, lighting and media controls respect supported features and units,
 * and no displayed string can inject a target or a service.
 *
 * Feature bits and units are changed on the live entities (or the hass config) and the rendered controls and the
 * recorded calls are checked. Hostile-looking names and options are shown as data and sent only as data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FakeHassObject } from '../../src/dev/fake-hass.ts';
import { MEDIA_PLAYER_FEATURE as MEDIA } from '../../src/ha/features.ts';
import type { HassLike } from '../../src/ha/types.ts';
import {
  advance,
  control,
  deepQuery,
  deepQueryAll,
  liveInput,
  mountLive,
  press,
  renderedText,
  section,
  serviceCalls,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const CLIMATE = 'climate.demo_bedroom';
const PLAYER = 'media_player.demo_living_room';
const READING_LAMP = 'light.demo_reading_lamp';
const STEPPER_DEBOUNCE_MS = 800;
const SLIDER_DEBOUNCE_MS = 400;
const SETTLE_MS = 2_000;
const INJECTED_SOURCE = 'script.demo_disarm_hold';
const INJECTED_NAME = 'light.turn_off cover.demo_garage';

beforeEach(() => {
  useAcceptanceTimers();
});

function metric(hass: FakeHassObject): HassLike {
  return { ...hass, config: { ...hass.config, unit_system: { temperature: '°C', length: 'km' } } };
}

async function openClimate(card: LiveCard): Promise<ShadowRoot> {
  await press(control(shadowOf(section(card, 'agr-comfort')), `comfort:${CLIMATE}:open`));
  return shadowOf(topOverlay(card));
}

async function openMedia(card: LiveCard): Promise<ShadowRoot> {
  await press(control(shadowOf(section(card, 'agr-media')), 'media:players'));
  return shadowOf(topOverlay(card));
}

/** The range input labelled "Brightness" in the open room drawer, if the light offers one. */
function brightnessSlider(card: LiveCard): HTMLInputElement | null {
  const slider = deepQuery(shadowOf(topOverlay(card)), 'agr-slider[label="Brightness"]');
  return slider === null ? null : shadowOf(slider).querySelector('input[type="range"]');
}

function sentTemperatures(card: LiveCard): unknown[] {
  return serviceCalls(card.fake)
    .filter((call) => call.domain === 'climate' && call.service === 'set_temperature')
    .map((call) => (call.data as { temperature?: unknown }).temperature);
}

describe('climate: step and unit come from the entity and the unit system', () => {
  it('three + taps with target_temp_step 1 send one call, 75, in the entity unit', async () => {
    const card = await mountLive();
    const drawer = await openClimate(card);
    // Shown as "72°" like every temperature on the card; the scale letter stays in the text for assistive tech.
    expect(renderedText(drawer)).toMatch(/72°\s?F/);
    for (let tap = 0; tap < 3; tap += 1) await press(control(drawer, `climate:${CLIMATE}:target:up`));
    await advance(STEPPER_DEBOUNCE_MS + SETTLE_MS);
    expect(sentTemperatures(card)).toEqual([75]);
  });

  it('a half-degree step snaps an off-grid target to the grid (22.3 → 22.5) and shows °C', async () => {
    const card = await mountLive({ transform: metric });
    card.fake.setState(CLIMATE, 'cool', {
      temperature: 22.3,
      target_temp_step: 0.5,
      min_temp: 7,
      max_temp: 35,
      current_temperature: 23,
    });
    await advance(0);
    const drawer = await openClimate(card);
    expect(renderedText(drawer)).toMatch(/°\s?C/);
    expect(renderedText(drawer)).not.toMatch(/°\s?F/);
    await press(control(drawer, `climate:${CLIMATE}:target:up`));
    await advance(STEPPER_DEBOUNCE_MS + SETTLE_MS);
    expect(sentTemperatures(card)).toEqual([22.5]);
  });

  it('at max_temp the + step sends nothing above the maximum', async () => {
    const card = await mountLive();
    card.fake.setState(CLIMATE, 'cool', { temperature: 86 });
    await advance(0);
    const drawer = await openClimate(card);
    for (let tap = 0; tap < 3; tap += 1) await press(control(drawer, `climate:${CLIMATE}:target:up`));
    await advance(STEPPER_DEBOUNCE_MS + SETTLE_MS);
    for (const temperature of sentTemperatures(card)) expect(temperature).toBeLessThanOrEqual(86);
  });

  it('without the target temperature feature there is no stepper to press', async () => {
    const card = await mountLive();
    card.fake.setState(CLIMATE, 'cool', { supported_features: 0 });
    await advance(0);
    const drawer = await openClimate(card);
    const up = deepQuery<HTMLElement>(drawer, `[data-focus-key="climate:${CLIMATE}:target:up"]`);
    if (up !== null) {
      expect(up.getAttribute('aria-disabled')).toBe('true');
      await press(up);
    }
    await advance(STEPPER_DEBOUNCE_MS + SETTLE_MS);
    expect(sentTemperatures(card)).toEqual([]);
  });

  it('HVAC modes offered are exactly the entity hvac_modes', async () => {
    const card = await mountLive();
    card.fake.setState(CLIMATE, 'cool', { hvac_modes: ['off', 'cool'] });
    await advance(0);
    const drawer = await openClimate(card);
    const modes = deepQueryAll(drawer, 'agr-choice-group button').map((button) => renderedText(button));
    expect(modes).toEqual(['Off', 'Cool']);
  });
});

describe('lighting: brightness only where the light supports it', () => {
  it('an on/off-only light has no brightness slider; a dimmable one commits an integer percentage once', async () => {
    const card = await mountLive();
    card.fake.setState(READING_LAMP, 'on', { supported_color_modes: ['onoff'], color_mode: 'onoff' });
    await advance(0);
    await press(control(shadowOf(section(card, 'agr-home')), 'room:1:open'));
    expect(brightnessSlider(card)).toBeNull();

    card.fake.setState(READING_LAMP, 'on', { supported_color_modes: ['brightness'], brightness: 128 });
    await advance(0);
    const slider = brightnessSlider(card);
    expect(slider).not.toBeNull();
    for (const value of ['40', '55', '61']) {
      (slider as HTMLInputElement).value = value;
      slider?.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await advance(SLIDER_DEBOUNCE_MS + SETTLE_MS);
    const calls = serviceCalls(card.fake);
    expect(calls).toEqual([
      { domain: 'light', service: 'turn_on', data: { brightness_pct: 61 }, target: { entity_id: READING_LAMP } },
    ]);
  });
});

describe('media: transport shows only what the player supports', () => {
  it('without the next and previous bits those buttons are absent; with them they appear', async () => {
    const card = await mountLive();
    const media = shadowOf(section(card, 'agr-media'));
    expect(renderedText(media)).toContain('Next track');
    card.fake.setState(PLAYER, 'playing', { supported_features: MEDIA.PLAY | MEDIA.PAUSE | MEDIA.VOLUME_SET });
    await advance(0);
    expect(renderedText(media)).not.toContain('Next track');
    expect(renderedText(media)).not.toContain('Previous track');
    expect(renderedText(media)).toContain('Pause');
  });

  it('volume commits a level in 0..1, rounded, once per gesture', async () => {
    const card = await mountLive();
    const slider = deepQueryAll<HTMLInputElement>(shadowOf(section(card, 'agr-media')), 'input[type="range"]')[0];
    (slider as HTMLInputElement).value = '47';
    slider?.dispatchEvent(new Event('change', { bubbles: true }));
    await advance(SLIDER_DEBOUNCE_MS + SETTLE_MS);
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'media_player', service: 'volume_set', data: { volume_level: 0.47 }, target: { entity_id: PLAYER } },
    ]);
  });
});

describe('displayed strings are data, never targets or services', () => {
  it('a source named like a script ID is sent as select_source data to the player, nothing else', async () => {
    const card = await mountLive();
    card.fake.setState(PLAYER, 'playing', { source_list: ['Demo Music', INJECTED_SOURCE] });
    await advance(0);
    const drawer = await openMedia(card);
    const option = deepQueryAll<HTMLButtonElement>(drawer, 'agr-choice-group button').find(
      (button) => renderedText(button) === INJECTED_SOURCE,
    );
    expect(option).toBeDefined();
    await press(option as HTMLButtonElement);
    expect(serviceCalls(card.fake)).toEqual([
      {
        domain: 'media_player',
        service: 'select_source',
        data: { source: INJECTED_SOURCE },
        target: { entity_id: PLAYER },
      },
    ]);
  });

  it('a light whose friendly name looks like a service call still toggles only that light', async () => {
    const card = await mountLive({
      input: liveInput('normal', { rooms: [{ name: INJECTED_NAME, lights: [READING_LAMP] }] }),
    });
    card.fake.setState(READING_LAMP, 'off', { friendly_name: INJECTED_NAME });
    await advance(0);
    const home = shadowOf(section(card, 'agr-home'));
    expect(renderedText(home)).toContain(INJECTED_NAME);
    await press(control(home, 'room:0:toggle'));
    expect(serviceCalls(card.fake)).toEqual([
      expect.objectContaining({ domain: 'light', service: 'turn_on', data: {} }),
    ]);
    expect([(serviceCalls(card.fake)[0]?.target as { entity_id: unknown }).entity_id].flat()).toEqual([READING_LAMP]);
  });
});
