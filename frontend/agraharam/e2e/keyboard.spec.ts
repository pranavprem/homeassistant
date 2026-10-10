/**
 * Keyboard and dialog behavior in real engines (§5.4, §7.2, §12.2). Runs in Chromium AND WebKit: happy-dom has no
 * modality, no Escape → cancel and no :focus-visible, so these rules are proven only here (§5.4 rule 14). All Tab
 * presses go through tabKey(), because Safari's default Tab skips buttons.
 *
 * Every test runs the built card against FakeHass (host=fake-hass), so "nothing was sent" is read from the calls
 * FakeHass recorded, and every deliberate activation is checked to produce exactly one correctly scoped call.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { LIVE_FALLBACK_INTERVAL_MS } from '../src/timing.ts';
import {
  cameraFetches,
  expectServiceCallCount,
  QUIET_MS,
  recordedCalls,
  runPageTimers,
  serviceCalls,
} from './helpers/calls.ts';
import { control, focusCardFrame, openHarness, shellAction, type HarnessOptions } from './helpers/harness.ts';
import { shiftTabKey, tabKey } from './helpers/keys.ts';
import type { FocusInfo } from './helpers/page-tools.ts';

const CLIMATE = 'climate.demo_bedroom';
const ACTIVE_PLAYER = 'media_player.demo_living_room';
const LANTERN = 'light.demo_courtyard_lantern';
const FRONT_GATE = 'camera.demo_front_gate';
/** Pebble's Start button in the Home panel (data-focus-key). */
const VACUUM_START = 'vacuum:vacuum.demo_pebble:start';
/** Keys that move between options in radio groups and listboxes; on a choice group they must do nothing. */
const NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
/** Upper bound on Tab presses when walking to a control from the card frame. */
const MAX_TABS = 80;
/** The live-view snapshot fallback requests 16:9 stills; tiles request 4:3. */
const LIVE_VIEW_ASPECT = 9 / 16;
/** Page time after a backdrop click in which a closing dialog would have closed. */
const CLOSE_WINDOW_MS = 300;

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, options: HarnessOptions = {}): Promise<void> {
  await openHarness(page, { host: 'fake-hass', sidebar: 'collapsed', ...options });
}

async function focusInfo(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => window.__agrE2E.focusInfo());
}

async function openDialogCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__agrE2E.openDialogs().length);
}

async function expectDialogOpen(page: Page, role: 'dialog' | 'alertdialog' = 'dialog'): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = window.__agrE2E.topDialog();
        return dialog === null
          ? null
          : { role: dialog.getAttribute('role') ?? 'dialog', modal: dialog.matches(':modal') };
      }),
    )
    .toEqual({ role, modal: true });
}

async function expectNoDialogOpen(page: Page): Promise<void> {
  await expect.poll(() => openDialogCount(page)).toBe(0);
}

/** Presses Tab until the control with `focusKey` has focus; fails if it is not in the tab order. */
async function tabTo(page: Page, browserName: string, focusKey: string): Promise<void> {
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    if ((await focusInfo(page))?.focusKey === focusKey) return;
    await page.keyboard.press(tabKey(browserName));
  }
  throw new Error(`${focusKey} was not reached within ${MAX_TABS} Tab presses`);
}

/** Number of elements in the topmost dialog that sequential focus can reach. */
async function tabbablesInTopDialog(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const dialog = tools.topDialog();
    if (dialog === null) return 0;
    const selector = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
    // The dialog's own tree, plus the drawer content slotted into it (rendered by the drawer element).
    const host = (dialog.getRootNode() as ShadowRoot).host;
    const scope = host.parentNode instanceof ShadowRoot ? host.parentNode.host : host;
    return tools
      .all(selector, scope.shadowRoot ?? scope)
      .filter((element) => !(element as HTMLButtonElement).disabled)
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      }).length;
  });
}

/** Tries to move focus to a control behind the dialog; inert content must refuse it. */
async function tryFocusBehindDialog(page: Page, focusKey: string): Promise<void> {
  await page.evaluate((key) => {
    const target = window.__agrE2E.all(`[data-focus-key="${key}"]`)[0];
    if (target instanceof HTMLElement) target.focus();
  }, focusKey);
}

async function serviceCallsNow(page: Page) {
  return serviceCalls(await recordedCalls(page));
}

test('security pill: Tab reaches it, Enter opens the drawer on its heading, the page is inert, Tab wraps, the focus ring shows, Escape restores focus', async ({
  page,
  browserName,
}) => {
  await open(page);
  await focusCardFrame(page);
  await page.keyboard.press(tabKey(browserName));

  const onPill = await focusInfo(page);
  expect(onPill?.focusKey).toBe('header:security');
  expect(onPill?.focusVisible, 'keyboard focus matches :focus-visible').toBe(true);
  expect(onPill?.outlineStyle).toBe('solid');
  expect(onPill?.outlineWidth).toBe('2px');

  await page.keyboard.press('Enter');
  await expectDialogOpen(page);
  await expect.poll(() => focusInfo(page)).toMatchObject({ tag: 'h2', text: 'Security', inTopDialog: true });

  await tryFocusBehindDialog(page, 'garage:open');
  expect((await focusInfo(page))?.inTopDialog, 'focus moved behind the modal drawer').toBe(true);

  const tabbables = await tabbablesInTopDialog(page);
  expect(tabbables).toBeGreaterThan(3);
  const forward: string[] = [];
  for (let press = 0; press < tabbables * 2; press += 1) {
    await page.keyboard.press(tabKey(browserName));
    const info = await focusInfo(page);
    expect(info?.inTopDialog, `Tab ${press + 1} left the dialog`).toBe(true);
    forward.push(`${info?.focusKey ?? ''}|${info?.text ?? ''}`);
  }
  // Tab visits every reachable control once, then wraps to the first.
  expect(new Set(forward.slice(0, tabbables)).size).toBe(tabbables);
  expect(forward.slice(tabbables)).toEqual(forward.slice(0, tabbables));

  // Focus is on the last control now; one more Tab wraps to the first, and Shift+Tab from there wraps back.
  const describe = (info: FocusInfo | null): string => `${info?.focusKey ?? ''}|${info?.text ?? ''}`;
  await page.keyboard.press(tabKey(browserName));
  expect(describe(await focusInfo(page))).toBe(forward[0]);
  await page.keyboard.press(shiftTabKey(browserName));
  const wrappedBack = await focusInfo(page);
  expect(wrappedBack?.inTopDialog).toBe(true);
  expect(describe(wrappedBack)).toBe(forward[tabbables - 1]);

  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  await expect.poll(async () => (await focusInfo(page))?.focusKey).toBe('header:security');
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('a confirm dialog stacked on the security drawer: Cancel has focus, Escape closes only the confirm and returns focus to its button', async ({
  page,
}) => {
  await open(page);
  await control(page, 'header:security').click();
  await expectDialogOpen(page);
  await control(page, 'security:hold_night').focus();
  await page.keyboard.press('Enter');

  await expectDialogOpen(page, 'alertdialog');
  expect(await openDialogCount(page)).toBe(2);
  await expect.poll(() => focusInfo(page)).toMatchObject({ tag: 'button', text: 'Cancel', inTopDialog: true });

  await page.keyboard.press('Escape');
  await expectDialogOpen(page, 'dialog');
  expect(await openDialogCount(page)).toBe(1);
  await expect.poll(async () => (await focusInfo(page))?.focusKey).toBe('security:hold_night');
  await runPageTimers(page, QUIET_MS);
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('a backdrop click closes a drawer but never a confirm dialog', async ({ page }) => {
  await open(page);
  await control(page, 'room:0:open').click();
  await expectDialogOpen(page);
  // The side sheet sits on the inline end; the left half of the viewport is backdrop.
  await page.mouse.click(120, 450);
  await expectNoDialogOpen(page);

  await control(page, 'garage:open').click();
  await expectDialogOpen(page, 'alertdialog');
  await page.mouse.click(20, 20);
  await runPageTimers(page, CLOSE_WINDOW_MS);
  await expectDialogOpen(page, 'alertdialog');
  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('confirm dialog: Cancel has initial focus, so Enter closes it and sends nothing', async ({ page }) => {
  await open(page);
  await control(page, 'garage:open').click();
  await expectDialogOpen(page, 'alertdialog');
  await expect.poll(() => focusInfo(page)).toMatchObject({ text: 'Cancel', inTopDialog: true });

  await page.keyboard.press('Enter');
  await expectNoDialogOpen(page);
  await expect.poll(async () => (await focusInfo(page))?.focusKey).toBe('garage:open');
  await runPageTimers(page, QUIET_MS);
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('room drawer brightness slider: arrow keys are a deliberate value change and coalesce into one call after the debounce', async ({
  page,
}) => {
  await open(page);
  await control(page, 'room:0:open').click();
  await expectDialogOpen(page);
  const slider = control(page, `room-drawer:0:light:${LANTERN}:brightness`);
  await slider.focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowRight');
  const value = Number(await slider.inputValue());

  const [call] = await expectServiceCallCount(page, 1);
  expect(call).toEqual({
    domain: 'light',
    service: 'turn_on',
    data: { brightness_pct: value },
    target: { entity_id: LANTERN },
  });
});

test('climate drawer HVAC modes: arrow, Home, End and Page keys never act; Enter on another mode sends exactly one call', async ({
  page,
  browserName,
}) => {
  await open(page);
  await control(page, `comfort:${CLIMATE}:open`).click();
  await expectDialogOpen(page);
  await control(page, `climate:${CLIMATE}:target:up`).focus();
  await page.keyboard.press(tabKey(browserName));
  const firstOption = await focusInfo(page);
  expect(firstOption?.focusKey).toBe(`climate:${CLIMATE}:mode:off`);

  for (const key of NAVIGATION_KEYS) await page.keyboard.press(key);
  expect((await focusInfo(page))?.focusKey, 'navigation keys moved focus inside the group').toBe(firstOption?.focusKey);
  await runPageTimers(page, QUIET_MS);
  expect(await serviceCallsNow(page)).toEqual([]);

  await tabTo(page, browserName, `climate:${CLIMATE}:mode:heat`);
  await page.keyboard.press('Enter');
  const [call] = await expectServiceCallCount(page, 1);
  expect(call).toEqual({
    domain: 'climate',
    service: 'set_hvac_mode',
    data: { hvac_mode: 'heat' },
    target: { entity_id: CLIMATE },
  });
});

test('media drawer sources: arrow, Home, End and Page keys never act; Enter on another source sends exactly one call', async ({
  page,
  browserName,
}) => {
  await open(page);
  await control(page, 'media:players').click();
  await expectDialogOpen(page);
  await control(page, `media-drawer:${ACTIVE_PLAYER}:volume`).focus();
  await page.keyboard.press(tabKey(browserName));
  const firstSource = await focusInfo(page);
  expect(firstSource?.focusKey).toBe(`media-drawer:${ACTIVE_PLAYER}:source:Demo Music`);

  for (const key of NAVIGATION_KEYS) await page.keyboard.press(key);
  expect((await focusInfo(page))?.focusKey).toBe(firstSource?.focusKey);
  await runPageTimers(page, QUIET_MS);
  expect(await serviceCallsNow(page)).toEqual([]);

  await tabTo(page, browserName, `media-drawer:${ACTIVE_PLAYER}:source:Demo Radio`);
  await page.keyboard.press('Enter');
  const [call] = await expectServiceCallCount(page, 1);
  expect(call).toEqual({
    domain: 'media_player',
    service: 'select_source',
    data: { source: 'Demo Radio' },
    target: { entity_id: ACTIVE_PLAYER },
  });
});

test('an aria-disabled action button stays in the tab order, exposes its reason, and Enter or Space does nothing', async ({
  page,
  browserName,
}) => {
  // starting: Home Assistant does not offer vacuum.start yet, so Start is disabled with the reason. (A garage door
  // with an unknown position offers no buttons at all, §16.14.)
  await open(page, { scenario: 'starting' });
  await focusCardFrame(page);
  await tabTo(page, browserName, VACUUM_START);
  const button = control(page, VACUUM_START);

  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAccessibleDescription(/finishes starting/);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await runPageTimers(page, QUIET_MS);
  expect(await openDialogCount(page)).toBe(0);
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('an edit-mode toggle with a drawer open leaves no dialog open, and a reopened drawer is modal again', async ({
  page,
}) => {
  await open(page);
  await control(page, 'room:0:open').click();
  await expectDialogOpen(page);

  await shellAction(page, 'Edit-mode toggle');
  await expectNoDialogOpen(page);

  await control(page, 'room:0:open').click();
  await expectDialogOpen(page);
  await expect.poll(async () => (await focusInfo(page))?.inTopDialog).toBe(true);
  await tryFocusBehindDialog(page, 'garage:open');
  expect((await focusInfo(page))?.inTopDialog, 'the reopened drawer is not modal').toBe(true);
  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('camera live view (snapshot fallback): Escape closes it and no further fallback stills are fetched', async ({
  page,
}) => {
  await open(page);
  await control(page, 'camera:0:live').click();
  await expectDialogOpen(page);
  await expect.poll(async () => (await focusInfo(page))?.inTopDialog).toBe(true);
  const liveFetches = async (): Promise<number> =>
    cameraFetches(await recordedCalls(page), FRONT_GATE).filter(
      (size) => Math.abs(size.height / size.width - LIVE_VIEW_ASPECT) < 0.01,
    ).length;
  await expect.poll(liveFetches, { message: 'the fallback fetched a still' }).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  const afterClose = await liveFetches();
  await runPageTimers(page, LIVE_FALLBACK_INTERVAL_MS * 2.5);
  expect(await liveFetches()).toBe(afterClose);
  expect(await serviceCallsNow(page)).toEqual([]);
});

// -----------------------------------------------------------------------------------------------------------------
// Sky and weather (AIRSPACE.md §6, §8): read-only drawers on the same keyboard rules. The sky drawer opens with the
// nearest aircraft (the overhead DEMO214, ICAO 001a2b) expanded; its row is a disclosure button keyed by the hex.

const NEAREST_ROW = 'sky:aircraft:001a2b';
const NEAREST_LINK = 'sky:link:001a2b';
/** Tab stops sampled after the drawer heading: Close, the scroll region, then the three Show choices. */
const SKY_DRAWER_FIRST_STOPS = 6;
/** A nearby aircraft whose place changes between Distance (4th) and Altitude (last) order. */
const MOVED_ROW = 'sky:aircraft:000f12';

async function rowExpanded(page: Page, focusKey: string): Promise<string | null> {
  return control(page, focusKey).getAttribute('aria-expanded');
}

/** The data-key order of the sky drawer's rows (inside the drawer's shadow root). */
async function skyRowOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = window.__agrE2E.all('agr-sky-drawer')[0]?.shadowRoot;
    return [...(root?.querySelectorAll('li.aircraft') ?? [])].map((row) => row.getAttribute('data-key') ?? '');
  });
}

test('sky: Tab reaches Details, Enter opens the drawer on its heading, Overhead by keyboard, Enter toggles a row, Tab reaches its link, Escape restores focus', async ({
  page,
  browserName,
}) => {
  await open(page, { scenario: 'sky' });
  await focusCardFrame(page);
  await tabTo(page, browserName, 'sky:details');
  expect((await focusInfo(page))?.focusVisible, 'keyboard focus matches :focus-visible').toBe(true);

  await page.keyboard.press('Enter');
  await expectDialogOpen(page);
  await expect.poll(() => focusInfo(page)).toMatchObject({ tag: 'h2', text: 'Sky', inTopDialog: true });

  // The radar is not focusable: after the drawer's own chrome (Close, and the body's scroll region when the body
  // scrolls) the next Tab stops are the Show choices, in order.
  const stops: string[] = [];
  for (let press = 0; press < SKY_DRAWER_FIRST_STOPS; press += 1) {
    await page.keyboard.press(tabKey(browserName));
    const info = await focusInfo(page);
    stops.push(info?.focusKey ?? (info?.tag === 'button' ? `button:${info.text}` : (info?.tag ?? '')));
  }
  const firstChoice = stops.indexOf('sky:view:nearby');
  expect(firstChoice, stops.join(', ')).toBeGreaterThan(0);
  expect(stops.slice(0, firstChoice).every((stop) => stop === 'button:Close' || stop === 'div')).toBe(true);
  expect(stops.slice(firstChoice, firstChoice + 3)).toEqual([
    'sky:view:nearby',
    'sky:view:overhead',
    'sky:view:recent',
  ]);
  await tabTo(page, browserName, 'sky:view:overhead');
  for (const key of NAVIGATION_KEYS) await page.keyboard.press(key);
  expect((await focusInfo(page))?.focusKey, 'navigation keys moved focus inside the group').toBe('sky:view:overhead');
  await page.keyboard.press('Enter');
  await expect(control(page, 'sky:view:overhead')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => skyRowOrder(page)).toEqual(['001a2b']);

  await tabTo(page, browserName, NEAREST_ROW);
  expect(await rowExpanded(page, NEAREST_ROW)).toBe('true');
  await page.keyboard.press('Enter');
  await expect.poll(() => rowExpanded(page, NEAREST_ROW)).toBe('false');
  await page.keyboard.press('Enter');
  await expect.poll(() => rowExpanded(page, NEAREST_ROW)).toBe('true');
  expect((await focusInfo(page))?.focusKey, 'the row keeps focus while it toggles').toBe(NEAREST_ROW);

  await page.keyboard.press(tabKey(browserName));
  const link = await focusInfo(page);
  expect(link).toMatchObject({ tag: 'a', focusKey: NEAREST_LINK, inTopDialog: true });
  await expect(control(page, NEAREST_LINK)).toHaveAttribute('href', 'https://globe.adsb.lol/?icao=001a2b');

  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  await expect.poll(async () => (await focusInfo(page))?.focusKey).toBe('sky:details');
  await runPageTimers(page, QUIET_MS);
  expect(await serviceCallsNow(page)).toEqual([]);
});

test("today: the header's Details opens the weather drawer on its heading, and Escape returns focus to it", async ({
  page,
  browserName,
}) => {
  await open(page, { scenario: 'sky' });
  await focusCardFrame(page);
  await tabTo(page, browserName, 'today:details');
  await page.keyboard.press('Enter');
  await expectDialogOpen(page);
  await expect.poll(() => focusInfo(page)).toMatchObject({ tag: 'h2', text: 'Weather details', inTopDialog: true });

  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  await expect.poll(async () => (await focusInfo(page))?.focusKey).toBe('today:details');
  expect(await serviceCallsNow(page)).toEqual([]);
});

test('sky: re-sorting while a row has focus keeps focus on the same aircraft as the list re-orders', async ({
  page,
  browserName,
}) => {
  await open(page, { scenario: 'sky' });
  await control(page, 'sky:details').click();
  await expectDialogOpen(page);
  await tabTo(page, browserName, MOVED_ROW);
  const before = await skyRowOrder(page);
  expect(before.indexOf('000f12')).toBe(3);

  // The Sort group's own choice event: the list re-orders under the focused row (a pointer on Sort would itself
  // take focus in Chromium, though not in Safari).
  await page.evaluate(() => {
    const sort = window.__agrE2E.all('agr-sky-drawer')[0]?.shadowRoot?.querySelector('agr-choice-group[label="Sort"]');
    sort?.dispatchEvent(new CustomEvent('agr-choose', { detail: { value: 'altitude' } }));
  });

  await expect.poll(() => skyRowOrder(page)).not.toEqual(before);
  expect((await skyRowOrder(page)).at(-1)).toBe('000f12');
  await expect.poll(async () => (await focusInfo(page))?.focusKey).toBe(MOVED_ROW);
  expect((await focusInfo(page))?.inTopDialog).toBe(true);
  await page.keyboard.press('Escape');
  await expectNoDialogOpen(page);
  expect(await serviceCallsNow(page)).toEqual([]);
});
