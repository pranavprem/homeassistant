/**
 * Sky in the browser (AIRSPACE.md §5–§7, ARCHITECTURE.md §19): the optional panel and its drawer in the built card,
 * against FakeHass (host=fake-hass, so outbound aircraft links render as in Home Assistant).
 *
 * - Layout at 1440×900, 1194×834 with the sidebar collapsed (wide placement) and expanded (medium placement), and
 *   390×844: the panel is laid out and reachable, nothing scrolls sideways, and neither the sky nor the quiet panels
 *   stretch. At 1440×900 the full demo household already fills the columns, so the sky sits below the fold in the
 *   rightmost column and the column bottoms "align or are clearly apart" within an explicit 160 px (§11.2, §14).
 * - The drawer fits a 390×844 phone: no sideways scroll, the first row visible on open with the nearest aircraft
 *   expanded, at least five collapsed rows on the first screen, every row reachable; the bottom sheet's radar is
 *   160 px with its labels scaled back to their side-sheet size.
 * - Freshness through Playwright's clock: +4 min and one sky tick ⇒ "Not live" with hollow marks; +16 min ⇒ nothing
 *   is drawn. The shell's Disconnect ⇒ the offline copy, and Reconnect brings the live panel back.
 * - The sky opens no network request and calls nothing; the `normal` scenario has no sky panel.
 *
 * Screenshots of the panel and the drawer at each viewport go to the test output directory for review.
 */
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { expectNoMutation, recordedCalls, runPageTimers, serviceCalls } from './helpers/calls.ts';
import { control, expectFontsLoaded, openHarness, PINNED_NOW, shellAction } from './helpers/harness.ts';
import { columnBottoms, horizontalOverflows, measureLayout, type LayoutMeasure } from './helpers/layout.ts';
import { recordMetrics } from './helpers/metrics.ts';
import { shellSidebar, viewportRow, type ViewportRow } from './helpers/viewports.ts';
import { SKY_TICK_MS } from '../src/components/sky/sky-clock.ts';
import { PANEL_HEIGHT_TARGET_PX } from '../src/model/budget.ts';
import { ALIGN_SNAP_PX } from '../src/styles/layout.ts';

/** §14: at 1440×900 the expected gap is about 136 px (columns 1–2 end near 764 px, column 3 near 900 px). */
const SKY_BOTTOM_TOLERANCE_PX = 160;
/** §6.2.1: bottoms closer than this count as aligned. */
const BOTTOM_ALIGNMENT_PX = 2;
const MS_PER_MINUTE = 60_000;
const NON_STRETCHING = ['agr-sky', 'agr-health', 'agr-upcoming'];
const QUIET = ['agr-health', 'agr-upcoming'];
const LAYOUT_ROW_IDS = ['1440x900-collapsed', '1194x834-collapsed', '1194x834-expanded', '390x844-hidden'] as const;
/** The fixture's nearby list (nearest first) and its one overhead aircraft. */
const NEARBY_COUNT = 8;
const OFFLINE_LINE = 'Not live while Home Assistant is offline';
/** Fully on screen, less sub-pixel layout rounding (a 184 px panel at fractional offsets reads 0.997). */
const IN_VIEW_RATIO = 0.99;
/**
 * Collapsed rows fully visible when the phone sheet opens at the top with no row expanded. ARCHITECTURE.md §19 and
 * the design ask for at least five; measured exactly 5 in Chromium and WebKit with the 160 px bottom-sheet radar
 * (1 to 3 with the earlier 240 px radar). With the nearest aircraft expanded, as Details opens it, only that first
 * row fits, which the test checks separately.
 */
const COLLAPSED_ROWS_ON_OPEN = 5;
/** The bottom sheet's radar side, and its ring labels' computed size (8 viewBox units × the 1.5 text scale). */
const SHEET_RADAR_PX = 160;
const SHEET_RING_LABEL_FONT = '12px';
/** Sub-pixel rounding allowed when comparing layout boxes. */
const LAYOUT_EPSILON_PX = 0.5;

async function openSky(page: Page, viewport: ViewportRow, scenario: 'sky' | 'normal' = 'sky'): Promise<LayoutMeasure> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await openHarness(page, { scenario, host: 'fake-hass', sidebar: shellSidebar(viewport) });
  await expectFontsLoaded(page);
  return measureLayout(page);
}

interface SkyPanelState {
  readonly pill: string | null;
  readonly line: string | null;
  readonly count: string | null;
}

/** The panel's header pill, its state line and its count, as rendered. */
async function skyPanelState(page: Page): Promise<SkyPanelState> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const sky = tools.all('agr-sky', tools.card().shadowRoot ?? document)[0];
    const root = sky?.shadowRoot;
    if (root === null || root === undefined) throw new Error('the sky panel is not rendered');
    const text = (element: Element | null | undefined): string | null =>
      element === null || element === undefined ? null : (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      pill: text(root.querySelector('agr-panel')?.shadowRoot?.querySelector('.pill')),
      line: text(root.querySelector('.state-line')),
      count: text(root.querySelector('.count')),
    };
  });
}

interface SkyDrawerState {
  readonly status: string | null;
  readonly banner: string;
  readonly rows: number;
  readonly mutedRows: number;
  readonly radarLive: string | null;
  readonly hollowMarks: number;
  readonly chevrons: number;
}

async function skyDrawerState(page: Page): Promise<SkyDrawerState> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const drawer = tools.all('agr-sky-drawer')[0];
    const root = drawer?.shadowRoot;
    if (root === null || root === undefined) throw new Error('the sky drawer is not open');
    const radar = root.querySelector('agr-sky-radar')?.shadowRoot;
    return {
      status: root.querySelector('.banner')?.getAttribute('data-status') ?? null,
      banner: (root.querySelector('.sentence')?.textContent ?? '').trim(),
      rows: root.querySelectorAll('button.aircraft-row').length,
      mutedRows: root.querySelectorAll('button.aircraft-row[data-muted]').length,
      radarLive: radar?.querySelector('svg')?.getAttribute('data-live') ?? null,
      hollowMarks: radar?.querySelectorAll('circle.mark.hollow').length ?? 0,
      chevrons: radar?.querySelectorAll('path.mark').length ?? 0,
    };
  });
}

async function openSkyDrawer(page: Page): Promise<void> {
  await control(page, 'sky:details').click();
  await expect.poll(() => page.evaluate(() => window.__agrE2E.topDialog() !== null)).toBe(true);
  await page.evaluate(() => window.__agrE2E.animationsSettled());
}

/** Moves the page clock to `minutes` after the pinned time and runs one sky tick, which re-renders the sky. */
async function clockAt(page: Page, minutes: number): Promise<void> {
  await page.clock.setFixedTime(new Date(Date.parse(PINNED_NOW) + minutes * MS_PER_MINUTE));
  await runPageTimers(page, SKY_TICK_MS);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string, panelOnly = false): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  if (panelOnly) await page.locator('agr-sky').screenshot({ path, animations: 'disabled', caret: 'hide' });
  else await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
}

/** Column bottoms align (within 2 px) or differ clearly (by at least ALIGN_SNAP_PX − 1), within `tolerancePx`. */
function expectAlignedOrClearlyApart(measure: LayoutMeasure, tolerancePx: number): void {
  const bottoms = columnBottoms(measure);
  const label = `column bottoms ${bottoms.join(', ')}`;
  expect(Math.max(...bottoms) - Math.min(...bottoms), label).toBeLessThanOrEqual(tolerancePx);
  for (const a of bottoms) {
    for (const b of bottoms) {
      const apart = Math.abs(a - b);
      expect(apart <= BOTTOM_ALIGNMENT_PX || apart >= ALIGN_SNAP_PX - 1, `${label}: a near miss`).toBe(true);
    }
  }
}

test.use({ reducedMotion: 'reduce' });

test.describe('sky layout (AIRSPACE.md §7)', () => {
  for (const rowId of LAYOUT_ROW_IDS) {
    test(`${rowId}: the panel is laid out and reachable, nothing scrolls sideways, sky and quiet panels never stretch`, async ({
      page,
    }, testInfo) => {
      const measure = await openSky(page, viewportRow(rowId));
      const sections = measure.columns.flat();
      const sky = sections.find((section) => section.tag === 'agr-sky');
      const column = measure.columns.find((candidate) => candidate.some((section) => section.tag === 'agr-sky'));
      recordMetrics('sky-layout', `${testInfo.project.name}-${rowId}`, {
        mode: measure.mode,
        columnBottoms: columnBottoms(measure),
        sky: sky === undefined ? null : { height: sky.height, naturalHeight: sky.naturalHeight },
        target: PANEL_HEIGHT_TARGET_PX.sky,
      });

      expect(sky, 'the sky panel').toBeDefined();
      expect(horizontalOverflows(measure), 'horizontal overflow').toEqual([]);
      for (const section of sections.filter((candidate) => NON_STRETCHING.includes(candidate.tag))) {
        expect(section.stretched, `${section.tag} is marked to stretch`).toBe(false);
        expect(Math.abs(section.height - section.naturalHeight), `${section.tag} taller than its content`).toBeLessThan(
          1.5,
        );
      }
      // The satellite joins a column after its raised panels and before its quiet ones (§11.2).
      const tags = (column ?? []).map((section) => section.tag);
      for (const quiet of QUIET.filter((tag) => tags.includes(tag))) {
        expect(tags.indexOf('agr-sky'), `sky before ${quiet} in ${tags.join(', ')}`).toBeLessThan(tags.indexOf(quiet));
      }
      if (rowId === '1440x900-collapsed') {
        expect(measure.mode).toBe('wide');
        expect(measure.columns.at(-1)?.map((section) => section.tag)).toContain('agr-sky');
        expectAlignedOrClearlyApart(measure, SKY_BOTTOM_TOLERANCE_PX);
        expect(sky?.naturalHeight ?? Infinity, 'sky height against its target').toBeLessThanOrEqual(
          PANEL_HEIGHT_TARGET_PX.sky + 1,
        );
      }

      const panel = page.locator('agr-sky');
      await panel.scrollIntoViewIfNeeded();
      await expect(panel).toBeInViewport({ ratio: IN_VIEW_RATIO });
      expect(await skyPanelState(page)).toEqual({ pill: null, line: null, count: String(NEARBY_COUNT) });
      await screenshot(page, testInfo, `sky-panel-${rowId}`, true);

      await openSkyDrawer(page);
      await screenshot(page, testInfo, `sky-drawer-${rowId}`);
    });
  }

  test('the normal scenario has no sky panel', async ({ page }) => {
    const measure = await openSky(page, viewportRow('1440x900-collapsed'), 'normal');
    expect(measure.columns.flat().map((section) => section.tag)).not.toContain('agr-sky');
    expect(await page.evaluate(() => window.__agrE2E.all('agr-sky').length)).toBe(0);
  });
});

test.describe('the sky drawer on a 390×844 phone', () => {
  test('fits the viewport with no sideways scroll; the first row is visible on open, five collapsed rows fit, and every row is reachable', async ({
    page,
  }) => {
    await openSky(page, viewportRow('390x844-hidden'));
    await openSkyDrawer(page);
    const fit = await page.evaluate(() => {
      const tools = window.__agrE2E;
      const dialog = tools.topDialog();
      const drawer = tools.all('agr-sky-drawer')[0];
      const rows = [...(drawer?.shadowRoot?.querySelectorAll('button.aircraft-row') ?? [])];
      if (dialog === null || rows.length === 0) throw new Error('no open sky drawer with rows');
      const box = dialog.getBoundingClientRect();
      const first = rows[0]!.getBoundingClientRect();
      // Every element in the drawer's composed tree, to catch a child wider than the sheet.
      const wide = tools
        .all('*', drawer?.shadowRoot ?? document)
        .filter((element) => element.getBoundingClientRect().right > box.right + 0.5)
        .map((element) => element.tagName.toLowerCase());
      return {
        dialog: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        scrollWidth: dialog.scrollWidth,
        clientWidth: dialog.clientWidth,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        first: { top: first.top, bottom: first.bottom },
        rows: rows.length,
        wide,
      };
    });

    expect(fit.dialog.left).toBeGreaterThanOrEqual(-0.5);
    expect(fit.dialog.right).toBeLessThanOrEqual(fit.viewport.width + 0.5);
    expect(fit.dialog.bottom).toBeLessThanOrEqual(fit.viewport.height + 0.5);
    expect(fit.scrollWidth, 'sideways scroll inside the drawer').toBeLessThanOrEqual(fit.clientWidth);
    expect(fit.wide, 'elements wider than the sheet').toEqual([]);
    expect(fit.rows).toBe(NEARBY_COUNT);
    expect(fit.first.top, 'first row below the sheet top').toBeGreaterThanOrEqual(fit.dialog.top);
    expect(fit.first.bottom, 'first row visible on open').toBeLessThanOrEqual(
      Math.min(fit.dialog.bottom, fit.viewport.height),
    );

    // The bottom sheet's radar is smaller, with its labels scaled back up to their side-sheet size.
    const radar = await page.evaluate(() => {
      const root = window.__agrE2E.all('agr-sky-drawer')[0]?.shadowRoot;
      const element = root?.querySelector('agr-sky-radar');
      const ringLabel = element?.shadowRoot?.querySelector('text[data-role="ring"]');
      return {
        width: element?.getBoundingClientRect().width ?? 0,
        ringFont: ringLabel === null || ringLabel === undefined ? null : getComputedStyle(ringLabel).fontSize,
      };
    });
    expect(radar.width, 'bottom-sheet radar width').toBeLessThanOrEqual(SHEET_RADAR_PX + LAYOUT_EPSILON_PX);
    expect(radar.ringFont, 'ring label size on the small radar').toBe(SHEET_RING_LABEL_FONT);

    // With no row expanded, at least five collapsed rows fit on the sheet's first screen.
    await page.locator('agr-sky-drawer button.aircraft-row[aria-expanded="true"]').click();
    const collapsed = await page.evaluate((epsilon) => {
      const tools = window.__agrE2E;
      const dialog = tools.topDialog();
      const body = dialog?.querySelector<HTMLElement>('.dialog-body') ?? dialog;
      if (dialog === null || body === null) throw new Error('no open sky drawer');
      body.scrollTop = 0;
      const port = body.getBoundingClientRect();
      const bottom = Math.min(port.bottom, dialog.getBoundingClientRect().bottom, window.innerHeight);
      const rows = [...(tools.all('agr-sky-drawer')[0]?.shadowRoot?.querySelectorAll('button.aircraft-row') ?? [])];
      return {
        expanded: rows.filter((row) => row.getAttribute('aria-expanded') === 'true').length,
        visible: rows.filter((row) => {
          const box = row.getBoundingClientRect();
          return box.top >= port.top - epsilon && box.bottom <= bottom + epsilon;
        }).length,
      };
    }, LAYOUT_EPSILON_PX);
    expect(collapsed.expanded).toBe(0);
    expect(collapsed.visible, 'collapsed rows fully visible on open').toBeGreaterThanOrEqual(COLLAPSED_ROWS_ON_OPEN);

    // The list is reachable: the last row scrolls into view inside the sheet.
    const lastRow = page.locator('agr-sky-drawer button.aircraft-row').last();
    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport({ ratio: IN_VIEW_RATIO });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe('sky freshness in the browser (AIRSPACE.md §5)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('+4 min and one sky tick: Not live, muted rows and hollow marks; +16 min: nothing drawn', async ({ page }) => {
    await openHarness(page, { scenario: 'sky', host: 'fake-hass', sidebar: 'collapsed' });
    expect(await skyPanelState(page)).toEqual({ pill: null, line: null, count: String(NEARBY_COUNT) });

    await clockAt(page, 4);
    await expect
      .poll(() => skyPanelState(page))
      .toEqual({ pill: 'Not live', line: 'No fresh aircraft data', count: null });
    await openSkyDrawer(page);
    expect(await skyDrawerState(page)).toEqual({
      status: 'stale',
      banner: 'Not live. Positions have changed since the last update.',
      rows: NEARBY_COUNT,
      mutedRows: NEARBY_COUNT,
      radarLive: 'false',
      hollowMarks: NEARBY_COUNT,
      chevrons: 0,
    });

    await clockAt(page, 16);
    await expect
      .poll(() => skyDrawerState(page))
      .toMatchObject({
        status: 'stale',
        banner: 'No fresh aircraft data.',
        rows: 0,
        radarLive: null,
        hollowMarks: 0,
      });
    await expectNoMutation(page);
  });

  test("the shell's Disconnect shows the offline copy; Reconnect brings the live panel back", async ({ page }) => {
    await openHarness(page, { scenario: 'sky', host: 'fake-hass', sidebar: 'collapsed' });
    await shellAction(page, 'Disconnect');
    await expect.poll(() => skyPanelState(page)).toEqual({ pill: 'Offline', line: OFFLINE_LINE, count: null });
    await openSkyDrawer(page);
    expect(await skyDrawerState(page)).toMatchObject({
      status: 'offline',
      banner: 'Not live. Showing the last aircraft received.',
      rows: NEARBY_COUNT,
      mutedRows: NEARBY_COUNT,
      radarLive: 'false',
      chevrons: 0,
    });

    await shellAction(page, 'Reconnect');
    await expect.poll(() => skyDrawerState(page)).toMatchObject({ status: 'live', banner: '', mutedRows: 0 });
    await page.keyboard.press('Escape');
    await expect.poll(() => skyPanelState(page)).toEqual({ pill: null, line: null, count: String(NEARBY_COUNT) });
    await expectNoMutation(page);
  });
});

test.describe('the sky stays local (AIRSPACE.md §9)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opening the drawer, every view and sort, expanding rows and a radar mark make no request and no call', async ({
    page,
  }) => {
    await openHarness(page, { scenario: 'sky', host: 'fake-hass', sidebar: 'collapsed' });
    await expectFontsLoaded(page);
    const requests: string[] = [];
    // In-page blob: and data: URLs never leave the browser (the network guard's own rule); WebKit reports the camera
    // stills' blob: loads as requests, Chromium does not.
    page.on('request', (request) => {
      if (!/^(blob|data):/.test(request.url())) requests.push(request.url());
    });
    const callsBefore = (await recordedCalls(page)).length;

    await openSkyDrawer(page);
    for (const view of ['overhead', 'recent', 'nearby']) {
      await control(page, `sky:view:${view}`).click();
      for (const sort of view === 'recent' ? ['latest', 'altitude', 'name'] : ['altitude', 'name', 'distance']) {
        await control(page, `sky:sort:${sort}`).click();
      }
      const rows = page.locator('agr-sky-drawer button.aircraft-row');
      for (let index = 0; index < (await rows.count()); index += 1) await rows.nth(index).click();
    }
    // The mark's own handler, as a pointer on its invisible hit circle runs it (marks may overlap, so no real click).
    await page.locator('agr-sky-radar circle.hit').first().dispatchEvent('click');
    await page.keyboard.press('Escape');
    await control(page, 'today:details').click();
    await page.keyboard.press('Escape');
    await runPageTimers(page, SKY_TICK_MS * 3);

    expect(requests, 'requests made by the sky').toEqual([]);
    const added = (await recordedCalls(page)).slice(callsBefore);
    expect(added.filter((call) => JSON.stringify(call.args).includes('sensor.demo_sky_airspace'))).toEqual([]);
    expect(serviceCalls(added)).toEqual([]);
    await expectNoMutation(page);
  });
});
