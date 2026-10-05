import { describe, expect, it } from 'vitest';
import { alarmDisplayFor, isAlarmSounding, isArmedOrArming, isKnownAlarmState } from '../../src/domain/alarm.ts';
import { alarmIcon } from '../../src/model/alarm-labels.ts';
import { entityId, fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';

const ALARM = entityId('alarm_control_panel.demo_home');

function display(state: string | undefined, options: FakeStoreOptions = {}) {
  const states = state === undefined ? [] : [testEntity(ALARM, state)];
  return alarmDisplayFor(fakeStore(states, options), ALARM);
}

describe('alarm labels (§8.1)', () => {
  it.each([
    ['disarmed', 'Disarmed', 'neutral'],
    ['armed_home', 'Armed home', 'ok'],
    ['armed_away', 'Armed away', 'ok'],
    ['armed_night', 'Armed night', 'ok'],
    ['armed_vacation', 'Armed vacation', 'ok'],
    ['armed_custom_bypass', 'Armed custom', 'ok'],
    ['arming', 'Arming', 'attention'],
    ['pending', 'Entry delay', 'attention'],
    ['disarming', 'Disarming', 'attention'],
    ['triggered', 'Alarm triggered', 'danger'],
  ])('%s → "%s" (%s)', (state, label, tone) => {
    expect(display(state)).toEqual({ state, label, tone, stale: false });
  });

  it('labels absent and unexpected states muted, never as healthy', () => {
    expect(display('unavailable')).toEqual({
      state: 'unavailable',
      label: 'Alarm unavailable',
      tone: 'muted',
      stale: false,
    });
    expect(display('unknown')).toEqual({ state: 'unknown', label: 'Alarm state unknown', tone: 'muted', stale: false });
    expect(display(undefined)).toEqual({
      state: 'missing-binding',
      label: 'Alarm not found',
      tone: 'muted',
      stale: false,
    });
    expect(display('armed_strange').label).toBe('Alarm state unknown');
  });

  it('keeps the last known label while disconnected, stale and muted', () => {
    expect(display('armed_vacation', { connected: false })).toEqual({
      state: 'armed_vacation',
      label: 'Armed vacation',
      tone: 'muted',
      stale: true,
    });
  });

  it('classifies armed/arming and known states for the garage confirmation line', () => {
    expect(isArmedOrArming(display('armed_night'))).toBe(true);
    expect(isArmedOrArming(display('arming'))).toBe(true);
    expect(isArmedOrArming(display('armed_away', { connected: false }))).toBe(false);
    expect(isKnownAlarmState(display('triggered'))).toBe(true);
    expect(isKnownAlarmState(display('unknown'))).toBe(false);
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'armed_valueOf'])(
    'never mistakes the state %s for a known one through the object prototype',
    (state) => {
      const alarm = display(state);
      expect(alarm).toMatchObject({ label: 'Alarm state unknown', tone: 'muted' });
      expect(isKnownAlarmState(alarm)).toBe(false);
      expect(isArmedOrArming(alarm)).toBe(false);
      expect(isAlarmSounding(alarm)).toBe(false);
    },
  );
});

describe('alarm icon: one choice for the header pill and the security drawer (§8.1)', () => {
  it.each([
    ['disarmed', 'shield-off'],
    ['armed_home', 'shield-check'],
    ['armed_away', 'shield-check'],
    ['armed_custom_bypass', 'shield-check'],
    ['arming', 'shield-alert'],
    ['pending', 'shield-alert'],
    ['disarming', 'shield-alert'],
    ['triggered', 'shield-alert'],
    ['unknown', 'shield'],
    ['unavailable', 'shield'],
    ['armed_spaceship', 'shield'],
  ])('%s → %s', (state, icon) => {
    expect(alarmIcon(display(state))).toBe(icon);
  });

  it('draws a plain shield for anything not known live: not found, loading and every stale state', () => {
    expect(alarmIcon(display(undefined))).toBe('shield');
    expect(alarmIcon(display('armed_away', { connected: false }))).toBe('shield');
    expect(alarmIcon(display('disarmed', { connected: false }))).toBe('shield');
  });
});

describe('alarm sounding: when Silence sound may skip its confirmation (§7.1)', () => {
  it('is true only for a live triggered alarm or entry delay', () => {
    expect(isAlarmSounding(display('triggered'))).toBe(true);
    expect(isAlarmSounding(display('pending'))).toBe(true);
    for (const state of ['disarmed', 'armed_away', 'arming', 'disarming', 'unknown', 'unavailable']) {
      expect(isAlarmSounding(display(state)), state).toBe(false);
    }
  });

  it('never counts a last known triggered state', () => {
    expect(isAlarmSounding(display('triggered', { connected: false }))).toBe(false);
  });
});
