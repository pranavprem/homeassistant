/**
 * ACCEPTANCE check 9 (§12.1 row 9): camera privacy on or unknown prevents any still fetch and any stream startup;
 * dismissing or unmounting releases streams.
 *
 * "Fetch" is observed as hass.fetchWithAuth calls for that camera's proxy path (FakeHass records each). Native live
 * view is observed through stubbed card helpers; without them the dialog uses the snapshot fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESYNC_GRACE_MS } from '../../src/ha/resync.ts';
import {
  advance,
  control,
  deepQuery,
  deepQueryAll,
  expectNoMutation,
  fetchesFor,
  mountLive,
  overlays,
  press,
  renderedText,
  revealAll,
  section,
  settle,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const FRONT_GATE = 'camera.demo_front_gate';
const SIDE_PATH = 'camera.demo_side_path';
const COURTYARD = 'camera.demo_courtyard';
const HALL = 'camera.demo_hall';
const HALL_PRIVACY = 'switch.demo_hall_camera_privacy';
const HALL_INDEX = 3;
const A_MINUTE_MS = 60_000;

type EmbeddedCard = HTMLElement & { hass?: unknown };

beforeEach(() => {
  useAcceptanceTimers();
});

afterEach(() => {
  delete window.loadCardHelpers;
});

function cameras(card: LiveCard): ShadowRoot {
  return shadowOf(section(card, 'agr-cameras'));
}

/** The rendered tree of one camera tile, in panel order. */
function tile(card: LiveCard, index: number): ShadowRoot {
  const found = deepQueryAll(cameras(card), 'agr-camera-tile')[index];
  if (found === undefined) throw new Error(`no camera tile ${index}`);
  return shadowOf(found);
}

/** Stubs HA's card helpers; every created embedded card is recorded. */
function stubLiveHelpers(): EmbeddedCard[] {
  const created: EmbeddedCard[] = [];
  window.loadCardHelpers = vi.fn(() =>
    Promise.resolve({
      createCardElement: vi.fn(() => {
        const element = document.createElement('div') as EmbeddedCard;
        created.push(element);
        return element;
      }),
    }),
  );
  return created;
}

/** Mounts normal with the Hall camera's privacy switch off, so Hall starts out allowed. */
async function mountWithHallVisible(): Promise<LiveCard> {
  const card = await mountLive();
  card.fake.setState(HALL_PRIVACY, 'off');
  await settle();
  revealAll();
  await advance(500);
  return card;
}

describe('privacy on, unknown or unexpected: no still and no live view, ever', () => {
  it('normal: the privacy-on camera is never fetched and offers no live view; the others are fetched', async () => {
    const card = await mountLive();
    revealAll();
    await advance(A_MINUTE_MS);
    expect(fetchesFor(card.fake, HALL)).toEqual([]);
    expect(fetchesFor(card.fake, FRONT_GATE).length).toBeGreaterThan(0);
    const hall = tile(card, HALL_INDEX);
    expect(renderedText(hall)).toContain('Privacy on');
    expect(deepQuery(hall, 'button')).toBeNull();
    expect(deepQuery(hall, 'img')).toBeNull();
  });

  it('degraded: privacy unknown, an unexpected privacy string and an offline camera are never fetched', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    revealAll();
    await advance(A_MINUTE_MS);
    for (const camera of [FRONT_GATE, SIDE_PATH, COURTYARD, HALL]) expect(fetchesFor(card.fake, camera)).toEqual([]);
    expect(deepQueryAll(cameras(card), 'agr-camera-tile button')).toEqual([]);
  });

  it('privacy turning on stops fetching at once and drops the picture', async () => {
    const card = await mountWithHallVisible();
    expect(fetchesFor(card.fake, HALL).length).toBeGreaterThan(0);
    expect(deepQuery(tile(card, HALL_INDEX), 'img')).not.toBeNull();
    card.fake.setState(HALL_PRIVACY, 'on');
    await settle();
    const fetches = fetchesFor(card.fake, HALL).length;
    expect(deepQuery(tile(card, HALL_INDEX), 'img')).toBeNull();
    expect(renderedText(tile(card, HALL_INDEX))).toContain('Privacy on');
    await advance(A_MINUTE_MS);
    expect(fetchesFor(card.fake, HALL)).toHaveLength(fetches);
  });

  it('privacy turned on during an outage: nothing is fetched before or after the reconnect snapshot', async () => {
    const card = await mountWithHallVisible();
    card.fake.disconnect();
    await advance(0);
    const fetchesBeforeOutage = fetchesFor(card.fake, HALL).length;
    expect(deepQuery(tile(card, HALL_INDEX), 'img')).toBeNull(); // pictures are dropped while disconnected
    card.fake.queueOutageChange(HALL_PRIVACY, 'on');
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(200); // resyncing: old states, barrier armed
    expect(fetchesFor(card.fake, HALL)).toHaveLength(fetchesBeforeOutage);
    await advance(A_MINUTE_MS);
    expect(fetchesFor(card.fake, HALL)).toHaveLength(fetchesBeforeOutage);
    expect(renderedText(tile(card, HALL_INDEX))).toContain('Privacy on');
  });

  it('a reconnect no runtime saw: Reconnecting for the grace, then privacy-off cameras resume and stay live', async () => {
    const card = await mountWithHallVisible();
    card.stopPushes();
    card.card.remove();
    await advance(61_000); // orphan disposal: the runtime that observed the house is gone
    card.fake.disconnect();
    card.fake.queueOutageChange(HALL_PRIVACY, 'on');
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(0); // the snapshot lands while nothing observes it
    const courtyardBefore = fetchesFor(card.fake, COURTYARD).length;
    const hallBefore = fetchesFor(card.fake, HALL).length;

    document.body.append(card.card);
    card.card.hass = card.fake.hass; // HA pushes its current hass to the re-added panel
    const stop = card.fake.onPush((hass) => {
      card.card.hass = hass;
    });
    await settle();
    revealAll();
    await advance(RESYNC_GRACE_MS - 100);
    expect(card.services()?.reader.connection().phase).toBe('resyncing');
    expect(fetchesFor(card.fake, COURTYARD)).toHaveLength(courtyardBefore);

    await advance(100);
    expect(card.services()?.reader.connection().phase).toBe('connected');
    await advance(1_000);
    const courtyardAfterGrace = fetchesFor(card.fake, COURTYARD).length;
    expect(courtyardAfterGrace).toBeGreaterThan(courtyardBefore);
    // An unrelated change keeps every unchanged camera fresh (before the fix it froze them as uncertain).
    card.fake.setState(FRONT_GATE, 'idle', { access_token: 'rotated-after-reconnect' });
    await advance(A_MINUTE_MS);
    expect(fetchesFor(card.fake, COURTYARD).length).toBeGreaterThan(courtyardAfterGrace);
    expect(renderedText(tile(card, 2))).not.toContain('Privacy status unavailable');
    expect(fetchesFor(card.fake, HALL)).toHaveLength(hallBefore);
    expect(renderedText(tile(card, HALL_INDEX))).toContain('Privacy on');
    expectNoMutation(card.fake);
    stop();
  });

  it('a privacy entity the snapshot did not refresh stays closed as "Privacy status unavailable"', async () => {
    const card = await mountWithHallVisible();
    card.fake.disconnect();
    card.fake.deleteDuringOutage(HALL_PRIVACY);
    await advance(0);
    const fetches = fetchesFor(card.fake, HALL).length;
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(A_MINUTE_MS);
    expect(fetchesFor(card.fake, HALL)).toHaveLength(fetches);
    expect(renderedText(tile(card, HALL_INDEX))).toContain('Privacy status unavailable');
  });
});

describe('live view: never started under privacy, always released on dismiss and unmount', () => {
  it('privacy turning on while the live view is open disposes the embedded stream', async () => {
    const created = stubLiveHelpers();
    const card = await mountWithHallVisible();
    await press(control(tile(card, HALL_INDEX), 'camera:3:live'));
    await advance(100);
    expect(created).toHaveLength(1);
    expect(created[0]?.isConnected).toBe(true);
    card.fake.setState(HALL_PRIVACY, 'on');
    await advance(100);
    expect(created[0]?.isConnected).toBe(false);
    expect(created).toHaveLength(1);
    expect(renderedText(shadowOf(topOverlay(card)))).toContain('Privacy on');
  });

  it('closing the live view releases the embedded stream; reopening creates a new one', async () => {
    const created = stubLiveHelpers();
    const card = await mountLive();
    revealAll();
    await advance(500);
    await press(control(tile(card, 0), 'camera:0:live'));
    await advance(100);
    expect(created[0]?.isConnected).toBe(true);
    await press(shadowOf(topOverlay(card)).querySelector('button.close') as HTMLButtonElement);
    await advance(100);
    expect(created[0]?.isConnected).toBe(false);
    await press(control(tile(card, 0), 'camera:0:live'));
    await advance(100);
    expect(created).toHaveLength(2);
    expect(created[1]?.isConnected).toBe(true);
  });

  it('removing the card with the live view open releases the stream', async () => {
    const created = stubLiveHelpers();
    const card = await mountLive();
    revealAll();
    await advance(500);
    await press(control(tile(card, 0), 'camera:0:live'));
    await advance(100);
    card.card.remove();
    await settle();
    expect(created[0]?.isConnected).toBe(false);
    expect(overlays(card).querySelector('agr-camera-dialog')).toBeNull();
  });

  it('the snapshot fallback stops fetching when the dialog closes and when the card is removed', async () => {
    const card = await mountLive(); // FakeHass has no card helpers: the dialog falls back to 2 s snapshots
    revealAll();
    await advance(500);
    await press(control(tile(card, 0), 'camera:0:live'));
    await advance(5_000);
    expect(renderedText(shadowOf(topOverlay(card)))).toContain('Snapshot view. Refreshes every 2 seconds.');
    const tileCadenceFetches = (ms: number): number => Math.ceil(ms / 10_000) + 1;
    await press(shadowOf(topOverlay(card)).querySelector('button.close') as HTMLButtonElement);
    const afterClose = fetchesFor(card.fake, FRONT_GATE).length;
    await advance(20_000);
    // Only the tile's own 10 s cadence continues; the dialog's 2 s refresh has stopped.
    expect(fetchesFor(card.fake, FRONT_GATE).length - afterClose).toBeLessThanOrEqual(tileCadenceFetches(20_000));

    await press(control(tile(card, 0), 'camera:0:live'));
    await advance(3_000);
    card.card.remove();
    await settle();
    const afterRemove = fetchesFor(card.fake, FRONT_GATE).length;
    await advance(A_MINUTE_MS);
    expect(fetchesFor(card.fake, FRONT_GATE)).toHaveLength(afterRemove);
  });

  it('the live view never starts for a camera whose privacy is on, even when asked directly', async () => {
    const created = stubLiveHelpers();
    const card = await mountLive();
    revealAll();
    await advance(500);
    const trigger = cameras(card).host as HTMLElement;
    trigger.dispatchEvent(
      new CustomEvent('agr-open-drawer', {
        bubbles: true,
        composed: true,
        detail: { request: { id: 'camera', entity: HALL }, trigger },
      }),
    );
    await advance(1_000);
    expect(created).toEqual([]);
    expect(fetchesFor(card.fake, HALL)).toEqual([]);
    expect(renderedText(shadowOf(topOverlay(card)))).toContain('Privacy on');
  });
});
