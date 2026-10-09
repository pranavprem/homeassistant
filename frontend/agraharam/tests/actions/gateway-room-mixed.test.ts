/**
 * Rooms with lighting switches through the REAL gateway (§18, design §5): one gesture is one ticket with one call per
 * domain (lights first, then switches), the outcome is the aggregate of both calls (§5.2), locks and sticky denials
 * cover every target, settings switches are left out (step 5b.2), and until Home Assistant has delivered its entity
 * registry no switch is switched and a room with switches is refused whole (step 5b.1, the registry-pending gate).
 * Light-only rooms keep exactly today's call. Every ID is fictional (`*.demo_*`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { mintConfirmationToken } from '../../src/ha/actions/confirmation.ts';
import { REGISTRY_PENDING_COPY, SETTINGS_SWITCH_COPY } from '../../src/ha/actions/messages.ts';
import { ACTION_TIMEOUT_MS, type ActionRequest, type Availability } from '../../src/ha/actions/types.ts';
import { COVER_FEATURE } from '../../src/ha/features.ts';
import { BASE_INPUT, configFrom, flush, harness, IDS, ROOM, type Harness } from './harness.ts';

const e = (id: string): EntityId => id as EntityId;
const STUDY_ON: ActionRequest = { kind: 'room.lights_on', room: ROOM.study };
const STUDY_OFF: ActionRequest = { kind: 'room.lights_off', room: ROOM.study };
const KITCHEN_ON: ActionRequest = { kind: 'room.lights_on', room: ROOM.kitchen };
const DESK_ON: ActionRequest = { kind: 'switch.turn_on', entity: e(IDS.deskLamp) };
const FLOOR_ON: ActionRequest = { kind: 'switch.turn_on', entity: e(IDS.floorLamp) };
const STUDY_LIGHT_ON: ActionRequest = { kind: 'light.turn_on', entity: e(IDS.studyLight) };
const ROOM_TIMEOUT_MS = ACTION_TIMEOUT_MS.room;
const STUDY_TARGETS = [IDS.studyLight, IDS.deskLamp, IDS.floorLamp];
/** An entity-ID-shaped substring, which no user-facing message may contain. */
const ENTITY_ID_SHAPE = /\b[a-z_]+\.[a-z0-9_]+\b/;

const LIGHT_CALL = (service: 'turn_on' | 'turn_off') => ({
  domain: 'light',
  service,
  data: {},
  target: { entity_id: [IDS.studyLight] },
});
const SWITCH_CALL = (service: 'turn_on' | 'turn_off', ids: readonly string[] = [IDS.deskLamp, IDS.floorLamp]) => ({
  domain: 'switch',
  service,
  data: {},
  target: { entity_id: ids },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function disabled(availability: Availability): Extract<Availability, { enabled: false }> {
  if (availability.enabled) throw new Error(`expected a disabled availability, got ${JSON.stringify(availability)}`);
  return availability;
}

/** Every Study target on (or off), as the observation needs. */
function setStudy(h: Harness, state: 'on' | 'off'): void {
  for (const id of STUDY_TARGETS) h.patch(id, {}, state);
}

describe('one gesture, one ticket, one call per domain (§5.1 plan)', () => {
  it('a mixed room sends the light call, then the switch call, in one task, under one room ticket', () => {
    const h = harness();
    expect(h.gateway.evaluate(STUDY_ON)).toEqual({ enabled: true, confirm: false });
    const status = h.gateway.request(STUDY_ON);
    expect(status).toMatchObject({ key: `room:${ROOM.study}`, kind: 'room.lights_on', phase: 'pending' });
    expect(h.port.calls).toEqual([LIGHT_CALL('turn_on'), SWITCH_CALL('turn_on')]);
    // Exactly one ticket was opened: a second tap is busy and sends nothing more.
    expect(h.gateway.request(STUDY_ON).error?.code).toBe('busy');
    expect(h.port.calls).toHaveLength(2);
  });

  it('All off sets every lighting item off, including a light that is already off (a coherent desired state)', () => {
    const h = harness({ states: { [IDS.deskLamp]: ['on', { friendly_name: 'Desk lamp' }] } });
    h.gateway.request(STUDY_OFF);
    expect(h.port.calls).toEqual([LIGHT_CALL('turn_off'), SWITCH_CALL('turn_off')]);
  });

  it('a switch-only room sends one call in the switch domain', () => {
    const input = { ...BASE_INPUT, rooms: [{ name: 'Loft', switches: [IDS.deskLamp, IDS.floorLamp] }] };
    const h = harness({ input });
    h.gateway.request({ kind: 'room.lights_on', room: 0 });
    expect(h.port.calls).toEqual([SWITCH_CALL('turn_on')]);
  });

  it('a light-only room sends exactly the cf0c182 call (deep-equal literal, frozen target)', () => {
    const h = harness();
    h.gateway.request(KITCHEN_ON);
    expect(h.port.calls).toEqual([
      { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: [IDS.kitchenLight, IDS.kitchenStrip] } },
    ]);
    expect(Object.isFrozen(h.port.calls[0]?.target.entity_id)).toBe(true);
  });

  it('leaves unknown and unavailable switches out, and keeps the rest of the room', () => {
    const h = harness({
      states: {
        [IDS.deskLamp]: ['unknown', { friendly_name: 'Desk lamp' }],
        [IDS.floorLamp]: ['unavailable', { friendly_name: 'Floor lamp' }],
      },
    });
    h.gateway.request(STUDY_ON);
    expect(h.port.calls).toEqual([LIGHT_CALL('turn_on')]);
  });

  it('with only switches available, sends only the switch call', () => {
    const h = harness({ states: { [IDS.studyLight]: ['unavailable', { friendly_name: 'Study ceiling' }] } });
    h.gateway.request(STUDY_ON);
    expect(h.port.calls).toEqual([SWITCH_CALL('turn_on')]);
  });

  it('All on is not applicable once every light AND switch is on; one switch off is enough to offer it', () => {
    const h = harness();
    setStudy(h, 'on');
    expect(h.gateway.evaluate(STUDY_ON)).toEqual({
      enabled: false,
      reason: 'not-applicable',
      message: 'All lights are already on',
    });
    h.patch(IDS.floorLamp, {}, 'off');
    expect(h.gateway.evaluate(STUDY_ON)).toEqual({ enabled: true, confirm: false });
    // All off applies while anything is on, the switches included.
    setStudy(h, 'off');
    h.patch(IDS.deskLamp, {}, 'on');
    expect(h.gateway.evaluate(STUDY_OFF).enabled).toBe(true);
    h.patch(IDS.deskLamp, {}, 'off');
    expect(disabled(h.gateway.evaluate(STUDY_OFF)).message).toBe('All lights are already off');
  });

  it('a missing switch service refuses the whole request (no half-done room), and sends nothing', () => {
    const h = harness();
    h.missingServices.add('switch.turn_on');
    expect(disabled(h.gateway.evaluate(STUDY_ON)).reason).toBe('service-missing');
    expect(h.gateway.request(STUDY_ON).error?.code).toBe('service-missing');
    expect(h.port.calls).toEqual([]);
    // The light-only Kitchen does not need the switch service.
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
  });
});

describe('the aggregate outcome through the gateway (§5.2)', () => {
  it('both calls resolve: sent until every target of both calls is observed, then confirmed', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    h.port.resolve('demo-light-call');
    await flush();
    expect(h.gateway.status(key)?.phase).toBe('pending');
    h.port.resolve('demo-switch-call');
    await flush();
    expect(h.gateway.status(key)?.phase).toBe('sent');
    h.patch(IDS.studyLight, {}, 'on');
    h.patch(IDS.deskLamp, {}, 'on');
    expect(h.gateway.status(key)?.phase).toBe('sent');
    h.patch(IDS.floorLamp, {}, 'on');
    expect(h.gateway.status(key)?.phase).toBe('confirmed');
    expect(h.port.calls).toHaveLength(2);
  });

  it('the light call resolves and the switch call is refused: partial, uncertain, never "Nothing changed"', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    h.port.resolve();
    h.port.reject({ code: 'service_validation_error', message: 'Plug is offline.' });
    await flush();
    const status = h.gateway.status(key);
    expect(status).toMatchObject({ phase: 'uncertain', partial: true, error: { code: 'rejected' } });
    expect(status?.error?.message).toBe(
      "Some of the Study lights may have switched, but Home Assistant didn't accept the rest (Plug is offline). Check the room before trying again.",
    );
    expect(status?.error?.message).not.toMatch(/nothing/i);
    expect(status?.error?.message).not.toMatch(ENTITY_ID_SHAPE);
    expect(h.port.calls).toHaveLength(2);
  });

  it('both calls refused: failed with the standard copy, not partial', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    h.port.reject({ code: 'service_validation_error', message: 'Bridge is offline.' });
    h.port.reject({ code: 'service_validation_error', message: 'Plug is offline.' });
    await flush();
    const status = h.gateway.status(key);
    expect(status).toMatchObject({ phase: 'failed', error: { code: 'rejected' } });
    expect(status?.partial).toBeUndefined();
    expect(status?.error?.message.startsWith("Home Assistant didn't accept the request")).toBe(true);
    // A failed request releases its lock at once.
    for (const id of STUDY_TARGETS) expect(h.inflight.isBusy(e(id), h.now()), id).toBe(false);
  });

  it('a lost connection after the outcome was observed while pending: confirmed', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    setStudy(h, 'on');
    expect(h.gateway.status(key)?.phase).toBe('pending');
    h.port.resolve();
    h.port.reject(3);
    await flush();
    expect(h.gateway.status(key)).toMatchObject({ phase: 'confirmed' });
    expect(h.gateway.status(key)?.error).toBeUndefined();
  });

  it('a lost connection on one call, not observed: uncertain(connection-lost), standard copy, not partial', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    h.port.resolve();
    h.port.reject({ error: { code: 3 } });
    await flush();
    const status = h.gateway.status(key);
    expect(status).toMatchObject({ phase: 'uncertain', error: { code: 'connection-lost' } });
    expect(status?.partial).toBeUndefined();
  });

  it('neither call left the browser (PortNotSent on both): failed(disconnected), truthfully "Nothing was changed"', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    h.port.reject({ portError: 'not-sent', reason: 'disconnected' });
    h.port.reject({ portError: 'not-sent', reason: 'disconnected' });
    await flush();
    expect(h.gateway.status(key)?.error).toEqual({
      code: 'disconnected',
      message: 'Not sent: Home Assistant was disconnected. Nothing was changed.',
    });
    for (const id of STUDY_TARGETS) expect(h.inflight.isBusy(e(id), h.now()), id).toBe(false);
  });

  it('no outcome by the 15 s room timeout: uncertain(timeout), never retried', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    h.port.resolve();
    h.port.resolve();
    await flush();
    vi.advanceTimersByTime(ROOM_TIMEOUT_MS - 1);
    expect(h.gateway.status(key)?.phase).toBe('sent');
    vi.advanceTimersByTime(1);
    expect(h.gateway.status(key)).toMatchObject({ phase: 'uncertain', error: { code: 'timeout' } });
    vi.advanceTimersByTime(10 * ROOM_TIMEOUT_MS);
    expect(h.port.calls).toHaveLength(2);
  });

  it('a call that never answers keeps the ticket pending, then settles partial at the room timeout', async () => {
    const h = harness();
    const { key } = h.gateway.request(STUDY_ON);
    // The light call is refused; the switch call never answers, so it may still have executed.
    h.port.reject({ code: 'service_validation_error', message: 'Bridge is offline.' });
    await flush();
    expect(h.gateway.status(key)?.phase).toBe('pending');
    vi.advanceTimersByTime(ROOM_TIMEOUT_MS - 1);
    expect(h.gateway.status(key)?.phase).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(h.gateway.status(key)).toMatchObject({ phase: 'uncertain', partial: true, error: { code: 'rejected' } });
    expect(h.gateway.status(key)?.error?.message).not.toMatch(/nothing/i);
  });
});

describe('locks and sticky denial cover every target (§5.2)', () => {
  it('after a partial outcome every target stays locked until the 15 s room timeout, then is offered again', async () => {
    const h = harness();
    h.gateway.request(STUDY_ON);
    h.port.resolve();
    h.port.reject({ code: 'service_validation_error', message: 'Plug is offline.' });
    await flush();
    expect(disabled(h.gateway.evaluate(STUDY_ON)).reason).toBe('busy');
    expect(disabled(h.gateway.evaluate(DESK_ON)).reason).toBe('busy');
    expect(disabled(h.gateway.evaluate(STUDY_LIGHT_ON)).reason).toBe('busy');
    // A second gateway (a rebuilt card) sees the same in-flight targets.
    expect(disabled(h.newGateway().evaluate(FLOOR_ON)).reason).toBe('busy');
    vi.advanceTimersByTime(ROOM_TIMEOUT_MS);
    expect(h.gateway.evaluate(STUDY_ON).enabled).toBe(true);
    expect(h.gateway.evaluate(DESK_ON).enabled).toBe(true);
    expect(h.port.calls).toHaveLength(2);
  });

  it('a single switch in flight makes its room busy, and the room makes its switches busy', () => {
    const h = harness();
    h.gateway.request(DESK_ON);
    expect(disabled(h.gateway.evaluate(STUDY_ON)).reason).toBe('busy');
    const other = harness();
    other.gateway.request(STUDY_ON);
    expect(disabled(other.gateway.evaluate(FLOOR_ON)).reason).toBe('busy');
  });

  it("a permission refusal on the switch call blocks the room action, but not the room's single lights or switches", async () => {
    const h = harness();
    h.gateway.request(STUDY_ON);
    h.port.resolve();
    h.port.reject({ code: 'home_assistant_error', message: 'Unauthorized' });
    await flush();
    expect(h.gateway.status(`room:${ROOM.study}`)).toMatchObject({
      phase: 'uncertain',
      partial: true,
      error: {
        code: 'permission-denied',
        message:
          "Some of the Study lights may have switched, but your Home Assistant user can't control the rest. Check the room before trying again.",
      },
    });
    vi.advanceTimersByTime(ROOM_TIMEOUT_MS);
    expect(disabled(h.gateway.evaluate(STUDY_ON)).reason).toBe('permission-denied');
    // All off is denied too once it applies (the precondition, step 7, is checked before the denial, step 12).
    h.patch(IDS.deskLamp, {}, 'on');
    expect(disabled(h.gateway.evaluate(STUDY_OFF)).reason).toBe('permission-denied');
    expect(h.gateway.evaluate(STUDY_LIGHT_ON).enabled).toBe(true);
    expect(h.gateway.evaluate({ kind: 'switch.turn_off', entity: e(IDS.deskLamp) }).enabled).toBe(true);
    expect(h.gateway.evaluate(FLOOR_ON).enabled).toBe(true);
    expect(h.gateway.evaluate(KITCHEN_ON).enabled).toBe(true);
    h.changeUser();
    expect(h.gateway.evaluate(STUDY_ON).enabled).toBe(true);
  });
});

describe('settings switches (step 5b.2, entity_category backstop)', () => {
  function withSettingsSwitch(): Harness {
    const h = harness();
    h.registry.set(IDS.floorLamp, { entity_id: IDS.floorLamp, entity_category: 'config' });
    return h;
  }

  it('refuses a single switch kind on a config or diagnostic switch, with the settings copy', () => {
    for (const category of ['config', 'diagnostic'] as const) {
      const h = harness();
      h.registry.set(IDS.floorLamp, { entity_id: IDS.floorLamp, entity_category: category });
      expect(h.gateway.evaluate(FLOOR_ON)).toEqual({
        enabled: false,
        reason: 'not-allowed',
        message: SETTINGS_SWITCH_COPY,
      });
      expect(h.gateway.request(FLOOR_ON).error?.code).toBe('not-allowed');
      expect(h.port.calls).toEqual([]);
    }
  });

  it('leaves a settings switch out of the room target and keeps the rest', () => {
    const h = withSettingsSwitch();
    h.gateway.request(STUDY_ON);
    expect(h.port.calls).toEqual([LIGHT_CALL('turn_on'), SWITCH_CALL('turn_on', [IDS.deskLamp])]);
  });

  it('refuses a room whose every switch is a settings switch and has no light, with the settings copy', () => {
    const input = { ...BASE_INPUT, rooms: [{ name: 'Loft', switches: [IDS.floorLamp] }] };
    const h = harness({ input });
    h.registry.set(IDS.floorLamp, { entity_id: IDS.floorLamp, entity_category: 'diagnostic' });
    expect(h.gateway.evaluate({ kind: 'room.lights_on', room: 0 })).toEqual({
      enabled: false,
      reason: 'not-allowed',
      message: SETTINGS_SWITCH_COPY,
    });
    expect(h.port.calls).toEqual([]);
  });

  it('allows a switch with no registry entry once the registry has loaded (a YAML switch), and a null category', () => {
    const h = harness();
    h.registry.set(IDS.deskLamp, { entity_id: IDS.deskLamp, entity_category: null });
    expect(h.gateway.evaluate(DESK_ON).enabled).toBe(true);
    expect(h.gateway.evaluate(FLOOR_ON).enabled).toBe(true);
  });
});

describe('the registry-pending gate (step 5b.1, review B1)', () => {
  function pending(): Harness {
    const h = harness();
    h.registryLoaded = false;
    return h;
  }

  it('refuses a single switch with the visible registry copy, and sends nothing', () => {
    const h = pending();
    expect(h.gateway.evaluate(DESK_ON)).toEqual({
      enabled: false,
      reason: 'state-unknown',
      message: "Waiting for Home Assistant's device list before switching Desk lamp.",
    });
    expect(h.gateway.evaluate({ kind: 'switch.turn_off', entity: e(IDS.floorLamp) })).toMatchObject({
      enabled: false,
      reason: 'state-unknown',
    });
    expect(h.gateway.request(DESK_ON).error?.code).toBe('state-unknown');
    expect(h.port.calls).toEqual([]);
  });

  it('refuses a room with any switch, whatever the switch states, and never drops the switches', () => {
    for (const switchState of ['on', 'off', 'unavailable', 'unknown']) {
      const h = pending();
      h.patch(IDS.deskLamp, {}, switchState);
      h.patch(IDS.floorLamp, {}, switchState);
      for (const req of [STUDY_ON, STUDY_OFF]) {
        expect(h.gateway.evaluate(req), `${req.kind} with switches ${switchState}`).toEqual({
          enabled: false,
          reason: 'state-unknown',
          message: REGISTRY_PENDING_COPY.control('the Study lights'),
        });
        expect(h.gateway.request(req).error?.code).toBe('state-unknown');
      }
      expect(h.port.calls).toEqual([]);
    }
    expect(REGISTRY_PENDING_COPY.control('the Study lights')).toBe(
      "Waiting for Home Assistant's device list before switching the Study lights.",
    );
  });

  it('leaves light-only rooms and every other kind fully usable (exactly one call each)', async () => {
    const usable: readonly [ActionRequest, boolean][] = [
      [KITCHEN_ON, false],
      [STUDY_LIGHT_ON, false],
      [{ kind: 'curtain.open', entity: e(IDS.blind) }, false],
      [{ kind: 'fan.turn_on', entity: e(IDS.roomPurifier) }, false],
      [{ kind: 'shortcut.run', role: 'lights_toggle' }, true],
    ];
    for (const [req, confirm] of usable) {
      const h = pending();
      expect(h.gateway.evaluate(req), req.kind).toEqual({ enabled: true, confirm });
      h.gateway.request(req, confirm ? { confirmation: mintConfirmationToken(req) } : undefined);
      await flush();
      expect(h.port.calls, req.kind).toHaveLength(1);
      expect(h.port.calls[0]?.domain, req.kind).not.toBe('switch');
    }
  });

  it('never clears on its own: an hour later with no registry, still refused with the same reason', () => {
    const h = pending();
    vi.advanceTimersByTime(60 * 60 * 1000);
    h.setConnected(false);
    h.setConnected(true);
    expect(disabled(h.gateway.evaluate(DESK_ON)).message).toBe(REGISTRY_PENDING_COPY.control('Desk lamp'));
    expect(disabled(h.gateway.evaluate(STUDY_ON)).reason).toBe('state-unknown');
    expect(h.port.calls).toEqual([]);
  });

  it('clears at the first registry delivery; a settings switch is then refused as a settings switch', () => {
    const h = pending();
    h.registry.set(IDS.floorLamp, { entity_id: IDS.floorLamp, entity_category: 'config' });
    // Not loaded yet: the entry cannot be read, so even the settings switch reads as waiting, never as allowed.
    expect(disabled(h.gateway.evaluate(FLOOR_ON)).reason).toBe('state-unknown');
    h.registryLoaded = true;
    expect(h.gateway.evaluate(DESK_ON)).toEqual({ enabled: true, confirm: false });
    expect(h.gateway.evaluate(FLOOR_ON)).toEqual({
      enabled: false,
      reason: 'not-allowed',
      message: SETTINGS_SWITCH_COPY,
    });
    h.gateway.request(STUDY_ON);
    expect(h.port.calls).toEqual([LIGHT_CALL('turn_on'), SWITCH_CALL('turn_on', [IDS.deskLamp])]);
  });
});

describe('readings can never be controlled (collection role, §18 D1)', () => {
  const READING_SWITCH = 'switch.demo_aquarium_pump';
  const DISPLAY_ONLY_LUMINAIRE = 'light.demo_porch_lantern';
  const READING_COVER = 'cover.demo_skylight';
  const READING_FAN = 'fan.demo_attic_fan';

  function readingsHarness(): Harness {
    const input = {
      ...BASE_INPUT,
      collections: [
        {
          name: 'Readings',
          entities: [READING_SWITCH, DISPLAY_ONLY_LUMINAIRE, READING_COVER, READING_FAN, IDS.vacuum, IDS.deskLamp],
        },
      ],
    };
    return harness({
      input,
      states: {
        [READING_SWITCH]: ['off', { friendly_name: 'Aquarium pump' }],
        [DISPLAY_ONLY_LUMINAIRE]: ['off', { supported_color_modes: ['brightness'] }],
        [READING_COVER]: ['closed', { supported_features: COVER_FEATURE.OPEN | COVER_FEATURE.CLOSE }],
        [READING_FAN]: ['off', { supported_features: 0xff }],
      },
    });
  }

  it('every kind that names a reading-only entity is not-allowed, with controls on', () => {
    const h = readingsHarness();
    expect(h.config.controls).toBe(true);
    const requests: ActionRequest[] = [
      { kind: 'switch.turn_on', entity: e(READING_SWITCH) },
      { kind: 'switch.turn_off', entity: e(READING_SWITCH) },
      { kind: 'light.turn_on', entity: e(DISPLAY_ONLY_LUMINAIRE) },
      { kind: 'light.set_brightness', entity: e(DISPLAY_ONLY_LUMINAIRE), pct: 50 },
      { kind: 'curtain.open', entity: e(READING_COVER) },
      { kind: 'fan.turn_on', entity: e(READING_FAN) },
    ];
    for (const req of requests) {
      expect(disabled(h.gateway.evaluate(req)).reason, req.kind).toBe('not-allowed');
      expect(h.gateway.request(req).error?.code, req.kind).toBe('not-allowed');
    }
    expect(h.port.calls).toEqual([]);
  });

  it('an entity that is a vacuum and a reading stays controllable only through the vacuum kinds', async () => {
    const h = readingsHarness();
    expect(h.config.bindings.get(e(IDS.vacuum))).toEqual(['vacuum', 'collection']);
    h.gateway.request({ kind: 'vacuum.start', entity: e(IDS.vacuum) });
    await flush();
    expect(h.port.calls).toEqual([{ domain: 'vacuum', service: 'start', data: {}, target: { entity_id: IDS.vacuum } }]);
    expect(disabled(h.gateway.evaluate({ kind: 'switch.turn_on', entity: e(IDS.vacuum) })).reason).toBe('not-allowed');
  });

  it('a room switch that is also a reading keeps exactly its room switch controls', () => {
    const h = readingsHarness();
    expect(h.config.bindings.get(e(IDS.deskLamp))).toEqual(['room_switch', 'collection']);
    expect(h.gateway.evaluate(DESK_ON).enabled).toBe(true);
    expect(disabled(h.gateway.evaluate({ kind: 'light.turn_on', entity: e(IDS.deskLamp) })).reason).toBe('not-allowed');
  });

  it('a hand-built config that gives a reading an actionable-looking role list still cannot act', () => {
    const valid = configFrom(BASE_INPUT);
    const bindings = new Map(valid.bindings);
    bindings.set(e(READING_SWITCH), ['collection']);
    const h = harness({
      config: { ...valid, bindings },
      states: { [READING_SWITCH]: ['off', { friendly_name: 'Aquarium pump' }] },
    });
    expect(disabled(h.gateway.evaluate({ kind: 'switch.turn_on', entity: e(READING_SWITCH) })).reason).toBe(
      'not-allowed',
    );
    expect(h.port.calls).toEqual([]);
  });
});
