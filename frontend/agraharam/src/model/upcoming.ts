/**
 * Upcoming selector (§4.8, §9.5): today's and tomorrow's events from the calendar controller's snapshot, at most
 * CONTENT_BUDGET.upcomingEvents of them, today first. Pure; it re-runs on the 'clock' meta, so the groups roll
 * over at midnight and ended events drop off without a refetch.
 *
 * Days are calendar days in the formatter's time zone (the HA profile's local or server time, §4.4), so "Today"
 * agrees with the clock, the greeting and the Today panel when the profile shows server time in another zone than
 * the device's. HA delivers all-day events as plain dates; they are read as dates in that same zone.
 */
import type { EntityId, Ref } from '../config/schema.ts';
import type { CalendarEntry, CalendarSnapshot } from '../ha/calendar-controller.ts';
import { dateStart, dayStart } from '../ha/format.ts';
import type { CalendarEventLike, Formatter } from '../ha/host.ts';
import { CONTENT_BUDGET } from './budget.ts';
import { friendlyName } from './display.ts';
import type { SelectorInput, UpcomingEventVM, UpcomingVM } from './types.ts';

interface UpcomingInput extends SelectorInput {
  readonly calendar: CalendarSnapshot;
}

export const UPCOMING_NOTES = Object.freeze({
  error: "Calendar couldn't be loaded.",
  // The panel's "Offline" pill and the banner say why; the panel says what happens next (§16.13).
  disconnected: 'Events resume when Home Assistant reconnects.',
});

/** The time label of an event already under way; the section styles it as live. */
export const NOW_LABEL = 'Now';
const ALL_DAY_LABEL = 'All day';
const FALLBACK_CALENDAR_NAME = 'Calendar';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Day = 'today' | 'tomorrow';
const DAY_LABELS: Readonly<Record<Day, string>> = Object.freeze({ today: 'Today', tomorrow: 'Tomorrow' });

interface Placed {
  readonly entry: CalendarEntry;
  readonly day: Day;
  readonly startMs: number;
  readonly endMs: number;
}

/** The first instants of tomorrow and of the day after, in the formatter's zone. */
interface DayBounds {
  readonly tomorrowMs: number;
  readonly dayAfterMs: number;
}

export function selectUpcoming(input: UpcomingInput): UpcomingVM {
  const { config, store, calendar } = input;
  if (config.calendars.length === 0) return { state: 'ready', groups: [] };
  if (!store.isReady()) return { state: 'loading', groups: [] };
  const groups = groupEvents(input);
  if (!store.isConnected()) return { state: 'disconnected', groups, note: UPCOMING_NOTES.disconnected };
  if (calendar.entries.length === 0 && (calendar.phase === 'idle' || calendar.phase === 'loading')) {
    return { state: 'loading', groups: [] };
  }
  if (calendar.phase === 'error') return { state: 'error', groups, note: UPCOMING_NOTES.error };
  return { state: 'ready', groups };
}

function groupEvents(input: UpcomingInput): UpcomingVM['groups'] {
  const formatter = input.reader.formatter();
  const nowMs = input.now.getTime();
  const names = calendarNames(input);
  const bounds: DayBounds = {
    tomorrowMs: dayStart(formatter, input.now, 1).getTime(),
    dayAfterMs: dayStart(formatter, input.now, 2).getTime(),
  };
  const instantOf = instantReader(formatter);
  const placed = input.calendar.entries
    .map((entry) => place(entry, bounds, instantOf))
    .filter((item): item is Placed => item !== undefined && item.endMs > nowMs)
    .sort(compareEvents)
    .slice(0, CONTENT_BUDGET.upcomingEvents);
  return (['today', 'tomorrow'] as const)
    .map((day) => ({
      label: DAY_LABELS[day],
      events: placed.filter((item) => item.day === day).map((item) => eventVM(item, nowMs, formatter, names)),
    }))
    .filter((group) => group.events.length > 0);
}

type InstantReader = (value: string, allDay: boolean) => number | undefined;

/** The event's span and its day, or undefined when it starts after tomorrow or is malformed. */
function place(entry: CalendarEntry, bounds: DayBounds, instantOf: InstantReader): Placed | undefined {
  const startMs = instantOf(entry.event.start, entry.event.allDay);
  const endMs = instantOf(entry.event.end, entry.event.allDay);
  if (startMs === undefined || endMs === undefined) return undefined;
  if (startMs >= bounds.dayAfterMs) return undefined;
  return { entry, day: startMs < bounds.tomorrowMs ? 'today' : 'tomorrow', startMs, endMs };
}

/** Today first; within a day all-day events first, then by start time, then by title. */
function compareEvents(a: Placed, b: Placed): number {
  if (a.day !== b.day) return a.day === 'today' ? -1 : 1;
  if (a.entry.event.allDay !== b.entry.event.allDay) return a.entry.event.allDay ? -1 : 1;
  return a.startMs - b.startMs || a.entry.event.summary.localeCompare(b.entry.event.summary);
}

function eventVM(
  item: Placed,
  nowMs: number,
  formatter: Formatter,
  names: ReadonlyMap<EntityId, string>,
): UpcomingEventVM {
  const { calendar, event } = item.entry;
  return {
    key: `${calendar}|${event.key}`,
    time: timeLabel(event, item.startMs, nowMs, formatter),
    title: event.summary,
    allDay: event.allDay,
    calendarName: names.get(calendar) ?? FALLBACK_CALENDAR_NAME,
  };
}

/** "All day", "Now" for an event already under way, else its start time ("6:30 PM"). */
function timeLabel(event: CalendarEventLike, startMs: number, nowMs: number, formatter: Formatter): string {
  if (event.allDay) return ALL_DAY_LABEL;
  return startMs <= nowMs ? NOW_LABEL : formatter.time(new Date(startMs));
}

function calendarNames(input: UpcomingInput): ReadonlyMap<EntityId, string> {
  return new Map(
    input.config.calendars.map((ref: Ref) => [
      ref.entity,
      friendlyName(input.store, ref.entity, ref.name, FALLBACK_CALENDAR_NAME),
    ]),
  );
}

/**
 * All-day dates are calendar dates in the formatter's zone ("2026-10-01" → that day's first instant there); timed
 * events are ISO instants. All-day starts repeat across events, so each date is resolved once per selection.
 */
function instantReader(formatter: Formatter): InstantReader {
  const dateStarts = new Map<string, number | undefined>();
  return (value, allDay) => {
    if (allDay && DATE_ONLY_RE.test(value)) {
      if (!dateStarts.has(value)) dateStarts.set(value, dateStart(formatter, value)?.getTime());
      return dateStarts.get(value);
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return undefined;
    return allDay ? dayStart(formatter, new Date(ms)).getTime() : ms;
  };
}
