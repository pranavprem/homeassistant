/**
 * Ticket selection by id (§7.2): Home's ImmediateTickets and the shared newerStatus pick the newer of the gateway's
 * ticket and a failure request() returned at once, by ticket id alone (start times can tie or run backwards).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { ImmediateTickets } from '../../src/components/home/home-actions.ts';
import { newerStatus, type ActionStatus } from '../../src/ha/actions/types.ts';

const KEY = 'entity:light.demo_lamp' as const;

function status(id: number, phase: ActionStatus['phase'], startedAt: number): ActionStatus {
  return { id, key: KEY, kind: 'light.turn_on', phase, startedAt };
}

function host(): ReactiveControllerHost {
  return {
    addController: (_controller: ReactiveController) => undefined,
    removeController: () => undefined,
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
}

describe('newerStatus', () => {
  it('returns the one present, or the higher id of two', () => {
    const older = status(3, 'failed', 50);
    const newer = status(4, 'pending', 10);
    expect(newerStatus(undefined, undefined)).toBeUndefined();
    expect(newerStatus(older, undefined)).toBe(older);
    expect(newerStatus(undefined, newer)).toBe(newer);
    expect(newerStatus(older, newer)).toBe(newer);
    expect(newerStatus(newer, older)).toBe(newer);
  });
});

describe('ImmediateTickets.current', () => {
  it('picks the newer ticket by id even when its start time is earlier', () => {
    const tickets = new ImmediateTickets(host());
    const immediate = status(7, 'failed', 900);
    tickets.record(immediate);
    expect(tickets.current(KEY, status(6, 'confirmed', 1000))).toBe(immediate);
    const newer = status(8, 'pending', 800);
    expect(tickets.current(KEY, newer)).toBe(newer);
  });

  it('forgets a dismissed immediate failure', () => {
    const tickets = new ImmediateTickets(host());
    tickets.record(status(2, 'failed', 0));
    tickets.forget(KEY);
    expect(tickets.current(KEY, undefined)).toBeUndefined();
  });
});
