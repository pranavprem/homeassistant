import { describe, expect, it } from 'vitest';
import {
  greetingFor,
  initialsFor,
  selectAlertBanners,
  selectConnection,
  selectHeader,
  selectHousehold,
} from '../../src/model/header.ts';
import type { ConnectionInfo } from '../../src/ha/host.ts';
import { fakeStore, testEntity } from '../helpers/fake-store.ts';
import { ALARM, ARUN, headerConfig, laFormatter, MEERA, POLICY, testInput, testReader } from './support.ts';

const config = headerConfig();

function presenceOf(states: Readonly<Record<string, string>>, storeOptions = {}) {
  const store = fakeStore(
    Object.entries(states).map(([id, state]) => testEntity(id, state)),
    storeOptions,
  );
  return selectHeader(testInput(config, store)).people;
}

describe('selectHeader presence (§4.8: Home, Away or Unknown only)', () => {
  it('maps home to Home and not_home to Away', () => {
    const [meera, arun] = presenceOf({ [MEERA]: 'home', [ARUN]: 'not_home' });
    expect(meera).toMatchObject({ name: 'Meera', initials: 'M', presence: 'home', label: 'Home' });
    expect(arun).toMatchObject({ name: 'Arun', initials: 'A', presence: 'away', label: 'Away' });
  });

  it('reads a zone name as Away and never carries the zone itself', () => {
    const [meera] = presenceOf({ [MEERA]: 'Grandmother house', [ARUN]: 'home' });
    expect(meera?.label).toBe('Away');
    expect(JSON.stringify(meera)).not.toContain('Grandmother');
  });

  it.each(['unknown', 'unavailable', ''])('reads %j as Unknown', (state) => {
    const [meera] = presenceOf({ [MEERA]: state, [ARUN]: 'home' });
    expect(meera?.label).toBe('Unknown');
  });

  it('reads a missing person entity as Unknown', () => {
    const [meera] = presenceOf({ [ARUN]: 'home' });
    expect(meera?.label).toBe('Unknown');
  });

  it('never claims a stale presence: disconnected and resyncing read Unknown', () => {
    expect(presenceOf({ [MEERA]: 'home', [ARUN]: 'home' }, { connected: false })[0]?.label).toBe('Unknown');
    expect(presenceOf({ [MEERA]: 'home', [ARUN]: 'home' }, { connected: false, resyncing: true })[0]?.label).toBe(
      'Unknown',
    );
  });

  it('falls back to the friendly name, then a numbered name, never the entity ID', () => {
    const unnamed = headerConfig({ people: [MEERA, ARUN] });
    const store = fakeStore([testEntity(MEERA, 'home', { friendly_name: 'Meera Iyer' })]);
    const [meera, arun] = selectHeader(testInput(unnamed, store)).people;
    expect(meera).toMatchObject({ name: 'Meera Iyer', initials: 'MI' });
    expect(arun?.name).toBe('Person 2');
    expect(JSON.stringify([meera?.name, arun?.name])).not.toContain('demo_');
  });
});

describe('initialsFor', () => {
  it.each([
    ['Meera', 'M'],
    ['asha rao', 'AR'],
    ['Asha Lakshmi Rao', 'AR'],
    ['  ', '?'],
    ['Élodie', 'É'],
    ['Person 2', 'P'],
    ['42', '?'],
  ])('%j → %j', (name, initials) => {
    expect(initialsFor(name)).toBe(initials);
  });
});

describe('selectHeader security summary (§8.1: actual state, policy separate)', () => {
  function summary(alarm: string | undefined, policy: string, storeOptions = {}) {
    const states = [testEntity(POLICY, policy), ...(alarm === undefined ? [] : [testEntity(ALARM, alarm)])];
    return selectHeader(testInput(config, fakeStore(states, storeOptions))).security;
  }

  it('armed_away with policy Auto shows both, independently', () => {
    const security = summary('armed_away', 'Auto');
    expect(security?.alarm).toMatchObject({ label: 'Armed away', tone: 'ok', stale: false });
    expect(security?.policy).toEqual({ kind: 'value', text: 'Auto', stale: false });
  });

  it('disarmed with policy Auto never reads as armed', () => {
    const security = summary('disarmed', 'Auto');
    expect(security?.alarm.label).toBe('Disarmed');
    expect(security?.alarm.label).not.toMatch(/^Armed/);
  });

  it('a policy named like a mode never changes the alarm label', () => {
    expect(summary('disarmed', 'Hold Away')?.alarm.label).toBe('Disarmed');
  });

  it('keeps the last known alarm label as stale while disconnected and while resyncing', () => {
    expect(summary('armed_vacation', 'Auto', { connected: false })?.alarm).toMatchObject({
      label: 'Armed vacation',
      stale: true,
      tone: 'muted',
    });
    expect(summary('armed_vacation', 'Auto', { connected: false, resyncing: true })?.alarm.stale).toBe(true);
  });

  it('names an unknown, unavailable or missing alarm honestly', () => {
    expect(summary('unknown', 'Auto')?.alarm.label).toBe('Alarm state unknown');
    expect(summary('unavailable', 'Auto')?.alarm.label).toBe('Alarm unavailable');
    expect(summary(undefined, 'Auto')?.alarm.label).toBe('Alarm not found');
  });

  it('has no security summary without a security config', () => {
    const noSecurity = headerConfig({ security: undefined });
    expect(selectHeader(testInput(noSecurity)).security).toBeUndefined();
  });
});

describe('selectConnection (§9.1)', () => {
  const store = fakeStore([]);
  it.each([
    [{ phase: 'loading' } as const, 'hass', 'loading', 'Connecting'],
    [{ phase: 'connected', haState: 'RUNNING' } as const, 'hass', 'connected', 'Connected'],
    [{ phase: 'resyncing' } as const, 'hass', 'resyncing', 'Reconnecting'],
    [{ phase: 'disconnected' } as const, 'hass', 'disconnected', 'Disconnected'],
    [{ phase: 'connected', haState: 'STARTING' } as const, 'hass', 'starting', 'Starting'],
    [{ phase: 'connected', haState: 'RUNNING' } as const, 'demo', 'demo', 'Demo'],
    [{ phase: 'disconnected' } as const, 'demo', 'disconnected', 'Disconnected'],
  ] as const)('%o on %s → %s "%s"', (info, kind, status, label) => {
    const vm = selectConnection(testReader(store, { connection: () => info, kind }));
    expect(vm).toMatchObject({ status, label });
  });

  it('never uses danger red for the indicator (red is the banner, the alarm and failures, §6.5)', () => {
    const vm = selectConnection(testReader(store, { connection: () => ({ phase: 'disconnected' }) }));
    expect(vm.tone).not.toBe('danger');
  });
});

describe('clock, date and greeting (§6.4: locale, 12/24 h and time zone aware)', () => {
  it('formats the pinned time in 12-hour Los Angeles time', () => {
    const vm = selectHeader(testInput(config));
    expect(vm.clock).toEqual({ hm: '5:51', period: 'PM' });
    expect(vm.date).toBe('Wed, Sep 30');
  });

  it('follows a 24-hour profile and the server time zone', () => {
    const formatter = laFormatter({ language: 'en-GB', time_format: '24' }, 'Europe/Berlin');
    const vm = selectHeader(testInput(config, fakeStore([]), { formatter }));
    expect(vm.clock).toEqual({ hm: '2:51' });
    expect(vm.date).toBe('Thu 1 Oct');
  });

  it.each([
    [6, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [16, 'Good afternoon'],
    [17, 'Good evening'],
    [23, 'Good evening'],
    [2, 'Good evening'],
  ])('greets at hour %i with %j', (hour, greeting) => {
    expect(greetingFor(hour)).toBe(greeting);
  });

  it("greets in the clock's time zone when the profile uses server time", () => {
    // 2026-09-30T23:51Z: evening in Los Angeles (16:51 is afternoon there), morning in Kolkata (05:21 next day).
    const now = new Date(Date.UTC(2026, 8, 30, 23, 51));
    const greetingIn = (zone: string) =>
      selectHeader(testInput(config, fakeStore([]), { formatter: laFormatter({ time_zone: 'server' }, zone), now }))
        .greeting;
    expect(greetingIn('America/Los_Angeles')).toBe('Good afternoon');
    expect(greetingIn('Asia/Kolkata')).toBe('Good morning');
  });
});

describe('diagnostics availability (admin and diagnostics: true)', () => {
  it('is available only to admins with diagnostics enabled', () => {
    expect(selectHeader(testInput(config, fakeStore([]), { admin: true })).diagnosticsAvailable).toBe(true);
    expect(selectHeader(testInput(config, fakeStore([]), { admin: false })).diagnosticsAvailable).toBe(false);
    const off = headerConfig({ diagnostics: false });
    expect(selectHeader(testInput(off, fakeStore([]), { admin: true })).diagnosticsAvailable).toBe(false);
  });
});

describe('selectAlertBanners (§9.1)', () => {
  function banners(
    alarm: string,
    connection: ConnectionInfo = { phase: 'connected', haState: 'RUNNING' },
    storeOptions = {},
  ) {
    const store = fakeStore([testEntity(ALARM, alarm), testEntity(POLICY, 'Auto')], storeOptions);
    return selectAlertBanners(testInput(config, store, { connection: () => connection })).map((banner) => banner.kind);
  }

  it('shows nothing while connected with a quiet alarm, and nothing while loading', () => {
    expect(banners('disarmed')).toEqual([]);
    expect(banners('disarmed', { phase: 'loading' })).toEqual([]);
  });

  it('shows the connection banners in their own words', () => {
    const store = fakeStore([]);
    const copy = (phase: 'disconnected' | 'resyncing') =>
      selectAlertBanners(testInput(config, store, { connection: () => ({ phase }) }))[0];
    expect(copy('disconnected')).toMatchObject({
      title: 'Connection to Home Assistant lost.',
      message: 'Showing last known values. Controls are paused until it reconnects.',
      tone: 'danger',
      urgent: false,
    });
    expect(copy('resyncing')).toMatchObject({
      title: 'Reconnecting to Home Assistant.',
      message: 'Showing last known values until current states arrive.',
    });
    expect(banners('disarmed', { phase: 'connected', haState: 'STARTING' })).toEqual(['starting']);
  });

  it('raises an urgent alarm banner only for a live triggered state', () => {
    expect(banners('triggered')).toEqual(['alarm']);
    expect(banners('triggered', { phase: 'disconnected' }, { connected: false })).toEqual(['disconnected']);
  });
});

describe('selectHousehold', () => {
  it('carries presence, the long date and the connection detail when not connected (the header shows the time)', () => {
    const store = fakeStore([testEntity(MEERA, 'home'), testEntity(ARUN, 'not_home')]);
    const vm = selectHousehold(testInput(config, store, { connection: () => ({ phase: 'disconnected' }) }));
    expect(vm.people.map((person) => person.label)).toEqual(['Home', 'Away']);
    expect(vm.date).toBe('Wednesday, September 30');
    expect(vm).not.toHaveProperty('time');
    expect(vm.connectionDetail).toContain('Connection to Home Assistant lost.');
    expect(selectHousehold(testInput(config, store)).connectionDetail).toBeUndefined();
  });
});
