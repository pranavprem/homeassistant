/**
 * ACCEPTANCE check 4 (§12.1 row 4): offline and unauthorized controls are disabled, and no queued action replays on
 * reconnect.
 *
 * Every button on the card is pressed while disconnected. A button that opens something (a drawer or dialog) is
 * navigation and stays usable; every other button must be aria-disabled (so it stays focusable and announces why)
 * and press without effect. Nothing may be sent then, during the post-reconnect resync barrier, or afterwards.
 * Real Enter and Space on a disabled button are covered by e2e/keyboard.spec.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import type { EntityId } from '../../src/config/schema.ts';
import { deepActive } from '../helpers/dom.ts';
import {
  advance,
  buttons,
  control,
  deepQueryAll,
  describedBy,
  liveInput,
  mountLive,
  renderedText,
  section,
  serviceCalls,
  settle,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  writeCalls,
  type LiveCard,
} from './support.ts';
import {
  chooseSky,
  closeOverlays as closeSkyOverlays,
  openSkyDrawer,
  openWeatherDrawer,
  publishSky,
  radarLive,
  SKY,
  skyBanner,
  skyPanelLine,
  skyPanelPill,
  skyPayload,
  skyRoot,
  skyRowButtons,
  type SkyPayload,
} from './sky-support.ts';

const PAUSED = 'Paused while Home Assistant is disconnected.';
const RESYNCING = 'Paused until Home Assistant sends current states.';
const COLUMN_SECTIONS = [
  'agr-today',
  'agr-comfort',
  'agr-home',
  'agr-cameras',
  'agr-garage',
  'agr-media',
  'agr-health',
];
const SNAPSHOT_DELAY_MS = 10_000;
const SLIDER_DEBOUNCE_MS = 400;
const STEPPER_DEBOUNCE_MS = 800;

beforeEach(() => {
  useAcceptanceTimers();
});

function closeOverlays(card: LiveCard): void {
  (card.root.querySelector('agr-overlay-host') as AgrOverlayHost).closeAll();
  card.root.querySelector<HTMLElement>('.frame')?.focus();
}

function label(button: HTMLButtonElement): string {
  return renderedText(button) || (button.getAttribute('data-focus-key') ?? 'unnamed button');
}

interface PressReport {
  readonly disabled: string[];
  readonly navigation: string[];
}

/**
 * Presses every button under `root` (re-querying after each press, because a press may re-render). A press that
 * mounts an overlay is navigation; anything else must be aria-disabled with `reason`, focusable, and inert.
 */
async function pressEverything(card: LiveCard, root: ParentNode, reason: string): Promise<PressReport> {
  const report: PressReport = { disabled: [], navigation: [] };
  for (const button of buttons(root)) {
    if (!button.isConnected) continue;
    const name = label(button);
    const disabled = button.getAttribute('aria-disabled') === 'true';
    button.focus();
    button.click();
    await settle();
    const opened = topOverlay(card) !== undefined;
    if (opened) {
      report.navigation.push(name);
      closeOverlays(card);
      await settle();
      continue;
    }
    expect(disabled, `"${name}" acted while disconnected`).toBe(true);
    expect(describedBy(button), `"${name}" has no reason`).toContain(reason);
    expect(button.disabled, `"${name}" uses native disabled and leaves the tab order`).toBe(false);
    expect(button.tabIndex, `"${name}" is not focusable`).toBeGreaterThanOrEqual(0);
    expect(deepActive(), `"${name}" did not take focus`).toBe(button);
    report.disabled.push(name);
  }
  return report;
}

/** Opens a drawer through its real trigger, then presses everything inside except Close and local view controls. */
async function pressInDrawer(card: LiveCard, trigger: HTMLElement, reason: string): Promise<string[]> {
  trigger.click();
  await settle();
  const drawer = topOverlay(card);
  if (drawer === undefined) throw new Error('the trigger opened no drawer');
  const disabled: string[] = [];
  for (const button of buttons(shadowOf(drawer))) {
    // Close and the media drawer's player picker are view controls, not actions (§5.3).
    if (button.classList.contains('close') || button.dataset['focusKey']?.startsWith('media-drawer:pick:')) continue;
    const name = label(button);
    expect(button.getAttribute('aria-disabled'), `"${name}" in the drawer is enabled while disconnected`).toBe('true');
    // The observed current option of a choice group keeps its own reason ("Current mode"): it never sends anyway.
    const expected = button.getAttribute('aria-pressed') === 'true' ? new RegExp(`${reason}|^Current `) : reason;
    expect(describedBy(button), `"${name}" in the drawer has no reason`).toMatch(expected);
    button.click();
    await settle();
    disabled.push(name);
  }
  for (const range of deepQueryAll<HTMLInputElement>(shadowOf(drawer), 'input[type="range"]')) {
    expect(range.disabled).toBe(true);
  }
  closeOverlays(card);
  await settle();
  return disabled;
}

function columnRoots(card: LiveCard): ShadowRoot[] {
  return COLUMN_SECTIONS.flatMap((tag) => {
    const element = card.root.querySelector(tag);
    return element === null ? [] : [shadowOf(element)];
  });
}

describe('while disconnected every action control is disabled with its reason, and nothing is sent', () => {
  it('every button in every panel: aria-disabled with the reason, focusable, inert; navigation still opens', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    const disabled: string[] = [];
    const navigation: string[] = [];
    for (const root of columnRoots(card)) {
      const report = await pressEverything(card, root, PAUSED);
      disabled.push(...report.disabled);
      navigation.push(...report.navigation);
    }
    expect(disabled).toEqual(
      expect.arrayContaining(['Turn on Reading room lights', 'Open garage', 'Start Pebble', 'Pause', 'Next track']),
    );
    expect(navigation.length).toBeGreaterThan(0);
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('inside the room, climate, media and security drawers every action is disabled with the reason', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    const home = shadowOf(section(card, 'agr-home'));
    const room = await pressInDrawer(card, control(home, 'room:1:open'), PAUSED);
    const climate = await pressInDrawer(
      card,
      control(shadowOf(section(card, 'agr-comfort')), 'comfort:climate.demo_bedroom:open'),
      PAUSED,
    );
    const media = await pressInDrawer(card, control(shadowOf(section(card, 'agr-media')), 'media:players'), PAUSED);
    const header = shadowOf(section(card, 'agr-header'));
    const security = await pressInDrawer(card, control(header, 'header:security'), PAUSED);
    expect(room).toEqual(expect.arrayContaining(['All on', 'Turn on Reading lamp', 'Open']));
    expect(climate).toEqual(expect.arrayContaining(['Heat', 'Increase Target temperature']));
    expect(media).toEqual(expect.arrayContaining(['Demo Radio']));
    expect(security).toEqual(expect.arrayContaining(['Disarm & hold', 'Silence sound', 'Prepare garage departure']));
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });
});

describe('the banner says it once: each panel shows an "Offline" pill instead of repeating the sentence', () => {
  it('while disconnected every column panel carries the pill and no visible paused notice', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    for (const tag of [...COLUMN_SECTIONS, 'agr-upcoming']) {
      const root = shadowOf(section(card, tag));
      const panel = root.querySelector('agr-panel') as (HTMLElement & { pill?: unknown }) | null;
      expect(panel?.pill, `${tag} pill`).toEqual({ label: 'Offline', tone: 'muted', icon: 'wifi-off' });
      const notices = [...root.querySelectorAll('.notice, .reason, .paused')].map((element) => renderedText(element));
      expect(
        notices.filter((text) => text.includes(PAUSED)),
        `${tag} repeats the banner`,
      ).toEqual([]);
    }
    // The controls still carry the full sentence for assistive technology (checked button by button above).
    expect(describedBy(control(shadowOf(section(card, 'agr-garage')), 'garage:open'))).toContain(PAUSED);
  });
});

describe('the resync barrier keeps controls paused until current states arrive', () => {
  it('two-step reconnect: still paused (resync reason) and "Last known" before the snapshot; live after, 0 calls', async () => {
    const card = await mountLive();
    const home = shadowOf(section(card, 'agr-home'));
    const garage = shadowOf(section(card, 'agr-garage'));
    card.fake.disconnect();
    await advance(0);
    card.fake.reconnect({ snapshotDelayMs: SNAPSHOT_DELAY_MS });
    await advance(0);

    for (const focusKey of ['room:1:toggle', 'garage:open']) {
      const button = control(focusKey === 'garage:open' ? garage : home, focusKey);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(describedBy(button)).toContain(RESYNCING);
    }
    for (const root of columnRoots(card)) await pressEverything(card, root, RESYNCING);
    expect(renderedText(shadowOf(section(card, 'agr-header')))).toMatch(/Last known/);
    expect(renderedText(shadowOf(section(card, 'agr-header')))).toContain('Reconnecting');

    await advance(SNAPSHOT_DELAY_MS);
    expect(control(home, 'room:1:toggle').getAttribute('aria-disabled')).toBeNull();
    expect(control(garage, 'garage:open').getAttribute('aria-disabled')).toBeNull();
    expect(renderedText(shadowOf(section(card, 'agr-header')))).not.toMatch(/Last known/);
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });
});

describe('nothing queued is replayed on reconnect', () => {
  it('a volume slider commit still debouncing when the connection drops is never sent, and shows "Not sent"', async () => {
    const card = await mountLive();
    const media = shadowOf(section(card, 'agr-media'));
    const slider = deepQueryAll<HTMLInputElement>(media, 'input[type="range"]')[0] as HTMLInputElement;
    slider.value = '60';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await advance(SLIDER_DEBOUNCE_MS / 2);
    card.fake.disconnect();
    await advance(SLIDER_DEBOUNCE_MS * 4);
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(5_000);
    expect(writeCalls(card.fake)).toEqual([]);
    expect(renderedText(media)).toContain('Not sent');
  });

  it('a stepper draft interrupted by a disconnect is never sent after reconnecting', async () => {
    const card = await mountLive();
    control(shadowOf(section(card, 'agr-comfort')), 'comfort:climate.demo_bedroom:open').click();
    await settle();
    const drawer = topOverlay(card) as Element;
    control(shadowOf(drawer), 'climate:climate.demo_bedroom:target:up').click();
    await advance(STEPPER_DEBOUNCE_MS / 2);
    card.fake.disconnect();
    await advance(STEPPER_DEBOUNCE_MS * 2);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(5_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('a press while disconnected sends nothing then or after reconnecting', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    control(shadowOf(section(card, 'agr-home')), 'room:1:toggle').click();
    control(shadowOf(section(card, 'agr-garage')), 'garage:open').click();
    await advance(1_000);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('a call in flight when the connection drops is not repeated after the reconnect', async () => {
    const card = await mountLive();
    control(shadowOf(section(card, 'agr-home')), 'room:1:toggle').click();
    await settle();
    expect(serviceCalls(card.fake)).toHaveLength(1);
    card.fake.disconnect();
    await advance(100);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(60_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });
});

describe('an unauthorized user sees the permission message and the control stays disabled', () => {
  it('restricted: the first tap is rejected as Unauthorized, the button then refuses further taps', async () => {
    const card = await mountLive({ scenario: 'restricted' });
    const home = shadowOf(section(card, 'agr-home'));
    control(home, 'room:1:toggle').click();
    await advance(1_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
    const toggle = control(home, 'room:1:toggle');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(renderedText(home)).toMatch(/can't control .+\. Ask an administrator for access\./);
    toggle.click();
    await advance(1_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Sky (AIRSPACE.md §4, §6): offline is a layer over data only. Live, empty or stale data turns "offline"
// and is never depicted live; an entity that is not data (unavailable, malformed, unsupported, missing) stays what it
// is, under the shared Offline pill. Sky navigation and its view controls are not actions, so they stay usable.

const OFFLINE_PILL = { label: 'Offline', tone: 'muted', icon: 'wifi-off' };
const SKY_OFFLINE_LINE = 'Not live while Home Assistant is offline';

/** Mounts the sky scenario, publishes `payload` (or keeps the fixture's), then drops the connection. */
async function skyOffline(payload?: SkyPayload): Promise<LiveCard> {
  const card = await mountLive({ scenario: 'sky' });
  if (payload !== undefined) await publishSky(card, payload);
  card.fake.disconnect();
  await advance(0);
  return card;
}

describe('sky: offline is a layer over live, empty and stale data, never shown as live', () => {
  it('live data: the Offline pill and line, then the last list in the drawer, muted, hollow and unemphasised', async () => {
    const card = await skyOffline();
    expect(skyPanelPill(card)).toEqual(OFFLINE_PILL);
    expect(skyPanelLine(card)).toBe(SKY_OFFLINE_LINE);
    expect(skyRoot(card).querySelector('.count, .nearest')).toBeNull();

    const drawer = await openSkyDrawer(card);
    expect(drawer.querySelector('.banner')?.getAttribute('data-status')).toBe('offline');
    expect(skyBanner(drawer)).toBe('Not live. Showing the last aircraft received.');
    const rows = skyRowButtons(drawer);
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => !row.hasAttribute('data-muted'))).toEqual([]);
    expect(drawer.querySelector('.chip, [data-overhead]')).toBeNull();
    expect(radarLive(drawer)).toBe('false');
    expect(drawer.querySelector('agr-sky-radar')?.shadowRoot?.querySelector('path.mark, .halo')).toBeNull();
    // No row is opened as "the nearest overhead aircraft" while not live; one opened by hand says Last known.
    rows[0]?.click();
    await settle();
    expect(renderedText(drawer.querySelector('.detail:not([hidden]) .detail-note') ?? drawer)).toBe('Last known');
  });

  it('empty data: the panel line, and a banner that says no aircraft were in the last update', async () => {
    const card = await skyOffline(skyPayload('empty'));
    expect(skyPanelLine(card)).toBe(SKY_OFFLINE_LINE);
    expect(renderedText(skyRoot(card))).not.toContain('Quiet skies');
    const drawer = await openSkyDrawer(card);
    expect(skyBanner(drawer)).toBe('Not live. No aircraft were reported in the last update.');
  });

  it('stale data: offline wins over the Not live pill; past 15 minutes nothing is drawn at all', async () => {
    const stale = await skyOffline(skyPayload('normal', 4));
    expect(skyPanelPill(stale)).toEqual(OFFLINE_PILL);
    expect(skyPanelLine(stale)).toBe(SKY_OFFLINE_LINE);
    const drawer = await openSkyDrawer(stale);
    expect(drawer.querySelector('.banner')?.getAttribute('data-status')).toBe('offline');
    expect(renderedText(drawer.querySelector('.age') ?? drawer)).toBe('Last update 4 min ago');
    expect(skyRowButtons(drawer)).toHaveLength(8);

    const old = await skyOffline(skyPayload('normal', 16));
    const oldDrawer = await openSkyDrawer(old);
    expect(skyBanner(oldDrawer)).toBe('Not live. Aircraft return when Home Assistant reconnects.');
    expect(skyRowButtons(oldDrawer)).toEqual([]);
    expect(oldDrawer.querySelector('agr-sky-radar')).toBeNull();
  });
});

describe('sky: an entity that is not data stays what it is while offline', () => {
  it.each<[string, (card: LiveCard) => Promise<void>, string, string]>([
    [
      'unavailable',
      async (card) => {
        card.fake.setState(SKY, 'unavailable');
        await settle();
      },
      'Aircraft data unavailable',
      'The aircraft feed is not reporting. It returns when the collector publishes fresh data.',
    ],
    [
      'malformed',
      (card) => publishSky(card, { ...skyPayload('normal'), radius_km: 0 }),
      'Sky data could not be read',
      'The latest sky data was incomplete or invalid, so nothing is shown.',
    ],
    [
      'unsupported',
      (card) => publishSky(card, { ...skyPayload('normal'), schema_version: 2 }),
      'Unsupported sky data',
      'The sky sensor uses a newer data format than this dashboard understands. Update the dashboard.',
    ],
  ])('%s: its own line and banner under the Offline pill, and no aircraft', async (_status, make, line, banner) => {
    const card = await mountLive({ scenario: 'sky' });
    await make(card);
    expect(skyPanelLine(card)).toBe(line);
    card.fake.disconnect();
    await advance(0);

    expect(skyPanelPill(card)).toEqual(OFFLINE_PILL);
    expect(skyPanelLine(card)).toBe(line);
    const drawer = await openSkyDrawer(card);
    expect(skyBanner(drawer)).toBe(banner);
    expect(skyRowButtons(drawer)).toEqual([]);
    expect(drawer.querySelector('agr-sky-radar')).toBeNull();
  });

  it('a sensor HA does not have stays "not found" while offline', async () => {
    const card = await mountLive({
      scenario: 'sky',
      input: liveInput('sky', { airspace: { entity: 'sensor.demo_sky_gone' } }),
    });
    card.fake.disconnect();
    await advance(0);
    expect(skyPanelPill(card)).toEqual(OFFLINE_PILL);
    expect(skyPanelLine(card)).toBe('Sky sensor not found');
  });
});

describe('sky: offline only while HA is disconnected or resyncing', () => {
  /**
   * Publishes a payload `minutesOld`, drops the connection, deletes the sensor during the outage (the reconnect
   * snapshot keeps its old object, so it is never refreshed) and reconnects until the resync barrier clears.
   */
  async function unrefreshedAfterReconnect(minutesOld: number): Promise<LiveCard> {
    const card = await mountLive({ scenario: 'sky' });
    await publishSky(card, skyPayload('normal', minutesOld));
    card.fake.disconnect();
    await advance(0);
    expect(skyPanelLine(card)).toBe(SKY_OFFLINE_LINE);
    card.fake.deleteDuringOutage(SKY);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(5_000);
    expect(card.services()?.reader.connection().phase).toBe('connected');
    expect(card.services()?.store.freshSinceResync(SKY as EntityId)).toBe(false);
    return card;
  }

  it('a sensor the reconnect snapshot did not replace reads stale by its own age, not offline', async () => {
    const card = await unrefreshedAfterReconnect(4);
    expect(skyPanelPill(card)).toEqual({ label: 'Not live', tone: 'attention' });
    expect(skyPanelLine(card)).toBe('No fresh aircraft data');
    const drawer = await openSkyDrawer(card);
    expect(drawer.querySelector('.banner')?.getAttribute('data-status')).toBe('stale');
    expect(skyRowButtons(drawer)).toHaveLength(8);
    expect(radarLive(drawer)).toBe('false');
  });

  it('and is no longer drawn once that age passes 15 minutes', async () => {
    const card = await unrefreshedAfterReconnect(16);
    expect(skyPanelLine(card)).toBe('No fresh aircraft data');
    const drawer = await openSkyDrawer(card);
    expect(skyBanner(drawer)).toBe('No fresh aircraft data.');
    expect(skyRowButtons(drawer)).toEqual([]);
    expect(drawer.querySelector('agr-sky-radar')).toBeNull();
  });
});

describe('sky: the resync barrier keeps the sky not live until current states arrive', () => {
  it('between ready and the snapshot the panel stays not live; the snapshot brings the outage payload live', async () => {
    const card = await mountLive({ scenario: 'sky' });
    card.fake.disconnect();
    await advance(0);
    card.fake.queueOutageChange(SKY, '50', skyPayload('dense'));
    card.fake.reconnect({ snapshotDelayMs: SNAPSHOT_DELAY_MS });
    await advance(0);

    expect(card.services()?.reader.connection().phase).toBe('resyncing');
    expect(skyPanelPill(card)).toEqual(OFFLINE_PILL);
    expect(skyPanelLine(card)).toBe(SKY_OFFLINE_LINE);
    expect(skyRoot(card).querySelector('.count')).toBeNull();

    await advance(SNAPSHOT_DELAY_MS);
    expect(card.services()?.reader.connection().phase).toBe('connected');
    expect(skyPanelPill(card)).toBeUndefined();
    expect(renderedText(skyRoot(card).querySelector('.count') ?? skyRoot(card))).toBe('50');
    expect(writeCalls(card.fake)).toEqual([]);
  });
});

describe('sky: navigation and view controls are not actions, so they stay usable', () => {
  it('offline: Sky and Weather Details open their drawers; Show and Sort change the view and send nothing', async () => {
    const card = await skyOffline();
    const details = control(skyRoot(card), 'sky:details');
    expect(details.getAttribute('aria-disabled')).toBeNull();
    const drawer = await openSkyDrawer(card);
    for (const key of ['sky:view:nearby', 'sky:view:overhead', 'sky:view:recent', 'sky:sort:altitude']) {
      expect(control(drawer, key).getAttribute('aria-disabled'), key).toBeNull();
    }
    await chooseSky(drawer, 'view', 'recent');
    expect(skyRowButtons(drawer)).toHaveLength(3);
    await chooseSky(drawer, 'sort', 'name');
    expect(control(drawer, 'sky:sort:name').getAttribute('aria-pressed')).toBe('true');
    await closeSkyOverlays(card);
    const weather = await openWeatherDrawer(card);
    expect(renderedText(weather)).toContain('Last known values while Home Assistant is offline.');
    await closeSkyOverlays(card);
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('with controls off, a non-admin and the editor preview, both Details buttons and the view controls work', async () => {
    const card = await mountLive({
      scenario: 'sky',
      input: liveInput('sky', { controls: false }),
      transform: (hass) => ({ ...hass, user: { id: 'demo-guest', is_admin: false } }),
    });
    card.card.preview = true;
    await settle();
    expect(card.services()?.config.controls).toBe(false);
    expect(card.services()?.preview).toBe(true);
    expect(card.services()?.reader.isAdmin()).toBe(false);

    expect(control(skyRoot(card), 'sky:details').getAttribute('aria-disabled')).toBeNull();
    const drawer = await openSkyDrawer(card);
    expect(control(drawer, 'sky:view:overhead').getAttribute('aria-disabled')).toBeNull();
    await chooseSky(drawer, 'view', 'overhead');
    expect(skyRowButtons(drawer)).toHaveLength(1);
    const row = skyRowButtons(drawer)[0] as HTMLButtonElement;
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    row.click();
    await settle();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    await closeSkyOverlays(card);
    await openWeatherDrawer(card);
    await closeSkyOverlays(card);
    expect(writeCalls(card.fake)).toEqual([]);
  });
});
