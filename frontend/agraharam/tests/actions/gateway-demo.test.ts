/**
 * Demo isolation (§10.1): in demo mode the real gateway drives DemoHost's port, so observed-state confirmation runs
 * through the same pipeline while nothing touches the network. Targets are picked from the assembled demo config at
 * run time, because the section packages own the fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, ResolvedConfig } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { mintConfirmationToken } from '../../src/ha/actions/confirmation.ts';
import { createGateway } from '../../src/ha/actions/gateway.ts';
import { createInflightRegistry } from '../../src/ha/actions/inflight.ts';
import type { ActionGateway, ActionRequest } from '../../src/ha/actions/types.ts';
import type { ServiceCall, ServicePort } from '../../src/ha/host.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { DemoHost } from '../../src/demo/demo-host.ts';
import type { DemoScenarioId } from '../../src/config/schema.ts';

interface DemoWorld {
  readonly host: DemoHost;
  readonly config: ResolvedConfig;
  readonly gateway: ActionGateway;
  readonly calls: ServiceCall[];
}

const networkSpies = { fetch: vi.fn(), WebSocket: vi.fn(), XMLHttpRequest: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', networkSpies.fetch);
  vi.stubGlobal('WebSocket', networkSpies.WebSocket);
  vi.stubGlobal('XMLHttpRequest', networkSpies.XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const spy of Object.values(networkSpies)) spy.mockReset();
});

function demoWorld(scenario: DemoScenarioId): DemoWorld {
  const host = new DemoHost(scenario, { latencyMs: [0, 0], random: () => 0, now: () => Date.now() });
  const validation = validateConfig(demoCardInput(scenario));
  if (!validation.ok) throw new Error('demo config invalid');
  const calls: ServiceCall[] = [];
  const port: ServicePort = {
    invoke: (call) => {
      calls.push(call);
      return host.port.invoke(call);
    },
  };
  const gateway = createGateway({
    port,
    reader: host.reader,
    config: validation.config,
    isPreview: () => false,
    now: () => Date.now(),
    inflight: createInflightRegistry(),
  });
  return { host, config: validation.config, gateway, calls };
}

/** The first room light whose state allows a plain toggle, as the matching request. */
function lightToggle(world: DemoWorld): ActionRequest | undefined {
  for (const room of world.config.rooms) {
    for (const light of room.lights) {
      const state = world.host.reader.store.get(light)?.state;
      const req: ActionRequest | undefined =
        state === 'on'
          ? { kind: 'light.turn_off', entity: light }
          : state === 'off'
            ? { kind: 'light.turn_on', entity: light }
            : undefined;
      if (req !== undefined && world.gateway.evaluate(req).enabled) return req;
    }
  }
  return undefined;
}

function expectNoNetwork(): void {
  expect(networkSpies.fetch).not.toHaveBeenCalled();
  expect(networkSpies.WebSocket).not.toHaveBeenCalled();
  expect(networkSpies.XMLHttpRequest).not.toHaveBeenCalled();
}

describe('the real gateway over DemoHost', () => {
  it('runs controls (the demo config has controls on) and confirms a light from simulated state', async () => {
    const world = demoWorld('normal');
    expect(world.config.controls).toBe(true);
    const req = lightToggle(world);
    if (req === undefined) throw new Error('the normal scenario has no toggleable light');
    const status = world.gateway.request(req);
    expect(status.phase).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(world.gateway.status(status.key)?.phase).toBe('confirmed');
    expect(world.calls).toHaveLength(1);
    expectNoNetwork();
    world.gateway.dispose();
    world.host.dispose();
  });

  it('moves the demo garage only with a confirmation token, through its progress state', async () => {
    const world = demoWorld('normal');
    const cover = world.config.garage?.cover;
    if (cover === undefined) throw new Error('the normal scenario has no garage');
    const state = world.host.reader.store.get(cover)?.state;
    const req: ActionRequest = state === 'open' ? { kind: 'garage.close' } : { kind: 'garage.open' };
    expect(world.gateway.evaluate(req)).toEqual({ enabled: true, confirm: true });
    expect(world.gateway.request(req).error?.code).toBe('confirmation-required');
    expect(world.calls).toEqual([]);
    const phases: string[] = [];
    world.gateway.subscribe('garage', (ticket) => phases.push(ticket.progress ?? ticket.phase));
    world.gateway.request(req, { confirmation: mintConfirmationToken(req) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(phases.slice(0, 4)).toEqual(['pending', 'sent', 'moving', 'confirmed']);
    expect(world.calls).toEqual([
      {
        domain: 'cover',
        service: req.kind === 'garage.open' ? 'open_cover' : 'close_cover',
        data: {},
        target: { entity_id: cover },
      },
    ]);
    expectNoNetwork();
    world.host.dispose();
  });

  it('restricted: the first rejected tap is permission-denied and the control then stays disabled', async () => {
    const world = demoWorld('restricted');
    const req = lightToggle(world);
    if (req === undefined) throw new Error('the restricted scenario has no toggleable light');
    const status = world.gateway.request(req);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(world.gateway.status(status.key)?.error?.code).toBe('permission-denied');
    expect(world.gateway.evaluate(req)).toMatchObject({ enabled: false, reason: 'permission-denied' });
    expect(world.calls).toHaveLength(1);
    world.host.dispose();
  });

  it('offline: every action is paused and nothing reaches the port', () => {
    const world = demoWorld('offline');
    const light = world.config.rooms[0]?.lights[0];
    if (light === undefined) throw new Error('the offline scenario has no light');
    const req: ActionRequest = { kind: 'light.turn_on', entity: light as EntityId };
    expect(world.gateway.evaluate(req)).toMatchObject({ enabled: false, reason: 'disconnected' });
    expect(world.gateway.request(req).error?.code).toBe('disconnected');
    expect(world.calls).toEqual([]);
    world.host.dispose();
  });

  it('a dropped demo connection moves the epoch, so drafts and dialogs started before it are not sent', () => {
    const world = demoWorld('normal');
    const req = lightToggle(world);
    if (req === undefined) throw new Error('the normal scenario has no toggleable light');
    const epoch = world.gateway.epoch();
    world.host.setConnected(false);
    world.host.setConnected(true);
    expect(world.gateway.epoch()).toBe(epoch + 1);
    expect(world.gateway.request(req, { epoch }).error?.code).toBe('not-sent');
    expect(world.calls).toEqual([]);
    world.host.dispose();
  });
});
