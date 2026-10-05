/**
 * The built bundle against FakeHass and the demo host (§12.1 row 1 in the browser, §12.2 fake-hass.spec): loading,
 * the shell's three remount modes ("Route change", "Edit-mode toggle", "Hidden 5 min") and reconnects send nothing
 * to Home Assistant and raise no page error; the first deliberate tap afterwards sends exactly one correctly scoped
 * call; the garage needs its confirmation and stays locked across an edit-mode toggle; an interrupted draft is
 * never replayed; a reconnect never unsubscribes a stale command id; and states changed during an outage count only
 * once the reconnect snapshot lands. Page errors and contained card errors are checked for every test by the
 * shared fixture.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { SHELL_SNAPSHOT_DELAY_MS } from '../src/timing.ts';
import {
  cameraFetches,
  expectNoMutation,
  expectServiceCallCount,
  QUIET_MS,
  recordedCalls,
  runPageTimers,
  serviceCalls,
  type RecordedCall,
} from './helpers/calls.ts';
import {
  control,
  openHarness,
  shellAction,
  waitForStableRender,
  type HostMode,
  type ShellAction,
} from './helpers/harness.ts';
import type { DemoScenarioId } from '../src/config/schema.ts';
import { demoCardInput } from '../src/demo/configs.ts';
import { DEMO_SCENARIO_IDS } from '../src/demo/scenarios.ts';

const NORMAL = demoCardInput('normal');
const READING_ROOM_INDEX = 1;
const READING_ROOM_LIGHTS = NORMAL.rooms?.[READING_ROOM_INDEX]?.lights ?? [];
const GARAGE_COVER = NORMAL.garage?.cover;
const CLIMATE = 'climate.demo_bedroom';
const REMOUNTS: readonly ShellAction[] = ['Route change', 'Edit-mode toggle', 'Hidden 5 min'];
/** Longer than the stepper debounce (800 ms) plus the snapshot delay, so a replay would have happened. */
const REPLAY_WINDOW_MS = 3_000;

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, scenario: DemoScenarioId = 'normal', host: HostMode = 'fake-hass'): Promise<void> {
  await openHarness(page, { scenario, host, sidebar: 'collapsed' });
}

/** Runs page time past the post-reconnect snapshot (the shell delivers it after 'ready'), then waits for the card. */
async function settleAfterReconnect(page: Page): Promise<void> {
  await runPageTimers(page, SHELL_SNAPSHOT_DELAY_MS);
  await waitForStableRender(page);
}

async function readingRoomToggleSendsOneCall(page: Page): Promise<void> {
  await expect(control(page, `room:${READING_ROOM_INDEX}:toggle`)).not.toHaveAttribute('aria-disabled', 'true');
  await control(page, `room:${READING_ROOM_INDEX}:toggle`).click();
  const [call] = await expectServiceCallCount(page, 1);
  expect(call?.domain).toBe('light');
  expect(call?.service).toBe('turn_on');
  expect(call?.data).toEqual({});
  expect([(call?.target as { entity_id: unknown } | undefined)?.entity_id].flat()).toEqual(READING_ROOM_LIGHTS);
}

function staleUnsubscribes(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) => call.method === 'unsubscribe_events' && (call.args[0] as { stale?: boolean } | undefined)?.stale === true,
  );
}

function forecastSubscriptions(calls: readonly RecordedCall[]): number {
  return calls.filter((call) => call.method === 'connection.subscribeMessage').length;
}

/** Each camera tile's visible state, keyed by camera name: "picture" when it shows a still, else its reason. */
async function cameraTileStates(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const result: Record<string, string> = {};
    for (const tile of tools.all('agr-camera-tile', tools.card().shadowRoot ?? document)) {
      const root = tile.shadowRoot;
      if (root === null) continue;
      const name = (root.querySelector('.name-pill, .name')?.textContent ?? '').trim();
      const picture = root.querySelector('img.picture') !== null;
      result[name] = picture ? 'picture' : (root.querySelector('.reason')?.textContent ?? '').trim();
    }
    return result;
  });
}

test.describe('loading and a route change never mutate, in every scenario and both hosts', () => {
  for (const host of ['fake-hass', 'demo'] as const) {
    for (const scenario of DEMO_SCENARIO_IDS) {
      test(`${host}: ${scenario}`, async ({ page }) => {
        await open(page, scenario, host);
        if (scenario === 'loading') await shellAction(page, 'Deliver first update');
        await shellAction(page, 'Route change');
        await waitForStableRender(page);

        if (host === 'demo') {
          // The demo host never touches the hass object it is given (it reads only the theme, §10.1).
          expect(await recordedCalls(page)).toEqual([]);
        } else {
          await expectNoMutation(page);
        }
      });
    }
  }
});

test.describe('remounts and reconnects send nothing; the next tap sends exactly one scoped call', () => {
  for (const remount of REMOUNTS) {
    test(`after "${remount}"`, async ({ page }) => {
      await open(page);
      await shellAction(page, remount);
      await settleAfterReconnect(page);

      await expectNoMutation(page);
      await readingRoomToggleSendsOneCall(page);
    });
  }

  test('after a disconnect and a two-step reconnect', async ({ page }) => {
    await open(page);
    await shellAction(page, 'Disconnect');
    await waitForStableRender(page);
    await shellAction(page, 'Reconnect');
    await settleAfterReconnect(page);

    await expectNoMutation(page);
    await readingRoomToggleSendsOneCall(page);
  });

  test('the demo host: taps, a confirmed garage open, a security hold and every remount never touch hass', async ({
    page,
  }) => {
    await open(page, 'normal', 'demo');
    await expect(page.getByText('Demo mode: fictional data', { exact: false })).toBeVisible();
    await control(page, `room:${READING_ROOM_INDEX}:toggle`).click();
    await control(page, 'garage:open').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Open garage' }).click();
    await control(page, 'header:security').click();
    await control(page, 'security:hold_night').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Hold Night' }).click();
    await page.keyboard.press('Escape');
    for (const remount of REMOUNTS) await shellAction(page, remount);
    await waitForStableRender(page);

    expect(await recordedCalls(page)).toEqual([]);
  });
});

test.describe('garage confirmation in the built card', () => {
  test('Open then Cancel sends nothing; Open then confirm sends exactly one open_cover to the configured door', async ({
    page,
  }) => {
    await open(page);
    await control(page, 'garage:open').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await runPageTimers(page, QUIET_MS);
    expect(serviceCalls(await recordedCalls(page))).toEqual([]);

    await control(page, 'garage:open').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Open garage' }).click();
    const [call] = await expectServiceCallCount(page, 1);
    expect(call).toEqual({ domain: 'cover', service: 'open_cover', data: {}, target: { entity_id: GARAGE_COVER } });
  });

  test('after a confirmed Open, an edit-mode toggle does not make the door openable again', async ({ page }) => {
    await open(page);
    await control(page, 'garage:open').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Open garage' }).click();
    await expect.poll(async () => serviceCalls(await recordedCalls(page)).length).toBe(1);

    await shellAction(page, 'Edit-mode toggle');
    const garageButtons = page.locator('[data-focus-key^="garage:"]');
    await expect(garageButtons.first()).toBeVisible();
    for (const button of await garageButtons.all()) await expect(button).toHaveAttribute('aria-disabled', 'true');
    // A real pointer press on the disabled button. `force` skips Playwright's wait for the button to become enabled,
    // which would otherwise hold the click until the door finished opening.
    await control(page, 'garage:open').click({ force: true });
    await runPageTimers(page, QUIET_MS);

    expect(await page.evaluate(() => window.__agrE2E.openDialogs().length)).toBe(0);
    expect(serviceCalls(await recordedCalls(page)).filter((call) => call.service === 'open_cover')).toHaveLength(1);
  });
});

test('a stepper tap interrupted by a disconnect is never sent, then or after the reconnect, and shows "Not sent"', async ({
  page,
}) => {
  await open(page);
  await control(page, `comfort:${CLIMATE}:open`).click();
  await expect(control(page, `climate:${CLIMATE}:target:up`)).toBeVisible();
  // The tap and the disconnect run in one page task, so the drop always lands inside the 800 ms stepper debounce.
  await page.evaluate((key) => {
    const tools = window.__agrE2E;
    const up = tools.all(`[data-focus-key="${key}"]`)[0];
    if (!(up instanceof HTMLElement)) throw new Error(`no control ${key}`);
    up.click();
    tools.shellButton('Disconnect').click();
  }, `climate:${CLIMATE}:target:up`);
  await runPageTimers(page, QUIET_MS);
  await shellAction(page, 'Reconnect');
  await runPageTimers(page, REPLAY_WINDOW_MS);

  expect(serviceCalls(await recordedCalls(page))).toEqual([]);
  await expect(page.locator('agr-stepper').getByText('Not sent')).toBeVisible();
});

test.describe('a reconnect never unsubscribes a stale command id (§9.2)', () => {
  for (const sequence of [['Hidden 5 min'], ['Disconnect', 'Reconnect']] as const) {
    test(`${sequence.join(' then ')} with the forecast subscribed`, async ({ page }) => {
      await open(page);
      const before = forecastSubscriptions(await recordedCalls(page));
      expect(before).toBeGreaterThan(0);
      for (const action of sequence) {
        await shellAction(page, action);
        await waitForStableRender(page);
      }
      await settleAfterReconnect(page);

      const calls = await recordedCalls(page);
      expect(staleUnsubscribes(calls), 'unsubscribe_events for a closed socket').toEqual([]);
      expect(forecastSubscriptions(calls), 'the forecast resubscribed after the reconnect').toBeGreaterThan(before);
      await expectNoMutation(page);
    });
  }
});

test.describe('states changed during an outage count only once the reconnect snapshot lands', () => {
  /**
   * Clicks Reconnect and reads a control's aria-disabled before the snapshot (FakeHass delivers it 400 ms after
   * 'ready'), in one page task so the read cannot race the snapshot.
   */
  async function reconnectAndReadBeforeSnapshot(page: Page, focusKey: string): Promise<string | null> {
    return page.evaluate(async (key) => {
      const tools = window.__agrE2E;
      tools.shellButton('Reconnect').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return tools.all(`[data-focus-key="${key}"]`)[0]?.getAttribute('aria-disabled') ?? null;
    }, focusKey);
  }

  for (const scenario of ['degraded', 'normal'] as const) {
    test(`${scenario}: controls stay paused until the snapshot; the camera whose privacy turned on is never fetched`, async ({
      page,
    }) => {
      await open(page, scenario);
      const tilesBefore = await cameraTileStates(page);
      await shellAction(page, 'Disconnect');
      await waitForStableRender(page);
      const fetchesAtDisconnect = (await recordedCalls(page)).length;
      await shellAction(page, 'Outage change');

      const duringResync = await reconnectAndReadBeforeSnapshot(page, `room:${READING_ROOM_INDEX}:toggle`);
      expect(duringResync, 'a control was live before the post-reconnect snapshot').toBe('true');
      await settleAfterReconnect(page);
      await expect(control(page, `room:${READING_ROOM_INDEX}:toggle`)).not.toHaveAttribute('aria-disabled', 'true');

      const tilesAfter = await cameraTileStates(page);
      const turnedPrivate = Object.keys(tilesAfter).filter(
        (name) => tilesAfter[name] === 'Privacy on' && tilesBefore[name] !== 'Privacy on',
      );
      expect(
        turnedPrivate,
        `the shell's "Outage change" turned no camera's privacy on (tiles before: ${JSON.stringify(tilesBefore)})`,
      ).toHaveLength(1);
      const cameraId = (demoCardInput(scenario).cameras ?? []).find(
        (camera) => camera.name === turnedPrivate[0],
      )?.entity;
      expect(cameraId).toBeDefined();
      const callsSinceDisconnect = (await recordedCalls(page)).slice(fetchesAtDisconnect);
      expect(cameraFetches(callsSinceDisconnect, cameraId ?? ''), `stills fetched for ${cameraId}`).toEqual([]);
      await expectNoMutation(page);
    });
  }
});
