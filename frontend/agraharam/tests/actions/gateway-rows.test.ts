/**
 * §7.1, one table-driven block per catalog row (§12.1 row 5): the exact ServiceCall, the precondition, the
 * unknown-state rule, the capability, the arguments, the observation and the timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintConfirmationToken } from '../../src/ha/actions/confirmation.ts';
import type { ActionRequest, RequestOptions } from '../../src/ha/actions/types.ts';
import { flush, harness, type Harness } from './harness.ts';
import { ROW_ENTRIES, type Row } from './rows.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function rowHarness(row: Row): Harness {
  return harness({ states: row.ready ?? {} });
}

function send(h: Harness, row: Row, req: ActionRequest = row.req) {
  const opts: RequestOptions | undefined = row.confirm ? { confirmation: mintConfirmationToken(req) } : undefined;
  return h.gateway.request(req, opts);
}

function setStates(
  h: Harness,
  states: Readonly<Record<string, readonly [string, Readonly<Record<string, unknown>>?]>>,
) {
  for (const [id, [state, attributes]] of Object.entries(states)) h.patch(id, attributes ?? {}, state);
}

describe.each(ROW_ENTRIES)('%s', (kind, row) => {
  it('builds exactly one scoped ServiceCall from the catalog and the configuration', () => {
    const h = rowHarness(row);
    expect(h.gateway.evaluate(row.req)).toEqual({ enabled: true, confirm: row.confirm });
    const status = send(h, row);
    expect(status).toMatchObject({ kind, phase: 'pending' });
    expect(h.port.calls).toEqual([
      {
        domain: row.call.domain,
        service: row.call.service,
        data: row.call.data,
        target: { entity_id: row.call.entity_id },
      },
    ]);
  });

  it(row.confirm ? 'requires the confirm dialog' : 'needs no confirmation', () => {
    const h = rowHarness(row);
    const status = h.gateway.request(row.req);
    if (row.confirm) {
      expect(status.error?.code).toBe('confirmation-required');
      expect(h.port.calls).toHaveLength(0);
    } else {
      expect(status.phase).toBe('pending');
      expect(h.port.calls).toHaveLength(1);
    }
  });

  if (row.notApplicable !== undefined) {
    const notApplicable = row.notApplicable;
    it(`reports not-applicable: ${notApplicable.message}`, () => {
      const h = rowHarness(row);
      setStates(h, notApplicable.states);
      expect(h.gateway.evaluate(row.req)).toEqual({
        enabled: false,
        reason: 'not-applicable',
        message: notApplicable.message,
      });
      expect(send(h, row).error?.code).toBe('not-applicable');
      expect(h.port.calls).toHaveLength(0);
    });
  }

  it(`applies the unknown-state rule: ${row.unknown}`, () => {
    const h = rowHarness(row);
    for (const id of row.unknownTargets) h.patch(id, {}, 'unknown');
    const availability = h.gateway.evaluate(row.req);
    if (row.unknown === 'allow') {
      expect(availability).toEqual({ enabled: true, confirm: row.confirm });
    } else {
      expect(availability).toMatchObject({ enabled: false, reason: 'state-unknown' });
    }
  });

  if (row.withoutCapability !== undefined) {
    const { id, attributes } = row.withoutCapability;
    it('refuses a target without the capability', () => {
      const h = rowHarness(row);
      h.patch(id, attributes);
      expect(h.gateway.evaluate(row.req)).toMatchObject({ enabled: false, reason: 'unsupported' });
      expect(send(h, row).error?.code).toBe('unsupported');
      expect(h.port.calls).toHaveLength(0);
    });
  }

  if (row.badArguments !== undefined) {
    it.each(row.badArguments.map((req) => [JSON.stringify(req), req] as const))(
      'refuses invalid arguments %s',
      (_label, req) => {
        const h = rowHarness(row);
        expect(h.gateway.evaluate(req)).toMatchObject({ enabled: false, reason: 'invalid-argument' });
        expect(send(h, row, req).error?.code).toBe('invalid-argument');
        expect(h.port.calls).toHaveLength(0);
      },
    );
  }

  it('confirms only from observed state, after the call resolved', async () => {
    const h = rowHarness(row);
    const key = send(h, row).key;
    h.port.resolve();
    await flush();
    expect(h.gateway.status(key)?.phase).toBe('sent');
    if (row.progress !== undefined) {
      row.progress(h);
      expect(h.gateway.status(key)).toMatchObject({ phase: 'sent', progress: 'moving' });
    }
    row.observe(h);
    expect(h.gateway.status(key)?.phase).toBe('confirmed');
    expect(h.port.calls).toHaveLength(1);
  });

  it(`settles uncertain after ${row.timeoutMs / 1000} s without retrying`, async () => {
    const h = rowHarness(row);
    const key = send(h, row).key;
    h.port.resolve();
    await flush();
    vi.advanceTimersByTime(row.timeoutMs - 1);
    expect(h.gateway.status(key)?.phase).toBe('sent');
    vi.advanceTimersByTime(1);
    expect(h.gateway.status(key)).toMatchObject({ phase: 'uncertain', error: { code: 'timeout' } });
    vi.advanceTimersByTime(10 * row.timeoutMs);
    expect(h.port.calls).toHaveLength(1);
  });
});
