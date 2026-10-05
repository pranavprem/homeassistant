/**
 * The no-network guard (§12.2): the card must never reach a CDN, Home Assistant or any device. Every request from
 * the browser context to an origin other than the preview server is aborted and recorded, and the test fails.
 * Only the origin is recorded, never the full URL, so a stray capability URL can never land in a report.
 */
import type { BrowserContext } from '@playwright/test';
import { PREVIEW_ORIGIN } from './origin.ts';

/** In-memory URLs created by the page itself; they never leave the browser. */
const LOCAL_SCHEMES = ['data:', 'blob:'];

export interface NetworkGuard {
  readonly blockedOrigins: readonly string[];
}

export async function guardNetwork(context: BrowserContext): Promise<NetworkGuard> {
  const blockedOrigins: string[] = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme)) || new URL(url).origin === PREVIEW_ORIGIN) {
      await route.continue();
      return;
    }
    blockedOrigins.push(new URL(url).origin);
    await route.abort('blockedbyclient');
  });
  return { blockedOrigins };
}
