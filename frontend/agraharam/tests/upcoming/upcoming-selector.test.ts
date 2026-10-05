/**
 * selectUpcoming (§4.8, §9.5): today and tomorrow only, at most four events, today first, all-day first within a
 * day, "Now" for events under way; midnight rollover from the clock alone; loading, error and disconnected states.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId, ResolvedConfig } from '../../src/config/schema.ts';
import type { CalendarSnapshot } from '../../src/ha/calendar-controller.ts';
import { createFormatter } from '../../src/ha/format.ts';
import type { CalendarEventLike, Formatter } from '../../src/ha/host.ts';
import type { UpcomingVM } from '../../src/model/types.ts';
import { selectUpcoming, UPCOMING_NOTES } from '../../src/model/upcoming.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';

const HOUSEHOLD = entityId('calendar.demo_household');
const CLUB = entityId('calendar.demo_club');
const NOW = new Date(2026, 8, 30, 17, 51, 0);
const MIN_MS = 60_000;

const formatter: Formatter = createFormatter({
  temperatureUnit: '°F',
  locale: { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'local' },
});

function timed(key: string, summary: string, startMin: number, lengthMin = 30, from = NOW): CalendarEventLike {
  return {
    key,
    summary,
    start: new Date(from.getTime() + startMin * MIN_MS).toISOString(),
    end: new Date(from.getTime() + (startMin + lengthMin) * MIN_MS).toISOString(),
    allDay: false,
  };
}

function dateOf(dayOffset: number): string {
  const day = new Date(NOW);
  day.setDate(day.getDate() + dayOffset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

function allDay(key: string, summary: string, dayOffset: number, days = 1): CalendarEventLike {
  return { key, summary, start: dateOf(dayOffset), end: dateOf(dayOffset + days), allDay: true };
}

function snapshot(
  events: readonly (readonly [EntityId, CalendarEventLike])[],
  phase: CalendarSnapshot['phase'] = 'ready',
): CalendarSnapshot {
  return {
    phase,
    entries: events.map(([calendar, event]) => ({ calendar, event })),
    failed: phase === 'error' ? 1 : 0,
  };
}

const twoCalendars = configFrom({
  calendars: [{ entity: HOUSEHOLD, name: 'Household' }, CLUB],
});

function select(
  calendar: CalendarSnapshot,
  options: { config?: ResolvedConfig; store?: FakeStoreOptions; now?: Date; formatter?: Formatter } = {},
): UpcomingVM {
  const store = fakeStore(
    [
      testEntity(HOUSEHOLD, 'off', { friendly_name: 'Home calendar' }),
      testEntity(CLUB, 'off', { friendly_name: 'Club' }),
    ],
    options.store,
  );
  return selectUpcoming({
    config: options.config ?? twoCalendars,
    store,
    reader: { ...fakeReader(store), formatter: () => options.formatter ?? formatter },
    gateway: new FakeGateway(),
    now: options.now ?? NOW,
    calendar,
  });
}

function summaries(vm: UpcomingVM): string[][] {
  return vm.groups.map((group) => [group.label, ...group.events.map((event) => `${event.time} ${event.title}`)]);
}

describe('selectUpcoming', () => {
  it('groups today and tomorrow, today first, with start times', () => {
    const vm = select(
      snapshot([
        [HOUSEHOLD, timed('b', 'Call the plumber', 129)],
        [HOUSEHOLD, timed('a', 'Grocery pickup', 69)],
        [CLUB, timed('c', 'Workshop', 24 * 60)],
      ]),
    );
    expect(vm.state).toBe('ready');
    expect(summaries(vm)).toEqual([
      [
        'Today',
        `${formatter.time(new Date(NOW.getTime() + 69 * MIN_MS))} Grocery pickup`,
        `${formatter.time(new Date(NOW.getTime() + 129 * MIN_MS))} Call the plumber`,
      ],
      ['Tomorrow', `${formatter.time(new Date(NOW.getTime() + 24 * 60 * MIN_MS))} Workshop`],
    ]);
  });

  it('names each event by its configured calendar name, else the friendly name', () => {
    const vm = select(
      snapshot([
        [HOUSEHOLD, timed('a', 'A', 10)],
        [CLUB, timed('b', 'B', 20)],
      ]),
    );
    expect(vm.groups[0]?.events.map((event) => event.calendarName)).toEqual(['Household', 'Club']);
  });

  it('shows at most four events, today before tomorrow (§6.2.1)', () => {
    const events = [0, 1, 2, 3, 4, 5].map(
      (index) => [HOUSEHOLD, timed(`e${index}`, `Event ${index}`, 30 + index * 60)] as const,
    );
    const vm = select(snapshot([...events, [CLUB, timed('t', 'Tomorrow thing', 24 * 60)]]));
    expect(vm.groups.flatMap((group) => group.events)).toHaveLength(4);
    expect(vm.groups.map((group) => group.label)).toEqual(['Today']);
  });

  it('labels events under way "Now" and drops events that have ended', () => {
    const vm = select(
      snapshot([
        [HOUSEHOLD, timed('past', 'Already over', -90, 30)],
        [HOUSEHOLD, timed('now', 'Veena practice', -20, 45)],
        [HOUSEHOLD, timed('later', 'Grocery pickup', 69)],
      ]),
    );
    expect(vm.groups[0]?.events.map((event) => [event.time, event.title])).toEqual([
      ['Now', 'Veena practice'],
      [formatter.time(new Date(NOW.getTime() + 69 * MIN_MS)), 'Grocery pickup'],
    ]);
  });

  it('puts all-day events first within their day and labels them "All day"', () => {
    const vm = select(
      snapshot([
        [HOUSEHOLD, timed('t', 'Dentist', 24 * 60 - 300)],
        [HOUSEHOLD, allDay('r', 'Recycling collection', 1)],
        [HOUSEHOLD, allDay('h', 'Holiday', 0)],
        [HOUSEHOLD, timed('g', 'Grocery pickup', 30)],
      ]),
    );
    expect(summaries(vm)).toEqual([
      ['Today', 'All day Holiday', `${formatter.time(new Date(NOW.getTime() + 30 * MIN_MS))} Grocery pickup`],
      [
        'Tomorrow',
        'All day Recycling collection',
        `${formatter.time(new Date(NOW.getTime() + (24 * 60 - 300) * MIN_MS))} Dentist`,
      ],
    ]);
    expect(vm.groups[0]?.events[0]?.allDay).toBe(true);
  });

  it('shows a multi-day all-day event once, in today', () => {
    const vm = select(snapshot([[HOUSEHOLD, allDay('trip', 'School break', -1, 4)]]));
    expect(summaries(vm)).toEqual([['Today', 'All day School break']]);
  });

  it('ignores events after tomorrow', () => {
    const vm = select(snapshot([[HOUSEHOLD, timed('far', 'Later this week', 3 * 24 * 60)]]));
    expect(vm.groups).toEqual([]);
    expect(vm.state).toBe('ready');
  });

  it('rolls the groups over at midnight with no refetch', () => {
    const tomorrowMorning = timed('m', 'Morning walk', 15 * 60); // 08:51 tomorrow
    const calendar = snapshot([[HOUSEHOLD, tomorrowMorning]]);
    expect(select(calendar).groups.map((group) => group.label)).toEqual(['Tomorrow']);
    const afterMidnight = new Date(2026, 9, 1, 0, 1, 0);
    expect(select(calendar, { now: afterMidnight }).groups.map((group) => group.label)).toEqual(['Today']);
  });

  it('is loading before the store or the first read is ready', () => {
    expect(select(snapshot([]), { store: { ready: false } })).toEqual({ state: 'loading', groups: [] });
    expect(select(snapshot([], 'idle'))).toEqual({ state: 'loading', groups: [] });
    expect(select(snapshot([], 'loading'))).toEqual({ state: 'loading', groups: [] });
  });

  it('keeps showing current events during a background refresh', () => {
    const vm = select(snapshot([[HOUSEHOLD, timed('a', 'Grocery pickup', 69)]], 'loading'));
    expect(vm.state).toBe('ready');
    expect(vm.groups).toHaveLength(1);
  });

  it('error: keeps the earlier events, with the error note', () => {
    const vm = select(snapshot([[HOUSEHOLD, timed('a', 'Grocery pickup', 69)]], 'error'));
    expect(vm.state).toBe('error');
    expect(vm.note).toBe(UPCOMING_NOTES.error);
    expect(vm.groups[0]?.events[0]?.title).toBe('Grocery pickup');
  });

  it('disconnected or resyncing: last known events with the paused note', () => {
    const calendar = snapshot([[HOUSEHOLD, timed('a', 'Grocery pickup', 69)]]);
    for (const store of [{ connected: false }, { connected: false, resyncing: true }]) {
      const vm = select(calendar, { store });
      expect(vm.state).toBe('disconnected');
      expect(vm.note).toBe(UPCOMING_NOTES.disconnected);
      expect(vm.groups).toHaveLength(1);
    }
  });

  it('ready with nothing today or tomorrow: no groups', () => {
    expect(select(snapshot([]))).toEqual({ state: 'ready', groups: [] });
  });

  it('without calendars configured: nothing to show', () => {
    expect(select(snapshot([]), { config: configFrom({}) })).toEqual({ state: 'ready', groups: [] });
  });

  it('skips events with unreadable times', () => {
    const broken: CalendarEventLike = { key: 'x', summary: 'Broken', start: 'soon', end: 'later', allDay: false };
    expect(select(snapshot([[HOUSEHOLD, broken]])).groups).toEqual([]);
  });
});

describe('selectUpcoming in the server time zone (§9.5)', () => {
  // 12:00 UTC: 21:00 on Sep 30 in Tokyo (UTC+9) and 02:00 on Sep 30 in Honolulu (UTC−10), both without DST.
  const AT = new Date('2026-09-30T12:00:00Z');
  const EVENTS = snapshot([
    [
      HOUSEHOLD,
      { key: 'x', summary: 'Late call', start: '2026-09-30T18:00:00Z', end: '2026-09-30T19:00:00Z', allDay: false },
    ],
    [
      HOUSEHOLD,
      { key: 'w', summary: 'Far call', start: '2026-10-01T20:00:00Z', end: '2026-10-01T21:00:00Z', allDay: false },
    ],
    [CLUB, { key: 'z', summary: 'Holiday', start: '2026-09-30', end: '2026-10-01', allDay: true }],
    [CLUB, { key: 'y', summary: 'Recycling', start: '2026-10-01', end: '2026-10-02', allDay: true }],
  ]);

  function serverFormatter(zone: string): Formatter {
    return createFormatter({
      temperatureUnit: '°F',
      serverTimeZone: zone,
      locale: { language: 'en-US', number_format: 'language', time_format: '12', time_zone: 'server' },
    });
  }

  function titles(vm: UpcomingVM): string[][] {
    return vm.groups.map((group) => [group.label, ...group.events.map((event) => event.title)]);
  }

  // Whatever zone the device is in, it disagrees with at least one of these two, so device-day grouping fails one.
  it('groups by the server calendar day in Tokyo', () => {
    expect(titles(select(EVENTS, { now: AT, formatter: serverFormatter('Asia/Tokyo') }))).toEqual([
      ['Today', 'Holiday'],
      ['Tomorrow', 'Recycling', 'Late call'], // 03:00 on Oct 1 there; the far call is after tomorrow
    ]);
  });

  it('groups by the server calendar day in Honolulu', () => {
    expect(titles(select(EVENTS, { now: AT, formatter: serverFormatter('Pacific/Honolulu') }))).toEqual([
      ['Today', 'Holiday', 'Late call'], // 08:00 on Sep 30 there
      ['Tomorrow', 'Recycling', 'Far call'],
    ]);
  });

  it('rolls over at the server midnight, not the device midnight', () => {
    const tokyo = serverFormatter('Asia/Tokyo');
    const beforeMidnight = new Date('2026-09-30T14:59:00Z'); // 23:59 in Tokyo
    const afterMidnight = new Date('2026-09-30T15:01:00Z'); // 00:01 on Oct 1 in Tokyo
    const calendar = snapshot([
      [CLUB, { key: 'y', summary: 'Recycling', start: '2026-10-01', end: '2026-10-02', allDay: true }],
    ]);
    expect(titles(select(calendar, { now: beforeMidnight, formatter: tokyo }))).toEqual([['Tomorrow', 'Recycling']]);
    expect(titles(select(calendar, { now: afterMidnight, formatter: tokyo }))).toEqual([['Today', 'Recycling']]);
  });
});
