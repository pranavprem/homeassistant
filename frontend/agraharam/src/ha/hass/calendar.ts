/**
 * Calendar seam (§4.4, §9.5): one authenticated GET per calendar through hass.callApi. A read, never a service
 * call. The path is built with encodeURIComponent and the query with URLSearchParams, so neither the entity ID nor
 * an ISO offset (a `+` would read as a space) can be misread.
 *
 * The response is untrusted input. Only summary, start, end and the all-day flag survive: location and
 * description are dropped here so they can never reach the UI, and summaries are capped at 120 characters.
 * Results that arrive after the signal aborts are discarded.
 */
import type { EntityId } from '../../config/schema.ts';
import { log } from '../../util/log.ts';
import { hostErrorFromStatus } from '../errors.ts';
import type { CalendarEventLike, HostError } from '../host.ts';
import type { HassLike } from '../types.ts';

export const MAX_SUMMARY_CHARS = 120;
/** Far more than a two-day window holds; anything beyond is ignored. */
const MAX_EVENTS_PER_CALENDAR = 200;
const UNTITLED_EVENT = 'Untitled event';
const ELLIPSIS = '…';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ABORTED: HostError = Object.freeze({ code: 'aborted' });
const BAD_RESPONSE: HostError = Object.freeze({ code: 'bad-response' });
const NETWORK: HostError = Object.freeze({ code: 'network' });
const UNKNOWN: HostError = Object.freeze({ code: 'unknown' });

/** `calendars/<encoded id>?start=…&end=…`, relative to HA's /api/ (callApi adds the prefix). */
export function calendarPath(id: EntityId, range: { start: Date; end: Date }): string {
  const query = new URLSearchParams({ start: range.start.toISOString(), end: range.end.toISOString() });
  return 'calendars/' + encodeURIComponent(id) + '?' + query.toString();
}

export function fetchCalendarEvents(
  hass: HassLike,
  id: EntityId,
  range: { start: Date; end: Date },
  signal: AbortSignal,
): Promise<readonly CalendarEventLike[]> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<readonly CalendarEventLike[]>((resolve, reject) => {
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(ABORTED);
      else settle();
    };
    let request: Promise<unknown>;
    try {
      request = hass.callApi<unknown>('GET', calendarPath(id, range));
    } catch (error) {
      request = Promise.reject(error);
    }
    request
      .then(
        (body) =>
          finish(() => {
            const events = parseCalendarEvents(body);
            if (events === undefined) reject(BAD_RESPONSE);
            else resolve(events);
          }),
        (error: unknown) => finish(() => reject(hostErrorFromCallApi(error))),
      )
      .catch(() => log.error('calendar-read-failed'));
  });
}

/**
 * hass.callApi rejects with `{ error, status_code, body }`: a status for an HTTP error, none for a failed request.
 * Only the status is read; `error` and `body` can carry HA messages and are never logged or shown.
 */
function hostErrorFromCallApi(error: unknown): HostError {
  if (typeof error !== 'object' || error === null) return UNKNOWN;
  const status = (error as { status_code?: unknown }).status_code;
  if (typeof status === 'number' && Number.isInteger(status)) return hostErrorFromStatus(status);
  return 'error' in error ? NETWORK : UNKNOWN;
}

/** HA's event list → CalendarEventLike[], or undefined when the body is not a list. Malformed items are skipped. */
export function parseCalendarEvents(body: unknown): readonly CalendarEventLike[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const events: CalendarEventLike[] = [];
  const keys = new Set<string>();
  for (const raw of body.slice(0, MAX_EVENTS_PER_CALENDAR)) {
    const event = parseCalendarEvent(raw);
    if (event === undefined) continue;
    events.push({ ...event, key: uniqueKey(event.key, keys) });
  }
  return events;
}

function parseCalendarEvent(raw: unknown): CalendarEventLike | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Readonly<Record<string, unknown>>;
  const start = parseWhen(record['start']);
  const end = parseWhen(record['end']);
  if (start === undefined || end === undefined || start.allDay !== end.allDay) return undefined;
  const uid = typeof record['uid'] === 'string' ? record['uid'] : '';
  const recurrence = typeof record['recurrence_id'] === 'string' ? record['recurrence_id'] : '';
  return {
    key: `${uid}|${recurrence}|${start.value}`,
    summary: summaryOf(record['summary']),
    start: start.value,
    end: end.value,
    allDay: start.allDay,
  };
}

/** `{ dateTime }` → an ISO instant; `{ date }` → the calendar date as written ("2026-10-01", all-day). */
function parseWhen(raw: unknown): { readonly value: string; readonly allDay: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { dateTime, date } = raw as { dateTime?: unknown; date?: unknown };
  if (typeof dateTime === 'string') {
    const ms = Date.parse(dateTime);
    return Number.isNaN(ms) ? undefined : { value: new Date(ms).toISOString(), allDay: false };
  }
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) return { value: date, allDay: true };
  return undefined;
}

/** Trimmed and capped at MAX_SUMMARY_CHARS code points (never splitting a surrogate pair). */
function summaryOf(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return UNTITLED_EVENT;
  const chars = [...text];
  return chars.length <= MAX_SUMMARY_CHARS ? text : chars.slice(0, MAX_SUMMARY_CHARS - 1).join('') + ELLIPSIS;
}

function uniqueKey(key: string, seen: Set<string>): string {
  let candidate = key;
  for (let suffix = 2; seen.has(candidate); suffix += 1) candidate = `${key}#${suffix}`;
  seen.add(candidate);
  return candidate;
}
