/**
 * The gateway pipeline and ticket lifecycle (§4.7, §12.1 rows 4–8, gateway parts): disabled states and no replay,
 * one tap = one call, rejections, delayed acknowledgement, timeouts, reversal, locks across gateways, epochs, sticky
 * denial, duplicate security scripts, garage-class curtains and staged enablement (`controls: false`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, ResolvedConfig, SecurityActionRole } from '../../src/config/schema.ts';
import { mintConfirmationToken, redeemConfirmationToken } from '../../src/ha/actions/confirmation.ts';
import { createGateway, RECENT_LIMIT } from '../../src/ha/actions/gateway.ts';
import { createInflightRegistry } from '../../src/ha/actions/inflight.ts';
import { storeView } from '../../src/ha/entity-store.ts';
import {
  ACTION_TIMEOUT_MS,
  CONFIRMED_DISPLAY_MS,
  type ActionRequest,
  type ActionStatus,
  type Availability,
  type RequestOptions,
} from '../../src/ha/actions/types.ts';
import { BASE_INPUT, configFrom, FEATURES, flush, harness, IDS } from './harness.ts';
import { ROW_ENTRIES } from './rows.ts';

const e = (id: string): EntityId => id as EntityId;
const KITCHEN_ON: ActionRequest = { kind: 'light.turn_on', entity: e(IDS.kitchenLight) };
const GARAGE_OPEN: ActionRequest = { kind: 'garage.open' };
/** What agr-confirm-dialog passes when the user presses Confirm: a token bound to exactly this request. */
const confirmedFor = (req: ActionRequest): RequestOptions => ({ confirmation: mintConfirmationToken(req) });
/** An entity-ID-shaped substring (domain.object_id), which no user-facing message may contain. */
const ENTITY_ID_SHAPE = /\b[a-z_]+\.[a-z0-9_]+\b/;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function disabled(availability: Availability): Extract<Availability, { enabled: false }> {
  if (availability.enabled) throw new Error('expected a disabled availability');
  return availability;
}

describe('creation and evaluate()', () => {
  it('makes no service call on creation, evaluation or store updates', () => {
    const h = harness();
    for (const [, row] of ROW_ENTRIES) h.gateway.evaluate(row.req);
    h.patch(IDS.kitchenLight, {}, 'on');
    h.setConnected(false);
    h.setConnected(true);
    expect(h.port.calls).toEqual([]);
  });

  it('never returns confirmation-required: confirm-required actions are enabled with confirm: true', () => {
    const h = harness();
    expect(h.gateway.evaluate(GARAGE_OPEN)).toEqual({ enabled: true, confirm: true });
    expect(h.gateway.evaluate({ kind: 'security.run', role: 'disarm_hold' })).toEqual({ enabled: true, confirm: true });
    for (const [, row] of ROW_ENTRIES) {
      const availability = h.gateway.evaluate(row.req);
      expect(availability.enabled ? undefined : availability.reason).not.toBe('confirmation-required');
    }
  });

  it.each([
    ['disarmed', true],
    ['armed_away', true],
    ['triggered', false],
    ['pending', false],
    ['unavailable', true],
    ['unknown', true],
  ] as const)('Silence Sound with the alarm %s → confirm: %s', (alarm, confirm) => {
    const h = harness();
    h.set(IDS.alarm, alarm);
    expect(h.gateway.evaluate({ kind: 'security.run', role: 'silence_sound' })).toEqual({ enabled: true, confirm });
  });

  it('runs Silence Sound without a confirmation only while the alarm is sounding', () => {
    const h = harness({ states: { [IDS.alarm]: ['triggered'] } });
    expect(h.gateway.request({ kind: 'security.run', role: 'silence_sound' }).phase).toBe('pending');
    expect(h.port.calls[0]?.target).toEqual({ entity_id: IDS.silence });
  });

  it.each(['triggered', 'pending'] as const)(
    'every other security role still requires the confirmation while the alarm is %s',
    (alarm) => {
      const h = harness({ states: { [IDS.alarm]: [alarm] } });
      const roles = ['disarm_hold', 'resume_auto', 'hold_night', 'hold_away', 'hold_vacation', 'prepare_departure'];
      for (const role of roles as SecurityActionRole[]) {
        expect(h.gateway.evaluate({ kind: 'security.run', role }), role).toEqual({ enabled: true, confirm: true });
        const status = h.gateway.request({ kind: 'security.run', role });
        expect(status.error?.code, role).toBe('confirmation-required');
      }
      expect(h.port.calls).toEqual([]);
    },
  );
});

describe('staged enablement, preview and connection (§12.1 row 4)', () => {
  it('controls: false disables every kind with controls-off and sends nothing', () => {
    const h = harness({ input: { ...BASE_INPUT, controls: false } });
    for (const [kind, row] of ROW_ENTRIES) {
      expect(h.gateway.evaluate(row.req), kind).toEqual({
        enabled: false,
        reason: 'controls-off',
        message: 'Controls are turned off in the dashboard configuration.',
      });
      const status = h.gateway.request(row.req, confirmedFor(row.req));
      expect(status).toMatchObject({ phase: 'failed', error: { code: 'controls-off' } });
      expect(h.gateway.status(status.key)).toBeUndefined();
    }
    expect(h.port.calls).toEqual([]);
  });

  it('preview disables controls and sends nothing', () => {
    const h = harness();
    h.preview = true;
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('preview');
    expect(h.gateway.request(KITCHEN_ON).error?.code).toBe('preview');
    expect(h.port.calls).toEqual([]);
  });

  it('disconnected: disabled with the paused copy, a tap fails as not sent, nothing is stored or replayed', () => {
    const h = harness();
    h.setConnected(false);
    expect(h.gateway.evaluate(KITCHEN_ON)).toEqual({
      enabled: false,
      reason: 'disconnected',
      message: 'Paused while Home Assistant is disconnected.',
    });
    const status = h.gateway.request(KITCHEN_ON);
    expect(status.error).toEqual({
      code: 'disconnected',
      message: 'Not sent: Home Assistant was disconnected. Nothing was changed.',
    });
    expect(h.gateway.status(status.key)).toBeUndefined();
    h.setConnected(true);
    vi.advanceTimersByTime(120_000);
    expect(h.port.calls).toEqual([]);
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
  });

  it('resyncing (socket back, snapshot not yet ingested) stays disabled until the snapshot', () => {
    const h = harness();
    h.setConnected(false);
    h.reconnectWithoutSnapshot();
    expect(h.gateway.evaluate(KITCHEN_ON)).toEqual({
      enabled: false,
      reason: 'disconnected',
      message: 'Paused until Home Assistant sends current states.',
    });
    expect(h.gateway.request(KITCHEN_ON).error?.code).toBe('disconnected');
    h.deliverSnapshot();
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
    expect(h.port.calls).toEqual([]);
  });

  it('trusts the live phase: a stale connected store with the socket down sends nothing', () => {
    const h = harness();
    h.phaseOverride = 'disconnected';
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('disconnected');
    expect(h.gateway.request(KITCHEN_ON).error?.code).toBe('disconnected');
    expect(h.port.calls).toEqual([]);
  });

  it('an entity the snapshot did not refresh is paused with the resync wording, never called missing', () => {
    const h = harness();
    h.setConnected(false);
    h.reconnectWithoutSnapshot();
    // Still the resync base's object: deleted during the outage, or a snapshot that has not arrived (§15 #25).
    h.deliverSnapshot([IDS.kitchenLight, IDS.courtyardLight]);
    expect(h.reader.connection().phase).toBe('connected');
    expect(h.gateway.evaluate(KITCHEN_ON)).toEqual({
      enabled: false,
      reason: 'disconnected',
      message: 'Paused until Home Assistant sends current states.',
    });
    const status = h.gateway.request(KITCHEN_ON);
    expect(status.error).toEqual({
      code: 'disconnected',
      message: 'Not sent: paused until Home Assistant sends current states. Nothing was changed.',
    });
    expect(JSON.stringify(status)).not.toContain("wasn't found");
    // A room whose only light is not refreshed says the same.
    const courtyard: ActionRequest = { kind: 'room.lights_off', room: 1 };
    expect(h.gateway.evaluate(courtyard)).toMatchObject({ enabled: false, reason: 'disconnected' });
    expect(h.port.calls).toEqual([]);
  });
});

describe('epochs and dispose', () => {
  it('moves the epoch once when the phase leaves connected, on invalidate and on dispose', () => {
    const h = harness();
    const seen: number[] = [];
    h.gateway.onEpochChange((epoch) => seen.push(epoch));
    h.setConnected(false);
    h.setConnected(true);
    h.reconnectWithoutSnapshot();
    h.gateway.invalidate('preview');
    h.gateway.dispose();
    h.gateway.dispose();
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('refuses a stale gesture epoch with not-sent and never invokes', () => {
    const h = harness();
    const epoch = h.gateway.epoch();
    h.gateway.invalidate('preview');
    const status = h.gateway.request(KITCHEN_ON, { epoch });
    expect(status.error?.code).toBe('not-sent');
    expect(h.gateway.status(status.key)).toBeUndefined();
    expect(h.port.calls).toEqual([]);
  });

  it('notices a phase change at request time even before the store reports it', () => {
    const h = harness();
    const epoch = h.gateway.epoch();
    h.phaseOverride = 'disconnected';
    expect(h.gateway.request(KITCHEN_ON, { epoch }).error?.code).toBe('not-sent');
    expect(h.gateway.epoch()).toBe(epoch + 1);
    expect(h.port.calls).toEqual([]);
  });

  it('after dispose: request() fails not-sent without invoking, and evaluate() is disabled', () => {
    const h = harness();
    h.gateway.dispose();
    expect(h.gateway.disposed).toBe(true);
    expect(h.gateway.request(KITCHEN_ON).error?.code).toBe('not-sent');
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('not-sent');
    expect(h.port.calls).toEqual([]);
  });

  it('dispose settles in-flight tickets as uncertain but keeps the in-flight lock', async () => {
    const h = harness();
    const status = h.gateway.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN));
    h.gateway.dispose();
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'uncertain' });
    expect(h.gateway.status(status.key)?.error?.message).toContain('Garage');
    const rebuilt = h.newGateway();
    expect(disabled(rebuilt.evaluate(GARAGE_OPEN)).reason).toBe('busy');
    h.port.resolve();
    h.patch(IDS.garage, {}, 'open');
    await flush();
    expect(h.gateway.status(status.key)?.phase).toBe('uncertain');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('one tap = one call (§12.1 row 5)', () => {
  it('a second request while the first is pending is busy and never invokes', () => {
    const h = harness();
    expect(h.gateway.request(KITCHEN_ON).phase).toBe('pending');
    const second = h.gateway.request(KITCHEN_ON);
    expect(second.error).toEqual({
      code: 'busy',
      message: 'Waiting for Kitchen pendant to respond to the last request.',
    });
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('busy');
    expect(h.port.calls).toHaveLength(1);
    expect(h.gateway.status(second.key)?.phase).toBe('pending');
  });

  it('all security roles share one lock', () => {
    const h = harness();
    h.gateway.request(
      { kind: 'security.run', role: 'hold_night' },
      confirmedFor({ kind: 'security.run', role: 'hold_night' }),
    );
    expect(
      h.gateway.request(
        { kind: 'security.run', role: 'disarm_hold' },
        confirmedFor({ kind: 'security.run', role: 'disarm_hold' }),
      ).error?.code,
    ).toBe('busy');
    expect(h.port.calls).toHaveLength(1);
  });

  it('a room action locks its lights for single-light actions too', () => {
    const h = harness();
    h.gateway.request({ kind: 'room.lights_on', room: 0 });
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('busy');
  });

  it('the in-flight registry keeps a second gateway busy until the first ticket is confirmed', async () => {
    const h = harness();
    const first = h.gateway.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN));
    const rebuilt = h.newGateway();
    expect(rebuilt.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN)).error?.code).toBe('busy');
    h.port.resolve();
    await flush();
    h.patch(IDS.garage, {}, 'open');
    expect(h.gateway.status(first.key)?.phase).toBe('confirmed');
    h.patch(IDS.garage, {}, 'closed');
    expect(rebuilt.evaluate(GARAGE_OPEN)).toEqual({ enabled: true, confirm: true });
    expect(h.port.calls).toHaveLength(1);
  });

  it('an uncertain call keeps its lock until the family timeout expires, then re-notifies views', async () => {
    const h = harness();
    const seen: ActionStatus[] = [];
    h.gateway.subscribe('*', (status) => seen.push(status));
    const status = h.gateway.request(KITCHEN_ON);
    h.port.reject({ error: { code: 3 } });
    await flush();
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'uncertain', error: { code: 'connection-lost' } });
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('busy');
    expect(disabled(h.newGateway().evaluate(KITCHEN_ON)).reason).toBe('busy');
    const notified = seen.length;
    vi.advanceTimersByTime(10_000 + 100);
    expect(seen.length).toBe(notified + 1);
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
    expect(h.port.calls).toHaveLength(1);
  });
});

describe('acknowledgement and observation', () => {
  it('state observed before the call resolves → confirmed at resolve, not earlier', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.patch(IDS.kitchenLight, {}, 'on');
    expect(h.gateway.status(status.key)?.phase).toBe('pending');
    h.port.resolve();
    await flush();
    expect(h.gateway.status(status.key)?.phase).toBe('confirmed');
  });

  it('state observed after resolve → sent, then confirmed', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.port.resolve();
    await flush();
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'sent' });
    h.patch(IDS.kitchenLight, {}, 'on');
    expect(h.gateway.status(status.key)?.phase).toBe('confirmed');
  });

  it('a script confirms from its context id matching the call', async () => {
    const h = harness();
    const status = h.gateway.request({ kind: 'studio_monitors.run' });
    h.set(IDS.studioMonitors, 'off', { last_triggered: '2026-09-29T10:00:00.000Z' }, 'demo-call-context');
    h.port.resolve('demo-call-context');
    await flush();
    expect(h.gateway.status(status.key)?.phase).toBe('confirmed');
  });

  it('never confirms from stale values while disconnected', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.port.resolve();
    await flush();
    h.setConnected(false);
    h.patch(IDS.kitchenLight, {}, 'on');
    expect(h.gateway.status(status.key)?.phase).toBe('sent');
  });

  it('a curtain reports progress while it moves', async () => {
    const h = harness();
    const status = h.gateway.request({ kind: 'curtain.open', entity: e(IDS.blind) });
    h.port.resolve();
    await flush();
    h.patch(IDS.blind, {}, 'opening');
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'sent', progress: 'moving' });
    h.patch(IDS.blind, { current_position: 100 }, 'open');
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'confirmed' });
    expect(h.gateway.status(status.key)?.progress).toBeUndefined();
  });

  it('a confirmed status is shown for CONFIRMED_DISPLAY_MS, then dismissed with one more notification', async () => {
    const h = harness();
    const seen: string[] = [];
    h.gateway.subscribe(`entity:${IDS.kitchenLight}`, (status) => seen.push(status.phase));
    const status = h.gateway.request(KITCHEN_ON);
    h.port.resolve();
    await flush();
    h.patch(IDS.kitchenLight, {}, 'on');
    vi.advanceTimersByTime(CONFIRMED_DISPLAY_MS - 1);
    expect(h.gateway.status(status.key)?.phase).toBe('confirmed');
    vi.advanceTimersByTime(1);
    expect(h.gateway.status(status.key)).toBeUndefined();
    expect(seen).toEqual(['pending', 'sent', 'confirmed', 'confirmed']);
  });

  it('dismiss() clears a terminal status but never an in-flight one', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.gateway.dismiss(status.key);
    expect(h.gateway.status(status.key)?.phase).toBe('pending');
    h.port.reject({ code: 'home_assistant_error', message: 'Bulb did not answer' });
    await flush();
    expect(h.gateway.status(status.key)?.phase).toBe('failed');
    h.gateway.dismiss(status.key);
    expect(h.gateway.status(status.key)).toBeUndefined();
  });
});

describe('rejections (§4.7 error map)', () => {
  it('service_validation_error → failed(rejected) quoting HA as plain, capped text', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    const payload = `<img src=x onerror=alert(1)> ${'x'.repeat(300)}`;
    h.port.reject({ code: 'service_validation_error', message: payload });
    await flush();
    const error = h.gateway.status(status.key)?.error;
    expect(error?.code).toBe('rejected');
    expect(error?.message.startsWith("Home Assistant didn't accept the request: <img src=x onerror=alert(1)>")).toBe(
      true,
    );
    expect(error?.message.length).toBeLessThanOrEqual("Home Assistant didn't accept the request: ".length + 160);
    expect(error?.haCode).toBe('service_validation_error');
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
  });

  it('{error: {code: 3}} and a bare 3 → uncertain(connection-lost), never retried', async () => {
    for (const rejection of [{ error: { code: 3 } }, 3]) {
      const h = harness();
      const status = h.gateway.request(KITCHEN_ON);
      h.port.reject(rejection);
      await flush();
      expect(h.gateway.status(status.key)).toMatchObject({ phase: 'uncertain', error: { code: 'connection-lost' } });
      h.setConnected(false);
      h.setConnected(true);
      vi.advanceTimersByTime(60_000);
      expect(h.port.calls).toHaveLength(1);
    }
  });

  it('PortNotSent → failed(disconnected) saying nothing was sent, and the lock is released', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.port.reject({ portError: 'not-sent', reason: 'disconnected' });
    await flush();
    expect(h.gateway.status(status.key)?.error).toEqual({
      code: 'disconnected',
      message: 'Not sent: Home Assistant was disconnected. Nothing was changed.',
    });
    expect(h.inflight.isBusy(e(IDS.kitchenLight), h.now())).toBe(false);
  });

  it('Unauthorized → permission-denied, sticky for that family and target until the user changes', async () => {
    const h = harness();
    h.gateway.request(KITCHEN_ON);
    h.port.reject({ code: 'home_assistant_error', message: 'Unauthorized' });
    await flush();
    const availability = disabled(h.gateway.evaluate(KITCHEN_ON));
    expect(availability.reason).toBe('permission-denied');
    expect(availability.message).toBe(
      "Your Home Assistant user can't control Kitchen pendant. Ask an administrator for access.",
    );
    expect(h.gateway.evaluate({ kind: 'light.turn_on', entity: e(IDS.kitchenStrip) }).enabled).toBe(true);
    expect(h.gateway.request(KITCHEN_ON).error?.code).toBe('permission-denied');
    expect(h.port.calls).toHaveLength(1);
    h.changeUser();
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
  });

  it("the 'unauthorized' code is sticky too", async () => {
    const h = harness();
    h.gateway.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN));
    h.port.reject({ code: 'unauthorized', message: 'Unauthorized' });
    await flush();
    expect(disabled(h.gateway.evaluate(GARAGE_OPEN)).reason).toBe('permission-denied');
  });
});

describe('garage (§7.1, §8.5)', () => {
  it('refuses garage.open without the dialog flag and sends nothing', () => {
    const h = harness();
    const status = h.gateway.request(GARAGE_OPEN);
    expect(status.error).toEqual({ code: 'confirmation-required', message: 'Confirm this action first.' });
    expect(h.gateway.status(status.key)).toBeUndefined();
    expect(h.port.calls).toEqual([]);
  });

  it('confirmed open → exactly one cover.open_cover on the configured cover and no script call', () => {
    const h = harness();
    h.gateway.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN));
    expect(h.port.calls).toEqual([
      { domain: 'cover', service: 'open_cover', data: {}, target: { entity_id: IDS.garage } },
    ]);
  });

  it('an unknown position disables both directions with the garage copy', () => {
    const h = harness({ states: { [IDS.garage]: ['unknown', { supported_features: FEATURES.cover }] } });
    for (const req of [GARAGE_OPEN, { kind: 'garage.close' } as const]) {
      expect(h.gateway.evaluate(req)).toEqual({
        enabled: false,
        reason: 'state-unknown',
        message: "The garage door hasn't reported its position, so it can't be moved from here.",
      });
    }
  });

  it('a moving door disables both directions', () => {
    const h = harness({ states: { [IDS.garage]: ['opening', { supported_features: FEATURES.cover }] } });
    expect(disabled(h.gateway.evaluate(GARAGE_OPEN)).reason).toBe('not-applicable');
    expect(disabled(h.gateway.evaluate({ kind: 'garage.close' })).reason).toBe('not-applicable');
  });

  it('close observed closing then opening → failed(reversed) at once, with the garage copy', async () => {
    const h = harness({ states: { [IDS.garage]: ['open', { supported_features: FEATURES.cover }] } });
    const status = h.gateway.request({ kind: 'garage.close' }, confirmedFor({ kind: 'garage.close' }));
    h.port.resolve();
    await flush();
    h.patch(IDS.garage, {}, 'closing');
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'sent', progress: 'moving' });
    h.patch(IDS.garage, {}, 'opening');
    expect(h.gateway.status(status.key)?.error).toEqual({
      code: 'reversed',
      message: 'The door reversed and is opening again. Check the doorway before trying again.',
    });
    expect(h.inflight.isBusy(e(IDS.garage), h.now())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('open observed opening then closing → reversed, even while the call is still pending', () => {
    const h = harness();
    const status = h.gateway.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN));
    h.patch(IDS.garage, {}, 'opening');
    h.patch(IDS.garage, {}, 'closing');
    expect(h.gateway.status(status.key)?.error).toEqual({
      code: 'reversed',
      message: 'The door stopped opening and is closing again. Check the garage before trying again.',
    });
  });

  it('a timeout uses the garage copy', async () => {
    const h = harness();
    const status = h.gateway.request(GARAGE_OPEN, confirmedFor(GARAGE_OPEN));
    h.port.resolve();
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(h.gateway.status(status.key)?.error?.message).toBe(
      "The door hasn't reported open after 60 seconds. Check the garage before trying again.",
    );
  });

  it('a garage, gate or door cover in the curtain role is never moved by curtain.*', () => {
    const covers = ['cover.demo_spare_garage', 'cover.demo_side_gate', 'cover.demo_shed_door'];
    const input = {
      ...BASE_INPUT,
      rooms: [{ name: 'Yard', lights: [IDS.courtyardLight], curtains: covers }],
    };
    const h = harness({
      input,
      states: {
        'cover.demo_spare_garage': ['closed', { supported_features: FEATURES.cover, device_class: 'garage' }],
        'cover.demo_side_gate': ['closed', { supported_features: FEATURES.cover, device_class: 'gate' }],
        'cover.demo_shed_door': ['closed', { supported_features: FEATURES.cover, device_class: 'door' }],
      },
    });
    for (const id of covers) {
      for (const kind of ['curtain.open', 'curtain.close'] as const) {
        const req: ActionRequest = { kind, entity: e(id) };
        // None of them is the configured garage cover, so no panel on this dashboard moves them.
        expect(h.gateway.evaluate(req), id).toEqual({
          enabled: false,
          reason: 'not-allowed',
          message: "Garage, gate and door covers can't be moved from this dashboard.",
        });
        expect(h.gateway.request(req).error?.code, id).toBe('not-allowed');
      }
    }
    expect(h.port.calls).toEqual([]);
  });
});

describe('allowlist and injection (§12.1 rows 6 and 8)', () => {
  it('security.run targets only the script bound to the role, via script.turn_on with no data', async () => {
    const h = harness();
    const roles = [
      ['silence_sound', IDS.silence],
      ['disarm_hold', IDS.disarmHold],
      ['resume_auto', IDS.resumeAuto],
      ['hold_night', IDS.holdNight],
      ['hold_away', IDS.holdAway],
      ['hold_vacation', IDS.holdVacation],
      ['prepare_departure', IDS.departure],
    ] as const;
    for (const [role, script] of roles) {
      expect(
        h.gateway.request({ kind: 'security.run', role }, confirmedFor({ kind: 'security.run', role })).phase,
      ).toBe('pending');
      expect(h.port.calls.at(-1)).toEqual({
        domain: 'script',
        service: 'turn_on',
        data: {},
        target: { entity_id: script },
      });
      h.port.reject({ code: 'home_assistant_error', message: 'Stopped by the test.' });
      await flush();
    }
    expect(h.port.calls).toHaveLength(roles.length);
  });

  it('a hand-built config with one script in two security roles → not-allowed, nothing sent', () => {
    const valid = configFrom(BASE_INPUT);
    const security = valid.security;
    if (security === undefined) throw new Error('security missing');
    const config: ResolvedConfig = {
      ...valid,
      security: { ...security, actions: { ...security.actions, silence_sound: e(IDS.disarmHold) } },
    };
    const h = harness({ config });
    for (const role of ['silence_sound', 'disarm_hold'] as const) {
      expect(disabled(h.gateway.evaluate({ kind: 'security.run', role })).reason).toBe('not-allowed');
      expect(
        h.gateway.request({ kind: 'security.run', role }, confirmedFor({ kind: 'security.run', role })).error?.code,
      ).toBe('not-allowed');
    }
    expect(h.port.calls).toEqual([]);
  });

  it('an unconfigured role or target is not-allowed', () => {
    const h = harness({ input: { ...BASE_INPUT, garage: undefined, studio_monitors_script: undefined } });
    expect(disabled(h.gateway.evaluate(GARAGE_OPEN)).reason).toBe('not-allowed');
    expect(disabled(h.gateway.evaluate({ kind: 'studio_monitors.run' })).reason).toBe('not-allowed');
    expect(disabled(h.gateway.evaluate({ kind: 'light.turn_on', entity: e('light.demo_unbound') })).reason).toBe(
      'not-allowed',
    );
    expect(disabled(h.gateway.evaluate({ kind: 'room.lights_on', room: 7 })).reason).toBe('not-allowed');
  });

  it('a target holding a different role is not-allowed (a fan ID with a light kind, a read-only bed climate)', () => {
    const h = harness();
    expect(disabled(h.gateway.evaluate({ kind: 'light.turn_on', entity: e(IDS.purifier) })).reason).toBe('not-allowed');
    const bed: ActionRequest = { kind: 'climate.set_temperature', entity: e(IDS.bedClimate), temperature: 70 };
    expect(disabled(h.gateway.evaluate(bed)).reason).toBe('not-allowed');
    expect(disabled(h.gateway.evaluate({ kind: 'curtain.open', entity: e(IDS.garage) })).reason).toBe('not-allowed');
  });

  it('a derived ID (vacuum battery) is never actionable', () => {
    const h = harness();
    h.store.setDerived([e(IDS.vacuumBattery)]);
    const req: ActionRequest = { kind: 'vacuum.start', entity: e(IDS.vacuumBattery) };
    expect(disabled(h.gateway.evaluate(req)).reason).toBe('not-allowed');
  });

  it('a binding whose domain does not match the kind is domain-mismatch (defense in depth)', () => {
    const valid = configFrom(BASE_INPUT);
    const bindings = new Map(valid.bindings);
    bindings.set(e('fan.demo_ceiling'), ['room_light']);
    const h = harness({
      config: { ...valid, bindings },
      states: { 'fan.demo_ceiling': ['off', {}] },
    });
    expect(disabled(h.gateway.evaluate({ kind: 'light.turn_on', entity: e('fan.demo_ceiling') })).reason).toBe(
      'domain-mismatch',
    );
  });

  it('an entity holding actionable roles of two families is not-allowed', () => {
    const valid = configFrom(BASE_INPUT);
    const bindings = new Map(valid.bindings);
    bindings.set(e(IDS.garage), ['garage_cover', 'room_curtain', 'perimeter']);
    const h = harness({ config: { ...valid, bindings } });
    expect(disabled(h.gateway.evaluate(GARAGE_OPEN)).reason).toBe('not-allowed');
  });

  it.each([
    ['domain', { kind: 'light.turn_on', entity: IDS.kitchenLight, domain: 'alarm_control_panel' }],
    ['service', { kind: 'light.turn_on', entity: IDS.kitchenLight, service: 'turn_off' }],
    ['data', { kind: 'garage.open', data: { variables: {} } }],
    ['entity_id', { kind: 'security.run', role: 'silence_sound', entity_id: IDS.disarmHold }],
    ['entity on a config-targeted kind', { kind: 'garage.open', entity: IDS.blind }],
    ['a string number', { kind: 'light.set_brightness', entity: IDS.kitchenLight, pct: '40' }],
    ['an invalid entity ID', { kind: 'light.turn_on', entity: 'Light.Kitchen' }],
    ['an unknown role', { kind: 'security.run', role: 'disarm' }],
    ['a negative room', { kind: 'room.lights_on', room: -1 }],
    ['an unknown kind', { kind: 'garage.force_open' }],
    ['null', null],
    ['a number', 42],
  ])('refuses a request with %s as not-allowed and never invokes', (_label, input) => {
    const h = harness();
    const req = input as unknown as ActionRequest;
    expect(disabled(h.gateway.evaluate(req)).reason).toBe('not-allowed');
    expect(h.gateway.request(req, confirmedFor(req))).toMatchObject({
      phase: 'failed',
      error: { code: 'not-allowed' },
    });
    expect(h.port.calls).toEqual([]);
  });

  it('never echoes caller text as a kind: an unknown kind reports "malformed"', () => {
    const h = harness();
    const status = h.gateway.request({ kind: '<img src=x onerror=alert(1)>' } as unknown as ActionRequest);
    expect(status).toMatchObject({ phase: 'failed', kind: 'malformed', error: { code: 'not-allowed' } });
  });

  it('sends exactly the validated fields, even when the caller mutates its request afterwards', () => {
    const h = harness();
    const req = { kind: 'light.turn_on', entity: IDS.kitchenLight } as Record<string, unknown>;
    // A non-enumerable data property passes the shape check, so the copy must carry it too.
    const hidden = { kind: 'light.turn_off' } as Record<string, unknown>;
    Object.defineProperty(hidden, 'entity', { value: IDS.kitchenLight, enumerable: false });
    h.set(IDS.kitchenLight, 'on');
    expect(h.gateway.evaluate(hidden as unknown as ActionRequest).enabled).toBe(true);
    h.set(IDS.kitchenLight, 'off');
    expect(h.gateway.request(req as unknown as ActionRequest).phase).toBe('pending');
    req['entity'] = IDS.blind;
    expect(h.port.calls).toEqual([
      { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: IDS.kitchenLight } },
    ]);
  });

  it('refuses accessor properties and non-plain objects', () => {
    const h = harness();
    const getter = { kind: 'light.turn_on' } as Record<string, unknown>;
    Object.defineProperty(getter, 'entity', { enumerable: true, get: () => IDS.kitchenLight });
    class Request {
      readonly kind = 'light.turn_on';
      readonly entity = IDS.kitchenLight;
    }
    for (const input of [getter, new Request()]) {
      expect(h.gateway.request(input as unknown as ActionRequest).error?.code).toBe('not-allowed');
    }
    expect(h.port.calls).toEqual([]);
  });

  it('a missing service is service-missing', () => {
    const h = harness();
    h.missingServices.add('light.turn_on');
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).reason).toBe('service-missing');
  });

  it('uses the Celsius grid (0.5) without target_temp_step and the entity step when it has one', () => {
    const h = harness();
    const at = (temperature: number): ActionRequest => ({
      kind: 'climate.set_temperature',
      entity: e(IDS.thermostat),
      temperature,
    });
    h.temperatureUnit = '°C';
    h.patch(IDS.thermostat, { min_temp: 7.2, max_temp: 30, temperature: 21 });
    expect(h.gateway.evaluate(at(21.5)).enabled).toBe(true);
    expect(h.gateway.evaluate(at(7.2)).enabled).toBe(true);
    expect(disabled(h.gateway.evaluate(at(21.3))).reason).toBe('invalid-argument');
    h.patch(IDS.thermostat, { target_temp_step: 0.1 });
    expect(h.gateway.evaluate(at(21.3)).enabled).toBe(true);
  });
});

describe('availability of targets (step 6)', () => {
  it('missing and unavailable targets are distinct', () => {
    const h = harness();
    h.remove(IDS.kitchenLight);
    expect(disabled(h.gateway.evaluate(KITCHEN_ON)).message).toBe("This light wasn't found in Home Assistant.");
    h.set(IDS.kitchenLight, 'unavailable', { friendly_name: 'Kitchen pendant' });
    expect(disabled(h.gateway.evaluate(KITCHEN_ON))).toEqual({
      enabled: false,
      reason: 'unavailable',
      message: 'Kitchen pendant is unavailable right now.',
    });
  });

  it('room actions leave unknown and unavailable lights out of the target', () => {
    const h = harness();
    h.patch(IDS.kitchenStrip, {}, 'unknown');
    h.gateway.request({ kind: 'room.lights_on', room: 0 });
    expect(h.port.calls[0]?.target).toEqual({ entity_id: [IDS.kitchenLight] });
  });

  it('a room with no available light reports the most useful reason, in plural', () => {
    const h = harness();
    h.patch(IDS.kitchenLight, {}, 'unavailable');
    h.patch(IDS.kitchenStrip, {}, 'unavailable');
    expect(disabled(h.gateway.evaluate({ kind: 'room.lights_on', room: 0 })).message).toBe(
      'The Kitchen lights are unavailable right now.',
    );
    h.patch(IDS.kitchenStrip, {}, 'unknown');
    expect(disabled(h.gateway.evaluate({ kind: 'room.lights_on', room: 0 })).message).toBe(
      "The Kitchen lights haven't reported their state, so this control is paused until they do.",
    );
  });

  it('messages name things by configured or friendly name, never by entity ID', async () => {
    const h = harness();
    h.remove(IDS.thermostat);
    h.set(IDS.kitchenLight, 'unavailable');
    const messages = [
      disabled(h.gateway.evaluate({ kind: 'climate.set_hvac_mode', entity: e(IDS.thermostat), mode: 'heat' })).message,
      disabled(h.gateway.evaluate(KITCHEN_ON)).message,
      disabled(h.gateway.evaluate({ kind: 'light.turn_on', entity: e('light.demo_unbound') })).message,
    ];
    h.gateway.request({ kind: 'fan.turn_off', entity: e(IDS.purifier) });
    h.port.reject({ code: 'home_assistant_error', message: 'Filter jammed.' });
    await flush();
    messages.push(h.gateway.status(`entity:${IDS.purifier}`)?.error?.message ?? '');
    expect(messages).toEqual([
      "Hall thermostat wasn't found in Home Assistant.",
      'This light is unavailable right now.',
      "This control isn't set up for this light in the dashboard configuration.",
      'Study purifier reported an error: Filter jammed. Check the device, then try again.',
    ]);
    for (const message of messages) expect(message).not.toMatch(ENTITY_ID_SHAPE);
  });
});

describe('visible refusals and recent()', () => {
  it('a refusal from step 4 on is shown on its key until dismissed; steps 0–3 never are', () => {
    const h = harness({ states: { [IDS.kitchenLight]: ['on', {}] } });
    const refused = h.gateway.request(KITCHEN_ON);
    expect(refused.error?.code).toBe('not-applicable');
    expect(h.gateway.status(refused.key)).toBe(refused);
    expect(h.gateway.recent()[0]).toBe(refused);
    h.gateway.dismiss(refused.key);
    expect(h.gateway.status(refused.key)).toBeUndefined();
  });

  it('a refusal never hides a ticket in flight on the same key', () => {
    const h = harness();
    const pending = h.gateway.request({ kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: 40 });
    h.gateway.request({ kind: 'light.set_brightness', entity: e(IDS.kitchenLight), pct: 400 });
    expect(h.gateway.status(pending.key)).toBe(pending);
  });

  it('keeps the last 20 settled or failed tickets, newest first, with monotonic times', async () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    for (let i = 0; i < RECENT_LIMIT + 5; i += 1) {
      clock += 10;
      h.gateway.request(KITCHEN_ON);
      clock += 5;
      h.port.reject({ code: 'home_assistant_error', message: `attempt ${i}` });
      await flush();
    }
    const recent = h.gateway.recent();
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]?.error?.message).toContain(`attempt ${RECENT_LIMIT + 4}`);
    expect(recent[RECENT_LIMIT - 1]?.error?.message).toContain('attempt 5');
    expect(recent.every((status) => status.settledAt !== undefined && status.settledAt - status.startedAt === 5)).toBe(
      true,
    );
    expect(Object.isFrozen(recent)).toBe(true);
  });
});

describe('dependencies and robustness', () => {
  it('defaults to the monotonic performance.now() clock, never Date.now()', () => {
    const h = harness();
    vi.spyOn(performance, 'now').mockReturnValue(4_242);
    const gateway = createGateway({
      port: h.port,
      reader: h.reader,
      config: h.config,
      isPreview: () => false,
      inflight: createInflightRegistry(),
    });
    expect(gateway.request(KITCHEN_ON).startedAt).toBe(4_242);
  });

  it('removes its store listener on dispose, so a disposed gateway retains nothing through the store', () => {
    const h = harness();
    const unsubscribe = vi.fn();
    const store = { ...storeView(h.store), subscribe: vi.fn(() => unsubscribe) };
    const reader = { ...h.reader, store };
    const gateway = createGateway({ port: h.port, reader, config: h.config, isPreview: () => false });
    expect(store.subscribe).toHaveBeenCalledWith([], ['connection', 'user'], expect.any(Function));
    gateway.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when a dependency does', () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = createGateway({
      port: h.port,
      reader: h.reader,
      config: h.config,
      isPreview: () => {
        throw new Error('boom');
      },
    });
    expect(gateway.evaluate(KITCHEN_ON)).toMatchObject({ enabled: false, reason: 'unknown' });
    expect(gateway.request(KITCHEN_ON)).toMatchObject({ phase: 'failed', error: { code: 'unknown' } });
    expect(h.port.calls).toEqual([]);
  });

  it('a port that throws synchronously settles the ticket instead of escaping', async () => {
    const h = harness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway = createGateway({
      port: {
        invoke: () => {
          throw new Error('sync failure');
        },
      },
      reader: h.reader,
      config: h.config,
      isPreview: () => false,
      now: () => Date.now(),
      inflight: createInflightRegistry(),
    });
    const status = gateway.request(KITCHEN_ON);
    await flush();
    expect(gateway.status(status.key)).toMatchObject({ phase: 'failed', error: { code: 'unknown' } });
  });
});

describe('confirmation tokens (§4.7 step 11)', () => {
  const SILENCE: ActionRequest = { kind: 'security.run', role: 'silence_sound' };
  const DISARM: ActionRequest = { kind: 'security.run', role: 'disarm_hold' };
  const GARAGE_CLOSE: ActionRequest = { kind: 'garage.close' };

  it('a plain confirmed flag, or any look-alike object, is not a confirmation', () => {
    const h = harness();
    const forged = { kind: 'confirmation-token', scope: 'garage|{"kind":"garage.open"}' };
    for (const opts of [{ confirmed: true }, { confirmation: true }, { confirmation: forged }]) {
      const status = h.gateway.request(GARAGE_OPEN, opts as unknown as RequestOptions);
      expect(status.error?.code).toBe('confirmation-required');
    }
    expect(redeemConfirmationToken(forged, GARAGE_OPEN)).toBe(false);
    expect(h.port.calls).toEqual([]);
  });

  it('is bound to its exact request: a Close token cannot open, a Silence sound token cannot disarm', () => {
    const h = harness({ states: { [IDS.garage]: ['open', { supported_features: FEATURES.cover }] } });
    expect(redeemConfirmationToken(mintConfirmationToken(GARAGE_CLOSE), GARAGE_CLOSE)).toBe(true);
    expect(redeemConfirmationToken(mintConfirmationToken(GARAGE_CLOSE), GARAGE_OPEN)).toBe(false);
    const silenceToken = mintConfirmationToken(SILENCE);
    expect(h.gateway.request(DISARM, { confirmation: silenceToken }).error?.code).toBe('confirmation-required');
    expect(h.port.calls).toEqual([]);
  });

  it('is single use, even when the request that spent it was refused', async () => {
    const h = harness();
    const token = mintConfirmationToken(GARAGE_OPEN);
    h.setConnected(false);
    expect(h.gateway.request(GARAGE_OPEN, { confirmation: token }).error?.code).toBe('disconnected');
    h.setConnected(true);
    expect(h.gateway.request(GARAGE_OPEN, { confirmation: token }).error?.code).toBe('confirmation-required');
    expect(h.port.calls).toEqual([]);
    const fresh = mintConfirmationToken(GARAGE_OPEN);
    expect(h.gateway.request(GARAGE_OPEN, { confirmation: fresh }).phase).toBe('pending');
    h.port.resolve();
    await flush();
    h.patch(IDS.garage, {}, 'open');
    vi.advanceTimersByTime(CONFIRMED_DISPLAY_MS);
    h.patch(IDS.garage, {}, 'closed');
    expect(h.gateway.request(GARAGE_OPEN, { confirmation: fresh }).error?.code).toBe('confirmation-required');
    expect(h.port.calls).toHaveLength(1);
  });

  it('a malformed request never gets a valid token', () => {
    const malformed = { kind: 'security.run', role: 'disarm' } as unknown as ActionRequest;
    expect(redeemConfirmationToken(mintConfirmationToken(malformed), malformed)).toBe(false);
    expect(redeemConfirmationToken(mintConfirmationToken(malformed), DISARM)).toBe(false);
  });

  /**
   * A Proxy that answers as Silence sound for its first `honestReads` trap calls and as Garage open after that,
   * modelling an object whose answers change between the token check and the pipeline.
   */
  function shapeShifter(honestReads: number): ActionRequest {
    let reads = 0;
    const silence: Record<string, unknown> = { kind: 'security.run', role: 'silence_sound' };
    const garage: Record<string, unknown> = { kind: 'garage.open' };
    const current = () => (reads++ < honestReads ? silence : garage);
    return new Proxy({ kind: 'security.run', role: 'silence_sound' } as Record<string, unknown>, {
      getPrototypeOf: () => (current(), Object.prototype),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_target, key) => {
        const answer = current();
        return Object.hasOwn(answer, key)
          ? { value: answer[key as string], writable: true, enumerable: true, configurable: true }
          : undefined;
      },
      get: (_target, key) => current()[key as string],
      has: (_target, key) => Object.hasOwn(current(), key),
    }) as unknown as ActionRequest;
  }

  it('a Silence sound token can never open the garage, however a Proxy changes its answers', () => {
    for (let honestReads = 0; honestReads <= 40; honestReads += 1) {
      const h = harness();
      const status = h.gateway.request(shapeShifter(honestReads), { confirmation: mintConfirmationToken(SILENCE) });
      const label = `answers change after ${honestReads} reads`;
      expect(
        h.port.calls.filter((call) => call.domain === 'cover'),
        label,
      ).toEqual([]);
      // Whatever the Proxy said, the gateway judged one copy read once: Silence sound runs its own script, a garage
      // open is refused for want of its own confirmation, and a copy that mixed both answers is malformed.
      const sent = h.port.calls.map((call) => call.target.entity_id);
      if (status.kind === 'security.run') expect(sent, label).toEqual([IDS.silence]);
      else if (status.kind === 'garage.open') expect(status.error?.code, label).toBe('confirmation-required');
      else expect([status.error?.code, sent], label).toEqual(['not-allowed', []]);
    }
  });
});

describe('an outcome observed while the call was pending (§4.7)', () => {
  it('confirms when the reply is then lost to a dropped connection', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.patch(IDS.kitchenLight, {}, 'on');
    expect(h.gateway.status(status.key)?.phase).toBe('pending');
    h.port.reject(3);
    await flush();
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'confirmed' });
    expect(h.gateway.status(status.key)?.error).toBeUndefined();
    expect(h.inflight.isBusy(e(IDS.kitchenLight), h.now())).toBe(false);
    expect(h.port.calls).toHaveLength(1);
  });

  it('confirms when the reply never arrives before the timeout', () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.patch(IDS.kitchenLight, {}, 'on');
    vi.advanceTimersByTime(ACTION_TIMEOUT_MS.light);
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'confirmed' });
    expect(h.port.calls).toHaveLength(1);
  });

  it('still reports any other rejection after an early observation', async () => {
    const h = harness();
    const status = h.gateway.request(KITCHEN_ON);
    h.patch(IDS.kitchenLight, {}, 'on');
    h.port.reject({ code: 'home_assistant_error', message: 'Bulb did not answer' });
    await flush();
    expect(h.gateway.status(status.key)).toMatchObject({ phase: 'failed', error: { code: 'device-error' } });
  });

  it('without an early observation a lost reply stays uncertain and a timeout too', async () => {
    const lost = harness();
    const first = lost.gateway.request(KITCHEN_ON);
    lost.port.reject(3);
    await flush();
    expect(lost.gateway.status(first.key)).toMatchObject({ phase: 'uncertain', error: { code: 'connection-lost' } });
    const slow = harness();
    const second = slow.gateway.request(KITCHEN_ON);
    vi.advanceTimersByTime(ACTION_TIMEOUT_MS.light);
    expect(slow.gateway.status(second.key)).toMatchObject({ phase: 'uncertain', error: { code: 'timeout' } });
  });
});
