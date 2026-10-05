/**
 * HostError mapping (§4.4). Errors carry codes only, never URLs, entity IDs or HA messages (§4.9 rule 3), so they
 * are safe to log by code and to show through fixed copy.
 */
import type { HostError, HostErrorCode } from './host.ts';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;
/** home-assistant-js-websocket ERR_CONNECTION_LOST: the socket closed while the message was being sent. */
const HAJS_CONNECTION_LOST = 3;

/** WebSocket result codes from HA that have a dedicated HostErrorCode; everything else is 'unknown'. */
const WS_CODE_MAP: Readonly<Record<string, HostErrorCode>> = Object.freeze({
  unauthorized: 'permission-denied',
  not_found: 'not-found',
  not_supported: 'unsupported',
  forecast_not_supported: 'unsupported',
});

const HOST_ERROR_CODES: ReadonlySet<string> = new Set<HostErrorCode>([
  'disconnected',
  'unsupported',
  'not-found',
  'permission-denied',
  'unavailable',
  'network',
  'aborted',
  'bad-response',
  'unknown',
]);

export function isHostError(value: unknown): value is HostError {
  if (typeof value !== 'object' || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && HOST_ERROR_CODES.has(code);
}

/** Non-2xx HTTP responses: 401/403 → permission-denied, 404 → not-found, 503 → unavailable (§4.4). */
export function hostErrorFromStatus(status: number): HostError {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return { code: 'permission-denied', status };
  if (status === HTTP_NOT_FOUND) return { code: 'not-found', status };
  if (status === HTTP_SERVICE_UNAVAILABLE) return { code: 'unavailable', status };
  const clientError = status >= HTTP_CLIENT_ERROR_MIN && status <= HTTP_CLIENT_ERROR_MAX;
  return { code: clientError ? 'bad-response' : 'network', status };
}

/** A rejected fetch: an AbortSignal abort, a network failure, or an error already mapped by our code. */
export function hostErrorFromFetchFailure(error: unknown): HostError {
  if (isHostError(error)) return error;
  if (error instanceof DOMException && error.name === 'AbortError') return { code: 'aborted' };
  if (error instanceof TypeError) return { code: 'network' };
  return { code: 'unknown' };
}

/** A rejected WebSocket command: hajs rejects with ERR_CONNECTION_LOST (3) or with HA's `{ code, message }`. */
export function hostErrorFromWs(error: unknown): HostError {
  if (isHostError(error)) return error;
  if (error === HAJS_CONNECTION_LOST) return { code: 'disconnected' };
  const haCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof haCode !== 'string') return { code: 'unknown' };
  return { code: WS_CODE_MAP[haCode] ?? 'unknown', haCode };
}
