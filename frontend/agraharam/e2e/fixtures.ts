/**
 * The `test` every spec uses. Its automatic fixture applies the cross-cutting e2e rules of §12.2 and §4.9 to every
 * test without each spec having to remember them:
 *
 * - requests to any origin other than the preview server are aborted and fail the test;
 * - uncaught page errors (`pageerror` and harness.html's `window.__agrPageErrors`) fail the test;
 * - contained card errors (`[agraharam] <code>` console errors) fail the test;
 * - the composed-tree page tools (`window.__agrE2E`) are installed before any page script runs.
 */
import { test as base, expect } from '@playwright/test';
import { pageErrorCounter, trackErrors } from './helpers/errors.ts';
import { guardNetwork } from './helpers/network.ts';
import { installPageTools } from './helpers/page-tools.ts';

export const test = base.extend<{ cardGuards: void }>({
  cardGuards: [
    async ({ context, page }, use) => {
      const network = await guardNetwork(context);
      const errors = trackErrors(page);
      await installPageTools(page);
      await use();
      expect(network.blockedOrigins, 'requests to origins other than the preview server').toEqual([]);
      expect(errors.pageErrors, 'uncaught page errors (HA would turn each into system_log.write)').toEqual([]);
      expect(errors.cardErrors, 'contained card errors logged by log.ts').toEqual([]);
      expect(await pageErrorCounter(page), 'window.__agrPageErrors').toBe(0);
    },
    { auto: true },
  ],
});

export { expect };
