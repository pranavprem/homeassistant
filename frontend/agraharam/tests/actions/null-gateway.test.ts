import { describe, expect, it, vi } from 'vitest';
import { createNullGateway } from '../../src/ha/actions/null-gateway.ts';
import { actionKeyFor, type ActionRequest } from '../../src/ha/actions/types.ts';
import type { EntityId } from '../../src/config/schema.ts';

const LIGHT = 'light.demo_kitchen' as EntityId;
const TOGGLE: ActionRequest = { kind: 'light.turn_on', entity: LIGHT };

describe('createNullGateway', () => {
  it('disables every action with reason unsupported', () => {
    const gateway = createNullGateway();
    expect(gateway.evaluate(TOGGLE)).toMatchObject({ enabled: false, reason: 'unsupported' });
    expect(gateway.evaluate({ kind: 'garage.open' })).toMatchObject({
      enabled: false,
      reason: 'unsupported',
    });
  });

  it('fails requests at once without storing a ticket', () => {
    const gateway = createNullGateway();
    const status = gateway.request(TOGGLE);
    expect(status).toMatchObject({ key: actionKeyFor(TOGGLE), kind: 'light.turn_on', phase: 'failed' });
    expect(status.error?.code).toBe('unsupported');
    expect(gateway.status(status.key)).toBeUndefined();
    expect(gateway.recent()).toEqual([]);
  });

  it('reports not-sent for a stale gesture epoch', () => {
    const gateway = createNullGateway();
    const epoch = gateway.epoch();
    gateway.invalidate('preview');
    expect(gateway.epoch()).toBe(epoch + 1);
    expect(gateway.request(TOGGLE, { epoch }).error?.code).toBe('not-sent');
  });

  it('moves the epoch once on dispose and reports not-sent afterwards', () => {
    const gateway = createNullGateway();
    const onEpoch = vi.fn();
    gateway.onEpochChange(onEpoch);
    gateway.dispose();
    gateway.dispose();
    expect(gateway.disposed).toBe(true);
    expect(onEpoch).toHaveBeenCalledTimes(1);
    expect(onEpoch).toHaveBeenCalledWith(1);
    expect(gateway.request(TOGGLE).error?.code).toBe('not-sent');
  });
});

describe('actionKeyFor', () => {
  it('keys entity actions by target and shares one key per room, garage, security and studio monitors', () => {
    expect(actionKeyFor({ kind: 'climate.set_temperature', entity: LIGHT, temperature: 21 })).toBe(`entity:${LIGHT}`);
    expect(actionKeyFor({ kind: 'room.lights_off', room: 2 })).toBe('room:2');
    expect(actionKeyFor({ kind: 'garage.close' })).toBe('garage');
    expect(actionKeyFor({ kind: 'security.run', role: 'silence_sound' })).toBe('security');
    expect(actionKeyFor({ kind: 'security.run', role: 'disarm_hold' })).toBe('security');
    expect(actionKeyFor({ kind: 'studio_monitors.run' })).toBe('studio_monitors');
  });
});
