/**
 * Whole-house shortcuts through the REAL gateway (§18, design §4.2 and §5): `shortcut.run` runs only the script the
 * configuration binds to the role, through script.turn_on with no data, and only with a confirmation token minted for
 * exactly that request (a floor no configuration can lower). The two roles are independent tickets, they never share
 * the security lock, and every existing gate applies. Every ID is fictional (`*.demo_*`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, ShortcutRole } from '../../src/config/schema.ts';
import { mintConfirmationToken } from '../../src/ha/actions/confirmation.ts';
import { ACTION_TIMEOUT_MS, type ActionRequest, type RequestOptions } from '../../src/ha/actions/types.ts';
import { BASE_INPUT, configFrom, flush, harness, IDS } from './harness.ts';

const e = (id: string): EntityId => id as EntityId;
const LIGHTS: ActionRequest = { kind: 'shortcut.run', role: 'lights_toggle' };
const CURTAINS: ActionRequest = { kind: 'shortcut.run', role: 'curtains_toggle' };
const HOLD_NIGHT: ActionRequest = { kind: 'security.run', role: 'hold_night' };
const confirmedFor = (req: ActionRequest): RequestOptions => ({ confirmation: mintConfirmationToken(req) });
const SCRIPT_FOR: Readonly<Record<ShortcutRole, string>> = {
  lights_toggle: IDS.lightsToggle,
  curtains_toggle: IDS.curtainsToggle,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shortcut.run sends exactly the configured script', () => {
  it.each(['lights_toggle', 'curtains_toggle'] as const)(
    '%s: always asks for confirmation, then one script.turn_on on its own script with no data',
    async (role) => {
      const h = harness();
      const req: ActionRequest = { kind: 'shortcut.run', role };
      expect(h.gateway.evaluate(req)).toEqual({ enabled: true, confirm: true });
      const status = h.gateway.request(req, confirmedFor(req));
      expect(status).toMatchObject({ key: `shortcut:${role}`, phase: 'pending' });
      await flush();
      expect(h.port.calls).toEqual([
        { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: SCRIPT_FOR[role] } },
      ]);
    },
  );

  it('the confirmation is a floor: still required with every state and every other gate open', () => {
    const h = harness();
    for (const req of [LIGHTS, CURTAINS]) {
      expect(h.gateway.evaluate(req)).toMatchObject({ confirm: true });
      expect(h.gateway.request(req).error?.code).toBe('confirmation-required');
    }
    expect(h.port.calls).toEqual([]);
  });

  it('refuses a look-alike, a plain flag, a spent token and a token minted for the other shortcut', async () => {
    const h = harness();
    const forged = { kind: 'confirmation-token', scope: 'shortcut:lights_toggle|{"kind":"shortcut.run"}' };
    for (const opts of [{ confirmed: true }, { confirmation: true }, { confirmation: forged }]) {
      expect(h.gateway.request(LIGHTS, opts as unknown as RequestOptions).error?.code).toBe('confirmation-required');
    }
    // A lights token cannot run the curtains script.
    expect(h.gateway.request(CURTAINS, confirmedFor(LIGHTS)).error?.code).toBe('confirmation-required');
    // A security token cannot run a shortcut, nor a shortcut token a security role.
    expect(h.gateway.request(LIGHTS, confirmedFor(HOLD_NIGHT)).error?.code).toBe('confirmation-required');
    expect(h.gateway.request(HOLD_NIGHT, confirmedFor(LIGHTS)).error?.code).toBe('confirmation-required');
    expect(h.port.calls).toEqual([]);

    const token = mintConfirmationToken(LIGHTS);
    expect(h.gateway.request(LIGHTS, { confirmation: token }).phase).toBe('pending');
    h.port.resolve();
    await flush();
    vi.advanceTimersByTime(ACTION_TIMEOUT_MS.shortcut);
    expect(h.gateway.request(LIGHTS, { confirmation: token }).error?.code).toBe('confirmation-required');
    expect(h.port.calls).toHaveLength(1);
  });

  it('a role the configuration does not bind is not-allowed, whatever token comes with it', () => {
    const input = { ...BASE_INPUT, shortcuts: { lights_toggle: IDS.lightsToggle } };
    const h = harness({ input });
    expect(h.gateway.evaluate(CURTAINS)).toMatchObject({ enabled: false, reason: 'not-allowed' });
    expect(h.gateway.request(CURTAINS, confirmedFor(CURTAINS)).error?.code).toBe('not-allowed');
    expect(h.gateway.evaluate(LIGHTS)).toEqual({ enabled: true, confirm: true });
    expect(h.port.calls).toEqual([]);
  });

  it('no shortcuts configured: both roles are not-allowed', () => {
    const { shortcuts: _shortcuts, ...withoutShortcuts } = BASE_INPUT;
    const h = harness({ input: withoutShortcuts });
    for (const req of [LIGHTS, CURTAINS]) {
      expect(h.gateway.evaluate(req)).toMatchObject({ enabled: false, reason: 'not-allowed' });
    }
  });

  it('a hand-built config binding one script to both roles (bypassing validation) runs neither', () => {
    const valid = configFrom(BASE_INPUT);
    const config = {
      ...valid,
      shortcuts: { lights_toggle: e(IDS.lightsToggle), curtains_toggle: e(IDS.lightsToggle) },
    };
    const h = harness({ config });
    for (const req of [LIGHTS, CURTAINS]) {
      expect(h.gateway.evaluate(req), req.kind).toMatchObject({ enabled: false, reason: 'not-allowed' });
      expect(h.gateway.request(req, confirmedFor(req)).error?.code).toBe('not-allowed');
    }
    expect(h.port.calls).toEqual([]);
  });

  it('a hand-built config pointing a shortcut at a security script runs nothing (the script holds two families)', () => {
    const valid = configFrom(BASE_INPUT);
    const bindings = new Map(valid.bindings);
    bindings.set(e(IDS.holdNight), ['security_action', 'house_shortcut']);
    const config = { ...valid, bindings, shortcuts: { ...valid.shortcuts, lights_toggle: e(IDS.holdNight) } };
    const h = harness({ config });
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'not-allowed' });
    expect(h.gateway.request(LIGHTS, confirmedFor(LIGHTS)).error?.code).toBe('not-allowed');
    expect(h.port.calls).toEqual([]);
  });

  it('a request never carries its own script, service or data', () => {
    const h = harness();
    const injected = {
      ...LIGHTS,
      entity: e(IDS.holdAway),
      data: { variables: { all: true } },
    } as unknown as ActionRequest;
    expect(h.gateway.request(injected, confirmedFor(LIGHTS)).error?.code).toBe('not-allowed');
    expect(h.port.calls).toEqual([]);
  });
});

describe('independent tickets', () => {
  it('lights and curtains are separate keys: one in flight does not block the other', async () => {
    const h = harness();
    h.gateway.request(LIGHTS, confirmedFor(LIGHTS));
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'busy' });
    expect(h.gateway.evaluate(CURTAINS)).toEqual({ enabled: true, confirm: true });
    h.gateway.request(CURTAINS, confirmedFor(CURTAINS));
    await flush();
    expect(h.port.calls.map((call) => call.target.entity_id)).toEqual([IDS.lightsToggle, IDS.curtainsToggle]);
  });

  it('a shortcut never shares the security lock, in either direction', () => {
    const h = harness();
    h.gateway.request(HOLD_NIGHT, confirmedFor(HOLD_NIGHT));
    expect(h.gateway.evaluate(LIGHTS)).toEqual({ enabled: true, confirm: true });
    h.gateway.request(LIGHTS, confirmedFor(LIGHTS));
    expect(h.gateway.status('security')?.phase).toBe('pending');
    expect(h.gateway.status('shortcut:lights_toggle')?.phase).toBe('pending');
    expect(h.port.calls).toHaveLength(2);
  });

  it('confirms only from the script reporting a new run, as "Requested", and never retries', async () => {
    const h = harness();
    const { key } = h.gateway.request(LIGHTS, confirmedFor(LIGHTS));
    h.port.resolve('demo-shortcut-call');
    await flush();
    expect(h.gateway.status(key)?.phase).toBe('sent');
    h.patch(IDS.lightsToggle, { last_triggered: '2026-09-30T17:22:00.000Z' });
    expect(h.gateway.status(key)?.phase).toBe('confirmed');
    vi.advanceTimersByTime(10 * ACTION_TIMEOUT_MS.shortcut);
    expect(h.port.calls).toHaveLength(1);
  });

  it('settles uncertain after 10 s when the script never reports, and keeps the copy free of entity IDs', async () => {
    const h = harness();
    const { key } = h.gateway.request(CURTAINS, confirmedFor(CURTAINS));
    h.port.resolve();
    await flush();
    vi.advanceTimersByTime(ACTION_TIMEOUT_MS.shortcut);
    const status = h.gateway.status(key);
    expect(status).toMatchObject({ phase: 'uncertain', error: { code: 'timeout' } });
    expect(status?.error?.message).not.toMatch(/\b[a-z_]+\.[a-z0-9_]+\b/);
  });
});

describe('every existing gate applies', () => {
  it('controls off, preview, disconnected and resyncing refuse with the shared reasons and send nothing', () => {
    const off = harness({ input: { ...BASE_INPUT, controls: false } });
    expect(off.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'controls-off' });
    expect(off.gateway.request(LIGHTS, confirmedFor(LIGHTS)).error?.code).toBe('controls-off');

    const preview = harness();
    preview.preview = true;
    expect(preview.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'preview' });

    const offline = harness();
    offline.setConnected(false);
    expect(offline.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'disconnected' });
    expect(offline.gateway.request(LIGHTS, confirmedFor(LIGHTS)).error?.code).toBe('disconnected');

    const resyncing = harness();
    resyncing.setConnected(false);
    resyncing.reconnectWithoutSnapshot();
    expect(resyncing.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'disconnected' });
    resyncing.deliverSnapshot();
    expect(resyncing.gateway.evaluate(LIGHTS)).toEqual({ enabled: true, confirm: true });

    for (const h of [off, preview, offline, resyncing]) expect(h.port.calls).toEqual([]);
  });

  it('an unavailable, unknown, missing or running script is refused with its own reason', () => {
    const h = harness();
    h.patch(IDS.lightsToggle, {}, 'unavailable');
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'unavailable' });
    h.patch(IDS.lightsToggle, {}, 'unknown');
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'state-unknown' });
    h.patch(IDS.lightsToggle, {}, 'on');
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({
      enabled: false,
      reason: 'not-applicable',
      message: 'Already running',
    });
    h.remove(IDS.lightsToggle);
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'missing-entity' });
    expect(h.port.calls).toEqual([]);
  });

  it('a stale gesture epoch is not sent', () => {
    const h = harness();
    const epoch = h.gateway.epoch();
    h.gateway.invalidate('preview');
    expect(h.gateway.request(LIGHTS, { ...confirmedFor(LIGHTS), epoch }).error?.code).toBe('not-sent');
    expect(h.port.calls).toEqual([]);
  });

  it('a permission refusal is sticky for that shortcut until the user changes, and leaves the other one usable', async () => {
    const h = harness();
    h.gateway.request(LIGHTS, confirmedFor(LIGHTS));
    h.port.reject({ code: 'unauthorized', message: 'Unauthorized' });
    await flush();
    expect(h.gateway.evaluate(LIGHTS)).toMatchObject({ enabled: false, reason: 'permission-denied' });
    expect(h.gateway.evaluate(CURTAINS)).toEqual({ enabled: true, confirm: true });
    h.changeUser();
    expect(h.gateway.evaluate(LIGHTS)).toEqual({ enabled: true, confirm: true });
  });

  it('is unaffected by the registry-pending gate (scripts are not switches)', () => {
    const h = harness();
    h.registryLoaded = false;
    expect(h.gateway.evaluate(LIGHTS)).toEqual({ enabled: true, confirm: true });
  });
});
