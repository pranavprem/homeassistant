/**
 * agr-upcoming (§9.5): hidden without calendars; renders grouped events from the calendar reads; escapes
 * calendar text; rolls over on the 'clock' meta; keeps stale events with a note on errors; no gateway use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgrUpcoming } from '../../src/components/upcoming/agr-upcoming.ts';
import '../../src/components/upcoming/agr-upcoming.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import type { CalendarEventLike, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import { deepQueryAll, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';
import { ManualStore } from '../today/controller-host.ts';

const HOUSEHOLD = entityId('calendar.demo_household');
const CLUB = entityId('calendar.demo_club');
const MIN_MS = 60_000;

function timed(key: string, summary: string, startMin: number, lengthMin = 30): CalendarEventLike {
  const now = Date.now();
  return {
    key,
    summary,
    start: new Date(now + startMin * MIN_MS).toISOString(),
    end: new Date(now + (startMin + lengthMin) * MIN_MS).toISOString(),
    allDay: false,
  };
}

async function mount(config: ResolvedConfig, events: Readonly<Record<string, readonly CalendarEventLike[]>> = {}) {
  const manual = new ManualStore([HOUSEHOLD, CLUB], [testEntity(HOUSEHOLD, 'off'), testEntity(CLUB, 'off')]);
  let fail = false;
  const fetchCalendarEvents = vi.fn((id: string) =>
    fail ? Promise.reject({ code: 'network' }) : Promise.resolve(events[id] ?? []),
  );
  const reader: HostReader = { ...fakeReader(manual.view, () => manual.phase()), fetchCalendarEvents };
  const gateway = new FakeGateway();
  const services: DashboardServices = {
    config,
    reader,
    store: manual.view,
    gateway,
    status: createStatusBoard(),
    warnings: [],
    mode: 'live',
    preview: false,
    theme: 'light',
  };
  const element = document.createElement('agr-upcoming') as AgrUpcoming;
  element.services = services;
  document.body.append(element);
  await settle();
  return {
    element,
    root: element.shadowRoot as ShadowRoot,
    manual,
    gateway,
    fetchCalendarEvents,
    failNext: () => {
      fail = true;
    },
  };
}

function rows(root: ShadowRoot): string[] {
  return deepQueryAll(root, 'li.event').map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agr-upcoming', () => {
  it('is hidden and reads nothing when no calendars are configured', async () => {
    const t = await mount(configFrom({}));
    expect(t.element.hidden).toBe(true);
    expect(t.root.querySelector('agr-panel')).toBeNull();
    expect(t.fetchCalendarEvents).not.toHaveBeenCalled();
  });

  it('renders today and tomorrow groups on a quiet panel', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 30, 17, 51, 0));
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }), {
      [HOUSEHOLD]: [timed('a', 'Grocery pickup', 90), timed('b', 'Workshop', 26 * 60)],
    });
    expect(t.root.querySelector('agr-panel')?.getAttribute('surface')).toBe('quiet');
    expect(t.root.querySelector('agr-panel')?.getAttribute('heading-id')).toBe('agr-upcoming-heading');
    const labels = [...t.root.querySelectorAll('.group-label')].map((label) => label.textContent);
    expect(labels).toEqual(['Today', 'Tomorrow']);
    expect(rows(t.root)).toEqual([
      expect.stringMatching(/^7:21\sPM Grocery pickup$/),
      expect.stringMatching(/^7:51\sPM Workshop$/),
    ]);
    expect(t.root.querySelector('.calendar')).toBeNull(); // one calendar: no per-row calendar name
  });

  it('names the calendar on each row when several are configured', async () => {
    const t = await mount(
      configFrom({
        calendars: [
          { entity: HOUSEHOLD, name: 'Household' },
          { entity: CLUB, name: 'Club' },
        ],
      }),
      {
        [HOUSEHOLD]: [timed('a', 'Grocery pickup', 10)],
        [CLUB]: [timed('b', 'Workshop', 20)],
      },
    );
    expect([...t.root.querySelectorAll('.calendar')].map((name) => name.textContent)).toEqual(['Household', 'Club']);
  });

  it('renders calendar text as literal text, never markup', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }), { [HOUSEHOLD]: [timed('x', payload, 10)] });
    expect(deepQueryAll(t.root, 'img, script')).toEqual([]);
    expect(rows(t.root)[0]).toContain(payload);
  });

  it('says when nothing is scheduled', async () => {
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }));
    expect(t.root.querySelector('.empty')?.textContent).toBe('Nothing scheduled today or tomorrow.');
  });

  it('keeps the previous events, dimmed, with a note when a refresh fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }), { [HOUSEHOLD]: [timed('a', 'Grocery pickup', 90)] });
    t.failNext();
    vi.advanceTimersByTime(15 * MIN_MS);
    await settle();
    expect(rows(t.root)[0]).toContain('Grocery pickup');
    expect(t.root.querySelector('.group')?.classList.contains('stale')).toBe(true);
    expect(t.root.querySelector('.note')?.textContent?.trim()).toBe("Calendar couldn't be loaded.");
  });

  it('shows the paused note and last known events while disconnected', async () => {
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }), { [HOUSEHOLD]: [timed('a', 'Grocery pickup', 90)] });
    t.manual.setConnected(false);
    await settle();
    expect(t.root.querySelector('.note')?.textContent?.trim()).toBe('Events resume when Home Assistant reconnects.');
    expect(t.root.textContent).toContain('last known');
  });

  it('re-groups on the clock meta alone: tomorrow becomes today after midnight, with no refetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 30, 23, 50, 0));
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }), {
      [HOUSEHOLD]: [timed('m', 'Morning walk', 9 * 60)],
    });
    expect([...t.root.querySelectorAll('.group-label')].map((label) => label.textContent)).toEqual(['Tomorrow']);
    vi.setSystemTime(new Date(2026, 9, 1, 0, 1, 0));
    t.manual.store.tick();
    await settle();
    expect([...t.root.querySelectorAll('.group-label')].map((label) => label.textContent)).toEqual(['Today']);
    expect(t.fetchCalendarEvents).toHaveBeenCalledTimes(1);
  });

  it('stops reading when removed and never uses the gateway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await mount(configFrom({ calendars: [HOUSEHOLD] }));
    t.element.remove();
    vi.advanceTimersByTime(60 * MIN_MS);
    expect(t.fetchCalendarEvents).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.gateway.calls).toEqual([]);
  });
});
