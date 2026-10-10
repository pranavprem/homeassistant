/**
 * Layout (§6.1, §6.2, §6.2.1, §6.4, ACCEPTANCE "Visual/browser review"): the built card inside the fake HA shell at
 * every row of the §6.1 tables. Column mode, header variant, hero size and forecast cell count must match the
 * tables; nothing may scroll horizontally, overflow its frame, clip or overlap; the header compacts by its OWN
 * container width; and the `normal` scenario meets the §6.2.1 hard gate with live-mode chrome (host=fake-hass).
 * Panel heights against their §6.2.1 targets are written to test-results/metrics/layout.json.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { control, expectFontsLoaded, openHarness, type HarnessOptions } from './helpers/harness.ts';
import {
  columnBottoms,
  horizontalOverflows,
  measureLayout,
  midWordSplits,
  panelVoids,
  type LayoutMeasure,
} from './helpers/layout.ts';
import { recordMetrics } from './helpers/metrics.ts';
import { shellSidebar, VIEWPORT_ROWS, viewportRow, type ViewportRow } from './helpers/viewports.ts';
import { PANEL_HEIGHT_TARGET_PX, type PanelId } from '../src/model/budget.ts';
import { HEADER_CQ } from '../src/styles/breakpoints.ts';
import { ALIGN_SNAP_PX } from '../src/styles/layout.ts';

/** §6.2.1: wide-mode column bottoms align within 2 px. */
const BOTTOM_ALIGNMENT_PX = 2;
/**
 * §16.14: outside `normal`, a stretched panel takes at most 64 px of its column's slack and the column may end short
 * rather than open a void inside Today or Garage; after spare height is spent on content, the bottoms stay within
 * this of each other.
 */
const RELAXED_BOTTOM_ALIGNMENT_PX = 120;
/** A panel that takes its column's slack keeps its content together: no band of empty space inside it is taller. */
const MAX_INNER_GAP_PX = 40;
/** The 640 px gate (§16.14): no band of empty space inside a panel is taller than this. */
const MAX_INNER_GAP_640_PX = 48;
/** A classic scrollbar may take this much from the card width; overlay scrollbars take none. */
const SCROLLBAR_ALLOWANCE_PX = 16;
/** A viewport whose compact header box (336 px) cannot fit "Alarm state unknown" on one line. */
const WRAP_VIEWPORT = { width: 360, height: 780 } as const;
const QUIET_PANELS = ['agr-health', 'agr-upcoming'] as const;

async function openAt(page: Page, viewport: ViewportRow, options: HarnessOptions = {}): Promise<LayoutMeasure> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await openHarness(page, { host: 'fake-hass', sidebar: shellSidebar(viewport), ...options });
  await expectFontsLoaded(page);
  return measureLayout(page);
}

function expectNoHorizontalOverflow(measure: LayoutMeasure): void {
  expect(horizontalOverflows(measure), 'horizontal overflow').toEqual([]);
}

function expectAlignedBottoms(measure: LayoutMeasure, tolerancePx = BOTTOM_ALIGNMENT_PX): void {
  const bottoms = columnBottoms(measure);
  expect(Math.max(...bottoms) - Math.min(...bottoms), `column bottoms ${bottoms.join(', ')}`).toBeLessThanOrEqual(
    tolerancePx,
  );
}

/**
 * Where the composition does not fit its viewport, a stretched panel takes at most its capped share of the slack
 * (§16.14): column bottoms then align or differ clearly (by more than ALIGN_SNAP_PX less a pixel of rounding), never
 * by a near miss, and never by more than the relaxed tolerance.
 */
function expectAlignedOrClearlyApart(measure: LayoutMeasure): void {
  const bottoms = columnBottoms(measure);
  const label = `column bottoms ${bottoms.join(', ')}`;
  expect(Math.max(...bottoms) - Math.min(...bottoms), label).toBeLessThanOrEqual(RELAXED_BOTTOM_ALIGNMENT_PX);
  for (const a of bottoms) {
    for (const b of bottoms) {
      const apart = Math.abs(a - b);
      expect(apart <= BOTTOM_ALIGNMENT_PX || apart >= ALIGN_SNAP_PX - 1, `${label}: a near miss`).toBe(true);
    }
  }
}

/** The rows the §6.2.1 composition is designed for: 1440×900 in both sidebar states fit, so their columns align. */
const ALIGNED_ROW_IDS: readonly string[] = ['1440x900-collapsed', '1440x900-expanded'];

/** Each panel's own content height against its §6.2.1 target, for the owning package to read. */
function panelMetrics(measure: LayoutMeasure): Record<string, unknown> {
  return {
    viewport: measure.viewport,
    cardWidth: measure.cardWidth,
    mode: measure.mode,
    verticalOverflowPx: Math.max(0, measure.view.scrollHeight - measure.view.clientHeight),
    columnBottoms: columnBottoms(measure),
    panels: measure.columns.map((column) =>
      column.map((section) => {
        const id = section.tag.replace(/^agr-/, '') as PanelId;
        const target = PANEL_HEIGHT_TARGET_PX[id];
        return {
          panel: id,
          contentHeight: section.naturalHeight,
          laidOutHeight: section.height,
          target,
          overTargetPx: Math.max(0, Math.round(section.naturalHeight - target)),
          stretched: section.stretched,
        };
      }),
    ),
  };
}

test.describe('§6.1 viewport matrix (normal, host=fake-hass)', () => {
  for (const viewport of VIEWPORT_ROWS) {
    test(`${viewport.id}: ${viewport.mode} columns, ${viewport.header} header, ${viewport.heroPx} px hero, ${viewport.forecastCells} forecast hours`, async ({
      page,
    }) => {
      const measure = await openAt(page, viewport);

      // Soft: every mismatch with the §6.1 tables is reported, not just the first.
      expect.soft(measure.cardWidth, 'card width').toBeLessThanOrEqual(viewport.cardWidth + 1);
      expect.soft(measure.cardWidth, 'card width').toBeGreaterThanOrEqual(viewport.cardWidth - SCROLLBAR_ALLOWANCE_PX);
      expect.soft(measure.mode, 'column mode').toBe(viewport.mode);
      expect.soft(measure.header.variant, 'header variant').toBe(viewport.header);
      expect.soft(measure.heroPx, 'Today hero size').toBe(viewport.heroPx);
      expect.soft(measure.forecastCells, 'forecast hours shown').toBe(viewport.forecastCells);
      expectNoHorizontalOverflow(measure);
      if (ALIGNED_ROW_IDS.includes(viewport.id)) expectAlignedBottoms(measure);
      else if (viewport.mode === 'wide') expectAlignedOrClearlyApart(measure);
    });

    test(`${viewport.id}: every control is fully on screen, inside its panel, unclipped and not overlapping another`, async ({
      page,
    }) => {
      const { controls } = await openAt(page, viewport);

      expect(controls.count).toBeGreaterThan(10);
      expect(controls.outsideViewport, 'controls outside the viewport').toEqual([]);
      expect(controls.outsideSection, 'controls outside their panel').toEqual([]);
      expect(controls.clipped, 'controls whose label is clipped').toEqual([]);
      expect(controls.overlaps, 'overlapping controls').toEqual([]);
    });
  }
});

test.describe('the same control check with the optional sky panel (sky scenario, AIRSPACE.md §7, §8)', () => {
  for (const viewport of VIEWPORT_ROWS) {
    test(`sky at ${viewport.id}: every control (Sky and Weather Details included) is on screen, inside its panel, unclipped, not overlapping`, async ({
      page,
    }) => {
      const { controls } = await openAt(page, viewport, { scenario: 'sky' });
      const keys = await page.evaluate(() =>
        window.__agrE2E.all('[data-focus-key]').map((element) => element.getAttribute('data-focus-key')),
      );

      expect(keys).toEqual(expect.arrayContaining(['sky:details', 'today:details']));
      expect(controls.count).toBeGreaterThan(10);
      expect(controls.outsideViewport, 'controls outside the viewport').toEqual([]);
      expect(controls.outsideSection, 'controls outside their panel').toEqual([]);
      expect(controls.clipped, 'controls whose label is clipped').toEqual([]);
      expect(controls.overlaps, 'overlapping controls').toEqual([]);
    });
  }
});

test.describe("Today's header keeps the Offline pill, the sun item and Details inside the panel (AIRSPACE.md §8)", () => {
  for (const viewport of VIEWPORT_ROWS) {
    test(`offline at ${viewport.id}: pill, sun item and Details inside the Today panel, unclipped, not overlapping`, async ({
      page,
    }) => {
      await openAt(page, viewport, { scenario: 'offline' });
      const header = await todayHeader(page);

      expect(header.pill, 'the Offline pill').toBe('Offline');
      expect(header.missing, 'header items not rendered').toEqual([]);
      expect(header.outside, 'header items outside the Today panel').toEqual([]);
      expect(header.clipped, 'header items whose content is clipped').toEqual([]);
      expect(header.overlaps, 'overlapping header items').toEqual([]);
      expect(header.offLine, 'header items not on the heading line').toEqual([]);
    });
  }
});

test.describe('the longest header labels never overflow at any §6.1 width', () => {
  // dense: "Armed vacation" (longest armed label); offline: stale pill with "Last known"; degraded: "Alarm state
  // unknown" (longest label of all, §16.10).
  for (const scenario of ['dense', 'offline', 'degraded'] as const) {
    for (const viewport of VIEWPORT_ROWS) {
      test(`${scenario} at ${viewport.id}: no horizontal scroll, the pill label is shown in full`, async ({ page }) => {
        const measure = await openAt(page, viewport, { scenario });
        const pill = await securityPillText(page);

        expectNoHorizontalOverflow(measure);
        expect(pill.labelClipped, `pill label "${pill.label}" is clipped`).toBe(false);
        expect(pill.insideHeader).toBe(true);
        if (scenario === 'offline') expect(pill.detail).toBe('Last known');
      });
    }
  }
});

test.describe('§6.2 a stretched panel keeps its content together (slack collects below it, never between children)', () => {
  const cases: readonly {
    readonly scenario: 'normal' | 'dense' | 'degraded' | 'restricted' | 'starting';
    readonly viewportId: string;
  }[] = [
    ...VIEWPORT_ROWS.map((viewport) => ({ scenario: 'normal' as const, viewportId: viewport.id })),
    { scenario: 'dense', viewportId: '1440x900-collapsed' },
    { scenario: 'dense', viewportId: '1440x900-expanded' },
    { scenario: 'degraded', viewportId: '1440x900-collapsed' },
    { scenario: 'restricted', viewportId: '1440x900-collapsed' },
    { scenario: 'starting', viewportId: '1440x900-collapsed' },
    { scenario: 'degraded', viewportId: '1194x834-collapsed' },
  ];
  for (const { scenario, viewportId } of cases) {
    test(`${scenario} at ${viewportId}: no gap between a panel's children exceeds ${MAX_INNER_GAP_PX} px`, async ({
      page,
    }) => {
      await openAt(page, viewportRow(viewportId), { scenario });
      const voids = (await panelVoids(page)).filter((panel) => panel.largestGapPx > MAX_INNER_GAP_PX);

      expect(voids, 'panels with an inner void').toEqual([]);
    });
  }
});

test.describe('the 640 px gate (§16.14): one calm column', () => {
  for (const scenario of ['normal', 'dense', 'degraded', 'restricted'] as const) {
    test(`${scenario} at 640x900: no word is split across lines and no gap inside a panel exceeds ${MAX_INNER_GAP_640_PX} px`, async ({
      page,
    }) => {
      await openAt(page, viewportRow('640x900-hidden'), { scenario });

      expect(await midWordSplits(page), 'words split across lines').toEqual([]);
      const voids = (await panelVoids(page)).filter((panel) => panel.largestGapPx > MAX_INNER_GAP_640_PX);
      expect(voids, 'panels with an inner void').toEqual([]);
    });
  }
});

test.describe('a layout change re-creates the sections without flashing the forecast or calendar skeletons', () => {
  test('toggling the sidebar at 1194×834 (wide to medium and back) never shows a Today or Upcoming placeholder', async ({
    page,
  }) => {
    const measure = await openAt(page, viewportRow('1194x834-collapsed'));
    expect(measure.mode).toBe('wide');

    for (const label of ['Sidebar: collapsed', 'Sidebar: expanded']) {
      const flashed = await page.evaluate(async (button) => {
        const tools = window.__agrE2E;
        const placeholders = (): number =>
          ['agr-today', 'agr-upcoming']
            .flatMap((tag) => tools.all(tag, tools.card().shadowRoot ?? document))
            .flatMap((section) => tools.all('.skeleton, .ghost', section.shadowRoot ?? section))
            .filter((element) => element.getBoundingClientRect().height > 0).length;
        tools.shellButton(button).click();
        let seen = 0;
        const until = performance.now() + 1500;
        while (performance.now() < until) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          seen = Math.max(seen, placeholders());
        }
        return seen;
      }, label);

      expect(flashed, `placeholders seen after "${label}"`).toBe(0);
    }
    expect((await measureLayout(page)).mode).toBe('wide');
  });
});

test.describe('§6.4 header: its own container query decides the variant', () => {
  test('agr-header is an inline-size container named "header"', async ({ page }) => {
    const measure = await openAt(page, viewportRow('1440x900-collapsed'));

    expect(measure.header.containerType).toBe('inline-size');
    expect(measure.header.containerName.split(/\s+/)).toContain('header');
  });

  test('the policy line shows only while the header box is at least 1040 px, whatever the viewport', async ({
    page,
  }) => {
    // 1194×834 with the sidebar collapsed: header box 1090 → full, policy shown.
    const wide = await openAt(page, viewportRow('1194x834-collapsed'));
    expect(wide.header.width).toBeGreaterThanOrEqual(HEADER_CQ.full);
    expect(wide.header.policyShown).toBe(true);

    // Same viewport, sidebar expanded: the viewport is still wider than 1040 but the header box is not.
    const medium = await openAt(page, viewportRow('1194x834-expanded'));
    expect(medium.viewport.width).toBeGreaterThanOrEqual(HEADER_CQ.full);
    expect(medium.header.width).toBeLessThan(HEADER_CQ.full);
    expect(medium.header.variant).toBe('medium');
    expect(medium.header.policyShown).toBe(false);

    // 1136×800 collapsed: a wide column layout (card 1080) can still have a medium header (box 1032).
    const edge = await openAt(page, viewportRow('1136x800-collapsed'));
    expect(edge.mode).toBe('wide');
    expect(edge.header.width).toBeLessThan(HEADER_CQ.full);
    expect(edge.header.policyShown).toBe(false);
  });

  test('the kolam mark is hidden only below a 380 px header box', async ({ page }) => {
    const narrow = await openAt(page, viewportRow('390x844-hidden'));
    expect(narrow.header.width).toBeLessThan(HEADER_CQ.kolam);
    expect(narrow.header.variant).toBe('compact-no-kolam');

    const compact = await openAt(page, viewportRow('640x900-hidden'));
    expect(compact.header.width).toBeGreaterThanOrEqual(HEADER_CQ.kolam);
    expect(compact.header.variant).toBe('compact');
  });

  // §6.4: the compact pill may wrap; it is never truncated and never overflows. Whether "Alarm state unknown"
  // actually needs a second line depends on the platform's text metrics (one line on Linux WebKit, two on macOS),
  // so the test asserts the wrapping mechanism and its outcome, not a line count.
  test('in the compact header "Alarm state unknown" may wrap and is never clipped or overflowing', async ({ page }) => {
    await page.setViewportSize(WRAP_VIEWPORT);
    await openHarness(page, { scenario: 'degraded', host: 'fake-hass' });
    await expectFontsLoaded(page);
    const measure = await measureLayout(page);
    const pill = await securityPillText(page);

    expect(pill.label).toBe('Alarm state unknown');
    expect(pill.labelCanWrap, 'the compact label must be allowed to wrap').toBe(true);
    expect(pill.labelLines).toBeGreaterThanOrEqual(1);
    expect(pill.labelClipped).toBe(false);
    expect(pill.insideHeader).toBe(true);
    expectNoHorizontalOverflow(measure);
  });
});

test.describe('§6.2.1 content budget gates (host=fake-hass, live-mode chrome)', () => {
  test('normal at 1440×900, sidebar collapsed: fits the viewport with no page scroll and aligned column bottoms (hard gate)', async ({
    page,
  }) => {
    const measure = await openAt(page, viewportRow('1440x900-collapsed'));
    recordMetrics('layout', 'normal-1440x900-collapsed', { gate: 'hard', ...panelMetrics(measure) });

    expect(measure.mode).toBe('wide');
    expect(measure.view.scrollHeight, 'page scroll height').toBeLessThanOrEqual(measure.view.clientHeight);
    expect(await documentScrolls(page)).toBe(false);
    expectAlignedBottoms(measure);
    expectNoHorizontalOverflow(measure);
  });

  for (const sidebar of ['collapsed', 'expanded'] as const) {
    test(`dense at 1440×900, sidebar ${sidebar}: no horizontal overflow and column bottoms within ${RELAXED_BOTTOM_ALIGNMENT_PX} px; vertical overflow is reported`, async ({
      page,
    }) => {
      const measure = await openAt(page, viewportRow(`1440x900-${sidebar}`), { scenario: 'dense' });
      recordMetrics('layout', `dense-1440x900-${sidebar}`, { gate: 'reported', ...panelMetrics(measure) });

      expect(measure.mode).toBe('wide');
      expectNoHorizontalOverflow(measure);
      expectAlignedOrClearlyApart(measure);
    });
  }

  for (const [scenario, viewportId] of [
    ['normal', '1440x900-collapsed'],
    ['dense', '1440x900-collapsed'],
    ['normal', '1194x834-expanded'],
    ['normal', '390x844-hidden'],
  ] as const) {
    test(`quiet panels never stretch (${scenario} at ${viewportId})`, async ({ page }) => {
      const measure = await openAt(page, viewportRow(viewportId), { scenario });
      const quiet = measure.columns
        .flat()
        .filter((section) => (QUIET_PANELS as readonly string[]).includes(section.tag));

      expect(quiet.length).toBeGreaterThan(0);
      for (const section of quiet) {
        expect(section.stretched, `${section.tag} is marked to stretch`).toBe(false);
        expect(
          Math.abs(section.height - section.naturalHeight),
          `${section.tag} is taller than its content`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('drawers and dialogs stay inside the 390×844 viewport', () => {
  const drawers: readonly {
    readonly name: string;
    readonly scenario: 'normal' | 'dense' | 'sky';
    readonly open: readonly string[];
  }[] = [
    { name: 'room drawer', scenario: 'normal', open: ['room:0:open'] },
    { name: 'climate drawer', scenario: 'normal', open: ['comfort:climate.demo_bedroom:open'] },
    { name: 'media drawer', scenario: 'normal', open: ['media:players'] },
    { name: 'security drawer', scenario: 'normal', open: ['header:security'] },
    { name: 'health drawer', scenario: 'normal', open: ['health:details'] },
    { name: 'household drawer', scenario: 'normal', open: ['header:menu'] },
    { name: 'diagnostics drawer', scenario: 'normal', open: ['header:menu', 'household:diagnostics'] },
    { name: 'camera live view', scenario: 'normal', open: ['camera:0:live'] },
    { name: 'garage confirm dialog', scenario: 'normal', open: ['garage:open'] },
    { name: 'home drawer', scenario: 'dense', open: ['home:all'] },
    { name: 'cameras drawer', scenario: 'dense', open: ['cameras:all'] },
    { name: 'climate overflow drawer', scenario: 'dense', open: ['comfort:more'] },
    { name: 'sky drawer', scenario: 'sky', open: ['sky:details'] },
    { name: 'weather drawer', scenario: 'sky', open: ['today:details'] },
  ];
  for (const drawer of drawers) {
    test(`${drawer.name} (${drawer.scenario})`, async ({ page }) => {
      await openAt(page, viewportRow('390x844-hidden'), { scenario: drawer.scenario });
      for (const key of drawer.open) await control(page, key).click();
      const box = await topDialogBox(page);

      expect(box, 'an open dialog').not.toBeNull();
      expect(box!.left).toBeGreaterThanOrEqual(-0.5);
      expect(box!.top).toBeGreaterThanOrEqual(-0.5);
      expect(box!.right).toBeLessThanOrEqual(box!.viewportWidth + 0.5);
      expect(box!.bottom).toBeLessThanOrEqual(box!.viewportHeight + 0.5);
      expect(box!.scrollWidth, 'horizontal overflow inside the dialog').toBeLessThanOrEqual(box!.clientWidth);
    });
  }
});

interface PillText {
  readonly label: string;
  readonly detail: string | null;
  readonly labelLines: number;
  /** True when the label's computed wrap mode allows a line break (the compact header's mechanism, §6.4). */
  readonly labelCanWrap: boolean;
  readonly labelClipped: boolean;
  readonly insideHeader: boolean;
}

async function securityPillText(page: Page): Promise<PillText> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const header = tools.all('agr-header', tools.card().shadowRoot ?? document)[0];
    const pill = header?.shadowRoot?.querySelector('agr-security-pill');
    const label = pill?.shadowRoot?.querySelector<HTMLElement>('.label');
    if (header === undefined || pill === null || pill === undefined || label === null || label === undefined) {
      throw new Error('the header has no security pill label');
    }
    const detail = pill.shadowRoot?.querySelector('.detail');
    const labelStyle = getComputedStyle(label);
    const lineHeight = Number.parseFloat(labelStyle.lineHeight);
    // Newer engines expose text-wrap-mode; older ones only the white-space shorthand.
    const wrapMode = labelStyle.getPropertyValue('text-wrap-mode');
    const labelCanWrap =
      wrapMode !== '' ? wrapMode === 'wrap' : ['normal', 'pre-wrap', 'break-spaces'].includes(labelStyle.whiteSpace);
    const headerBox = header.getBoundingClientRect();
    const pillBox = pill.getBoundingClientRect();
    return {
      label: (label.textContent ?? '').trim(),
      detail:
        detail === null || detail === undefined || getComputedStyle(detail).display === 'none'
          ? null
          : (detail.textContent ?? '').trim(),
      labelLines: Math.round(label.getBoundingClientRect().height / lineHeight),
      labelCanWrap,
      labelClipped: label.scrollWidth > label.clientWidth + 1,
      insideHeader: pillBox.left >= headerBox.left - 0.5 && pillBox.right <= headerBox.right + 0.5,
    };
  });
}

interface TodayHeader {
  readonly pill: string | null;
  readonly missing: readonly string[];
  readonly outside: readonly string[];
  readonly clipped: readonly string[];
  readonly overlaps: readonly string[];
  /** Items whose vertical centre is off the heading's: the header wrapped instead of compacting. */
  readonly offLine: readonly string[];
}

/**
 * Today's header row as laid out: its heading, the shared Offline pill (in agr-panel's own tree), and the sun item
 * and Details button slotted from agr-today. Each must sit inside the Today panel's box, show its content without
 * clipping, not overlap another, and stay on the heading's line. (Details overhangs the header box on purpose: its
 * 44 px target uses negative margins so the header keeps its 24 px rhythm, so the header's own scroll width is not
 * a measure of overflow.)
 */
async function todayHeader(page: Page): Promise<TodayHeader> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const today = tools.all('agr-today', tools.card().shadowRoot ?? document)[0];
    const panel = today?.shadowRoot?.querySelector('agr-panel');
    const panelRoot = panel?.shadowRoot;
    if (today === undefined || panel === null || panel === undefined || panelRoot === null || panelRoot === undefined) {
      throw new Error('the Today panel is not rendered');
    }
    const items: Record<string, Element | null> = {
      heading: panelRoot.querySelector('h2'),
      pill: panelRoot.querySelector('.pill'),
      sun: today.shadowRoot?.querySelector('.sun') ?? null,
      details: today.shadowRoot?.querySelector('[data-focus-key="today:details"]') ?? null,
    };
    const box = panel.getBoundingClientRect();
    const missing: string[] = [];
    const outside: string[] = [];
    const clipped: string[] = [];
    const overlaps: string[] = [];
    const shown = Object.entries(items).flatMap(([name, element]) => {
      const rect = element?.getBoundingClientRect();
      if (element === null || element === undefined || rect === undefined || rect.width < 1 || rect.height < 1) {
        missing.push(name);
        return [];
      }
      if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5 || rect.top < box.top - 0.5) {
        outside.push(
          `${name} ${Math.round(rect.left)}..${Math.round(rect.right)} in ${Math.round(box.left)}..${Math.round(box.right)}`,
        );
      }
      if (element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
        clipped.push(`${name} ${element.scrollWidth} > ${element.clientWidth}`);
      }
      return [{ name, rect }];
    });
    for (let i = 0; i < shown.length; i += 1) {
      for (let j = i + 1; j < shown.length; j += 1) {
        const a = shown[i]!.rect;
        const b = shown[j]!.rect;
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > 1 && height > 1) overlaps.push(`${shown[i]!.name} overlaps ${shown[j]!.name}`);
      }
    }
    const LINE_TOLERANCE_PX = 4;
    const centre = (rect: DOMRect): number => rect.top + rect.height / 2;
    const heading = shown.find((item) => item.name === 'heading');
    const offLine =
      heading === undefined
        ? ['heading']
        : shown
            .filter((item) => Math.abs(centre(item.rect) - centre(heading.rect)) > LINE_TOLERANCE_PX)
            .map(
              (item) => `${item.name} centre ${Math.round(centre(item.rect))} vs ${Math.round(centre(heading.rect))}`,
            );
    return {
      pill: (items['pill']?.textContent ?? '').trim() || null,
      missing,
      outside,
      clipped,
      overlaps,
      offLine,
    };
  });
}

async function documentScrolls(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
}

interface DialogBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

async function topDialogBox(page: Page): Promise<DialogBox | null> {
  await expect.poll(() => page.evaluate(() => window.__agrE2E.topDialog() !== null)).toBe(true);
  // Let a sheet's entry transition finish before measuring its resting position.
  await page.evaluate(() => window.__agrE2E.animationsSettled());
  return page.evaluate(() => {
    const dialog = window.__agrE2E.topDialog();
    if (dialog === null) return null;
    const box = dialog.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      scrollWidth: dialog.scrollWidth,
      clientWidth: dialog.clientWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}
