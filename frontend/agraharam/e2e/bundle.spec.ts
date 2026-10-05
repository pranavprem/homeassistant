/**
 * The built bundle as Home Assistant would serve it (§11.3, §11.5, §12.2 bundle.spec; ACCEPTANCE "All asset/module/
 * font URLs resolve at the deployed versioned /local base path"). harness.html loads the card from
 * /local/agraharam/<version>/, exactly the resource URL the install registers, so these checks prove the element
 * under test is the built module (not source), that its fonts resolve relative to that versioned path, and that
 * the served files are byte-identical to SHA256SUMS.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { expectFontsLoaded, openHarness } from './helpers/harness.ts';

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;
const BUNDLE_BASE = `/local/agraharam/${PACKAGE_VERSION}/`;
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
  expect(manifest.version).toBe(PACKAGE_VERSION);
  const elementVersion = await page.evaluate(
    () => (customElements.get('agraharam-dashboard') as unknown as { version?: string } | undefined)?.version,
  );
  expect(elementVersion, 'the element came from the built bundle').toBe(manifest.version);
});

test('both fonts load from the bundle directory and document.fonts.check passes', async ({ page }) => {
  const fonts: { path: string; status: number }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('.woff2')) fonts.push({ path: url.pathname, status: response.status() });
  });
  await openHarness(page, { host: 'demo' });
  await expectFontsLoaded(page);

  expect(fonts).toHaveLength(2);
  for (const font of fonts) {
    expect(font.path.startsWith(`${BUNDLE_BASE}fonts/`), `${font.path} resolves under ${BUNDLE_BASE}`).toBe(true);
    expect(font.status).toBe(200);
  }
  expect(
    await page.evaluate(() => [
      document.fonts.check('16px "Agraharam Serif"'),
      document.fonts.check('16px "Agraharam Sans"'),
    ]),
  ).toEqual([true, true]);
});

test('every served bundle file matches SHA256SUMS', async ({ page }) => {
  const sums = await (await page.request.get(`${BUNDLE_BASE}SHA256SUMS`)).text();
  const entries = sums
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (match === null) throw new Error(`SHA256SUMS line is not "<sha256>  <path>": ${line}`);
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
