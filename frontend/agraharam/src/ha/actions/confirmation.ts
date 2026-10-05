/**
 * Confirmation tokens (§4.7 step 11, §5.2). A request that needs confirmation must present a token that
 * agr-confirm-dialog minted when the user pressed Confirm; a plain flag such as `confirmed: true` no longer exists,
 * so no section can skip the dialog by passing a boolean.
 *
 * - Unforgeable: a token is valid only while it is in this module's private WeakSet. A look-alike object, a copy,
 *   or a token from another module instance never passes.
 * - Bound: each token names exactly one request (its action key, kind and arguments), so a token minted for
 *   "Close garage" cannot open it, and one minted for Silence sound cannot run Disarm & hold (both share the
 *   'security' key).
 * - Single use: the gateway spends a token on the first request() that presents it, whatever that request's
 *   outcome, so a refused or failed attempt can never be replayed with the same token.
 *
 * Call sites are pinned by fitness tests: mintConfirmationToken only in agr-confirm-dialog, redeemConfirmationToken
 * only in the gateway. No other code can ask about a token: holding one grants nothing until the gateway spends it.
 */
import { actionKeyFor, frozenActionRequest, type ActionRequest } from './types.ts';

/** Opaque: only membership in this module's WeakSet makes a token valid; its fields grant nothing. */
export interface ConfirmationToken {
  readonly kind: 'confirmation-token';
  /** The request it is bound to; undefined for a malformed request (such a token is never issued). */
  readonly scope: string | undefined;
}

const issued = new WeakSet<ConfirmationToken>();

/** The binding of a well-formed request: its action key plus its validated kind and arguments, read once. */
function scopeOf(req: unknown): string | undefined {
  const copy = frozenActionRequest(req);
  return copy === undefined ? undefined : `${actionKeyFor(copy)}|${JSON.stringify(copy)}`;
}

function isIssued(value: unknown): value is ConfirmationToken {
  return typeof value === 'object' && value !== null && issued.has(value as ConfirmationToken);
}

/**
 * A single-use token for exactly `req`. Only agr-confirm-dialog calls this, at the moment the user presses
 * Confirm. A malformed request gets a token that is never issued, so it can never confirm anything.
 */
export function mintConfirmationToken(req: ActionRequest): ConfirmationToken {
  const token: ConfirmationToken = Object.freeze({ kind: 'confirmation-token', scope: scopeOf(req) });
  if (token.scope !== undefined) issued.add(token);
  return token;
}

/**
 * The gateway's confirmation step: spends any issued token it is given (valid for this request or not), then
 * reports whether it was an unspent token for exactly `req`. Only the gateway calls this, with the one frozen copy
 * of the request it then checks and sends.
 */
export function redeemConfirmationToken(value: unknown, req: unknown): boolean {
  if (!isIssued(value)) return false;
  issued.delete(value);
  const scope = scopeOf(req);
  return scope !== undefined && value.scope === scope;
}
