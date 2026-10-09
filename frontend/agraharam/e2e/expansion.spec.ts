/** Household expansion through the built bundle, using fictional FakeHass only. */
import { expect, test } from './fixtures.ts';
import { control, expectFontsLoaded, openHarness, shellAction } from './helpers/harness.ts';
import { expectNoMutation, expectServiceCallCount } from './helpers/calls.ts';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1194, height: 834 },
  { width: 390, height: 844 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`expanded household ${viewport.width}×${viewport.height} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openHarness(page, { scenario: 'dense', theme, sidebar: 'collapsed' });
      await expectFontsLoaded(page);
      const art = page.locator('agr-vehicle svg[data-model="tesla-model-3"]');
      await expect(art).toBeVisible();
      await art.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('model-3-household.png'), animations: 'disabled' });
      await art.screenshot({ path: testInfo.outputPath('model-3.png'), animations: 'disabled' });
      await control(page, 'health:readings').click();
      const drawer = page.locator('agr-readings-drawer');
      await expect(drawer.getByRole('heading', { name: 'House readings', exact: true })).toBeVisible();
      await expect(drawer.locator('.group')).toHaveCount(7);
      const search = drawer.getByRole('searchbox', { name: 'Find a reading' });
      await search.fill('washer');
      await expect(drawer.locator('.reading')).toHaveCount(2);
      await expect(drawer.locator('.reading').first()).toContainText('1 h 25 min');
      await search.fill('');
      await page.evaluate(() => window.__agrE2E.animationsSettled());
      const overflow = await drawer.evaluate((host) => {
        const root = host.shadowRoot!;
        const shell = root.querySelector('agr-drawer')!;
        const dialog = shell.shadowRoot!.querySelector('dialog')!;
        return { extra: dialog.scrollWidth - dialog.clientWidth, right: dialog.getBoundingClientRect().right };
      });
      expect(overflow.extra).toBeLessThanOrEqual(1);
      expect(overflow.right).toBeLessThanOrEqual(viewport.width + 1);
      await page.screenshot({ path: testInfo.outputPath('readings.png'), animations: 'disabled' });
      expect(await drawer.locator('.reading button, .reading input, .reading a').count()).toBe(0);
      await drawer.locator('.reading').first().click();
      await expectNoMutation(page);
    });
  }
}

test('search Escape clears first, then closes and restores focus; reopening resets search', async ({ page }) => {
  await openHarness(page, { scenario: 'dense', sidebar: 'collapsed' });
  await control(page, 'health:readings').click();
  const drawer = page.locator('agr-readings-drawer');
  const search = drawer.getByRole('searchbox', { name: 'Find a reading' });
  await search.fill('no such reading');
  await expect(drawer.locator('.matches')).toHaveText('No readings match');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(drawer.locator('.group')).toHaveCount(7);
  await search.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(control(page, 'health:readings')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('');
  await expectNoMutation(page);
});

test('whole-house lights require confirmation; cancelling sends nothing; confirming sends one scoped script', async ({
  page,
}) => {
  await openHarness(page, { scenario: 'dense', sidebar: 'collapsed' });
  await control(page, 'home:shortcut:lights_toggle').click();
  const dialog = page.locator('agr-confirm-dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Toggle the whole-house lights?');
  await expectNoMutation(page);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectNoMutation(page);
  await control(page, 'home:shortcut:lights_toggle').click();
  await dialog.getByRole('button', { name: 'Toggle lights', exact: true }).click();
  expect(await expectServiceCallCount(page, 1)).toEqual([
    { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: 'script.demo_house_lights_toggle' } },
  ]);
});

test('readings remain browsable offline and never report current healthy counts', async ({ page }) => {
  await openHarness(page, { scenario: 'dense', sidebar: 'collapsed' });
  await shellAction(page, 'Disconnect');
  await control(page, 'health:readings').click();
  const drawer = page.locator('agr-readings-drawer');
  await expect(drawer.locator('.lead')).toContainText('Values shown are the last known');
  await drawer.getByRole('searchbox').fill('washer');
  await expect(drawer.locator('.stale')).toHaveCount(2);
  await expectNoMutation(page);
});
