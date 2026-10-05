/**
 * Error containment checks (§4.9 rule 5). HA's logging mixin turns every uncaught `error` and `unhandledrejection`
 * into a `system_log.write` service call, so an escaped error from the card is a service call made on the user's
 * behalf. harness.html counts both into `window.__agrPageErrors`; Playwright reports the same through `pageerror`.
 * Contained failures are logged by the card's log.ts as `[agraharam] <code>` console errors; they never reach HA,
 * but each one is still a defect, so specs treat them as failures too.
 */
import type { Page } from '@playwright/test';

const CARD_LOG_PREFIX = '[agraharam]';

export interface ErrorTracker {
  readonly pageErrors: readonly string[];
  readonly cardErrors: readonly string[];
}

/** Starts collecting uncaught page errors and the card's contained-error log lines for `page`. */
export function trackErrors(page: Page): ErrorTracker {
  const pageErrors: string[] = [];
  const cardErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith(CARD_LOG_PREFIX)) cardErrors.push(message.text());
  });
  return { pageErrors, cardErrors };
}

/** harness.html's counter; 0 when the page never loaded the harness. */
export async function pageErrorCounter(page: Page): Promise<number> {
  if (page.isClosed()) return 0;
  return page.evaluate(() => window.__agrPageErrors ?? 0);
}
