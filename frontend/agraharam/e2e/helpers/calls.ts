/**
 * What the card asked of Home Assistant. In `host=fake-hass` the shell records every FakeHass method call on
 * `window.__agrCalls` (§10.3), including the members real hass has but the card's types omit (callWS,
 * connection.sendMessage, connection.sendMessagePromise), so indirect writes are caught at runtime. In `host=demo`
 * the card never touches that object, so the list must stay empty.
 */
import { expect, type Page } from '@playwright/test';
import { SLIDER_COMMIT_DEBOUNCE_MS, STEPPER_COMMIT_DEBOUNCE_MS } from '../../src/ha/actions/types.ts';

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface ServiceCallRecord {
  readonly domain: unknown;
  readonly service: unknown;
  readonly data: unknown;
  readonly target: unknown;
}

/** Methods that change Home Assistant or can send an arbitrary socket message. */
export const WRITE_METHODS: readonly string[] = Object.freeze([
  'callService',
  'callWS',
  'connection.sendMessage',
  'connection.sendMessagePromise',
]);
/**
 * Page time that covers every commit debounce (slider and stepper) twice over: once it has run, a drafted value has
 * been sent or discarded, so a count still unchanged proves nothing more will come.
 */
export const QUIET_MS = 2 * Math.max(SLIDER_COMMIT_DEBOUNCE_MS, STEPPER_COMMIT_DEBOUNCE_MS);

/**
 * Runs the page's timers for `ms` of page time at once (Playwright's clock, installed by openHarness), so every
 * debounce, retry and refresh due in that window fires deterministically instead of after a real-time sleep.
 */
export async function runPageTimers(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
}

/** The only subscription the card may open (a read). */
export const FORECAST_SUBSCRIPTION = 'weather/subscribe_forecast';

export async function recordedCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(() =>
    (window.__agrCalls ?? []).map((call) => ({
      method: call.method,
      args: JSON.parse(JSON.stringify(call.args ?? [])) as unknown[],
    })),
  );
}

export function serviceCalls(calls: readonly RecordedCall[]): ServiceCallRecord[] {
  return calls
    .filter((call) => call.method === 'callService')
    .map(({ args }) => ({ domain: args[0], service: args[1], data: args[2], target: args[3] }));
}

export function writeCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => WRITE_METHODS.includes(call.method));
}

export function nonForecastSubscriptions(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) =>
      call.method === 'connection.subscribeMessage' &&
      (call.args[0] as Record<string, unknown> | undefined)?.['type'] !== FORECAST_SUBSCRIPTION,
  );
}

/** §12.1 row 1 in the browser: no write and no socket message; the only subscriptions are forecast reads. */
export async function expectNoMutation(page: Page): Promise<void> {
  const calls = await recordedCalls(page);
  expect(writeCalls(calls), 'writes to Home Assistant').toEqual([]);
  expect(nonForecastSubscriptions(calls), 'subscriptions other than the forecast read').toEqual([]);
}

/** Camera still fetches for one camera (`fetchWithAuth` on its proxy path), with the requested aspect ratio. */
export function cameraFetches(calls: readonly RecordedCall[], cameraId: string): { width: number; height: number }[] {
  const prefix = `/api/camera_proxy/${encodeURIComponent(cameraId)}?`;
  return calls
    .filter((call) => call.method === 'fetchWithAuth' && String(call.args[0]).startsWith(prefix))
    .map((call) => {
      const query = new URLSearchParams(String(call.args[0]).slice(prefix.length));
      return { width: Number(query.get('width')), height: Number(query.get('height')) };
    });
}

/** Waits until exactly `count` service calls were recorded, then runs `quietMs` of page timers to prove no more follow. */
export async function expectServiceCallCount(
  page: Page,
  count: number,
  quietMs = QUIET_MS,
): Promise<ServiceCallRecord[]> {
  await expect.poll(async () => serviceCalls(await recordedCalls(page)).length).toBe(count);
  await runPageTimers(page, quietMs);
  const calls = serviceCalls(await recordedCalls(page));
  expect(calls).toHaveLength(count);
  return calls;
}
