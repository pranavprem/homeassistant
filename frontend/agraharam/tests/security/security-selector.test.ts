import { describe, expect, it } from 'vitest';
import type { SecurityActionRole } from '../../src/config/schema.ts';
import { SECURITY_ACTION_COPY } from '../../src/model/action-copy.ts';
import { HEALTH_TEXT_MAX_CHARS, selectSecurity } from '../../src/model/security.ts';
import type { SecurityVM, SelectorInput } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeStore, testEntity, type FakeStoreOptions } from '../helpers/fake-store.ts';
import { configFrom, fakeReader } from '../helpers/services.ts';
import { GARAGE_STATES, IDS, SECURITY_INPUT, SECURITY_STATES, type StateSpec } from '../garage/world.ts';

const NOW = new Date(2026, 8, 30, 17, 51, 0);
const ALL_ROLES_IN_ORDER: readonly SecurityActionRole[] = [
  'silence_sound',
  'disarm_hold',
  'hold_night',
  'hold_away',
  'hold_vacation',
  'resume_auto',
  'prepare_departure',
];

interface SelectOptions extends FakeStoreOptions {
  readonly input?: Record<string, unknown>;
  readonly gateway?: FakeGateway;
}

function select(states: Readonly<Record<string, StateSpec | undefined>> = {}, options: SelectOptions = {}): SecurityVM {
  const merged = { ...SECURITY_STATES, [IDS.garage]: GARAGE_STATES[IDS.garage], ...states };
  const entities = Object.entries(merged)
    .filter((entry): entry is [string, StateSpec] => entry[1] !== undefined)
    .map(([id, [state, attributes]]) => testEntity(id, state, attributes));
  const store = fakeStore(entities, options);
  const input: SelectorInput = {
    config: configFrom({ controls: true, ...(options.input ?? SECURITY_INPUT) }),
    store,
    reader: fakeReader(store),
    gateway: options.gateway ?? new FakeGateway(),
    now: NOW,
  };
  return selectSecurity(input);
}

describe('selectSecurity: status rows stay separate concepts (§8.1)', () => {
  it('armed_away under policy "Auto" reports both, independently', () => {
    const vm = select({ [IDS.alarm]: ['armed_away', {}], [IDS.policy]: ['Auto', {}] });
    expect(vm.alarm).toEqual({ state: 'armed_away', label: 'Armed away', tone: 'ok', stale: false });
    expect(vm.policy).toEqual({ kind: 'value', text: 'Auto', stale: false });
  });

  it('disarmed under policy "Auto" never reads as armed', () => {
    const vm = select({ [IDS.alarm]: ['disarmed', {}], [IDS.policy]: ['Auto', {}] });
    expect(vm.alarm.label).toBe('Disarmed');
    expect(vm.alarm.label).not.toMatch(/\bArmed\b/);
    expect(vm.alarm.tone).toBe('neutral');
  });

  it('labels triggered, transitional, unknown and missing alarms', () => {
    expect(select({ [IDS.alarm]: ['triggered', {}] }).alarm).toMatchObject({
      label: 'Alarm triggered',
      tone: 'danger',
    });
    expect(select({ [IDS.alarm]: ['pending', {}] }).alarm).toMatchObject({ label: 'Entry delay', tone: 'attention' });
    expect(select({ [IDS.alarm]: ['unknown', {}] }).alarm).toMatchObject({ label: 'Alarm state unknown' });
    expect(select({ [IDS.alarm]: undefined }).alarm).toMatchObject({ label: 'Alarm not found', tone: 'muted' });
  });

  it('keeps the last known alarm and policy while disconnected, marked stale', () => {
    const vm = select({ [IDS.alarm]: ['armed_night', {}] }, { connected: false });
    expect(vm.alarm).toEqual({ state: 'armed_night', label: 'Armed night', tone: 'muted', stale: true });
    expect(vm.policy).toMatchObject({ kind: 'value', text: 'Auto', stale: true });
  });

  it('shows an unknown or missing policy as absent, not as a mode', () => {
    expect(select({ [IDS.policy]: ['unknown', {}] }).policy).toMatchObject({ kind: 'absent', label: 'Unknown' });
    expect(select({ [IDS.policy]: undefined }).policy).toMatchObject({ kind: 'absent', label: 'Not found' });
  });

  it('formats the suggested mode as its own row', () => {
    expect(select({ [IDS.suggested]: ['Armed away', {}] }).suggested).toMatchObject({ text: 'Armed away' });
    expect(select({ [IDS.suggested]: ['unavailable', {}] }).suggested).toMatchObject({
      kind: 'absent',
      label: 'Unavailable',
    });
  });

  it.each([
    ['on', { on: true, label: 'Setup mode on' }],
    ['off', { on: false, label: 'Off' }],
    ['unavailable', { on: null, label: 'Unavailable' }],
    ['unknown', { on: null, label: 'Unknown' }],
  ] as const)('commissioning %s reads as reported', (state, expected) => {
    expect(select({ [IDS.commissioning]: [state, {}] }).commissioning).toMatchObject(expected);
  });

  it('keeps a stale commissioning reading', () => {
    expect(select({ [IDS.commissioning]: ['on', {}] }, { connected: false }).commissioning).toEqual({
      status: 'disconnected',
      on: true,
      label: 'Setup mode on',
    });
  });

  it('caps the health text at 200 characters', () => {
    const long = 'Controller message. '.repeat(20);
    const health = select({ [IDS.health]: [long, {}] }).health;
    expect(health?.kind).toBe('value');
    const text = health?.kind === 'value' ? health.text : '';
    expect(text.length).toBeLessThanOrEqual(HEALTH_TEXT_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(select({ [IDS.health]: ['unavailable', {}] }).health).toMatchObject({ kind: 'absent' });
  });

  it('caps the health text by characters, never splitting an emoji into a lone surrogate', () => {
    const long = `${'a'.repeat(HEALTH_TEXT_MAX_CHARS - 2)}😀😀😀😀`;
    const health = select({ [IDS.health]: [long, {}] }).health;
    const text = health?.kind === 'value' ? health.text : '';
    expect(text.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
    expect(Array.from(text)).toHaveLength(HEALTH_TEXT_MAX_CHARS);
  });

  it('omits optional rows that are not configured', () => {
    const vm = select({}, { input: { security: { alarm: IDS.alarm, policy: IDS.policy } } });
    expect(vm.suggested).toBeUndefined();
    expect(vm.commissioning).toBeUndefined();
    expect(vm.health).toBeUndefined();
    expect(vm.perimeter).toEqual([]);
    expect(vm.actions).toEqual([]);
  });
});

describe('selectSecurity: monitored entry points (§8.3)', () => {
  it('maps sensors and covers through model/perimeter.ts, by friendly name', () => {
    const vm = select({ [IDS.backDoor]: ['on', { friendly_name: 'Back door' }] });
    expect(vm.perimeter).toEqual([
      { key: IDS.frontDoor, name: 'Front door', status: 'available', position: 'closed', label: 'Closed' },
      { key: IDS.backDoor, name: 'Back door', status: 'available', position: 'open', label: 'Open' },
      { key: IDS.garage, name: 'Garage door', status: 'available', position: 'closed', label: 'Closed' },
    ]);
  });

  it('keeps unavailable and missing entry points distinct', () => {
    const vm = select({ [IDS.frontDoor]: ['unavailable', {}], [IDS.backDoor]: undefined });
    expect(vm.perimeter.map((item) => item.label)).toEqual(['Unavailable', 'Not found', 'Closed']);
    expect(vm.perimeter[1]?.name).toBe('Entry point');
  });
});

describe('selectSecurity: actions (§8.2)', () => {
  it('lists every configured role in group order with copy from model/action-copy.ts', () => {
    const vm = select();
    expect(vm.actions.map((action) => action.role)).toEqual(ALL_ROLES_IN_ORDER);
    for (const action of vm.actions) {
      expect(action.label).toBe(SECURITY_ACTION_COPY[action.role].label);
      expect(action.consequence).toBe(SECURITY_ACTION_COPY[action.role].consequence);
      expect(action.group).toBe(SECURITY_ACTION_COPY[action.role].group);
    }
  });

  it('renders only configured roles', () => {
    const security = { ...SECURITY_INPUT.security, actions: { disarm_hold: IDS.disarmHold, hold_away: IDS.holdAway } };
    expect(select({}, { input: { security } }).actions.map((action) => action.role)).toEqual([
      'disarm_hold',
      'hold_away',
    ]);
  });

  it('takes each availability from gateway.evaluate for that role', () => {
    const gateway = new FakeGateway();
    gateway.availability = (req) =>
      req.kind === 'security.run' && req.role === 'silence_sound'
        ? { enabled: true, confirm: false }
        : { enabled: true, confirm: true };
    const actions = select({}, { gateway }).actions;
    expect(actions.find((action) => action.role === 'silence_sound')?.availability).toEqual({
      enabled: true,
      confirm: false,
    });
    expect(actions.filter((action) => action.availability.enabled && action.availability.confirm)).toHaveLength(6);
  });

  it('distinguishes Silence sound from Disarm & hold', () => {
    const [silence, disarm] = select().actions;
    expect(silence).toMatchObject({ role: 'silence_sound', group: 'sound', label: 'Silence sound' });
    expect(disarm).toMatchObject({ role: 'disarm_hold', group: 'disarm', label: 'Disarm & hold' });
    expect(disarm?.label.toLowerCase()).not.toContain('silence');
  });

  it('returns an empty view model when security is not configured', () => {
    const vm = select({}, { input: {} });
    expect(vm.actions).toEqual([]);
    expect(vm.perimeter).toEqual([]);
  });
});
