/**
 * Calendar refresh lifecycle (§9.5, §12.1 row 10): no reads without calendars; read on connect, every 15 minutes
 * while connected and visible, once after the resync barrier (never during it); each refresh supersedes the last;
 * failures keep earlier events; teardown aborts and clears the timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, ResolvedConfig } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { FakeHass } from '../../src/dev/fake-hass.ts';
import {
  CALENDAR_REFRESH_MS,
  CalendarController,
  calendarWindow,
  type CalendarSource,
} from '../../src/ha/calendar-controller.ts';
import { createFormatter } from '../../src/ha/format.ts';
import { HassHost } from '../../src/ha/hass-host.ts';
import type { CalendarEventLike, Formatter, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { setVisibility } from '../helpers/observers.ts';
import { fakeReader } from '../helpers/services.ts';
import { ManualStore, TestHost } from '../today/controller-host.ts';

const HOUSEHOLD = entityId('calendar.demo_household');
const CLUB = entityId('calendar.demo_club');
const NOW = new Date(2026, 8, 30, 17, 51, 0).getTime();
const DEVICE_FORMATTER = createFormatter({ temperatureUnit: '°F' });
const HOUR_MS = 3_600_000;

/** A formatter showing server time in `zone`. */
function serverFormatter(zone: string): Formatter {
  return createFormatter({
    temperatureUnit: '°F',
    serverTimeZone: zone,
    locale: { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'server' },
  });
}

interface Read {
  readonly id: EntityId;
  readonly range: { start: Date; end: Date };
  readonly signal: AbortSignal;
  readonly resolve: (events: readonly CalendarEventLike[]) => void;
  readonly reject: (error: unknown) => void;
}

function event(key: string, summary: string): CalendarEventLike {
  return {
    key,
    summary,
    start: new Date(NOW + 3_600_000).toISOString(),
    end: new Date(NOW + 5_400_000).toISOString(),
    allDay: false,
  };
}

function setup(calendars: readonly EntityId[] = [HOUSEHOLD], formatter: Formatter = DEVICE_FORMATTER) {
  const manual = new ManualStore([HOUSEHOLD, CLUB], [testEntity(HOUSEHOLD, 'off'), testEntity(CLUB, 'off')]);
  const reads: Read[] = [];
  let generation = 1;
  const reader: HostReader = {
    ...fakeReader(manual.view, () => manual.phase()),
    formatter: () => formatter,
    connectionGeneration: () => generation,
    fetchCalendarEvents: (id, range, signal) =>
      new Promise((resolve, reject) => {
        reads.push({ id, range, signal, resolve, reject });
      }),
  };
  const status = createStatusBoard();
  let source: CalendarSource = { reader, status, calendars };
  const host = new TestHost();
  const controller = new CalendarController(host, () => source);
  return {
    manual,
    reads,
    status,
    host,
    controller,
    source: () => source,
    setSource(next: Partial<CalendarSource>) {
      source = { ...source, ...next };
      host.update();
    },
    /** A socket close and reopen: the generation moves on and the phase passes through disconnected. */
    reconnect() {
      manual.setConnected(false);
      generation += 1;
      manual.setConnected(true);
      host.update();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the latest read survives a re-created Upcoming section (§5.1 layout change)', () => {
  function recreate(t: ReturnType<typeof setup>): CalendarController {
    t.host.disconnect(); // the layout change removes the old section
    const host = new TestHost();
    const controller = new CalendarController(host, t.source);
    host.connect();
    return controller;
  }

  it('shows the same events at once and reads again only when its 15 minutes are up', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([event('a', 'Grocery pickup')]);
    await flush();
    vi.advanceTimersByTime(60_000);

    const recreated = recreate(t);
    expect(recreated.snapshot().phase).toBe('ready');
    expect(recreated.snapshot().entries.map((entry) => entry.event.summary)).toEqual(['Grocery pickup']);
    expect(t.reads).toHaveLength(1);
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS - 60_000 - 1);
    expect(t.reads).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.reads).toHaveLength(2);
  });

  it('inherits a permission denial instead of spending another counted 401; a user change lifts it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup();
    t.host.connect();
    t.reads[0]?.reject({ code: 'permission-denied', status: 401 });
    await flush();

    recreate(t);
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS * 2);
    expect(t.reads).toHaveLength(1);
    t.manual.touchUser();
    expect(t.reads).toHaveLength(2);
  });

  it('is not used after a reconnect: the new socket reads at once', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([event('a', 'Grocery pickup')]);
    await flush();
    t.host.disconnect();
    t.reconnect();

    const host = new TestHost();
    const recreated = new CalendarController(host, t.source);
    host.connect();
    expect(t.reads).toHaveLength(2);
    expect(recreated.snapshot().phase).toBe('loading');
  });
});

describe('calendarWindow', () => {
  it('runs from now to the end of tomorrow, local time', () => {
    const window = calendarWindow(NOW, DEVICE_FORMATTER);
    expect(window.start.getTime()).toBe(NOW);
    expect(window.end.getTime()).toBe(new Date(2026, 9, 2, 0, 0, 0).getTime());
  });

  it('ends at the end of tomorrow in the server time zone when the profile shows server time', () => {
    const at = Date.parse('2026-09-30T12:00:00Z'); // Sep 30 in both zones below
    // Tokyo is UTC+9 and Honolulu UTC−10, neither with DST: midnight Oct 2 there, as a UTC instant.
    expect(calendarWindow(at, serverFormatter('Asia/Tokyo')).end.toISOString()).toBe('2026-10-01T15:00:00.000Z');
    expect(calendarWindow(at, serverFormatter('Pacific/Honolulu')).end.toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('keeps midnight across a DST change (a 25-hour day)', () => {
    const berlin = serverFormatter('Europe/Berlin');
    const at = Date.parse('2026-10-24T12:00:00Z'); // Oct 25 has 25 hours in Berlin
    expect(calendarWindow(at, berlin).end.toISOString()).toBe('2026-10-25T23:00:00.000Z'); // 00:00 CET on Oct 26
  });
});

describe('CalendarController', () => {
  it("reads the window in the reader's formatter zone", () => {
    const t = setup([HOUSEHOLD], serverFormatter('Asia/Tokyo'));
    t.host.connect();
    const tokyoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(NOW);
    const [year, month, day] = tokyoDay.split('-').map(Number);
    const expectedEnd = Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 0) + 2) - 9 * HOUR_MS;
    expect(t.reads[0]?.range.end.getTime()).toBe(expectedEnd);
  });

  it('makes no reads without calendars', () => {
    const t = setup([]);
    t.host.connect();
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS * 3);
    expect(t.reads).toEqual([]);
    expect(t.status.get('calendar')).toBe('not configured');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads every calendar on connect over now → end of tomorrow, then reports ready', async () => {
    const t = setup([HOUSEHOLD, CLUB]);
    t.host.connect();
    expect(t.reads.map((read) => read.id)).toEqual([HOUSEHOLD, CLUB]);
    expect(t.reads[0]?.range).toEqual(calendarWindow(NOW, DEVICE_FORMATTER));
    expect(t.controller.snapshot().phase).toBe('loading');
    const requestsAfterConnect = t.host.updateRequests;
    t.reads[0]?.resolve([event('a', 'Grocery pickup')]);
    t.reads[1]?.resolve([event('b', 'Workshop')]);
    await flush();
    const snapshot = t.controller.snapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.entries.map((entry) => [entry.calendar, entry.event.summary])).toEqual([
      [HOUSEHOLD, 'Grocery pickup'],
      [CLUB, 'Workshop'],
    ]);
    expect(t.host.updateRequests).toBe(requestsAfterConnect + 1);
    expect(t.status.get('calendar')).toBe('ready');
  });

  it('refreshes every 15 minutes while connected and visible, with a new AbortController each time', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([]);
    await flush();
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS - 1);
    expect(t.reads).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.reads).toHaveLength(2);
    expect(t.reads[1]?.signal).not.toBe(t.reads[0]?.signal);
  });

  it('does not refresh while hidden, and catches up once when visible again', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([]);
    await flush();
    setVisibility('hidden');
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS * 2);
    expect(t.reads).toHaveLength(1);
    setVisibility('visible');
    expect(t.reads).toHaveLength(2);
  });

  it('a newer refresh discards the earlier one (aborted, its late result ignored)', async () => {
    const t = setup();
    t.host.connect();
    t.manual.setConnected(false);
    t.manual.setConnected(true);
    expect(t.reads).toHaveLength(2);
    expect(t.reads[0]?.signal.aborted).toBe(true);
    t.reads[1]?.resolve([event('new', 'New')]);
    t.reads[0]?.resolve([event('old', 'Old')]);
    await flush();
    expect(t.controller.snapshot().entries.map((entry) => entry.event.summary)).toEqual(['New']);
  });

  it('keeps earlier events after a failed refresh and reports the error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([event('a', 'Grocery pickup')]);
    await flush();
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS);
    t.reads[1]?.reject({ code: 'network' });
    await flush();
    const snapshot = t.controller.snapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.failed).toBe(1);
    expect(snapshot.entries.map((entry) => entry.event.summary)).toEqual(['Grocery pickup']);
    expect(t.status.get('calendar')).toBe('error 1 of 1');
  });

  it('a permission denial stops every read until a reconnect or a user change (http.ban, as for cameras)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup([HOUSEHOLD, CLUB]);
    t.host.connect();
    t.reads[0]?.reject({ code: 'permission-denied', status: 401 });
    t.reads[1]?.resolve([event('b', 'Workshop')]);
    await flush();
    expect(t.controller.snapshot()).toMatchObject({ phase: 'error', failed: 1 });
    expect(t.status.get('calendar')).toBe('denied');
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS * 3);
    t.host.disconnect(); // an edit-mode toggle or a hidden tab re-attaches the same element
    t.host.connect();
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS);
    expect(t.reads).toHaveLength(2);

    t.manual.touchUser(); // another user may read the calendar: one new attempt
    expect(t.reads).toHaveLength(4);
    t.reads[2]?.reject({ code: 'permission-denied', status: 403 });
    t.reads[3]?.resolve([]);
    await flush();
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS);
    expect(t.reads).toHaveLength(4);

    t.reconnect(); // a new socket generation allows one more attempt
    expect(t.reads).toHaveLength(6);
    t.reads[4]?.resolve([event('a', 'Grocery pickup')]);
    t.reads[5]?.resolve([]);
    await flush();
    expect(t.controller.snapshot().phase).toBe('ready');
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS);
    expect(t.reads).toHaveLength(8); // and the regular refresh resumes
  });

  it('pauses while disconnected: aborts, clears the timer, and reads nothing until reconnected', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([]);
    await flush();
    t.manual.setConnected(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS * 2);
    expect(t.reads).toHaveLength(1);
    expect(t.status.get('calendar')).toBe('paused disconnected');
  });

  it('never refreshes during the resync barrier, and exactly once after it clears', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([]);
    await flush();
    t.manual.setConnected(false);
    t.manual.setConnected(true, true);
    t.host.update();
    expect(t.reads).toHaveLength(1);
    t.manual.setConnected(true, false);
    t.host.update();
    expect(t.reads).toHaveLength(2);
  });

  it('teardown aborts the read in flight, clears the timer and removes its listeners', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const t = setup();
    t.host.connect();
    t.host.disconnect();
    expect(t.reads[0]?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    setVisibility('visible');
    vi.advanceTimersByTime(CALENDAR_REFRESH_MS * 2);
    expect(t.reads).toHaveLength(1);
  });

  it('a timer-scheduled teardown after a completed read also leaves nothing behind', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([]);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    t.host.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-attaching reads once more, keeps showing the current events meanwhile, and renders only on change', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([event('a', 'Grocery pickup')]);
    await flush();
    t.host.disconnect();
    const requests = t.host.updateRequests;
    t.host.connect();
    expect(t.reads).toHaveLength(2);
    expect(t.controller.snapshot().phase).toBe('ready');
    expect(t.host.updateRequests).toBe(requests); // nothing visible changed yet
    t.reads[1]?.resolve([event('b', 'Call the plumber')]);
    await flush();
    expect(t.host.updateRequests).toBe(requests + 1);
    expect(t.controller.snapshot().entries.map((entry) => entry.event.summary)).toEqual(['Call the plumber']);
  });

  it('a new calendar list starts over', async () => {
    const t = setup();
    t.host.connect();
    t.reads[0]?.resolve([event('a', 'Old calendar')]);
    await flush();
    t.setSource({ calendars: [CLUB] });
    expect(t.reads.at(-1)?.id).toBe(CLUB);
    expect(t.controller.snapshot().entries).toEqual([]);
  });
});

function liveConfig(): ResolvedConfig {
  const result = validateConfig(demoCardInput('normal'));
  if (!result.ok) throw new Error('demo config invalid');
  return result.config;
}

describe('CalendarController with HassHost and FakeHass', () => {
  it('reads through callApi once on connect, not during the barrier, once after it, with zero service calls', () => {
    const fake = new FakeHass('normal');
    const config = liveConfig();
    const runtime = new HassHost(config.bindings.keys());
    runtime.update(fake.hass);
    fake.onPush((hass) => runtime.update(hass));
    const host = new TestHost();
    new CalendarController(host, () => ({
      reader: runtime.reader,
      status: runtime.status,
      calendars: config.calendars.map((ref) => ref.entity),
    }));
    host.connect();
    const callApi = () => fake.calls.filter((call) => call.method === 'callApi');
    expect(callApi()).toHaveLength(1);
    expect(callApi()[0]?.args[1]).toMatch(/^calendars\/calendar\.demo_household\?start=.+&end=.+$/);
    fake.disconnect();
    fake.reconnect({ snapshotDelayMs: 400 });
    expect(callApi()).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(callApi()).toHaveLength(2);
    expect(fake.calls.filter((call) => call.method === 'callService')).toEqual([]);
    host.disconnect();
  });
});
