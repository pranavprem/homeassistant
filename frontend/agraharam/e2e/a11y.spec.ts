/**
 * Accessibility (§1.2 item 10, §5.4 rule 10, §12.2 a11y.spec): axe-core with the WCAG 2.0/2.1/2.2 A and AA rule
 * sets on the built card, in light and dark, at desktop and phone width, for every scenario that changes what is
 * on screen, and with each drawer and dialog open. axe is scoped to the card (the fake HA chrome is not under test)
 * and reaches it through the shell's shadow root. Two checks axe does not make at this strength are added: every
 * focusable target, aria-disabled ones included (they stay in the tab order, §7.2), is at least 44×44 CSS px, and no
 * interactive element is nested inside another.
 *
 * Any axe violation, whatever its impact, fails the test; every result is also recorded in
 * test-results/metrics/a11y.json.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { runPageTimers } from './helpers/calls.ts';
import { control, expectFontsLoaded, openHarness, PINNED_NOW, type Theme } from './helpers/harness.ts';
import { recordMetrics } from './helpers/metrics.ts';
import type { DemoScenarioId } from '../src/config/schema.ts';
import { SKY_TICK_MS } from '../src/components/sky/sky-clock.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MIN_TARGET_PX = 44;
const SCENARIOS: readonly DemoScenarioId[] = ['normal', 'degraded', 'offline', 'alert', 'restricted', 'dense', 'sky'];
const THEMES: readonly Theme[] = ['light', 'dark'];
const VIEWPORTS = [
  { id: '1440x900', width: 1440, height: 900 },
  { id: '390x844', width: 390, height: 844 },
] as const;

interface Overlay {
  readonly name: string;
  readonly scenario: DemoScenarioId;
  /** Controls clicked in order to open it. */
  readonly open: readonly string[];
  readonly viewports: readonly (typeof VIEWPORTS)[number]['id'][];
}

const OVERLAYS: readonly Overlay[] = [
  { name: 'readings drawer', scenario: 'dense', open: ['health:readings'], viewports: ['1440x900', '390x844'] },
  {
    name: 'whole-house confirmation',
    scenario: 'dense',
    open: ['home:shortcut:lights_toggle'],
    viewports: ['1440x900', '390x844'],
  },

  { name: 'security drawer', scenario: 'normal', open: ['header:security'], viewports: ['1440x900', '390x844'] },
  { name: 'security drawer (alarm triggered)', scenario: 'alert', open: ['header:security'], viewports: ['1440x900'] },
  { name: 'garage confirm dialog', scenario: 'normal', open: ['garage:open'], viewports: ['1440x900', '390x844'] },
  {
    name: 'security confirm dialog over the drawer',
    scenario: 'normal',
    open: ['header:security', 'security:hold_night'],
    viewports: ['1440x900', '390x844'],
  },
  { name: 'room drawer', scenario: 'normal', open: ['room:0:open'], viewports: ['1440x900'] },
  { name: 'climate drawer', scenario: 'normal', open: ['comfort:climate.demo_bedroom:open'], viewports: ['1440x900'] },
  { name: 'media drawer', scenario: 'normal', open: ['media:players'], viewports: ['1440x900'] },
  { name: 'health drawer', scenario: 'degraded', open: ['health:details'], viewports: ['1440x900'] },
  { name: 'diagnostics drawer', scenario: 'normal', open: ['header:diagnostics'], viewports: ['1440x900'] },
  { name: 'household drawer', scenario: 'normal', open: ['header:menu'], viewports: ['390x844'] },
  { name: 'camera live view', scenario: 'normal', open: ['camera:0:live'], viewports: ['1440x900'] },
  { name: 'home drawer', scenario: 'dense', open: ['home:all'], viewports: ['1440x900'] },
  { name: 'cameras drawer', scenario: 'dense', open: ['cameras:all'], viewports: ['1440x900'] },
  // Sky (AIRSPACE.md §6): opens with the nearest aircraft expanded, so its outbound link is checked too.
  { name: 'sky drawer', scenario: 'sky', open: ['sky:details'], viewports: ['1440x900', '390x844'] },
  { name: 'sky drawer, Recent', scenario: 'sky', open: ['sky:details', 'sky:view:recent'], viewports: ['1440x900'] },
  { name: 'weather drawer', scenario: 'sky', open: ['today:details'], viewports: ['1440x900', '390x844'] },
];

interface AxeSummary {
  readonly rule: string;
  readonly impact: string;
  readonly help: string;
  readonly nodes: readonly string[];
}

async function runAxe(page: Page): Promise<AxeSummary[]> {
  const results = await new AxeBuilder({ page })
    .include({ fromShadowDom: ['dev-ha-shell', 'agraharam-dashboard'] })
    .withTags(WCAG_TAGS)
    .analyze();
  return results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help,
    // The last selector step and axe's message; enough to find the element without dumping markup.
    nodes: violation.nodes.map((node) => {
      const target = node.target.at(-1);
      const path = Array.isArray(target) ? target.join(' > ') : String(target);
      const message = node.any[0]?.message ?? node.all[0]?.message ?? node.none[0]?.message ?? '';
      return `${path}: ${message}`;
    }),
  }));
}

interface TargetIssues {
  readonly small: readonly string[];
  readonly nested: readonly string[];
  readonly checked: number;
  /** How many of the checked targets were aria-disabled (reachable, announcing their reason, never acting). */
  readonly ariaDisabled: number;
}

/**
 * 44×44 minimum for every visible, focusable interactive element (natively disabled inputs leave the tab order and
 * are skipped; aria-disabled controls stay in it and are checked); no interactive element inside another.
 */
async function targetIssues(page: Page): Promise<TargetIssues> {
  return page.evaluate((minimum) => {
    const tools = window.__agrE2E;
    const card = tools.card();
    const interactive =
      'button, input, select, textarea, a[href], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
    const describe = (element: Element): string =>
      element.getAttribute('data-focus-key') ??
      `${element.tagName.toLowerCase()} "${(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
    const parentOf = (node: Node): Node | null => {
      if (node instanceof Element && node.assignedSlot !== null) return node.assignedSlot;
      return node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
    };
    const elements = tools.all(interactive, card.shadowRoot ?? card);
    const small: string[] = [];
    const nested: string[] = [];
    let checked = 0;
    let ariaDisabled = 0;
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      const visible = box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== 'hidden';
      const focusable = (element as HTMLButtonElement).disabled !== true;
      if (visible && focusable) {
        checked += 1;
        if (element.getAttribute('aria-disabled') === 'true') ariaDisabled += 1;
        if (box.width < minimum - 0.5 || box.height < minimum - 0.5) {
          small.push(`${describe(element)}: ${Math.round(box.width)}×${Math.round(box.height)}`);
        }
      }
      for (let node = parentOf(element); node !== null && node !== card; node = parentOf(node)) {
        if (node instanceof Element && node.matches(interactive)) {
          nested.push(`${describe(element)} inside ${describe(node)}`);
          break;
        }
      }
    }
    return { small, nested, checked, ariaDisabled };
  }, MIN_TARGET_PX);
}

async function expectAccessible(page: Page, testInfo: TestInfo, caseId: string): Promise<TargetIssues> {
  const violations = await runAxe(page);
  const targets = await targetIssues(page);
  recordMetrics(testInfo.project.name === 'chromium' ? 'a11y' : `a11y.${testInfo.project.name}`, caseId, {
    violations,
    targets,
  });

  expect(violations, 'axe violations of any impact').toEqual([]);
  expect(targets.checked, 'interactive targets checked').toBeGreaterThan(0);
  expect(targets.small, `interactive targets smaller than ${MIN_TARGET_PX}×${MIN_TARGET_PX}`).toEqual([]);
  expect(targets.nested, 'interactive elements nested inside another').toEqual([]);
  return targets;
}

test.describe('scenarios × themes × viewports', () => {
  for (const scenario of SCENARIOS) {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        test(`${scenario}, ${theme}, ${viewport.id}`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await openHarness(page, { scenario, theme, host: 'fake-hass' });
          await expectFontsLoaded(page);

          const targets = await expectAccessible(page, testInfo, `${scenario}-${theme}-${viewport.id}`);
          // Offline, every action is aria-disabled: the size check must have covered those controls too.
          if (scenario === 'offline') expect(targets.ariaDisabled, 'aria-disabled targets checked').toBeGreaterThan(0);
        });
      }
    }
  }
});

test.describe('drawers and dialogs open', () => {
  for (const overlay of OVERLAYS) {
    for (const viewportId of overlay.viewports) {
      for (const theme of THEMES) {
        test(`${overlay.name}, ${theme}, ${viewportId}`, async ({ page }, testInfo) => {
          const viewport = VIEWPORTS.find((candidate) => candidate.id === viewportId) ?? VIEWPORTS[0];
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await openHarness(page, { scenario: overlay.scenario, theme, host: 'fake-hass' });
          await expectFontsLoaded(page);
          for (const key of overlay.open) await control(page, key).click();
          await expect.poll(() => page.evaluate(() => window.__agrE2E.topDialog() !== null)).toBe(true);
          await page.evaluate(() => window.__agrE2E.animationsSettled());

          const slug = overlay.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
          await expectAccessible(page, testInfo, `${slug}-${theme}-${viewportId}`);
        });
      }
    }
  }
});

test.describe('the stale sky drawer (AIRSPACE.md §4: muted rows, hollow marks, the Not live banner)', () => {
  /** The fixture snapshot is 15 s older than the pinned time; 4 minutes later it is stale but still drawn. */
  const STALE_AFTER_PIN_MS = 4 * 60_000;

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`stale sky drawer, ${theme}, ${viewport.id}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openHarness(page, { scenario: 'sky', theme, host: 'fake-hass' });
        await expectFontsLoaded(page);
        await page.clock.setFixedTime(new Date(Date.parse(PINNED_NOW) + STALE_AFTER_PIN_MS));
        await runPageTimers(page, SKY_TICK_MS);
        await control(page, 'sky:details').click();
        await expect.poll(() => page.evaluate(() => window.__agrE2E.topDialog() !== null)).toBe(true);
        await page.evaluate(() => window.__agrE2E.animationsSettled());
        const banner = await page.evaluate(
          () =>
            window.__agrE2E
              .all('agr-sky-drawer')[0]
              ?.shadowRoot?.querySelector('.banner')
              ?.getAttribute('data-status') ?? null,
        );
        expect(banner, 'the drawer shows stale data').toBe('stale');

        await expectAccessible(page, testInfo, `stale-sky-drawer-${theme}-${viewport.id}`);
      });
    }
  }
});
