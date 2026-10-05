/**
 * ACCEPTANCE check 10 (§12.1 row 10): an unsupported or failing forecast, unsubscribing, and component teardown
 * leave no leaked work: no subscription left open, no stale unsubscribe sent on a new socket, no timer left behind.
 *
 * FakeHass records each forecast subscription and each unsubscribe (with the socket it belonged to, and whether
 * that socket was already gone: an unsubscribe for an old socket would kill HA's own resubscription, §9.2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  FORECAST_SUBSCRIPTION,
  liveInput,
  mountLive,
  renderedText,
  section,
  settle,
  shadowOf,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const ORPHAN_DISPOSE_MS = 60_000;
const NO_FORECAST = "This weather source doesn't provide a forecast.";
const FORECAST_ERROR = "Forecast couldn't be loaded. Current conditions are still live.";
const DAILY_ONLY = "Hourly forecast isn't provided by this weather source.";

beforeEach(() => {
  useAcceptanceTimers();
});

interface Unsubscribe {
  readonly subscription: number;
  readonly socket: number;
  readonly stale: boolean;
}

function forecastSubscriptions(card: LiveCard): string[] {
  return card.fake.calls
    .filter((call) => call.method === 'connection.subscribeMessage')
    .map((call) => call.args[0] as { type: string; forecast_type: string })
    .filter((message) => message.type === FORECAST_SUBSCRIPTION)
    .map((message) => message.forecast_type);
}

function unsubscribes(card: LiveCard): Unsubscribe[] {
  return card.fake.calls
    .filter((call) => call.method === 'unsubscribe_events')
    .map((call) => call.args[0] as Unsubscribe);
}

function today(card: LiveCard): string {
  return renderedText(shadowOf(section(card, 'agr-today')));
}

describe('unsupported, daily-only and failing forecasts', () => {
  it('a weather source without forecast features opens no subscription and says so', async () => {
    const card = await mountLive({ scenario: 'empty' });
    await advance(5_000);
    expect(forecastSubscriptions(card)).toEqual([]);
    expect(today(card)).toContain(NO_FORECAST);
  });

  it('a daily-only source subscribes once, to daily, and notes the missing hourly forecast', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    await advance(5_000);
    expect(forecastSubscriptions(card)).toEqual(['daily']);
    expect(today(card)).toContain(DAILY_ONLY);
  });

  it('a failing forecast shows the error copy, keeps current conditions, and does not retry on a timer', async () => {
    const card = await mountLive({ scenario: 'starting' });
    await advance(5_000);
    const attempts = forecastSubscriptions(card).length;
    expect(today(card)).toContain(FORECAST_ERROR);
    await advance(10 * 60_000);
    expect(forecastSubscriptions(card)).toHaveLength(attempts);
  });

  it('an unavailable weather entity opens no subscription', async () => {
    const card = await mountLive({ scenario: 'restricted' });
    await advance(5_000);
    expect(forecastSubscriptions(card)).toEqual([]);
  });
});

describe('teardown leaves nothing running', () => {
  it('normal: hourly and daily open once each; removing the card unsubscribes each exactly once', async () => {
    const card = await mountLive();
    await advance(1_000);
    expect(forecastSubscriptions(card).sort()).toEqual(['daily', 'hourly']);
    card.stopPushes();
    card.card.remove();
    await advance(ORPHAN_DISPOSE_MS + 1_000);
    const unsubs = unsubscribes(card);
    expect(unsubs).toHaveLength(2);
    expect(new Set(unsubs.map((unsub) => unsub.subscription)).size).toBe(2);
    expect(unsubs.every((unsub) => !unsub.stale)).toBe(true);
  });

  it('after removal and the orphan timeout, no timer of the card is left pending', async () => {
    const card = await mountLive();
    await advance(1_000);
    card.stopPushes();
    card.card.remove();
    await advance(ORPHAN_DISPOSE_MS + 1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a disconnect never sends an unsubscribe for the closed socket; the reconnect resubscribes once per type', async () => {
    const card = await mountLive();
    await advance(1_000);
    card.fake.disconnect();
    await advance(1_000);
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(200);
    expect(forecastSubscriptions(card)).toHaveLength(2); // nothing new while resyncing
    await advance(2_000);
    expect(forecastSubscriptions(card).sort()).toEqual(['daily', 'daily', 'hourly', 'hourly']);
    expect(unsubscribes(card).filter((unsub) => unsub.stale)).toEqual([]);
  });

  it('the hidden-tab order (detach, drop, re-attach, reconnect) never unsubscribes a stale command id', async () => {
    const card = await mountLive();
    await advance(1_000);
    card.stopPushes();
    card.card.remove();
    card.fake.disconnect();
    document.body.append(card.card);
    card.card.hass = card.fake.hass;
    const stop = card.fake.onPush((hass) => {
      card.card.hass = hass;
    });
    await settle();
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(5_000);
    expect(unsubscribes(card).filter((unsub) => unsub.stale)).toEqual([]);
    card.stopPushes();
    stop();
  });

  it('replacing the weather entity unsubscribes the old forecast once; a new entity that does not exist opens nothing', async () => {
    const card = await mountLive();
    await advance(1_000);
    card.card.setConfig({
      type: 'custom:agraharam-dashboard',
      ...liveInput('normal'),
      weather: 'weather.demo_elsewhere',
    });
    card.card.hass = card.fake.hass;
    await advance(1_000);
    expect(unsubscribes(card)).toHaveLength(2);
    const targets = card.fake.calls
      .filter((call) => call.method === 'connection.subscribeMessage')
      .map((call) => (call.args[0] as { entity_id: string }).entity_id);
    expect(new Set(targets)).toEqual(new Set(['weather.demo_home']));
    expect(today(card)).not.toContain('Partly cloudy');
  });
});
