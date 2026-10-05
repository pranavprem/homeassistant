/**
 * ACCEPTANCE check 5 (§12.1 row 5): one deliberate tap produces one correctly scoped service action; repeated
 * taps, a service rejection, a delayed acknowledgement and a timeout behave visibly and safely (no retry, ever).
 *
 * Everything is driven through the rendered controls of the live card; the recorded FakeHass calls are the proof.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  control,
  deepQueryAll,
  mountLive,
  renderedText,
  section,
  serviceCalls,
  settle,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  type LiveCard,
  type RecordedServiceCall,
} from './support.ts';

const READING_LAMP = 'light.demo_reading_lamp';
const HALL_FAN = 'fan.demo_hall_air_mover';
const LIGHT_TIMEOUT_MS = 10_000;
const FAN_TIMEOUT_MS = 20_000;

beforeEach(() => {
  useAcceptanceTimers();
});

function home(card: LiveCard): ShadowRoot {
  return shadowOf(section(card, 'agr-home'));
}

/** The Home section's single polite live region and any visible ticket text. */
function homeStatus(card: LiveCard): string {
  return deepQueryAll(home(card), 'agr-control-notes')
    .map((status) => renderedText(status))
    .join(' ');
}

/** The target's entity_id as a list: HA accepts a string or a list, and both name the same scope. */
function targets(call: RecordedServiceCall | undefined): string[] {
  const entityId = (call?.target as { entity_id?: string | string[] } | undefined)?.entity_id;
  return entityId === undefined ? [] : [entityId].flat();
}

describe('one tap, one correctly scoped call', () => {
  it('the room quick toggle turns on exactly the room lights, with no extra data', async () => {
    const card = await mountLive();
    control(home(card), 'room:1:toggle').click();
    await settle();
    const calls = serviceCalls(card.fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ domain: 'light', service: 'turn_on', data: {} });
    expect(targets(calls[0])).toEqual([READING_LAMP]);
  });

  it('a light toggle in the room drawer targets only that light', async () => {
    const card = await mountLive();
    control(home(card), 'room:0:open').click();
    await settle();
    const drawer = shadowOf(topOverlay(card));
    control(drawer, 'room-drawer:0:light:light.demo_courtyard_lantern:toggle').click();
    await settle();
    const calls = serviceCalls(card.fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ domain: 'light', data: {} });
    expect(targets(calls[0])).toEqual(['light.demo_courtyard_lantern']);
  });

  it('the vacuum Start button sends vacuum.start to that vacuum only', async () => {
    const card = await mountLive();
    control(home(card), 'vacuum:vacuum.demo_pebble:start').click();
    await settle();
    expect(serviceCalls(card.fake)).toEqual([
      expect.objectContaining({ domain: 'vacuum', service: 'start', data: {} }),
    ]);
    expect(targets(serviceCalls(card.fake)[0])).toEqual(['vacuum.demo_pebble']);
  });

  it('the media transport sends media_pause to the active player', async () => {
    const card = await mountLive();
    const media = shadowOf(section(card, 'agr-media'));
    control(media, 'media:media_player.demo_living_room:play-pause').click();
    await settle();
    expect(serviceCalls(card.fake)).toEqual([
      expect.objectContaining({ domain: 'media_player', service: 'media_pause', data: {} }),
    ]);
    expect(targets(serviceCalls(card.fake)[0])).toEqual(['media_player.demo_living_room']);
  });
});

describe('repeated taps', () => {
  it('five rapid taps while the first is in flight send one call; after it confirms, a new tap is a new call', async () => {
    const card = await mountLive();
    for (let tap = 0; tap < 5; tap += 1) {
      control(home(card), 'room:1:toggle').click();
      await settle();
    }
    expect(serviceCalls(card.fake)).toHaveLength(1);
    await advance(1_000); // the simulated device turns on and the ticket confirms
    expect(renderedText(control(home(card), 'room:1:toggle'))).toContain('Turn off');
    control(home(card), 'room:1:toggle').click();
    await settle();
    const calls = serviceCalls(card.fake);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ domain: 'light', service: 'turn_off' });
  });

  it('a held key (repeat keydowns) is suppressed by the button, so it cannot click repeatedly', async () => {
    const card = await mountLive();
    const toggle = control(home(card), 'room:1:toggle');
    const repeated = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    toggle.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(true);
  });
});

describe('delayed acknowledgement, rejection and timeout', () => {
  it('a slow device: "Sending" or "Waiting" while it works, then "Done"; still one call', async () => {
    const card = await mountLive({ latencyMs: [5_000, 5_000] });
    control(home(card), 'room:1:toggle').click();
    await advance(1_000);
    expect(homeStatus(card)).toMatch(/Sending|Waiting/);
    await advance(5_000);
    expect(homeStatus(card)).toMatch(/Done/);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });

  it("a rejected call shows Home Assistant's reason and is not retried", async () => {
    const card = await mountLive({ scenario: 'degraded' });
    control(home(card), 'room:2:toggle').click(); // the Kitchen light rejects with a validation error
    await advance(2_000);
    expect(homeStatus(card)).toMatch(/Home Assistant didn't accept the request/);
    await advance(60_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });

  it('a device that never confirms ends uncertain after its timeout, says so, and is not retried', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    control(shadowOf(section(card, 'agr-comfort')), 'comfort:more').click();
    await settle();
    const drawer = shadowOf(topOverlay(card));
    control(drawer, `climate:${HALL_FAN}:power`).click();
    await advance(FAN_TIMEOUT_MS + 1_000);
    expect(renderedText(drawer)).toMatch(/didn't confirm within 20 seconds/);
    await advance(120_000);
    const calls = serviceCalls(card.fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ domain: 'fan', service: 'turn_on' });
    expect(targets(calls[0])).toEqual([HALL_FAN]);
  });

  it('a connection lost mid-call is reported as uncertain, never as done, and not retried', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    control(shadowOf(section(card, 'agr-media')), 'media:players').click();
    await settle();
    const drawer = shadowOf(topOverlay(card));
    const source = deepQueryAll<HTMLButtonElement>(drawer, 'agr-choice-group:not([label="Players"]) button').find(
      (button) => button.getAttribute('aria-pressed') === 'false' && button.getAttribute('aria-disabled') !== 'true',
    );
    expect(source).toBeDefined();
    source?.click();
    await advance(2_000);
    expect(renderedText(drawer)).toMatch(/may or may not have reached/);
    await advance(LIGHT_TIMEOUT_MS * 6);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });
});

describe('choice groups: browsing never acts, one activation is one call', () => {
  const CLIMATE = 'climate.demo_bedroom';
  const ACTIVE_PLAYER = 'media_player.demo_living_room';
  /** Keys that move the selection in radio groups and listboxes; a choice group must ignore every one. */
  const NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

  function options(drawer: ShadowRoot, prefix: string): HTMLButtonElement[] {
    return deepQueryAll<HTMLButtonElement>(drawer, `[data-focus-key^="${prefix}"]`);
  }

  function browse(option: HTMLButtonElement): void {
    option.focus();
    for (const key of NAVIGATION_KEYS) {
      option.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));
      option.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true, cancelable: true }));
    }
  }

  it.each([
    {
      name: 'HVAC modes',
      section: 'agr-comfort',
      open: `comfort:${CLIMATE}:open`,
      prefix: `climate:${CLIMATE}:mode:`,
      choose: 'heat',
      call: { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: 'heat' } },
      target: CLIMATE,
    },
    {
      name: 'media sources',
      section: 'agr-media',
      open: 'media:players',
      prefix: `media-drawer:${ACTIVE_PLAYER}:source:`,
      choose: 'Demo Radio',
      call: { domain: 'media_player', service: 'select_source', data: { source: 'Demo Radio' } },
      target: ACTIVE_PLAYER,
    },
  ])(
    '$name: arrow, Home, End and Page keys on every option send nothing; one activation sends one call and locks the group',
    async (group) => {
      const card = await mountLive();
      control(shadowOf(section(card, group.section)), group.open).click();
      await settle();
      const drawer = shadowOf(topOverlay(card));
      const all = options(drawer, group.prefix);
      expect(all.length).toBeGreaterThan(2);

      for (const option of all) browse(option);
      await advance(2_000);
      expect(serviceCalls(card.fake)).toEqual([]);

      control(drawer, `${group.prefix}${group.choose}`).click();
      await settle();
      const calls = serviceCalls(card.fake);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject(group.call);
      expect(targets(calls[0])).toEqual([group.target]);
      // While the ticket is in flight every option refuses, and the pressed option follows only the observed state.
      for (const option of options(drawer, group.prefix)) {
        expect(option.getAttribute('aria-disabled')).toBe('true');
      }
      expect(control(drawer, `${group.prefix}${group.choose}`).getAttribute('aria-pressed')).toBe('false');
    },
  );
});
