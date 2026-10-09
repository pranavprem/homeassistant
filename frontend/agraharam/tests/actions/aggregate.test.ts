/**
 * The aggregate outcome of a multi-call request (§18, design §5.2 and review S2). A room with lights and lighting
 * switches sends one call per domain under one ticket, and `aggregateOutcome` decides the ticket from every call's
 * result. The tables below are written out by hand from the design's six rules, independently of the implementation:
 *
 * - P pending, R resolved, CL rejected with connection-lost, NS PortNotSent (never left the browser), D any other
 *   rejection (precedence permission-denied > device-error > rejected > service-missing > bad-request > unknown);
 * - before the timeout any pending call keeps the ticket pending; at the timeout a pending call counts like R,
 *   because it may have executed;
 * - nothing may read "Nothing changed" (failed) once some call may have left the browser: then it is partial.
 *
 * The single-call table is a literal record of cf0c182's #onResolved / #onRejected / #onTimeout, so the aggregate
 * provably reduces to today's behaviour for every existing request.
 */
import { describe, expect, it } from 'vitest';
import { aggregateOutcome, type CallResult, type Outcome } from '../../src/ha/actions/aggregate.ts';
import type { ActionErrorCode } from '../../src/ha/actions/types.ts';

type Token = 'P' | 'R' | 'CL' | 'NS' | 'D';

const DEVICE_MESSAGE = 'Value out of range for this device';

const RESULT: Readonly<Record<Token, CallResult>> = Object.freeze({
  P: Object.freeze({ state: 'pending' }),
  R: Object.freeze({ state: 'resolved' }),
  CL: Object.freeze({ state: 'rejected', code: 'connection-lost', notSent: false, haCode: 3 }),
  NS: Object.freeze({ state: 'rejected', code: 'disconnected', notSent: true }),
  D: Object.freeze({
    state: 'rejected',
    code: 'rejected',
    notSent: false,
    haCode: 'service_validation_error',
    haMessage: DEVICE_MESSAGE,
  }),
});

/** A rejection other than connection-lost or not-sent, with this code. */
function denial(code: ActionErrorCode, haMessage?: string): CallResult {
  return Object.freeze({
    state: 'rejected',
    code,
    notSent: false,
    haCode: `ha_${code}`,
    ...(haMessage !== undefined && { haMessage }),
  });
}

/**
 * The outcome in short form: 'pending' | 'sent' | 'confirmed' | 'uncertain:<code>' | 'partial:<code>' |
 * 'failed:<code>'. 'partial' is phase uncertain with partial: true; 'uncertain' and 'failed' are never partial.
 */
function short(outcome: Outcome): string {
  if (!outcome.settled || outcome.phase === 'confirmed') return outcome.phase;
  if (outcome.partial === true) {
    expect(outcome.phase, 'a partial outcome is uncertain, never failed').toBe('uncertain');
    return `partial:${outcome.code}`;
  }
  return `${outcome.phase}:${outcome.code}`;
}

/** [live, not observed], [live, observed], [at the timeout, not observed], [at the timeout, observed]. */
type Row = readonly [string, string, string, string];
const COLUMNS = [
  { observed: false, atTimeout: false },
  { observed: true, atTimeout: false },
  { observed: false, atTimeout: true },
  { observed: true, atTimeout: true },
] as const;

/** Every unordered pair of two calls (15), by hand from the six rules of design §5.2. */
const TWO_CALLS: Readonly<Record<string, Row>> = {
  // Rule 0 (still waiting) and rule 6 (timeout, nothing rejected).
  'P+P': ['pending', 'pending', 'uncertain:timeout', 'confirmed'],
  'P+R': ['pending', 'pending', 'uncertain:timeout', 'confirmed'],
  // At the timeout P counts as R: rule 4, rule 5 (NS with R) and rule 2 (D with something that went out).
  'P+CL': ['pending', 'pending', 'uncertain:connection-lost', 'confirmed'],
  'P+NS': ['pending', 'pending', 'partial:disconnected', 'partial:disconnected'],
  'P+D': ['pending', 'pending', 'partial:rejected', 'partial:rejected'],
  // Rule 1 and rule 6.
  'R+R': ['sent', 'confirmed', 'uncertain:timeout', 'confirmed'],
  // Rule 4: connection lost on one call; observation still confirms, as today.
  'R+CL': ['uncertain:connection-lost', 'confirmed', 'uncertain:connection-lost', 'confirmed'],
  // Rule 5: one call never left the browser, the other went out.
  'R+NS': ['partial:disconnected', 'partial:disconnected', 'partial:disconnected', 'partial:disconnected'],
  // Rule 2: a refusal next to a call that went out is partial, and refusals dominate observation.
  'R+D': ['partial:rejected', 'partial:rejected', 'partial:rejected', 'partial:rejected'],
  'CL+CL': ['uncertain:connection-lost', 'confirmed', 'uncertain:connection-lost', 'confirmed'],
  // Rule 4 comes before rule 5: D is empty and CL is not.
  'CL+NS': ['uncertain:connection-lost', 'confirmed', 'uncertain:connection-lost', 'confirmed'],
  'CL+D': ['partial:rejected', 'partial:rejected', 'partial:rejected', 'partial:rejected'],
  // Rule 5: nothing left the browser, so "Nothing was changed" is true.
  'NS+NS': ['failed:disconnected', 'failed:disconnected', 'failed:disconnected', 'failed:disconnected'],
  // Rule 3: only refusals, possibly with not-sent.
  'NS+D': ['failed:rejected', 'failed:rejected', 'failed:rejected', 'failed:rejected'],
  'D+D': ['failed:rejected', 'failed:rejected', 'failed:rejected', 'failed:rejected'],
};

/** cf0c182's single-call behaviour, as a literal table (the regression proof that one call is unchanged). */
const ONE_CALL: Readonly<Record<Token, Row>> = {
  // Pending: an observation while pending is remembered (observedEarly); the timeout confirms it, else uncertain.
  P: ['pending', 'pending', 'uncertain:timeout', 'confirmed'],
  // #onResolved: confirmed when observed, else sent; #onTimeout: uncertain(timeout) unless observed.
  R: ['sent', 'confirmed', 'uncertain:timeout', 'confirmed'],
  // #onRejected: connection-lost is uncertain, but confirmed when the outcome was already observed.
  CL: ['uncertain:connection-lost', 'confirmed', 'uncertain:connection-lost', 'confirmed'],
  // #onRejected: PortNotSent is failed(disconnected) whatever was observed.
  NS: ['failed:disconnected', 'failed:disconnected', 'failed:disconnected', 'failed:disconnected'],
  // #onRejected: every other rejection is failed, whatever was observed.
  D: ['failed:rejected', 'failed:rejected', 'failed:rejected', 'failed:rejected'],
};

const TOKENS = Object.keys(RESULT) as Token[];
const PAIRS = TOKENS.flatMap((a, i) => TOKENS.slice(i).map((b) => [a, b] as const));
const ORDERED_PAIRS = TOKENS.flatMap((a) => TOKENS.map((b) => [a, b] as const));

describe('aggregateOutcome: two calls (every combination × observed × timeout)', () => {
  it('the hand-written table covers every unordered pair exactly once', () => {
    expect(Object.keys(TWO_CALLS).sort()).toEqual(PAIRS.map(([a, b]) => `${a}+${b}`).sort());
  });

  describe.each(PAIRS.map(([a, b]) => [`${a}+${b}`, a, b] as const))('%s', (label, a, b) => {
    it.each(COLUMNS.map((column, index) => [JSON.stringify(column), column, index] as const))(
      '%s',
      (_name, { observed, atTimeout }, index) => {
        const expected = TWO_CALLS[label]?.[index];
        expect(short(aggregateOutcome([RESULT[a], RESULT[b]], observed, atTimeout))).toBe(expected);
      },
    );
  });

  it.each(ORDERED_PAIRS.map(([a, b]) => [`${a},${b}`, a, b] as const))(
    'does not depend on the order of the calls (%s)',
    (_label, a, b) => {
      for (const { observed, atTimeout } of COLUMNS) {
        expect(short(aggregateOutcome([RESULT[a], RESULT[b]], observed, atTimeout))).toBe(
          short(aggregateOutcome([RESULT[b], RESULT[a]], observed, atTimeout)),
        );
      }
    },
  );

  it('never fails ("Nothing changed") once some call resolved, was lost or is still pending at the timeout', () => {
    for (const [a, b] of ORDERED_PAIRS) {
      for (const { observed, atTimeout } of COLUMNS) {
        const outcome = aggregateOutcome([RESULT[a], RESULT[b]], observed, atTimeout);
        const wentOut = [a, b].some((token) => token === 'R' || token === 'CL' || (token === 'P' && atTimeout));
        if (wentOut && outcome.settled) expect(outcome.phase, `${a},${b}`).not.toBe('failed');
      }
    }
  });

  it('marks partial only where a refusal or a not-sent call sits beside a call that went out', () => {
    for (const [a, b] of ORDERED_PAIRS) {
      for (const { observed, atTimeout } of COLUMNS) {
        const outcome = aggregateOutcome([RESULT[a], RESULT[b]], observed, atTimeout);
        if (!outcome.settled || outcome.phase === 'confirmed' || !outcome.partial) continue;
        const tokens = [a, b];
        expect(
          tokens.some((token) => token === 'D' || token === 'NS'),
          `${a},${b}`,
        ).toBe(true);
        expect(
          tokens.some((token) => token === 'R' || token === 'CL' || token === 'P'),
          `${a},${b}`,
        ).toBe(true);
      }
    }
  });
});

describe('aggregateOutcome: refusal precedence and HA detail', () => {
  /** Highest first (design §5.2). */
  const PRECEDENCE: readonly ActionErrorCode[] = [
    'permission-denied',
    'device-error',
    'rejected',
    'service-missing',
    'bad-request',
    'unknown',
  ];

  it.each(PRECEDENCE.flatMap((higher, i) => PRECEDENCE.slice(i + 1).map((lower) => [higher, lower] as const)))(
    '%s outranks %s, as failed when both were refused and as partial beside a resolved call',
    (higher, lower) => {
      for (const calls of [
        [denial(lower), denial(higher)],
        [denial(higher), denial(lower)],
      ]) {
        expect(short(aggregateOutcome(calls, false, false))).toBe(`failed:${higher}`);
      }
      expect(short(aggregateOutcome([RESULT.R, denial(lower), denial(higher)], false, false))).toBe(
        `partial:${higher}`,
      );
    },
  );

  it('carries the winning refusal’s HA message and code, never the other call’s', () => {
    const outcome = aggregateOutcome(
      [denial('unknown', 'ignored text'), denial('rejected', DEVICE_MESSAGE)],
      false,
      false,
    );
    expect(outcome).toMatchObject({
      settled: true,
      phase: 'failed',
      code: 'rejected',
      partial: false,
      haMessage: DEVICE_MESSAGE,
      haCode: 'ha_rejected',
    });
    const partial = aggregateOutcome([RESULT.R, denial('rejected', DEVICE_MESSAGE)], true, false);
    expect(partial).toMatchObject({ phase: 'uncertain', code: 'rejected', partial: true, haMessage: DEVICE_MESSAGE });
  });

  it('a permission refusal beside a not-sent call is still the refusal (failed, not partial)', () => {
    expect(short(aggregateOutcome([RESULT.NS, denial('permission-denied')], false, false))).toBe(
      'failed:permission-denied',
    );
  });
});

describe('aggregateOutcome: one call reduces to cf0c182 exactly', () => {
  it.each(TOKENS)('%s', (token) => {
    COLUMNS.forEach(({ observed, atTimeout }, index) => {
      expect(
        short(aggregateOutcome([RESULT[token]], observed, atTimeout)),
        JSON.stringify({ observed, atTimeout }),
      ).toBe(ONE_CALL[token][index]);
    });
  });

  it.each(['permission-denied', 'device-error', 'rejected', 'service-missing', 'bad-request', 'unknown'] as const)(
    'a single %s refusal is failed with its own code and HA detail, never partial',
    (code) => {
      for (const { observed, atTimeout } of COLUMNS) {
        expect(aggregateOutcome([denial(code, DEVICE_MESSAGE)], observed, atTimeout)).toEqual({
          settled: true,
          phase: 'failed',
          code,
          partial: false,
          haMessage: DEVICE_MESSAGE,
          haCode: `ha_${code}`,
        });
      }
    },
  );
});

describe('aggregateOutcome: purity', () => {
  it('reads its inputs without changing them and answers the same every time', () => {
    const calls = Object.freeze([RESULT.R, RESULT.D, RESULT.P]);
    const first = aggregateOutcome(calls, false, true);
    expect(aggregateOutcome(calls, false, true)).toEqual(first);
    expect(calls).toEqual([RESULT.R, RESULT.D, RESULT.P]);
  });

  it('handles three calls with the same rules (a pending call before the timeout keeps it pending)', () => {
    expect(short(aggregateOutcome([RESULT.R, RESULT.D, RESULT.P], false, false))).toBe('pending');
    expect(short(aggregateOutcome([RESULT.R, RESULT.R, RESULT.R], true, false))).toBe('confirmed');
    expect(short(aggregateOutcome([RESULT.NS, RESULT.NS, RESULT.D], false, false))).toBe('failed:rejected');
  });
});
