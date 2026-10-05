/**
 * Calendar fixture (§10.2). Fictional and clock-relative. Events carry summary, start and end only: location
 * and description never reach the UI (§4.4).
 *
 * Scenario variants: every scenario has the household calendar with two events later today (§10.2 normal), except
 * empty (no calendars, so the panel is hidden) and dense (two calendars, six events across today and tomorrow,
 * including one under way, an all-day event and a long title, so the four-event budget and truncation show).
 */
import type { DemoScenarioId } from '../../config/schema.ts';
import type { CalendarEventLike } from '../../ha/host.ts';
import { demoEntity, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

const HOUSEHOLD_CALENDAR = 'calendar.demo_household';
const CLUB_CALENDAR = 'calendar.demo_club';
const MS_PER_MINUTE = 60_000;
const SLOT_MIN = 30;

/** Minutes until the next :00 or :30, so fixture events start at tidy times ("7:00 PM") on any clock. */
function minutesToNextSlot(clock: FixtureClock): number {
  const now = clock.now;
  const intoSlot = (now.getMinutes() % SLOT_MIN) + now.getSeconds() / 60 + now.getMilliseconds() / MS_PER_MINUTE;
  return SLOT_MIN - intoSlot;
}

function timed(
  clock: FixtureClock,
  key: string,
  summary: string,
  startMin: number,
  lengthMin: number,
): CalendarEventLike {
  return { key, summary, start: clock.at(startMin), end: clock.at(startMin + lengthMin), allDay: false };
}

/** An all-day event on today + dayOffset, as HA delivers it: plain local dates, end exclusive. */
function allDay(clock: FixtureClock, key: string, summary: string, dayOffset: number): CalendarEventLike {
  return { key, summary, start: localDate(clock, dayOffset), end: localDate(clock, dayOffset + 1), allDay: true };
}

function localDate(clock: FixtureClock, dayOffset: number): string {
  const day = new Date(clock.dayAt(dayOffset, 12, 0));
  const month = String(day.getMonth() + 1).padStart(2, '0');
  const date = String(day.getDate()).padStart(2, '0');
  return `${day.getFullYear()}-${month}-${date}`;
}

function householdEvents(scenario: DemoScenarioId, clock: FixtureClock): readonly CalendarEventLike[] {
  const slot = minutesToNextSlot(clock);
  const evening = [
    timed(clock, 'demo-event-grocery', 'Grocery pickup', slot + 60, 30),
    timed(clock, 'demo-event-plumber', 'Call the plumber', slot + 120, 30),
  ];
  if (scenario !== 'dense') return evening;
  return [
    timed(clock, 'demo-event-practice', 'Veena practice', -20, 45),
    ...evening,
    timed(
      clock,
      'demo-event-long',
      'Neighbourhood association meeting about the courtyard garden and the shared tool library',
      slot + 150,
      60,
    ),
    allDay(clock, 'demo-event-recycling', 'Recycling collection', 1),
  ];
}

function clubEvents(clock: FixtureClock): readonly CalendarEventLike[] {
  return [
    timed(clock, 'demo-event-workshop', 'Workshop club: soldering basics', minutesToNextSlot(clock) + 24 * 60, 90),
  ];
}

export const upcomingFixture: SectionFixture = {
  config: (scenario) => {
    if (scenario === 'empty') return {};
    const household = { entity: HOUSEHOLD_CALENDAR, name: 'Household' };
    return { calendars: scenario === 'dense' ? [household, { entity: CLUB_CALENDAR, name: 'Club' }] : [household] };
  },
  states: (scenario, clock) => {
    if (scenario === 'empty') return [];
    const household = demoEntity(clock, HOUSEHOLD_CALENDAR, 'off', { friendly_name: 'Household' });
    if (scenario !== 'dense') return [household];
    return [household, demoEntity(clock, CLUB_CALENDAR, 'off', { friendly_name: 'Club' })];
  },
  calendarEvents: (scenario, clock): Readonly<Record<string, readonly CalendarEventLike[]>> => {
    if (scenario === 'empty') return {};
    const household = householdEvents(scenario, clock);
    return scenario === 'dense'
      ? { [HOUSEHOLD_CALENDAR]: household, [CLUB_CALENDAR]: clubEvents(clock) }
      : { [HOUSEHOLD_CALENDAR]: household };
  },
};
