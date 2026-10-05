/**
 * The calendar fixture's scenario variants (§10.2): two events later today in normal, none configured in empty,
 * and a dense set that exercises the four-event budget, all-day events and truncation. Fictional and clock-relative.
 */
import { describe, expect, it } from 'vitest';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { upcomingFixture } from '../../src/demo/fixtures/upcoming.ts';

const NOW = new Date(2026, 8, 30, 17, 51, 0).getTime();
const clock = fixtureClock(NOW);
const endOfToday = new Date(2026, 9, 1, 0, 0, 0).getTime();

describe('upcoming fixture', () => {
  it('normal: two events later today, at tidy times, summary/start/end only', () => {
    const events = upcomingFixture.calendarEvents?.('normal', clock)['calendar.demo_household'] ?? [];
    expect(events.map((event) => event.summary)).toEqual(['Grocery pickup', 'Call the plumber']);
    for (const event of events) {
      const start = new Date(event.start);
      expect(start.getTime()).toBeGreaterThan(NOW);
      expect(start.getTime()).toBeLessThan(endOfToday);
      expect(start.getMinutes() % 30).toBe(0);
      expect(Object.keys(event).sort()).toEqual(['allDay', 'end', 'key', 'start', 'summary']);
    }
  });

  it('empty: no calendars, so the panel is hidden', () => {
    expect(upcomingFixture.config('empty')).toEqual({});
    expect(upcomingFixture.states('empty', clock)).toEqual([]);
    expect(upcomingFixture.calendarEvents?.('empty', clock)).toEqual({});
  });

  it('dense: two calendars and more events than the budget, including all-day and a long title', () => {
    expect(upcomingFixture.config('dense').calendars).toHaveLength(2);
    const all = Object.values(upcomingFixture.calendarEvents?.('dense', clock) ?? {}).flat();
    expect(all.length).toBeGreaterThan(4);
    expect(all.some((event) => event.allDay && /^\d{4}-\d{2}-\d{2}$/.test(event.start))).toBe(true);
    expect(all.some((event) => event.summary.length > 60)).toBe(true);
    expect(all.some((event) => Date.parse(event.start) < NOW && Date.parse(event.end) > NOW)).toBe(true);
  });

  it('moves with the clock', () => {
    const shift = 2 * 24 * 60 * 60_000;
    const early = upcomingFixture.calendarEvents?.('normal', clock)['calendar.demo_household']?.[0];
    const late = upcomingFixture.calendarEvents?.('normal', fixtureClock(NOW + shift))['calendar.demo_household']?.[0];
    expect(Date.parse(late?.start ?? '') - Date.parse(early?.start ?? '')).toBe(shift);
  });
});
