/**
 * The built bundle as Home Assistant would serve it (§11.3, §11.5, §12.2 bundle.spec, §17.2, §17.8; ACCEPTANCE "All
 * asset/module/font URLs resolve at the deployed versioned /local base path"). harness.html loads the card from
 * /local/agraharam/<version>/, exactly the resource URL the /local install registers, so these checks prove the
 * element under test is the built module (not source), that it is one self-contained file (both fonts embedded, no
 * font request), that it carries its legal banner, and that the served files are byte-identical to SHA256SUMS.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { APP_VERSION } from '../build-env.ts';
import { FONT_LICENSES, legalBanner } from '../scripts/lib/font-licenses.mjs';
import { expect, test } from './fixtures.ts';
import { expectFontsLoaded, openHarness } from './helpers/harness.ts';

const PACKAGE_DIR = join(import.meta.dirname, '..');
const BUNDLE_BASE = `/local/agraharam/${APP_VERSION}/`;
const MODULE_PATH = `${BUNDLE_BASE}agraharam.js`;

test('the card element is defined by the built module served from the versioned /local path', async ({ page }) => {
  const modules: { path: string; status: number; type: string }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('.js')) {
      modules.push({ path: url.pathname, status: response.status(), type: response.headers()['content-type'] ?? '' });
    }
  });
  await openHarness(page, { host: 'demo' });

  const card = modules.find((module) => module.path === MODULE_PATH);
  expect(card, `a request for ${MODULE_PATH}`).toBeDefined();
  expect(card?.status).toBe(200);
  expect(card?.type).toMatch(/javascript/);
  const manifest = (await (await page.request.get(`${BUNDLE_BASE}manifest.json`)).json()) as { version: string };
  expect(manifest.version).toBe(APP_VERSION);
  const elementVersion = await page.evaluate(
    () => (customElements.get('agraharam-dashboard') as unknown as { version?: string } | undefined)?.version,
  );
  expect(elementVersion, 'the element came from the built bundle').toBe(manifest.version);
});

test('both embedded fonts load with zero font requests, and document.fonts.check passes', async ({ page }) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === 'font' || url.pathname.endsWith('.woff2')) fontRequests.push(url.pathname);
  });
  await openHarness(page, { host: 'demo' });
  await expectFontsLoaded(page);

  expect(fontRequests, 'the fonts are inside agraharam.js (§17.2)').toEqual([]);
  expect(
    await page.evaluate(() => [
      document.fonts.check('16px "Agraharam Serif"'),
      document.fonts.check('16px "Agraharam Sans"'),
    ]),
  ).toEqual([true, true]);
});

test('the module starts with the legal banner, and the license files name both fonts', async ({ page }) => {
  const bundle = await (await page.request.get(MODULE_PATH)).text();
  expect(bundle.startsWith(`${legalBanner(PACKAGE_DIR)}\n`), 'agraharam.js starts with the §17.2 banner').toBe(true);

  const notices = await (await page.request.get(`${BUNDLE_BASE}THIRD_PARTY_LICENSES.md`)).text();
  for (const font of FONT_LICENSES) {
    expect(notices, `THIRD_PARTY_LICENSES.md lists ${font.licensePackage}`).toContain(`## ${font.licensePackage} `);
    const license = await page.request.get(`${BUNDLE_BASE}${font.licenseFile}`);
    expect(license.status(), font.licenseFile).toBe(200);
    expect(await license.text()).toContain('SIL Open Font License');
  }
});

test('every served bundle file matches the flat SHA256SUMS', async ({ page }) => {
  const sums = await (await page.request.get(`${BUNDLE_BASE}SHA256SUMS`)).text();
  const entries = sums
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}([^/\s]+)$/.exec(line);
      if (match === null) throw new Error(`SHA256SUMS line is not "<sha256>  <flat name>": ${line}`);
      return { sha256: match[1], path: match[2] };
    });

  expect(entries.map((entry) => entry.path)).toContain('agraharam.js');
  for (const entry of entries) {
    const response = await page.request.get(`${BUNDLE_BASE}${entry.path}`);
    expect(response.status(), entry.path).toBe(200);
    const digest = createHash('sha256')
      .update(await response.body())
      .digest('hex');
    expect(digest, `${entry.path} bytes`).toBe(entry.sha256);
  }
});

test('loading the card in both hosts logs no console error and no request fails', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => errors.push(`request failed: ${new URL(request.url()).pathname}`));
  await openHarness(page, { host: 'demo' });
  await expectFontsLoaded(page);
  await openHarness(page, { host: 'fake-hass' });

  expect(errors).toEqual([]);
});
