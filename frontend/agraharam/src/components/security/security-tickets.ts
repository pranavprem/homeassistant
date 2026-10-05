/**
 * Which security button a ticket belongs to (§8.2). Every role shares the 'security' ticket key (§4.7 step 13), so
 * the gateway cannot say which action a ticket is for; the drawer remembers the button the user activated and the
 * newest ticket id at that moment, and only a ticket newer than that can be its own. A request that failed before a
 * ticket existed (the gateway stores none for prechecks) is kept here until dismissed or superseded.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { SecurityActionRole } from '../../config/schema.ts';
import { newerStatus, type ActionGateway, type ActionStatus } from '../../ha/actions/types.ts';

/** The current security ticket, with the role whose button started it when this drawer saw the gesture. */
export interface AttributedTicket {
  readonly status: ActionStatus;
  readonly role: SecurityActionRole | undefined;
}

interface PendingRole {
  readonly role: SecurityActionRole;
  readonly afterId: number;
}

export class SecurityTickets implements ReactiveController {
  readonly #gateway: () => ActionGateway | undefined;
  #pending: PendingRole | undefined;
  #attributed: { readonly id: number; readonly role: SecurityActionRole } | undefined;
  #immediateFailure: { readonly status: ActionStatus; readonly role: SecurityActionRole } | undefined;

  constructor(host: ReactiveControllerHost, gateway: () => ActionGateway | undefined) {
    this.#gateway = gateway;
    host.addController(this);
  }

  /** The user activated `role` (directly or through its confirm dialog, which may still be cancelled). */
  begin(role: SecurityActionRole): void {
    this.#pending = { role, afterId: this.#stored()?.id ?? 0 };
  }

  /** A request made at once returned `status`: its own ticket, or a failure the gateway did not store. */
  record(role: SecurityActionRole, status: ActionStatus): void {
    this.#pending = undefined;
    if (status.phase === 'failed') this.#immediateFailure = { status, role };
    else this.#attributed = { id: status.id, role };
  }

  /** The newer (by ticket id) of an immediate failure and the gateway's ticket, attributed when this drawer started
   *  it. */
  current(): AttributedTicket | undefined {
    const immediate = this.#immediateFailure;
    const newest = newerStatus(this.#stored(), immediate?.status);
    if (newest === undefined) return undefined;
    if (newest === immediate?.status) return immediate;
    return { status: newest, role: newest.id === this.#attributed?.id ? this.#attributed.role : undefined };
  }

  /** Clears the shown outcome; returns the role it belonged to, for focus to return to its button. */
  dismiss(): SecurityActionRole | undefined {
    const role = this.current()?.role;
    this.#immediateFailure = undefined;
    this.#gateway()?.dismiss('security');
    return role;
  }

  /** A ticket newer than the one current at the gesture belongs to the button the user activated. */
  hostUpdate(): void {
    const stored = this.#stored();
    const pending = this.#pending;
    if (stored !== undefined && pending !== undefined && stored.id > pending.afterId) {
      this.#attributed = { id: stored.id, role: pending.role };
      this.#pending = undefined;
    }
  }

  #stored(): ActionStatus | undefined {
    return this.#gateway()?.status('security');
  }
}
