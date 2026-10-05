/**
 * The forecast seam (§9.2 teardown details, §12.1 row 10): exact message, never awaiting subscribe on stop, the
 * socket-generation rule for unsubscribes, and error containment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForecastPayload, HostError } from '../../src/ha/host.ts';
import { parseForecastPayload, subscribeForecast } from '../../src/ha/hass/forecast.ts';
import type { ConnectionLike } from '../../src/ha/types.ts';
import { entityId } from '../helpers/fake-store.ts';

const WEATHER = entityId('weather.demo_home');

type Unsub = () => Promise<void>;

interface Pending {
  readonly message: Readonly<Record<string, unknown>>;
  readonly options: { resubscribe?: boolean } | undefined;
  readonly deliver: (message: unknown) => void;
  readonly resolve: (unsub: Unsub) => void;
  readonly reject: (error: unknown) => void;
}

/** A hajs-like connection whose subscribeMessage settles only when the test says so. */
function deferredConnection(): { conn: ConnectionLike; pending: Pending[] } {
  const pending: Pending[] = [];
  const conn: ConnectionLike = {
    connected: true,
    subscribeMessage<T>(
      callback: (msg: T) => void,
      message: Readonly<Record<string, unknown>>,
      options?: { resubscribe?: boolean },
    ): Promise<Unsub> {
      return new Promise<Unsub>((resolve, reject) => {
        pending.push({ message, options, deliver: (msg) => callback(msg as T), resolve, reject });
      });
    },
  };
  return { conn, pending };
}

function handlers() {
  return { next: vi.fn<(payload: ForecastPayload) => void>(), error: vi.fn<(error: HostError) => void>() };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribeForecast seam', () => {
  it('sends the exact weather/subscribe_forecast message with resubscribe: false', () => {
    const { conn, pending } = deferredConnection();
    subscribeForecast(conn, WEATHER, 'hourly', handlers(), () => 1);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message).toEqual({
      type: 'weather/subscribe_forecast',
      entity_id: WEATHER,
      forecast_type: 'hourly',
    });
    expect(pending[0]?.options).toEqual({ resubscribe: false });
  });

  it('delivers payloads, then stop calls the hajs unsubscribe exactly once', async () => {
    const { conn, pending } = deferredConnection();
    const h = handlers();
    const stop = subscribeForecast(conn, WEATHER, 'daily', h, () => 1);
    const unsub = vi.fn(() => Promise.resolve());
    pending[0]?.resolve(unsub);
    await flush();
    pending[0]?.deliver({ type: 'daily', forecast: [{ datetime: '2026-10-01T12:00:00Z', temperature: 70 }] });
    expect(h.next).toHaveBeenCalledWith({
      type: 'daily',
      forecast: [{ datetime: '2026-10-01T12:00:00Z', temperature: 70, templow: null, precipitation_probability: null }],
    });
    stop();
    stop();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('stop before subscribeMessage resolves: the unsubscribe runs as soon as it resolves', async () => {
    const { conn, pending } = deferredConnection();
    const stop = subscribeForecast(conn, WEATHER, 'hourly', handlers(), () => 1);
    stop();
    const unsub = vi.fn(() => Promise.resolve());
    pending[0]?.resolve(unsub);
    await flush();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('never calls an unsubscribe from an older socket generation (stop after a reconnect)', async () => {
    const { conn, pending } = deferredConnection();
    let generation = 1;
    const stop = subscribeForecast(conn, WEATHER, 'hourly', handlers(), () => generation);
    const unsub = vi.fn(() => Promise.resolve());
    pending[0]?.resolve(unsub);
    await flush();
    generation = 3; // the socket closed and reopened while nothing stopped this subscription
    stop();
    expect(unsub).not.toHaveBeenCalled();
  });

  it('drops a late-resolving subscribe from an older generation instead of unsubscribing it', async () => {
    const { conn, pending } = deferredConnection();
    let generation = 1;
    const h = handlers();
    const stop = subscribeForecast(conn, WEATHER, 'hourly', h, () => generation);
    stop();
    generation = 2;
    const unsub = vi.fn(() => Promise.resolve());
    pending[0]?.resolve(unsub);
    await flush();
    expect(unsub).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it('logs a rejecting unsubscribe by code and never rethrows it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { conn, pending } = deferredConnection();
    const stop = subscribeForecast(conn, WEATHER, 'hourly', handlers(), () => 1);
    pending[0]?.resolve(() => Promise.reject(new Error('socket gone')));
    await flush();
    expect(() => stop()).not.toThrow();
    await flush();
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'forecast-unsub-failed');
  });

  it('a never-settling subscribe does not block teardown', () => {
    const { conn } = deferredConnection();
    const h = handlers();
    const stop = subscribeForecast(conn, WEATHER, 'hourly', h, () => 1);
    expect(() => stop()).not.toThrow();
    expect(h.next).not.toHaveBeenCalled();
  });

  it('ignores events delivered after stop', async () => {
    const { conn, pending } = deferredConnection();
    const h = handlers();
    const stop = subscribeForecast(conn, WEATHER, 'hourly', h, () => 1);
    pending[0]?.resolve(() => Promise.resolve());
    await flush();
    stop();
    pending[0]?.deliver({ type: 'hourly', forecast: [] });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('maps forecast_not_supported to unsupported and keeps HA codes, never messages', async () => {
    const { conn, pending } = deferredConnection();
    const h = handlers();
    subscribeForecast(conn, WEATHER, 'hourly', h, () => 1);
    pending[0]?.reject({ code: 'forecast_not_supported', message: 'Not supported.' });
    await flush();
    expect(h.error).toHaveBeenCalledWith({ code: 'unsupported', haCode: 'forecast_not_supported' });
  });

  it('reports invalid_entity_id with its HA code', async () => {
    const { conn, pending } = deferredConnection();
    const h = handlers();
    subscribeForecast(conn, WEATHER, 'daily', h, () => 1);
    pending[0]?.reject({ code: 'invalid_entity_id', message: 'Weather entity not found' });
    await flush();
    expect(h.error).toHaveBeenCalledWith({ code: 'unknown', haCode: 'invalid_entity_id' });
  });

  it('turns a synchronous throw from subscribeMessage into an error report, not an exception', async () => {
    const conn: ConnectionLike = {
      connected: true,
      subscribeMessage: () => {
        throw new Error('closed');
      },
    };
    const h = handlers();
    expect(() => subscribeForecast(conn, WEATHER, 'hourly', h, () => 1)).not.toThrow();
    await flush();
    expect(h.error).toHaveBeenCalledWith({ code: 'unknown' });
  });

  it('reports a malformed payload as bad-response and contains a throwing handler', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { conn, pending } = deferredConnection();
    const h = handlers();
    subscribeForecast(conn, WEATHER, 'hourly', h, () => 1);
    pending[0]?.resolve(() => Promise.resolve());
    await flush();
    pending[0]?.deliver({ type: 'hourly', forecast: 'nope' });
    expect(h.error).toHaveBeenCalledWith({ code: 'bad-response' });
    h.next.mockImplementation(() => {
      throw new Error('handler bug');
    });
    expect(() => pending[0]?.deliver({ type: 'hourly', forecast: [] })).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'forecast-handler-failed');
  });
});

describe('parseForecastPayload', () => {
  it('maps forecast: null to a live empty payload', () => {
    expect(parseForecastPayload('daily', { type: 'daily', forecast: null })).toEqual({ type: 'daily', forecast: null });
  });

  it('keeps only well-typed known fields and skips items without a valid datetime', () => {
    const payload = parseForecastPayload('hourly', {
      type: 'ignored',
      forecast: [
        { datetime: 'not a date', temperature: 1 },
        null,
        {
          datetime: '2026-10-01T18:00:00Z',
          condition: 'rainy',
          temperature: '68',
          templow: Number.NaN,
          precipitation_probability: 40,
          is_daytime: false,
          wind_bearing: 'N',
        },
      ],
    });
    expect(payload).toEqual({
      type: 'hourly',
      forecast: [
        {
          datetime: '2026-10-01T18:00:00Z',
          condition: 'rainy',
          temperature: null,
          templow: null,
          precipitation_probability: 40,
          is_daytime: false,
        },
      ],
    });
  });

  it('rejects a payload that is not an object', () => {
    expect(parseForecastPayload('hourly', 'forecast')).toBeUndefined();
    expect(parseForecastPayload('hourly', null)).toBeUndefined();
  });
});
