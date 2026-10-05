/**
 * Timing the card, the dev shell and the e2e suite must agree on. DOM-free and import-free, so Playwright's Node side
 * imports it as it is, and the dev shell may import it across the harness boundary (§10.3).
 */

/** The live-view snapshot fallback refreshes a still this often while its dialog is open and visible (§9.4). */
export const LIVE_FALLBACK_INTERVAL_MS = 2_000;

/** The dev shell's FakeHass delivers the post-reconnect state snapshot this long after 'ready' (§10.3). */
export const SHELL_SNAPSHOT_DELAY_MS = 400;

/**
 * The demo host and FakeHass answer a service call after a random delay in this range (min, max), so a ticket is
 * visibly pending as it would be on a real house (§10.1, §10.3).
 */
export const SIMULATED_CALL_LATENCY_MS: readonly [min: number, max: number] = Object.freeze([400, 1200]);
