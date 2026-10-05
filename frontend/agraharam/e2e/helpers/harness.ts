/**
 * Driving the fake HA shell in harness.html (§10.3), which loads the BUILT card bundle. The shell's query string is
 * its only state (scenario, theme, sidebar, host); its toolbar offers the connection toggle and the three remount
 * modes. Every page gets the pinned clock of §12.2 before it loads, so fixtures, greetings and forecasts are the
 * same on every run and in every time zone.
 */
import { expect, type Page } from '@playwright/test';
import type { DemoScenarioId } from '../../src/config/schema.ts';

/** §12.2: an explicit offset, so the machine's own zone cannot shift it. */
export const PINNED_NOW = '2026-09-30T17:51:00-07:00';

export type HostMode = 'demo' | 'fake-hass';
export type Theme = 'light' | 'dark';
export type Sidebar = 'expanded' | 'collapsed';

export interface HarnessOptions {
  readonly scenario?: DemoScenarioId;
  readonly host?: HostMode;
  readonly theme?: Theme;
  readonly sidebar?: Sidebar;
}

/** Shell toolbar actions (labels as rendered). */
export type ShellAction =
  | 'Route change'
  | 'Edit-mode toggle'
  | 'Hidden 5 min'
  | 'Disconnect'
  | 'Reconnect'
  | 'Outage change'
  | 'Deliver first update';

const STABLE_SAMPLES = 3;
const STABLE_INTERVAL_MS = 150;
/**
 * Measured settle time is under 1 s; the deadline is generous because a loaded CI or shared machine slows every
 * sample (each one walks the whole composed tree), and 10 s was missed on a machine at a load average above 50.
 */
const STABLE_TIMEOUT_MS = 20_000;
/**
 * Opens harness.html with the pinned clock and waits until the card has rendered and settled. Pinning the time
 * installs Playwright's clock: timers keep running in real time, and a spec can also run them on at once
 * (runPageTimers) to prove that nothing more happens.
 */
export async function openHarness(page: Page, options: HarnessOptions = {}): Promise<void> {
  await page.clock.setFixedTime(PINNED_NOW);
  // The system scheme matches the HA theme, as with HA's default theme, so the frame painted before the first hass
  // (the `loading` scenario) shows the same theme as the card once it arrives.
  await page.emulateMedia({ colorScheme: options.theme ?? 'light' });
  const params = new URLSearchParams({
    scenario: options.scenario ?? 'normal',
    theme: options.theme ?? 'light',
    sidebar: options.sidebar ?? 'expanded',
    host: options.host ?? 'fake-hass',
  });
  await page.goto(`/harness.html?${params.toString()}`);
  await page.locator('agraharam-dashboard').waitFor({ state: 'attached' });
  await waitForStableRender(page);
}

/**
 * Waits until the card's rendered tree stops changing (element count, text, images, height and open dialogs equal
 * across consecutive samples). Async reads (forecast, calendar, camera stills) land within a few hundred ms.
 */
export async function waitForStableRender(page: Page): Promise<void> {
  const samples: string[] = [];
  const deadline = Date.now() + STABLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    samples.push(await page.evaluate(() => window.__agrE2E.signature()));
    const recent = samples.slice(-STABLE_SAMPLES);
    if (recent.length === STABLE_SAMPLES && recent.every((sample) => sample === recent[0])) return;
    await page.waitForTimeout(STABLE_INTERVAL_MS);
  }
  throw new Error(`the card did not settle within ${STABLE_TIMEOUT_MS} ms`);
}

/** §12.2: layout, a11y and screenshot specs measure only after both Agraharam faces have loaded. */
export async function expectFontsLoaded(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts]
          .filter((face) => face.family.includes('Agraharam'))
          .map((face) => `${face.family.replaceAll('"', '')}:${face.status}`)
          .sort(),
      ),
    )
    .toEqual(['Agraharam Sans:loaded', 'Agraharam Serif:loaded']);
}

/**
 * Clicks a shell toolbar button. The click is dispatched programmatically because an open modal dialog makes the
 * toolbar inert to the pointer, exactly as HA's own chrome is inert while a dialog is open; the shell's remount
 * modes are test controls, not something the user reaches through the card. Waits until the shell is idle again.
 */
export async function shellAction(page: Page, action: ShellAction): Promise<void> {
  await page.evaluate((label) => window.__agrE2E.shellButton(label).click(), action);
  await expect
    .poll(() => page.evaluate(() => window.__agrE2E.shellButton('Route change').disabled), {
      message: `the shell stays busy after "${action}"`,
    })
    .toBe(false);
}

/** The card's own focusable control with this `data-focus-key` (§5.1), anywhere in the composed tree. */
export function control(page: Page, focusKey: string) {
  return page.locator(`[data-focus-key="${focusKey}"]`);
}

/** Moves focus to the card frame (tabindex="-1"), so the next Tab reaches the card's first control. */
export async function focusCardFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = window.__agrE2E.all('.frame', window.__agrE2E.card().shadowRoot ?? document)[0];
    if (!(frame instanceof HTMLElement)) throw new Error('the card has no frame');
    frame.focus();
  });
}
