/**
 * Always-disabled gateway: what an ActionController's request() reaches while no services exist (before the first
 * publish, or while the configuration is invalid). It never invokes anything and stores no tickets, but it honors
 * the epoch contract (dispose and invalidate move the epoch) so drafts behave the same as with the real gateway.
 */
import { log } from '../../util/log.ts';
import { actionKeyFor } from './types.ts';
import type { ActionError, ActionGateway, ActionRequest, ActionStatus, Availability } from './types.ts';

const UNSUPPORTED_MESSAGE = "This control isn't available.";
const NOT_SENT_MESSAGE = 'Not sent. Nothing was changed. Use the control again to send it.';

const DISABLED: Availability = Object.freeze({
  enabled: false,
  reason: 'unsupported',
  message: UNSUPPORTED_MESSAGE,
});
const UNSUPPORTED_ERROR: ActionError = Object.freeze({ code: 'unsupported', message: UNSUPPORTED_MESSAGE });
const NOT_SENT_ERROR: ActionError = Object.freeze({ code: 'not-sent', message: NOT_SENT_MESSAGE });
const NO_TICKETS: readonly ActionStatus[] = Object.freeze([]);

export function createNullGateway(): ActionGateway {
  let epoch = 0;
  let disposed = false;
  let nextTicketId = 1;
  const epochListeners = new Set<(epoch: number) => void>();

  function advanceEpoch(): void {
    epoch += 1;
    for (const listener of [...epochListeners]) {
      try {
        listener(epoch);
      } catch {
        log.error('epoch-listener-failed');
      }
    }
  }

  function failedTicket(req: ActionRequest, error: ActionError): ActionStatus {
    const at = performance.now();
    return Object.freeze({
      id: nextTicketId++,
      key: actionKeyFor(req),
      kind: req.kind,
      phase: 'failed',
      error,
      startedAt: at,
      settledAt: at,
    });
  }

  return {
    evaluate: () => DISABLED,
    request(req, opts) {
      const staleGesture = disposed || (opts?.epoch !== undefined && opts.epoch !== epoch);
      return failedTicket(req, staleGesture ? NOT_SENT_ERROR : UNSUPPORTED_ERROR);
    },
    status: () => undefined,
    // No ticket is ever stored, so there is never anything to report.
    subscribe: () => () => undefined,
    recent: () => NO_TICKETS,
    epoch: () => epoch,
    onEpochChange(listener) {
      epochListeners.add(listener);
      return () => {
        epochListeners.delete(listener);
      };
    },
    invalidate: advanceEpoch,
    dismiss: () => undefined,
    dispose() {
      if (disposed) return;
      disposed = true;
      advanceEpoch();
    },
    get disposed() {
      return disposed;
    },
  };
}
