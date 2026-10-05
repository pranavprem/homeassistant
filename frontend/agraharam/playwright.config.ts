import { defineConfig, devices, type Project } from '@playwright/test';
import { PREVIEW_ORIGIN, PREVIEW_PORT } from './e2e/helpers/origin.ts';

/**
 * End-to-end suites (§12.2). Specs run against the BUILT bundle served by `vite preview` through harness.html, so
 * `npm run test:e2e` builds the card and the harness first. Setup: `npx playwright install chromium webkit`.
 *
 * - `chromium` runs every spec.
 * - `webkit-keyboard` runs keyboard.spec.ts in WebKit too: native <dialog> modality, Escape and Tab behavior are
 *   verified only in real engines (§5.4 rule 14), and wall tablets are often Safari.
 * - AGR_E2E_BROWSERS=all also runs every other spec in WebKit and Firefox (`npx playwright install firefox`);
 *   recommended before deployment.
 * - AGR_E2E_PORT moves the preview server off 4173 when that port is busy.
 */
const KEYBOARD_SPEC = 'keyboard.spec.ts';
const RUN_ALL_BROWSERS = process.env['AGR_E2E_BROWSERS'] === 'all';
const SERVER_START_TIMEOUT_MS = 60_000;

const defaultProjects: Project[] = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'webkit-keyboard', testMatch: KEYBOARD_SPEC, use: { ...devices['Desktop Safari'] } },
];

const allBrowserProjects: Project[] = [
  { name: 'webkit', testIgnore: KEYBOARD_SPEC, use: { ...devices['Desktop Safari'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
];

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/playwright',
  forbidOnly: true,
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: PREVIEW_ORIGIN,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite preview --config vite.harness.config.ts --port ${PREVIEW_PORT} --strictPort`,
    url: `${PREVIEW_ORIGIN}/harness.html`,
    reuseExistingServer: false,
    timeout: SERVER_START_TIMEOUT_MS,
  },
  projects: RUN_ALL_BROWSERS ? [...defaultProjects, ...allBrowserProjects] : defaultProjects,
});
