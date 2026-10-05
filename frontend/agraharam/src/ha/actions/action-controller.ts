/**
 * Ticket and draft controller (§4.7, §7.2). Every section uses it; leaves never call the gateway and own no timers.
 * The draft rules close the blind-repeat path: a held draft is sent only after a confirmed settle, and every
 * disconnect, preview, config change or unmount discards it as "Not sent".
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { DashboardServices } from '../../components/services.ts';
import { log } from '../../util/log.ts';
import type { Unsubscribe } from '../host.ts';
import { createNullGateway } from './null-gateway.ts';
import {
  isTicketInFlight,
  type ActionGateway,
  type ActionKey,
  type ActionRequest,
  type ActionStatus,
  type Availability,
} from './types.ts';

export type DraftState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'drafting'; readonly value: number } // debounce timer running ("Setting 72°")
  | { readonly phase: 'held'; readonly value: number } // waiting for this key's in-flight ticket
  | {
      readonly phase: 'not-sent'; // shown as observed value + "Not sent"
      readonly value: number;
      readonly reason: 'disconnected' | 'preview' | 'uncertain' | 'failed' | 'config';
    };
type NotSentReason = Extract<DraftState, { phase: 'not-sent' }>['reason'];

/** What a dismissed note stood for: the key's discarded draft, its stored gateway ticket, or both. */
export interface DismissParts {
  readonly draft: boolean;
  readonly ticket: boolean;
}

const IDLE: DraftState = Object.freeze({ phase: 'idle' });
const NO_SERVICES: Availability = Object.freeze({
  enabled: false,
  reason: 'unsupported',
  message: "This control isn't available yet.",
});

/** One in-progress draft; `epoch` is the gateway epoch captured on the draft's FIRST gesture. */
interface Draft {
  state: DraftState;
  readonly epoch: number;
  build: (value: number) => ActionRequest;
  observed: () => number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The ticket a held draft waits for. */
  heldBehind: number | undefined;
}

export class ActionController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #services: () => DashboardServices | undefined;
  readonly #keys: () => readonly ActionKey[];
  readonly #drafts = new Map<ActionKey, Draft>();
  readonly #ticketSubscriptions = new Map<ActionKey, Unsubscribe>();
  #gateway: ActionGateway | undefined;
  #epochUnsubscribe: Unsubscribe | undefined;
  #connected = false;
  /** Answers request() while no services exist (before the first publish or with an invalid config). */
  #fallbackGateway: ActionGateway | undefined;

  constructor(
    host: ReactiveControllerHost,
    services: () => DashboardServices | undefined,
    keys: () => readonly ActionKey[],
  ) {
    this.#host = host;
    this.#services = services;
    this.#keys = keys;
    host.addController(this);
  }

  status(key: ActionKey): ActionStatus | undefined {
    return this.#currentGateway()?.status(key);
  }

  /** Enabled results carry `confirm`. */
  evaluate(req: ActionRequest): Availability {
    return this.#currentGateway()?.evaluate(req) ?? NO_SERVICES;
  }

  /** Immediate gestures (toggles, transport, one activated choice option). For an Availability with
   *  confirm: true the section dispatches agr-request-confirm instead; calling request() anyway returns
   *  failed('confirmation-required'). */
  request(req: ActionRequest): ActionStatus {
    const gateway = this.#currentGateway() ?? this.#nullGateway();
    return gateway.request(req);
  }

  /** Debounced gestures (sliders, steppers). Starts or restarts the timer; captures gateway.epoch() on the
   *  FIRST gesture of a draft. */
  draft(
    key: ActionKey,
    value: number,
    build: (v: number) => ActionRequest,
    debounceMs: number,
    observed: () => number | null,
  ): void {
    const gateway = this.#currentGateway();
    if (gateway === undefined || !this.#connected) return;
    const existing = this.#drafts.get(key);
    if (existing !== undefined && existing.state.phase === 'held') {
      // More gestures while this key's ticket is in flight only update the held value (§7.2).
      existing.state = { phase: 'held', value };
      existing.build = build;
      existing.observed = observed;
      this.#host.requestUpdate();
      return;
    }
    const draft: Draft =
      existing !== undefined && existing.state.phase === 'drafting'
        ? existing
        : { state: IDLE, epoch: gateway.epoch(), build, observed, timer: undefined, heldBehind: undefined };
    clearTimeout(draft.timer);
    draft.state = { phase: 'drafting', value };
    draft.build = build;
    draft.observed = observed;
    draft.timer = setTimeout(() => this.#onTimer(key), debounceMs);
    this.#drafts.set(key, draft);
    this.#ensureTicketSubscription(key);
    this.#host.requestUpdate();
  }

  draftState(key: ActionKey): DraftState {
    return this.#drafts.get(key)?.state ?? IDLE;
  }

  /**
   * The user dismissed a note (§7.2): clears the key's draft, its stored gateway ticket, or both, then re-renders.
   * Every section's Dismiss goes through here (control-notes.ts dismissNote). The gateway keeps in-flight tickets.
   */
  dismiss(key: ActionKey, parts: DismissParts): void {
    if (parts.draft) {
      clearTimeout(this.#drafts.get(key)?.timer);
      this.#drafts.delete(key);
    }
    if (parts.ticket) this.#currentGateway()?.dismiss(key);
    this.#host.requestUpdate();
  }

  /** Subscribe to gateway tickets and the epoch. */
  hostConnected(): void {
    this.#connected = true;
    this.#syncGateway();
  }

  /** Rule 6: cancel EVERY draft timer, drafts → idle, unsubscribe. Nothing fires after the element leaves the DOM. */
  hostDisconnected(): void {
    this.#connected = false;
    for (const draft of this.#drafts.values()) clearTimeout(draft.timer);
    this.#drafts.clear();
    this.#unsubscribeAll();
    this.#gateway = undefined;
  }

  hostUpdate(): void {
    if (this.#connected) this.#syncGateway();
  }

  #currentGateway(): ActionGateway | undefined {
    return this.#services()?.gateway;
  }

  #nullGateway(): ActionGateway {
    this.#fallbackGateway ??= createNullGateway();
    return this.#fallbackGateway;
  }

  /** Rule 5: a different gateway means a config change, so pending drafts become not-sent('config'). */
  #syncGateway(): void {
    try {
      const gateway = this.#currentGateway();
      if (gateway !== this.#gateway) {
        this.#unsubscribeAll();
        if (this.#gateway !== undefined) this.#discardDrafts('config');
        this.#gateway = gateway;
        if (gateway !== undefined) this.#epochUnsubscribe = gateway.onEpochChange(() => this.#onEpochChange());
      }
      for (const key of this.#keys()) this.#ensureTicketSubscription(key);
    } catch {
      log.error('action-controller-failed');
    }
  }

  #ensureTicketSubscription(key: ActionKey): void {
    const gateway = this.#gateway;
    if (gateway === undefined || this.#ticketSubscriptions.has(key)) return;
    this.#ticketSubscriptions.set(
      key,
      gateway.subscribe(key, (status) => this.#onTicket(key, status)),
    );
  }

  #unsubscribeAll(): void {
    this.#epochUnsubscribe?.();
    this.#epochUnsubscribe = undefined;
    for (const unsubscribe of this.#ticketSubscriptions.values()) unsubscribe();
    this.#ticketSubscriptions.clear();
  }

  /** Rule 1: a non-terminal ticket on the key holds the draft; otherwise the draft is sent with its epoch. */
  #onTimer(key: ActionKey): void {
    try {
      const draft = this.#drafts.get(key);
      const gateway = this.#gateway;
      if (draft === undefined || draft.state.phase !== 'drafting') return;
      draft.timer = undefined;
      if (gateway === undefined || gateway !== this.#currentGateway()) {
        this.#setNotSent(key, draft, 'config');
        return;
      }
      const inFlight = gateway.status(key);
      if (isTicketInFlight(inFlight)) {
        draft.state = { phase: 'held', value: draft.state.value };
        draft.heldBehind = inFlight.id;
        this.#host.requestUpdate();
        return;
      }
      this.#send(key, draft, draft.state.value);
    } catch {
      log.error('draft-timer-failed');
    }
  }

  #send(key: ActionKey, draft: Draft, value: number): void {
    const gateway = this.#gateway;
    if (gateway === undefined) return;
    const status = gateway.request(draft.build(value), { epoch: draft.epoch });
    if (status.phase === 'failed') {
      // request() can notice a connection change and move the epoch before it refuses; the epoch listener has
      // then already discarded this draft with the true reason ("disconnected"), which the refusal must not
      // overwrite with the generic one.
      if (draft.state.phase !== 'not-sent') this.#setNotSent(key, draft, notSentReasonFor(status));
      return;
    }
    this.#drafts.delete(key);
    this.#host.requestUpdate();
  }

  /** Rules 2 and 3: a held draft follows its ticket's terminal phase. */
  #onTicket(key: ActionKey, status: ActionStatus): void {
    try {
      this.#host.requestUpdate();
      const draft = this.#drafts.get(key);
      if (draft === undefined) return;
      if (status.phase === 'uncertain' || status.phase === 'failed') {
        if (draft.state.phase === 'held' || draft.state.phase === 'drafting') {
          this.#setNotSent(key, draft, status.phase);
        }
        return;
      }
      if (status.phase === 'confirmed' && draft.state.phase === 'held' && draft.heldBehind === status.id) {
        this.#sendHeldIfStillWanted(key, draft, draft.state.value);
      }
    } catch {
      log.error('action-ticket-failed');
    }
  }

  /** Rule 2: only with the epoch unchanged, the phase connected, the host connected, and a value that still differs
   *  from the observed one. */
  #sendHeldIfStillWanted(key: ActionKey, draft: Draft, value: number): void {
    const services = this.#services();
    const gateway = this.#gateway;
    const stillValid =
      gateway !== undefined &&
      services?.gateway === gateway &&
      gateway.epoch() === draft.epoch &&
      services.reader.connection().phase === 'connected' &&
      this.#connected;
    if (!stillValid) {
      this.#setNotSent(key, draft, gateway?.disposed === true ? 'config' : 'disconnected');
      return;
    }
    if (value === draft.observed()) {
      this.#drafts.delete(key);
      this.#host.requestUpdate();
      return;
    }
    this.#send(key, draft, value);
  }

  /** Rule 4: an epoch change cancels every timer and discards every draft; a reconnect never revives one. */
  #onEpochChange(): void {
    try {
      const gateway = this.#gateway;
      let reason: NotSentReason = 'preview';
      if (gateway?.disposed === true) reason = 'config';
      else if (this.#services()?.reader.connection().phase !== 'connected') reason = 'disconnected';
      this.#discardDrafts(reason);
    } catch {
      log.error('action-epoch-failed');
    }
  }

  #discardDrafts(reason: NotSentReason): void {
    for (const [key, draft] of this.#drafts) {
      if (draft.state.phase === 'drafting' || draft.state.phase === 'held') this.#setNotSent(key, draft, reason);
    }
  }

  #setNotSent(key: ActionKey, draft: Draft, reason: NotSentReason): void {
    clearTimeout(draft.timer);
    draft.timer = undefined;
    const value = draft.state.phase === 'idle' ? 0 : draft.state.value;
    draft.state = { phase: 'not-sent', value, reason };
    this.#drafts.set(key, draft);
    this.#host.requestUpdate();
  }
}

/** A draft whose request failed at once keeps its value and shows why nothing was sent. */
function notSentReasonFor(status: ActionStatus): NotSentReason {
  if (status.error?.code === 'disconnected') return 'disconnected';
  if (status.error?.code === 'preview') return 'preview';
  if (status.error?.code === 'not-sent') return 'config';
  return 'failed';
}
