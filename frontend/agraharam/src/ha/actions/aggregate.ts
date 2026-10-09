/**
 * The outcome of one accepted request from the results of its calls (§4.7, §18). Most requests make one call; a room
 * with lights and lighting switches makes one per domain, under one ticket. Pure and total, so every combination is
 * tested directly, and with a single call every branch is exactly the single-call rule the gateway always had:
 *
 * - resolved: confirmed when the outcome is observed, else sent;
 * - rejected with a lost connection: confirmed when the outcome is observed, else uncertain;
 * - refused by the port (never sent): failed('disconnected'), truthfully "nothing was changed";
 * - any other rejection: failed with its code, even when the outcome is observed;
 * - the family timeout: confirmed when the outcome is observed, else uncertain('timeout').
 *
 * With several calls, a request of which part went out and part did not is `partial`: uncertain, never "nothing
 * changed", because some lighting may have switched.
 */
import type { ActionErrorCode } from './types.ts';

export type CallResult =
  | { readonly state: 'pending' }
  | { readonly state: 'resolved' }
  | {
      readonly state: 'rejected';
      readonly code: ActionErrorCode; // mapped by error-map.ts
      readonly notSent: boolean; // PortNotSent: the call never left the browser
      readonly haMessage?: string;
      readonly haCode?: string | number;
    };
type Rejected = Extract<CallResult, { state: 'rejected' }>;

export type Outcome =
  | { readonly settled: false; readonly phase: 'pending' | 'sent' }
  | { readonly settled: true; readonly phase: 'confirmed' }
  | {
      readonly settled: true;
      readonly phase: 'uncertain' | 'failed';
      readonly code: ActionErrorCode;
      readonly partial: boolean;
      readonly haMessage?: string;
      readonly haCode?: string | number;
    };

const PENDING: Outcome = Object.freeze({ settled: false, phase: 'pending' });
const SENT: Outcome = Object.freeze({ settled: false, phase: 'sent' });
const CONFIRMED: Outcome = Object.freeze({ settled: true, phase: 'confirmed' });

/**
 * Which refusal names a partly refused request: the one the household can act on first. A permission problem needs
 * an administrator whatever else happened; a device error names the device; HA's validation message comes next.
 */
const REFUSAL_PRECEDENCE: readonly ActionErrorCode[] = Object.freeze([
  'permission-denied',
  'device-error',
  'rejected',
  'service-missing',
  'bad-request',
  'unknown',
]);

/**
 * `observed`: the confirmation predicate held for every target. `atTimeout`: the family timeout fired, so calls still
 * out count as resolved (they may have executed) and the outcome always settles.
 */
export function aggregateOutcome(calls: readonly CallResult[], observed: boolean, atTimeout: boolean): Outcome {
  if (!atTimeout && calls.some((call) => call.state === 'pending')) return PENDING;
  const rejected = calls.filter((call): call is Rejected => call.state === 'rejected');
  const lost = rejected.filter((call) => call.code === 'connection-lost');
  const notSent = rejected.filter((call) => call.notSent);
  const refused = rejected.filter((call) => !call.notSent && call.code !== 'connection-lost');
  // A call that resolved, lost its connection while sending or is still out at the timeout may have taken effect.
  const someWentOut = lost.length > 0 || calls.some((call) => call.state !== 'rejected');

  const worst = mostActionable(refused);
  if (worst !== undefined) return settledWith(someWentOut ? 'uncertain' : 'failed', worst, someWentOut);
  const [firstLost] = lost;
  if (firstLost !== undefined) return observed ? CONFIRMED : settledWith('uncertain', firstLost, false);
  const [firstNotSent] = notSent;
  if (firstNotSent !== undefined) {
    // A call that was never sent outranks observation: the rest of the room was not asked to change.
    return someWentOut
      ? { settled: true, phase: 'uncertain', code: 'disconnected', partial: true }
      : settledWith('failed', firstNotSent, false);
  }
  if (observed) return CONFIRMED;
  return atTimeout ? { settled: true, phase: 'uncertain', code: 'timeout', partial: false } : SENT;
}

function settledWith(phase: 'uncertain' | 'failed', call: Rejected, partial: boolean): Outcome {
  return {
    settled: true,
    phase,
    code: call.code,
    partial,
    ...(call.haMessage !== undefined && { haMessage: call.haMessage }),
    ...(call.haCode !== undefined && { haCode: call.haCode }),
  };
}

function mostActionable(refusals: readonly Rejected[]): Rejected | undefined {
  const rank = (call: Rejected): number => {
    const index = REFUSAL_PRECEDENCE.indexOf(call.code);
    return index === -1 ? REFUSAL_PRECEDENCE.length : index;
  };
  return [...refusals].sort((a, b) => rank(a) - rank(b))[0];
}
