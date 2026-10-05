/**
 * Forecast seam (§4.4, §9.2): one `weather/subscribe_forecast` subscription per call, through the frontend's own
 * connection. A read, never a service call. The returned Unsubscribe is synchronous and safe to call at any time.
 *
 * Teardown rules (§9.2):
 * - Stopping never awaits subscribeMessage: a subscribe started while the socket is closing, with
 *   `resubscribe: false`, may never settle in home-assistant-js-websocket.
 * - A stop that lands before subscribeMessage resolves marks the subscription cancelled; the hajs unsubscribe is
 *   called as soon as it arrives.
 * - The hajs unsubscribe is called ONLY while the socket generation is still the one the subscription was made in.
 *   hajs resets its command ids to 1 on every new socket, so HA's own resubscriptions (subscribe_entities, the
 *   registries) reuse low ids. An old unsubscribe would send unsubscribe_events with a reused id and kill one of
 *   them, freezing hass.states while `connected` stays true. The server-side subscription died with the old socket
 *   anyway, so dropping the call loses nothing.
 * - Every permitted unsubscribe ends in a terminal catch (§4.9): a rejection is logged by code, never thrown.
 */
import type { EntityId } from '../../config/schema.ts';
import { log } from '../../util/log.ts';
import { hostErrorFromWs } from '../errors.ts';
import type { ForecastHandlers, ForecastItem, ForecastPayload, ForecastType, HostError, Unsubscribe } from '../host.ts';
import type { ConnectionLike } from '../types.ts';

type HajsUnsubscribe = () => Promise<void>;

/** More than any integration sends (hourly forecasts are typically 24–168 items); the rest is ignored. */
const MAX_FORECAST_ITEMS = 240;
const BAD_RESPONSE: HostError = Object.freeze({ code: 'bad-response' });

export function subscribeForecast(
  conn: ConnectionLike,
  id: EntityId,
  type: ForecastType,
  h: ForecastHandlers,
  generation: () => number,
): Unsubscribe {
  const subscribedIn = generation();
  let stopped = false;
  let release: HajsUnsubscribe | undefined;

  function releaseIfCurrent(unsubscribe: HajsUnsubscribe): void {
    if (generation() !== subscribedIn) return; // dropped, never called: see the module comment
    try {
      unsubscribe().catch(() => log.error('forecast-unsub-failed'));
    } catch {
      log.error('forecast-unsub-failed');
    }
  }

  function onMessage(message: unknown): void {
    if (stopped) return;
    const payload = parseForecastPayload(type, message);
    notify(() => (payload === undefined ? h.error(BAD_RESPONSE) : h.next(payload)));
  }

  let subscription: Promise<HajsUnsubscribe>;
  try {
    subscription = conn.subscribeMessage<unknown>(
      onMessage,
      { type: 'weather/subscribe_forecast', entity_id: id, forecast_type: type },
      { resubscribe: false },
    );
  } catch (error) {
    subscription = Promise.reject(error);
  }
  subscription
    .then(
      (unsubscribe) => {
        if (stopped) releaseIfCurrent(unsubscribe);
        else release = unsubscribe;
      },
      (error: unknown) => {
        if (!stopped) notify(() => h.error(hostErrorFromWs(error)));
      },
    )
    .catch(() => log.error('forecast-subscribe-failed'));

  return () => {
    if (stopped) return;
    stopped = true;
    const unsubscribe = release;
    release = undefined;
    if (unsubscribe !== undefined) releaseIfCurrent(unsubscribe);
  };
}

/** Handlers belong to the caller; one that throws must not escape into hajs's message loop (§4.9). */
function notify(call: () => void): void {
  try {
    call();
  } catch {
    log.error('forecast-handler-failed');
  }
}

/**
 * HA sends `{ type, forecast: ForecastItem[] | null }`. The payload is untrusted input: anything that is not that
 * shape is a bad response, and each item keeps only well-typed known fields. The requested type is authoritative.
 */
export function parseForecastPayload(type: ForecastType, message: unknown): ForecastPayload | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const forecast: unknown = (message as { forecast?: unknown }).forecast;
  if (forecast === null) return { type, forecast: null };
  if (!Array.isArray(forecast)) return undefined;
  const items: ForecastItem[] = [];
  for (const raw of forecast.slice(0, MAX_FORECAST_ITEMS)) {
    const item = parseForecastItem(raw);
    if (item !== undefined) items.push(item);
  }
  return { type, forecast: items };
}

function parseForecastItem(raw: unknown): ForecastItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Readonly<Record<string, unknown>>;
  const datetime = record['datetime'];
  if (typeof datetime !== 'string' || Number.isNaN(Date.parse(datetime))) return undefined;
  const condition = record['condition'];
  const isDaytime = record['is_daytime'];
  return {
    datetime,
    ...(typeof condition === 'string' && { condition }),
    temperature: finiteOrNull(record['temperature']),
    templow: finiteOrNull(record['templow']),
    precipitation_probability: finiteOrNull(record['precipitation_probability']),
    ...(typeof isDaytime === 'boolean' && { is_daytime: isDaytime }),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
