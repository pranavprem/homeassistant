/**
 * A controllable ActionGateway for UI tests (the real one is createGateway). `request()` records the call and opens a
 * pending ticket unless a precheck fails; the test settles tickets and moves the epoch by hand.
 */
import { actionKeyFor } from '../../src/ha/actions/types.ts';
import type {
  ActionError,
  ActionGateway,
  ActionKey,
  ActionPhase,
  ActionRequest,
  ActionStatus,
  Availability,
  RequestOptions,
} from '../../src/ha/actions/types.ts';
import type { Unsubscribe } from '../../src/ha/host.ts';

const ENABLED: Availability = { enabled: true, confirm: false };

interface RequestCall {
  readonly req: ActionRequest;
  readonly opts: RequestOptions | undefined;
}

export class FakeGateway implements ActionGateway {
  /** Every request() call, accepted or not. */
  readonly calls: RequestCall[] = [];
  /** What evaluate() answers; a function can vary it per request. */
  availability: Availability | ((req: ActionRequest) => Availability) = ENABLED;
  /** A precheck failure request() should report instead of opening a ticket. */
  failWith: ActionError | undefined;
  #epoch = 0;
  #disposed = false;
  #nextId = 1;
  readonly #statuses = new Map<ActionKey, ActionStatus>();
  readonly #listeners = new Map<ActionKey | '*', Set<(status: ActionStatus) => void>>();
  readonly #epochListeners = new Set<(epoch: number) => void>();

  readonly #accepted = new Set<RequestCall>();

  /** Requests that opened a ticket: what the real gateway would have passed to port.invoke(). */
  get invoked(): readonly ActionRequest[] {
    return this.calls.filter((call) => this.#accepted.has(call)).map((call) => call.req);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  evaluate(req: ActionRequest): Availability {
    return typeof this.availability === 'function' ? this.availability(req) : this.availability;
  }

  request(req: ActionRequest, opts?: RequestOptions): ActionStatus {
    const call = { req, opts };
    this.calls.push(call);
    const key = actionKeyFor(req);
    const staleEpoch = opts?.epoch !== undefined && opts.epoch !== this.#epoch;
    if (this.#disposed || staleEpoch) return this.#failed(req, { code: 'not-sent', message: 'Not sent.' });
    if (this.failWith !== undefined) return this.#failed(req, this.failWith);
    const status: ActionStatus = { id: this.#nextId++, key, kind: req.kind, phase: 'pending', startedAt: 0 };
    this.#accepted.add(call);
    this.#update(status);
    return status;
  }

  /** Moves the current ticket on `key` to `phase`. */
  settle(key: ActionKey, phase: ActionPhase, error?: ActionError): void {
    const current = this.#statuses.get(key);
    if (current === undefined) throw new Error(`no ticket on ${key}`);
    this.#update({ ...current, phase, settledAt: 1, ...(error !== undefined && { error }) });
  }

  status(key: ActionKey): ActionStatus | undefined {
    return this.#statuses.get(key);
  }

  subscribe(key: ActionKey | '*', listener: (status: ActionStatus) => void): Unsubscribe {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => listeners.delete(listener);
  }

  recent(): readonly ActionStatus[] {
    return [];
  }

  epoch(): number {
    return this.#epoch;
  }

  onEpochChange(listener: (epoch: number) => void): Unsubscribe {
    this.#epochListeners.add(listener);
    return () => this.#epochListeners.delete(listener);
  }

  invalidate(): void {
    this.advanceEpoch();
  }

  dismiss(key: ActionKey): void {
    this.#statuses.delete(key);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.advanceEpoch();
  }

  /** What the real gateway does when the connection phase leaves 'connected'. */
  advanceEpoch(): void {
    this.#epoch += 1;
    for (const listener of [...this.#epochListeners]) listener(this.#epoch);
  }

  #failed(req: ActionRequest, error: ActionError): ActionStatus {
    return { id: this.#nextId++, key: actionKeyFor(req), kind: req.kind, phase: 'failed', error, startedAt: 0 };
  }

  #update(status: ActionStatus): void {
    this.#statuses.set(status.key, status);
    for (const listener of [...(this.#listeners.get(status.key) ?? []), ...(this.#listeners.get('*') ?? [])]) {
      listener(status);
    }
  }
}
