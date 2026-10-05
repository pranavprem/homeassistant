/**
 * The calendar seam (§4.4, §9.5): the exact GET path built with encodeURIComponent and URLSearchParams, response
 * mapping to summary/start/end/all-day only, the 120-character cap, abort handling and error mapping.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  calendarPath,
  fetchCalendarEvents,
  MAX_SUMMARY_CHARS,
  parseCalendarEvents,
} from '../../src/ha/hass/calendar.ts';
import type { HassLike } from '../../src/ha/types.ts';
import { entityId } from '../helpers/fake-store.ts';

const CALENDAR = entityId('calendar.demo_household');
const RANGE = { start: new Date('2026-09-30T17:51:00.000Z'), end: new Date('2026-10-02T07:00:00.000Z') };

function hassWith(
  callApi: (method: 'GET', path: string) => Promise<unknown>,
): HassLike & { callApi: ReturnType<typeof vi.fn> } {
  return { callApi: vi.fn(callApi) } as unknown as HassLike & { callApi: ReturnType<typeof vi.fn> };
}

describe('calendarPath', () => {
  it('encodes the entity ID and builds the query with URLSearchParams', () => {
    expect(calendarPath(CALENDAR, RANGE)).toBe(
      'calendars/calendar.demo_household?start=2026-09-30T17%3A51%3A00.000Z&end=2026-10-02T07%3A00%3A00.000Z',
    );
  });

  it('keeps a + in an ISO value intact (it would otherwise read as a space)', () => {
    const farFuture = new Date(Date.UTC(10_000, 0, 1)); // toISOString() → "+010000-01-01T00:00:00.000Z"
    const path = calendarPath(CALENDAR, { start: RANGE.start, end: farFuture });
    expect(path).toContain('end=%2B010000');
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    expect(query.get('end')).toBe(farFuture.toISOString());
    expect(query.get('start')).toBe(RANGE.start.toISOString());
  });

  it('cannot be steered by a hostile entity ID', () => {
    const path = calendarPath(entityId('calendar.demo_x/../../states?x=1#'), RANGE);
    expect(path.startsWith('calendars/calendar.demo_x%2F..%2F..%2Fstates%3Fx%3D1%23?start=')).toBe(true);
  });
});

describe('fetchCalendarEvents', () => {
  it('GETs the calendar path and maps HA events, dropping location and description', async () => {
    const hass = hassWith(() =>
      Promise.resolve([
        {
          uid: 'a1',
          summary: 'Grocery pickup',
          description: 'Private notes',
          location: 'A private place',
          start: { dateTime: '2026-09-30T19:00:00-07:00' },
          end: { dateTime: '2026-09-30T19:30:00-07:00' },
        },
        { summary: 'Recycling collection', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
      ]),
    );
    const events = await fetchCalendarEvents(hass, CALENDAR, RANGE, new AbortController().signal);
    expect(hass.callApi).toHaveBeenCalledWith('GET', calendarPath(CALENDAR, RANGE));
    expect(events).toEqual([
      {
        key: 'a1||2026-10-01T02:00:00.000Z',
        summary: 'Grocery pickup',
        start: '2026-10-01T02:00:00.000Z',
        end: '2026-10-01T02:30:00.000Z',
        allDay: false,
      },
      { key: '||2026-10-01', summary: 'Recycling collection', start: '2026-10-01', end: '2026-10-02', allDay: true },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private/i);
  });

  it('caps summaries at 120 characters and names untitled events', () => {
    const events = parseCalendarEvents([
      { summary: 'x'.repeat(300), start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
      { summary: '   ', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
      { start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
    ]);
    expect([...(events?.[0]?.summary ?? '')]).toHaveLength(MAX_SUMMARY_CHARS);
    expect(events?.[0]?.summary.endsWith('…')).toBe(true);
    expect(events?.[1]?.summary).toBe('Untitled event');
    expect(events?.[2]?.summary).toBe('Untitled event');
  });

  it('skips malformed events and keeps keys unique', () => {
    const events = parseCalendarEvents([
      null,
      'event',
      { summary: 'No end', start: { date: '2026-10-01' } },
      { summary: 'Bad date', start: { date: '01/10/2026' }, end: { date: '2026-10-02' } },
      { summary: 'Mixed', start: { date: '2026-10-01' }, end: { dateTime: '2026-10-01T10:00:00Z' } },
      { summary: 'Twin', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
      { summary: 'Twin', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
    ]);
    expect(events?.map((event) => event.summary)).toEqual(['Twin', 'Twin']);
    expect(new Set(events?.map((event) => event.key)).size).toBe(2);
  });

  it('rejects a body that is not a list as bad-response', async () => {
    const hass = hassWith(() => Promise.resolve({ message: 'nope' }));
    await expect(fetchCalendarEvents(hass, CALENDAR, RANGE, new AbortController().signal)).rejects.toEqual({
      code: 'bad-response',
    });
  });

  it('maps HTTP and request failures by status only, never by message', async () => {
    const unauthorized = hassWith(() => Promise.reject({ error: 'Response error: 401', status_code: 401, body: 'x' }));
    await expect(fetchCalendarEvents(unauthorized, CALENDAR, RANGE, new AbortController().signal)).rejects.toEqual({
      code: 'permission-denied',
      status: 401,
    });
    const missing = hassWith(() => Promise.reject({ error: 'Response error: 404', status_code: 404 }));
    await expect(fetchCalendarEvents(missing, CALENDAR, RANGE, new AbortController().signal)).rejects.toEqual({
      code: 'not-found',
      status: 404,
    });
    const offline = hassWith(() => Promise.reject({ error: 'Request error', status_code: undefined }));
    await expect(fetchCalendarEvents(offline, CALENDAR, RANGE, new AbortController().signal)).rejects.toEqual({
      code: 'network',
    });
  });

  it('discards a result that arrives after the signal aborts', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const hass = hassWith(() => new Promise((done) => (resolve = done)));
    const abort = new AbortController();
    const result = fetchCalendarEvents(hass, CALENDAR, RANGE, abort.signal);
    abort.abort();
    resolve([{ summary: 'Late', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } }]);
    await expect(result).rejects.toEqual({ code: 'aborted' });
  });

  it('never calls HA when the signal is already aborted', async () => {
    const hass = hassWith(() => Promise.resolve([]));
    const abort = new AbortController();
    abort.abort();
    await expect(fetchCalendarEvents(hass, CALENDAR, RANGE, abort.signal)).rejects.toEqual({ code: 'aborted' });
    expect(hass.callApi).not.toHaveBeenCalled();
  });

  it('turns a synchronous throw into a rejection', async () => {
    const hass = hassWith(() => {
      throw new Error('boom');
    });
    await expect(fetchCalendarEvents(hass, CALENDAR, RANGE, new AbortController().signal)).rejects.toEqual({
      code: 'unknown',
    });
  });
});
