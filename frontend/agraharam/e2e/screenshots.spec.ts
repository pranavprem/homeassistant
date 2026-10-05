/**
 * Review screenshots (§12.2 screenshots.spec, ACCEPTANCE "Visual/browser review"). Fictional data only, written to
 * test-results/screenshots/ (gitignored); a curated subset may be committed under docs/screenshots/ only after
 * human review and `npm run check:public`.
 *
 * - Every scenario at every §6.1 viewport, light and dark, with live-mode chrome (host=fake-hass):
 *   `<viewport>-<sidebar>-<scenario>-<theme>.png`, plus `…-full.png` with the whole card where the view scrolls.
 * - The demo host at the three primary viewports, to review the demo labeling: `…-normal-<theme>-demo.png`.
 * - Every drawer and dialog open at 1440×900 (the household drawer at 390×844), and the dense overflow drawers.
 * - The alert scenario's security drawer after tapping Silence sound: the sent ticket, then the uncertain ticket
 *   once its 10 s timeout has run (tickets cannot be preloaded through a fixture, §10.2).
 *
 * Captures wait for both Agraharam faces and a settled render, with reduced motion and animations disabled, so
 * the demo stream and the pending sweep are static.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  control,
  expectFontsLoaded,
  openHarness,
  waitForStableRender,
  type HarnessOptions,
  type Theme,
} from './helpers/harness.ts';
import { PRIMARY_ROW_IDS, shellSidebar, VIEWPORT_ROWS, viewportRow, type ViewportRow } from './helpers/viewports.ts';
import { DEMO_SCENARIO_IDS } from '../src/demo/scenarios.ts';

const SCREENSHOT_ROOT = join(import.meta.dirname, '..', 'test-results', 'screenshots');
const THEMES: readonly Theme[] = ['light', 'dark'];
/** §8.2: the security controller's ticket times out after 10 s. */
const SECURITY_TIMEOUT_MS = 10_000;
/** One scenario test loads and captures every §6.1 viewport (up to two images each), so it gets a budget per row. */
const PER_VIEWPORT_BUDGET_MS = 20_000;

test.use({ reducedMotion: 'reduce' });

function screenshotPath(testInfo: TestInfo, name: string): string {
  // Chromium is the reference set; other engines (AGR_E2E_BROWSERS=all) get their own folder.
  const dir = testInfo.project.name === 'chromium' ? SCREENSHOT_ROOT : join(SCREENSHOT_ROOT, testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.png`);
}

async function openAt(page: Page, viewport: ViewportRow, options: HarnessOptions): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await openHarness(page, { host: 'fake-hass', sidebar: shellSidebar(viewport), ...options });
  await expectFontsLoaded(page);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await waitForStableRender(page);
  await page.evaluate(() => window.__agrE2E.animationsSettled());
  await page.screenshot({ path: screenshotPath(testInfo, name), animations: 'disabled', caret: 'hide' });
}

/**
 * The whole card when the shell's view scrolls: the view is switched to auto height for the capture (so the page
 * itself scrolls), then restored. Returns whether a full capture was needed.
 */
async function captureFullIfScrolling(page: Page, testInfo: TestInfo, name: string): Promise<boolean> {
  const scrolls = await page.evaluate(() => {
    const view = window.__agrE2E.view();
    return view.scrollHeight > view.clientHeight;
  });
  if (!scrolls) return false;
  await page.evaluate(() => {
    const view = window.__agrE2E.view();
    view.style.blockSize = 'auto';
    view.style.overflow = 'visible';
  });
  await page.screenshot({
    path: screenshotPath(testInfo, `${name}-full`),
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  await page.evaluate(() => {
    const view = window.__agrE2E.view();
    view.style.blockSize = '';
    view.style.overflow = '';
  });
  return true;
}

test.describe('every scenario at every §6.1 viewport (host=fake-hass)', () => {
  for (const scenario of DEMO_SCENARIO_IDS) {
    for (const theme of THEMES) {
      test(`${scenario}, ${theme}`, async ({ page }, testInfo) => {
        test.setTimeout(VIEWPORT_ROWS.length * PER_VIEWPORT_BUDGET_MS);
        let captured = 0;
        for (const viewport of VIEWPORT_ROWS) {
          await openAt(page, viewport, { scenario, theme });
          const name = `${viewport.id}-${scenario}-${theme}`;
          await capture(page, testInfo, name);
          captured += 1;
          if (await captureFullIfScrolling(page, testInfo, name)) captured += 1;
        }
        expect(captured).toBeGreaterThanOrEqual(VIEWPORT_ROWS.length);
      });
    }
  }
});

test.describe('the demo host, with its labeling', () => {
  for (const theme of THEMES) {
    test(`normal at the primary viewports, ${theme}`, async ({ page }, testInfo) => {
      for (const id of PRIMARY_ROW_IDS) {
        const viewport = viewportRow(id);
        await openAt(page, viewport, { scenario: 'normal', theme, host: 'demo' });
        await expect(page.getByText('Demo mode: fictional data', { exact: false })).toBeVisible();
        await capture(page, testInfo, `${viewport.id}-normal-${theme}-demo`);
      }
    });
  }
});

interface DrawerShot {
  readonly name: string;
  readonly scenario: 'normal' | 'dense';
  readonly viewportId: string;
  readonly open: readonly string[];
}

const DRAWER_SHOTS: readonly DrawerShot[] = [
  { name: 'room', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['room:0:open'] },
  {
    name: 'climate',
    scenario: 'normal',
    viewportId: '1440x900-collapsed',
    open: ['comfort:climate.demo_bedroom:open'],
  },
  { name: 'media', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['media:players'] },
  { name: 'security', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['header:security'] },
  { name: 'health', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['health:details'] },
  { name: 'diagnostics', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['header:diagnostics'] },
  { name: 'camera-live', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['camera:0:live'] },
  { name: 'garage-confirm', scenario: 'normal', viewportId: '1440x900-collapsed', open: ['garage:open'] },
  {
    name: 'security-confirm',
    scenario: 'normal',
    viewportId: '1440x900-collapsed',
    open: ['header:security', 'security:hold_night'],
  },
  { name: 'household', scenario: 'normal', viewportId: '390x844-hidden', open: ['header:menu'] },
  { name: 'security', scenario: 'normal', viewportId: '390x844-hidden', open: ['header:security'] },
  { name: 'home', scenario: 'dense', viewportId: '1440x900-collapsed', open: ['home:all'] },
  { name: 'cameras', scenario: 'dense', viewportId: '1440x900-collapsed', open: ['cameras:all'] },
  { name: 'climate-overflow', scenario: 'dense', viewportId: '1440x900-collapsed', open: ['comfort:more'] },
];

test.describe('drawers and dialogs', () => {
  for (const shot of DRAWER_SHOTS) {
    for (const theme of THEMES) {
      test(`${shot.scenario} ${shot.name} at ${shot.viewportId}, ${theme}`, async ({ page }, testInfo) => {
        await openAt(page, viewportRow(shot.viewportId), { scenario: shot.scenario, theme });
        for (const key of shot.open) await control(page, key).click();
        await expect.poll(() => page.evaluate(() => window.__agrE2E.topDialog() !== null)).toBe(true);

        await capture(page, testInfo, `${shot.viewportId}-${shot.scenario}-${theme}-drawer-${shot.name}`);
      });
    }
  }
});

test('alert: Silence sound acts at once, then its ticket goes from sent to uncertain after 10 s', async ({
  page,
}, testInfo) => {
  test.setTimeout(SECURITY_TIMEOUT_MS * 4);
  const viewport = viewportRow('1440x900-collapsed');
  await openAt(page, viewport, { scenario: 'alert', theme: 'light' });
  await capture(page, testInfo, `${viewport.id}-alert-light-banner`);
  await control(page, 'header:security').click();
  await control(page, 'security:silence_sound').click();

  // The alarm is sounding, so no confirmation is asked; the script never confirms in this scenario.
  expect(await page.evaluate(() => window.__agrE2E.openDialogs().length)).toBe(1);
  // The button that acted shows its progress in place; the drawer's live region announces it by name.
  const silence = page.locator('agr-button[focus-key="security:silence_sound"]');
  await expect(silence.getByText('Waiting for a response', { exact: true })).toBeVisible();
  await capture(page, testInfo, `${viewport.id}-alert-light-security-sent`);

  // The outcome stays visible in the live region, beside its Dismiss, until acknowledged.
  await expect(
    page
      .locator('agr-control-notes')
      .getByText(
        'No response from the security controller after 10 seconds. Check the alarm state before trying again.',
      ),
  ).toBeVisible({ timeout: SECURITY_TIMEOUT_MS * 2 });
  await expect(silence.getByText('No response yet', { exact: true })).toBeVisible();
  await capture(page, testInfo, `${viewport.id}-alert-light-security-uncertain`);
});
