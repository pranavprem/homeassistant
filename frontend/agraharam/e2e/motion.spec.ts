/**
 * Reduced motion (§1.2 item 10, §6.5 "Motion", §12.2 motion.spec): with `prefers-reduced-motion: reduce`, drawers
 * appear without a transition, a pending action is announced by its "Sending" text alone (no underline sweep), and
 * the demo live-view scene stands still. The same checks without the preference prove they are not vacuous.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { control, openHarness, type HostMode } from './helpers/harness.ts';

/** The purifier's power button in its climate drawer: the shared fan controls show ticket status on the button. */
const PURIFIER_OPEN = 'comfort:fan.demo_purifier:open';
const PURIFIER_POWER = 'climate:fan.demo_purifier:power';

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, host: HostMode = 'fake-hass'): Promise<void> {
  await openHarness(page, { host, sidebar: 'collapsed' });
}

/** The longest transition duration on the topmost open dialog, in seconds. */
async function dialogTransitionSeconds(page: Page): Promise<number> {
  await expect.poll(() => page.evaluate(() => window.__agrE2E.topDialog() !== null)).toBe(true);
  return page.evaluate(() => {
    const dialog = window.__agrE2E.topDialog();
    if (dialog === null) return -1;
    return Math.max(
      ...getComputedStyle(dialog)
        .transitionDuration.split(',')
        .map((part) => Number.parseFloat(part)),
    );
  });
}

/** Running finite or infinite animations on `selector`'s elements and everything rendered inside them. */
async function runningAnimations(page: Page, selector: string): Promise<number> {
  return page.evaluate((target) => {
    const tools = window.__agrE2E;
    const animations = new Set<Animation>();
    for (const host of tools.all(target)) {
      for (const element of [host, ...tools.all('*', host.shadowRoot ?? host)]) {
        for (const animation of element.getAnimations({ subtree: true })) {
          if (animation.playState === 'running') animations.add(animation);
        }
      }
    }
    return animations.size;
  }, selector);
}

/** Turns the purifier off from its drawer and waits until the ticket is pending (FakeHass answers within
 *  SIMULATED_CALL_LATENCY_MS, src/timing.ts). */
async function startPendingAction(page: Page): Promise<void> {
  await control(page, PURIFIER_OPEN).click();
  await control(page, PURIFIER_POWER).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) => window.__agrE2E.all(`[data-focus-key="${key}"]`)[0]?.getAttribute('data-phase'),
          PURIFIER_POWER,
        ),
      { intervals: [20] },
    )
    .toBe('pending');
}

const PENDING_BUTTON = `[data-focus-key="${PURIFIER_POWER}"]`;

test.describe('with prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a drawer appears without a transition', async ({ page }) => {
    await open(page);
    await control(page, 'room:0:open').click();
    expect(await dialogTransitionSeconds(page)).toBe(0);
  });

  test('a pending action shows "Sending" without the underline sweep', async ({ page }) => {
    await open(page);
    await startPendingAction(page);
    expect(await runningAnimations(page, PENDING_BUTTON)).toBe(0);
    await expect(page.locator('agr-fan-controls').getByText('Sending', { exact: true })).toBeVisible();
  });

  test('the demo live-view scene stands still', async ({ page }) => {
    await open(page, 'demo');
    await control(page, 'camera:0:live').click();
    await expect(page.locator('agr-demo-stream')).toBeVisible();
    expect(await runningAnimations(page, 'agr-demo-stream')).toBe(0);
  });
});

test.describe('without the preference (the reduced-motion checks are not vacuous)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('drawers transition, the pending sweep runs and the demo scene moves', async ({ page }) => {
    await open(page, 'demo');
    await control(page, 'camera:0:live').click();
    expect(await dialogTransitionSeconds(page)).toBeGreaterThan(0);
    await expect(page.locator('agr-demo-stream')).toBeVisible();
    expect(await runningAnimations(page, 'agr-demo-stream')).toBeGreaterThan(0);

    await open(page);
    await startPendingAction(page);
    expect(await runningAnimations(page, PENDING_BUTTON)).toBeGreaterThan(0);
  });
});
