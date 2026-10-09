/**
 * The action gateway (§4.7): the only code that calls ServicePort.invoke. Every request runs the §4.7 pipeline
 * (allowlist from config.bindings only, domain, availability, precondition, capability, service, arguments,
 * confirmation, sticky denial, lock), then becomes one ticket that is confirmed by OBSERVED state, never assumed.
 *
 * Safety properties, each covered by tests/actions/gateway.test.ts:
 * - one accepted request = exactly one invoke per planned call (a room with lights and lighting switches: two, one per
 *   domain, §18; every other request: one); nothing is ever repeated, queued, replayed or retried automatically;
 * - nothing is sent while disconnected, resyncing, in preview, with `controls: false`, after dispose, or for a
 *   gesture whose epoch is stale;
 * - targets, services and data come from the configuration and the catalog, never from the caller;
 * - locks live in the page-wide in-flight registry, so a rebuilt gateway still sees an in-flight garage call.
 */
import { domainOf } from '../../config/entity-id.ts';
import { LIMITS } from '../../config/limits.ts';
import {
  ACTIONABLE_ROLE_FAMILY,
  type ActionFamily,
  type EntityId,
  type ResolvedConfig,
  type ShortcutRole,
} from '../../config/schema.ts';
import { alarmDisplayFor, isAlarmSounding } from '../../domain/alarm.ts';
import { isDefined } from '../../util/defined.ts';
import { log } from '../../util/log.ts';
import { hasFeatures } from '../features.ts';
import type {
  ConnectionPhase,
  HostChange,
  HostReader,
  ServiceCall,
  ServiceCallResult,
  ServicePort,
  Unsubscribe,
} from '../host.ts';
import { normalizeEntity, type EntityStatus, type NormalizedEntity } from '../normalize.ts';
import type { HassEntityLike } from '../types.ts';
import { confirmRuleFor, specFor, type ActionSpec, type ObservationContext, type ServicePart } from './catalog.ts';
import { redeemConfirmationToken } from './confirmation.ts';
import { mapRejection, plainText } from './error-map.ts';
import { INFLIGHT } from './inflight.ts';
import { aggregateOutcome, type CallResult, type Outcome } from './aggregate.ts';
import {
  actionMessage,
  stoppedWatchingMessage,
  UNNAMED_SUBJECT,
  type ActionSubject,
  type GarageLikeCover,
  type MessageContext,
} from './messages.ts';
import {
  ACTION_TIMEOUT_MS,
  CONFIRMED_DISPLAY_MS,
  actionKeyFor,
  ENABLED,
  frozenActionRequest,
  isTicketInFlight,
  newerStatus,
  type ActionError,
  type ActionErrorCode,
  type ActionGateway,
  type ActionKey,
  type ActionKind,
  type ActionPhase,
  type ActionRequest,
  type ActionStatus,
  type Availability,
  type InflightRegistry,
  type RequestOptions,
} from './types.ts';
import { argumentsValid } from './validate-args.ts';

interface GatewayDeps {
  readonly port: ServicePort;
  readonly reader: HostReader;
  readonly config: ResolvedConfig;
  readonly isPreview: () => boolean;
  readonly now?: () => number; // default () => performance.now() (monotonic)
  readonly inflight?: InflightRegistry; // tests inject one; production uses the module singleton
}

export function createGateway(deps: GatewayDeps): ActionGateway {
  return new Gateway(deps);
}

/** §4.7: recent() keeps the last 20 settled or failed tickets. */
export const RECENT_LIMIT = 20;
/** A lock-expiry re-render fires this long after the lock's end, so the monotonic clock has surely passed it. */
const LOCK_EXPIRY_MARGIN_MS = 50;
/** Key and kind reported for a request too malformed to name either (never stored, never sent). */
const MALFORMED_KEY: ActionKey = 'entity:';
const MALFORMED_KIND = 'malformed' as ActionKind;

const SECURITY_SUBJECT: ActionSubject = Object.freeze({ name: 'the security controller', plural: false });
const STUDIO_MONITORS_SUBJECT: ActionSubject = Object.freeze({ name: 'the studio monitors', plural: true });
/** Fixed in code, like the shortcut labels: a script's own friendly_name never words a whole-house action (§18). */
const SHORTCUT_SUBJECTS: Readonly<Record<ShortcutRole, ActionSubject>> = Object.freeze({
  lights_toggle: Object.freeze({ name: 'the whole-house lights script', plural: false }),
  curtains_toggle: Object.freeze({ name: 'the whole-house curtains script', plural: false }),
});
/** Fallback names when neither the configuration nor HA offers one. Never an entity ID. */
const FAMILY_NOUNS: Readonly<Record<ActionFamily, ActionSubject>> = Object.freeze({
  light: { name: 'this light', plural: false },
  switch: { name: 'this switch', plural: false },
  room: { name: 'these lights', plural: true },
  climate: { name: 'this thermostat', plural: false },
  fan: { name: 'this fan', plural: false },
  vacuum: { name: 'this vacuum', plural: false },
  garage: { name: 'the garage door', plural: false },
  curtain: { name: 'this cover', plural: false },
  media: { name: 'this player', plural: false },
  security: SECURITY_SUBJECT,
  studio_monitors: STUDIO_MONITORS_SUBJECT,
  shortcut: { name: 'this shortcut', plural: false },
});

const ENABLED_WITH_CONFIRM: Availability = Object.freeze({ enabled: true, confirm: true });
const NO_TICKETS: readonly ActionStatus[] = Object.freeze([]);

/** Ticket ids are unique in the page, so a view never confuses tickets from a replaced gateway. */
let nextTicketId = 1;

type Stage = MessageContext['stage'];

/** One service call of a plan and the targets it addresses. */
interface PlannedCall {
  readonly call: ServiceCall;
  readonly targets: readonly EntityId[];
}

/** Everything an accepted request needs; built only by the pipeline. */
interface Plan {
  readonly req: ActionRequest;
  readonly spec: ActionSpec;
  readonly key: ActionKey;
  /** Every target of every call: locks, sticky denials and observation cover all of them. */
  readonly targets: readonly EntityId[];
  readonly subject: ActionSubject;
  readonly confirm: boolean;
  /** One call, or for a room one per domain with an available target (lights first, §18), invoked in this order. */
  readonly calls: readonly PlannedCall[];
  readonly timeoutMs: number;
  readonly temperatureUnit: string;
}

/** A refusal from steps 4 to 5b, with the context its copy needs. */
interface AllowlistRefusal {
  readonly code: ActionErrorCode;
  readonly extra?: Partial<MessageContext>;
}
const REGISTRY_PENDING_REFUSAL: AllowlistRefusal = Object.freeze({
  code: 'state-unknown',
  extra: Object.freeze({ registryPending: true }),
});
const SETTINGS_SWITCH_REFUSAL: AllowlistRefusal = Object.freeze({
  code: 'not-allowed',
  extra: Object.freeze({ settingsSwitch: true }),
});
const PENDING_CALL: CallResult = Object.freeze({ state: 'pending' });
const RESOLVED_CALL: CallResult = Object.freeze({ state: 'resolved' });

/** A precheck failure. `storable` failures become a visible failed ticket unless one is already in flight. */
interface Blocked {
  readonly ok: false;
  readonly code: ActionErrorCode;
  readonly message: string;
  readonly storable: boolean;
}
type Verdict = { readonly ok: true; readonly plan: Plan } | Blocked;

interface Ticket {
  status: ActionStatus;
  readonly plan: Plan;
  /** Target states when the request was accepted (media track and script last_triggered predicates). */
  readonly before: ReadonlyMap<EntityId, HassEntityLike | undefined>;
  /** The outcome was observed while a call was still pending; it confirms when the calls resolve. */
  observedEarly: boolean;
  progressSeen: boolean;
  /** One result per planned call, in plan order. */
  readonly results: CallResult[];
  /** HA's context id per call, once it resolved (script observation). */
  readonly contextIds: (string | undefined)[];
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  unobserve: Unsubscribe | undefined;
}

class Gateway implements ActionGateway {
  readonly #port: ServicePort;
  readonly #reader: HostReader;
  readonly #config: ResolvedConfig;
  readonly #isPreview: () => boolean;
  readonly #now: () => number;
  readonly #inflight: InflightRegistry;
  /** Configured display names (config refs), consulted before HA's friendly_name. */
  readonly #names: ReadonlyMap<EntityId, string>;
  /** The latest accepted ticket per key, live or terminal, until it is dismissed. */
  readonly #tickets = new Map<ActionKey, Ticket>();
  /** The latest visible refusal per key (a precheck failure from step 4 on), until dismissed or superseded. */
  readonly #refusals = new Map<ActionKey, ActionStatus>();
  readonly #listeners = new Map<ActionKey | '*', Set<(status: ActionStatus) => void>>();
  readonly #epochListeners = new Set<(epoch: number) => void>();
  /** Sticky Unauthorized denials, keyed by family and target (§4.7 step 12); cleared on a `user` meta change. */
  readonly #denied = new Set<string>();
  /** Re-render signals for uncertain tickets whose in-flight lock outlives them. */
  readonly #lockTimers = new Set<ReturnType<typeof setTimeout>>();
  #recent: ActionStatus[] = [];
  #recentView: readonly ActionStatus[] = NO_TICKETS;
  #epoch = 0;
  #disposed = false;
  #lastPhase: ConnectionPhase;
  #unsubscribeStore: Unsubscribe | undefined;

  constructor(deps: GatewayDeps) {
    this.#port = deps.port;
    this.#reader = deps.reader;
    this.#config = deps.config;
    this.#isPreview = deps.isPreview;
    this.#now = deps.now ?? (() => performance.now());
    this.#inflight = deps.inflight ?? INFLIGHT;
    this.#names = configuredNames(deps.config);
    this.#lastPhase = deps.reader.connection().phase;
    // A passive read subscription: phase changes move the epoch, a user change resets sticky denials.
    this.#unsubscribeStore = deps.reader.store.subscribe([], ['connection', 'user'], (change) =>
      this.#onMetaChange(change),
    );
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  evaluate(req: ActionRequest): Availability {
    try {
      const verdict = this.#check(frozenActionRequest(req), undefined, 'evaluate', false);
      if (!verdict.ok) return Object.freeze({ enabled: false, reason: verdict.code, message: verdict.message });
      return verdict.plan.confirm ? ENABLED_WITH_CONFIRM : ENABLED;
    } catch {
      log.error('action-evaluate-failed');
      return Object.freeze({ enabled: false, reason: 'unknown', message: genericMessage('unknown', 'evaluate') });
    }
  }

  request(req: ActionRequest, opts?: RequestOptions): ActionStatus {
    // The caller's request and options are each read once, here. The token's binding, the pipeline, the ticket and
    // the service call all judge the same frozen copy, so an object that answers differently on each read (a
    // Proxy, a getter) cannot pass the confirmation as one action and run as another.
    let frozen: ActionRequest | undefined;
    try {
      frozen = frozenActionRequest(req);
      const confirmation = opts?.confirmation;
      const epoch = opts?.epoch;
      // A phase change the store has not reported yet still moves the epoch before the epoch check.
      this.#syncPhase();
      // Spent here, whatever the outcome below: a refused or failed attempt can never reuse the token.
      const confirmed = redeemConfirmationToken(confirmation, frozen);
      const verdict = this.#check(frozen, epoch, 'request', confirmed);
      if (!verdict.ok) return this.#refuse(frozen, verdict);
      return this.#start(verdict.plan);
    } catch {
      log.error('action-request-failed');
      return this.#refuse(frozen, {
        ok: false,
        code: 'unknown',
        message: genericMessage('unknown', 'request'),
        storable: false,
      });
    }
  }

  /** The newer of the key's accepted ticket and its visible refusal. */
  status(key: ActionKey): ActionStatus | undefined {
    return newerStatus(this.#tickets.get(key)?.status, this.#refusals.get(key));
  }

  subscribe(key: ActionKey | '*', listener: (s: ActionStatus) => void): Unsubscribe {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  recent(): readonly ActionStatus[] {
    return this.#recentView;
  }

  epoch(): number {
    return this.#epoch;
  }

  onEpochChange(listener: (epoch: number) => void): Unsubscribe {
    this.#epochListeners.add(listener);
    return () => {
      this.#epochListeners.delete(listener);
    };
  }

  invalidate(_reason: 'preview'): void {
    this.#advanceEpoch();
  }

  /** Clears a terminal status. Listeners get the dismissed status once more so every view of the key re-renders;
   *  status(key) is undefined afterwards. In-flight tickets cannot be dismissed. */
  dismiss(key: ActionKey): void {
    const shown = this.status(key);
    const ticket = this.#tickets.get(key);
    if (shown === undefined || isTicketInFlight(ticket?.status)) return;
    if (ticket !== undefined) {
      this.#tickets.delete(key);
      this.#clearTicketTimers(ticket);
    }
    this.#refusals.delete(key);
    this.#notify(shown);
  }

  /** Clears timers and settles unfinished tickets as uncertain. In-flight registry entries are KEPT until they
   *  expire, because the call may still be executing. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = undefined;
    // Epoch first: drafts and dialogs see a disposed gateway and discard as 'config' before tickets settle.
    this.#advanceEpoch();
    for (const ticket of [...this.#tickets.values()]) {
      if (isTicketInFlight(ticket.status)) {
        // No dedicated code exists for "stopped watching"; the message says the call may still complete.
        const error: ActionError = Object.freeze({
          code: 'unknown',
          message: stoppedWatchingMessage(ticket.plan.subject),
        });
        this.#settle(ticket, 'uncertain', error);
      }
      this.#clearTicketTimers(ticket);
    }
    for (const timer of this.#lockTimers) clearTimeout(timer);
    this.#lockTimers.clear();
  }

  // -----------------------------------------------------------------------------------------------------------
  // Pipeline (§4.7). First failure wins; evaluate() skips step 11 and reports it as `confirm` instead.

  /**
   * `req` is the frozen copy frozenActionRequest took (undefined when the caller's object was malformed), so step 1
   * already ran on it. `confirmed`: the request presented an unspent confirmation token bound to exactly this copy.
   */
  #check(req: ActionRequest | undefined, epoch: number | undefined, stage: Stage, confirmed: boolean): Verdict {
    // Step 0: a disposed gateway or a stale gesture sends nothing and stores nothing.
    if (this.#disposed || (epoch !== undefined && epoch !== this.#epoch)) {
      return blocked('not-sent', { stage, subject: UNNAMED_SUBJECT }, false);
    }
    // Step 1: exactly the keys of the kind's variant; no caller-supplied domain, service, data or entity_id.
    if (req === undefined) {
      if (stage === 'request') log.warn('action-request-malformed');
      return blocked('not-allowed', { stage, subject: UNNAMED_SUBJECT }, false);
    }
    // Steps 2, 2a and 3 describe the whole surface, not this control, so they are never stored as tickets.
    if (this.#isPreview()) return blocked('preview', { stage, subject: UNNAMED_SUBJECT }, false);
    if (this.#config.controls !== true) return blocked('controls-off', { stage, subject: UNNAMED_SUBJECT }, false);
    const phase = this.#reader.connection().phase;
    if (phase !== 'connected') {
      return blocked('disconnected', { stage, subject: UNNAMED_SUBJECT, resyncing: phase === 'resyncing' }, false);
    }
    return this.#checkTargets(req, stage, confirmed);
  }

  /** Steps 4–13, which need the resolved target(s). */
  #checkTargets(req: ActionRequest, stage: Stage, confirmed: boolean): Verdict {
    const spec = specFor(req);
    const configured = this.#configuredTargets(req);
    const subject = this.#subjectFor(req, spec, configured);
    const fail = (code: ActionErrorCode, extra: Partial<MessageContext> = {}): Blocked =>
      blocked(code, { stage, kind: req.kind, subject, ...extra }, true);

    // Steps 4, 5 and 5a: allowlist, domain and garage-like covers.
    const allowlist = this.#checkAllowlist(req, spec, configured);
    if (allowlist !== undefined) return fail(allowlist.code, allowlist.extra);

    // Step 5b: no switch before HA's registry arrives; settings switches never (a room leaves them out).
    const switchable = this.#switchableTargets(spec, configured);
    if ('code' in switchable) return fail(switchable.code, switchable.extra);

    // Step 6: availability. Room actions narrow to their available lights and switches.
    const gate = this.#gateTargets(spec, switchable.targets);
    if ('code' in gate) return fail(gate.code, gate.resyncing === true ? { resyncing: true } : {});
    const { targets, entities } = gate;

    // Step 7: state precondition.
    const notApplicable = spec.precondition?.(entities, req);
    if (notApplicable !== undefined) return fail('not-applicable', { notApplicable });

    // Step 8: capability.
    const capable = entities.every(
      (entity) =>
        hasFeatures(entity.attributes['supported_features'], spec.requires) && (spec.capable?.(entity) ?? true),
    );
    if (!capable) return fail('unsupported');

    // Step 9: HA offers every service the request will call. A room with one service missing sends nothing at all,
    // so it reaches one desired state or none (§18).
    const calls = planCalls(req, spec, targets);
    if (calls.some(({ call }) => !this.#reader.hasService(call.domain, call.service))) return fail('service-missing');

    // Step 10: arguments.
    const temperatureUnit = this.#reader.formatter().temperatureUnit;
    if (!argumentsValid(req, entities[0], { temperatureUnit })) return fail('invalid-argument');

    // Step 11: confirmation. request() refuses without the dialog's token; evaluate() reports `confirm`.
    const confirm = this.#needsConfirmation(req);
    if (stage === 'request' && confirm && !confirmed) {
      log.warn('action-confirmation-required');
      return blocked('confirmation-required', { stage, kind: req.kind, subject }, false);
    }

    // Step 12: sticky permission denial.
    if (targets.some((target) => this.#denied.has(denialKey(spec.family, target)))) return fail('permission-denied');

    // Step 13: lock on the key and on every target (in-flight registry, shared across gateways).
    const key = actionKeyFor(req);
    const now = this.#now();
    if (
      isTicketInFlight(this.#tickets.get(key)?.status) ||
      targets.some((target) => this.#inflight.isBusy(target, now))
    ) {
      return fail('busy');
    }

    const timeoutMs = ACTION_TIMEOUT_MS[spec.family];
    return { ok: true, plan: { req, spec, key, targets, subject, confirm, calls, timeoutMs, temperatureUnit } };
  }

  /** Step 4's target lookup: from the request's entity or from the configuration slot, never from the caller. */
  #configuredTargets(req: ActionRequest): readonly EntityId[] {
    const config = this.#config;
    switch (req.kind) {
      case 'room.lights_on':
      case 'room.lights_off': {
        const room = config.rooms[req.room];
        return room === undefined ? [] : [...room.lights, ...room.switches];
      }
      case 'garage.open':
      case 'garage.close':
        return config.garage === undefined ? [] : [config.garage.cover];
      case 'security.run': {
        const script = config.security?.actions[req.role];
        return script === undefined ? [] : [script];
      }
      case 'studio_monitors.run':
        return config.studioMonitors === undefined ? [] : [config.studioMonitors];
      case 'shortcut.run': {
        const script = config.shortcuts[req.role];
        return script === undefined ? [] : [script];
      }
      default:
        return [req.entity];
    }
  }

  /** Steps 4, 5 and 5a. Derived IDs are not in config.bindings, so they can never pass. */
  #checkAllowlist(req: ActionRequest, spec: ActionSpec, targets: readonly EntityId[]): AllowlistRefusal | undefined {
    if (targets.length === 0) return { code: 'not-allowed' };
    for (const target of targets) {
      const roles = this.#config.bindings.get(target) ?? [];
      if (!roles.some((role) => spec.roles.includes(role))) return { code: 'not-allowed' };
      // §4.2 rule 4 again: actionable roles from one family only, in case a config bypassed validation.
      const families = new Set(roles.map((role) => ACTIONABLE_ROLE_FAMILY[role]).filter(isDefined));
      if (families.size > 1) return { code: 'not-allowed' };
    }
    if (req.kind === 'security.run' && !boundToExactlyOneRole(targets[0], this.#config.security?.actions ?? {})) {
      return { code: 'not-allowed' };
    }
    if (req.kind === 'shortcut.run' && !boundToExactlyOneRole(targets[0], this.#config.shortcuts)) {
      return { code: 'not-allowed' };
    }
    const domains = spec.parts === undefined ? checkDomain(spec, targets) : this.#checkParts(spec.parts, targets);
    if (domains !== undefined) return { code: domains };
    const refused = spec.refusedDeviceClasses;
    if (refused !== undefined) {
      const garageLike = targets.some((target) => {
        const deviceClass = this.#reader.store.get(target)?.attributes['device_class'];
        return typeof deviceClass === 'string' && refused.includes(deviceClass);
      });
      if (garageLike) return { code: 'not-allowed', extra: { garageLikeCover: this.#garageLikeCover(targets) } };
    }
    return undefined;
  }

  /** The configured garage cover is moved from the Garage panel; any other garage-like cover from nowhere here. */
  #garageLikeCover(targets: readonly EntityId[]): GarageLikeCover {
    const garage = this.#config.garage?.cover;
    return garage !== undefined && targets.includes(garage) ? 'garage-panel' : 'elsewhere';
  }

  /**
   * Steps 4 and 5 for a room (§18): each target belongs to the part of its own domain and must hold that part's role,
   * so a light can never ride in the switch call or a switch in the light call.
   */
  #checkParts(parts: readonly ServicePart[], targets: readonly EntityId[]): ActionErrorCode | undefined {
    for (const target of targets) {
      const part = parts.find((candidate) => candidate.domain === domainOf(target));
      if (part === undefined) return 'domain-mismatch';
      if (!(this.#config.bindings.get(target) ?? []).includes(part.role)) return 'not-allowed';
    }
    return undefined;
  }

  /**
   * Step 5b (§18), for switch-domain targets only.
   *
   * 1. Until HA has delivered its entity registry (hass.entities starts as null), no switch can be told from a
   *    settings switch, so a switch, or a room with any switch, is refused with a visible reason. A room's switches
   *    are never dropped instead: "All off" leaving lamps on is not one desired state. Light-only rooms skip this.
   *    The gate clears at the first registry delivery ('registry' meta, which re-evaluates every control).
   * 2. A switch the registry marks as a settings or diagnostic entity (a plug's child lock or LED) is never switched.
   *    A single switch is refused; a room leaves such switches out of its target, as it does unknown ones, and is
   *    refused only when nothing else is left. A switch with no registry entry once the registry has loaded (YAML) is
   *    a lamp as far as anyone can tell, so only positive evidence refuses.
   */
  #switchableTargets(
    spec: ActionSpec,
    targets: readonly EntityId[],
  ): { readonly targets: readonly EntityId[] } | AllowlistRefusal {
    const refused = spec.refusedEntityCategories;
    if (refused === undefined || !targets.some(isSwitch)) return { targets };
    if (!this.#reader.registryLoaded()) return REGISTRY_PENDING_REFUSAL;
    const switchable = targets.filter((target) => !this.#isSettingsSwitch(target, refused));
    if (switchable.length === targets.length) return { targets };
    if (spec.target !== 'room' || switchable.length === 0) return SETTINGS_SWITCH_REFUSAL;
    return { targets: switchable };
  }

  #isSettingsSwitch(target: EntityId, refused: readonly string[]): boolean {
    if (!isSwitch(target)) return false;
    const category = this.#reader.registry(target)?.entity_category;
    return typeof category === 'string' && refused.includes(category);
  }

  /** Step 6: normalized availability. Room actions keep only available lights (unknown ones are left out). */
  #gateTargets(
    spec: ActionSpec,
    targets: readonly EntityId[],
  ): { readonly targets: readonly EntityId[]; readonly entities: readonly HassEntityLike[] } | TargetBlock {
    const store = this.#reader.store;
    const normalized = targets.map((target) => normalizeEntity(store, target));
    if (spec.target === 'room') {
      const available = normalized.filter((n) => n.status === 'available' && n.entity !== undefined);
      if (available.length === 0) return roomBlock(normalized, store.isConnected());
      return { targets: available.map((n) => n.id), entities: available.map((n) => n.entity as HassEntityLike) };
    }
    const [target] = normalized;
    if (target === undefined) return { code: 'not-allowed' };
    const block = entityBlock(target, spec, store.isConnected());
    if (block !== undefined) return block;
    return { targets: [target.id], entities: target.entity === undefined ? [] : [target.entity] };
  }

  #needsConfirmation(req: ActionRequest): boolean {
    const rule = confirmRuleFor(req);
    if (rule === 'always') return true;
    if (rule === 'never') return false;
    return !this.#alarmSounding();
  }

  /** Silence Sound skips its confirmation only while the live alarm is sounding (§7.1). */
  #alarmSounding(): boolean {
    const alarm = this.#config.security?.alarm;
    return alarm !== undefined && isAlarmSounding(alarmDisplayFor(this.#reader.store, alarm));
  }

  /** A friendly subject for messages: configured name, then HA's friendly_name, then a generic noun. */
  #subjectFor(req: ActionRequest, spec: ActionSpec, targets: readonly EntityId[]): ActionSubject {
    switch (req.kind) {
      case 'room.lights_on':
      case 'room.lights_off': {
        const room = this.#config.rooms[req.room];
        return room === undefined ? FAMILY_NOUNS.room : { name: `the ${room.name} lights`, plural: true };
      }
      case 'garage.open':
      case 'garage.close':
        return this.#config.garage === undefined
          ? FAMILY_NOUNS.garage
          : { name: this.#config.garage.name, plural: false };
      case 'security.run':
        return SECURITY_SUBJECT;
      case 'studio_monitors.run':
        return STUDIO_MONITORS_SUBJECT;
      case 'shortcut.run':
        return SHORTCUT_SUBJECTS[req.role];
      default: {
        const [target] = targets;
        if (target === undefined) return FAMILY_NOUNS[spec.family];
        const name =
          this.#names.get(target) ??
          plainText(this.#reader.store.get(target)?.attributes['friendly_name'], LIMITS.nameChars);
        return name === undefined ? FAMILY_NOUNS[spec.family] : { name, plural: false };
      }
    }
  }

  // -----------------------------------------------------------------------------------------------------------
  // Tickets

  /** `req` is the frozen copy, or undefined for a malformed request (reported as 'malformed', never echoed). */
  #refuse(req: ActionRequest | undefined, verdict: Blocked): ActionStatus {
    const at = this.#now();
    const status: ActionStatus = Object.freeze({
      id: nextTicketId++,
      key: req === undefined ? MALFORMED_KEY : actionKeyFor(req),
      kind: req === undefined ? MALFORMED_KIND : req.kind,
      phase: 'failed',
      error: Object.freeze({ code: verdict.code, message: verdict.message }),
      startedAt: at,
      settledAt: at,
    });
    // A visible failure never hides a ticket that is still in flight on the same key.
    if (verdict.storable && !this.#disposed && !isTicketInFlight(this.#tickets.get(status.key)?.status)) {
      this.#refusals.set(status.key, status);
      this.#remember(status);
      this.#notify(status);
    }
    return status;
  }

  /**
   * Accepted: snapshot `before`, create the pending ticket, lock every target, invoke each planned call ONCE (in plan
   * order, in this task, with no await between them), start the timeout.
   */
  #start(plan: Plan): ActionStatus {
    const store = this.#reader.store;
    const startedAt = this.#now();
    const previous = this.#tickets.get(plan.key);
    if (previous !== undefined) this.#clearTicketTimers(previous);
    this.#refusals.delete(plan.key);
    const ticket: Ticket = {
      status: Object.freeze({ id: nextTicketId++, key: plan.key, kind: plan.req.kind, phase: 'pending', startedAt }),
      plan,
      before: new Map(plan.targets.map((target) => [target, store.get(target)])),
      observedEarly: false,
      progressSeen: false,
      results: plan.calls.map(() => PENDING_CALL),
      contextIds: plan.calls.map(() => undefined),
      timers: new Set(),
      unobserve: undefined,
    };
    this.#tickets.set(plan.key, ticket);
    this.#inflight.mark(plan.targets, startedAt + plan.timeoutMs);
    ticket.unobserve = store.subscribe(plan.targets, [], () => this.#observe(ticket));
    this.#notify(ticket.status);
    plan.calls.forEach((planned, index) => this.#invoke(ticket, planned.call, index));
    this.#addTicketTimer(ticket, plan.timeoutMs, () => this.#onTimeout(ticket));
    return ticket.status;
  }

  #invoke(ticket: Ticket, call: ServiceCall, index: number): void {
    let pending: Promise<ServiceCallResult>;
    try {
      pending = this.#port.invoke(call);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .then(
        (result) => this.#onResolved(ticket, index, result),
        (error: unknown) => this.#onRejected(ticket, index, error),
      )
      .catch(() => log.error('action-settle-failed'));
  }

  #onResolved(ticket: Ticket, index: number, result: ServiceCallResult | undefined): void {
    if (!isTicketInFlight(ticket.status)) return;
    const contextId = result?.contextId;
    ticket.contextIds[index] = typeof contextId === 'string' && contextId !== '' ? contextId : undefined;
    ticket.results[index] = RESOLVED_CALL;
    this.#applyOutcome(ticket, false);
  }

  #onRejected(ticket: Ticket, index: number, error: unknown): void {
    if (!isTicketInFlight(ticket.status)) return;
    const mapped = mapRejection(error);
    if (mapped.code === 'bad-request') log.error('action-bad-request', ticket.plan.req.kind);
    else if (mapped.code === 'unknown') log.warn('action-rejected-unknown', ticket.plan.req.kind);
    if (mapped.code === 'permission-denied') {
      // Only this call's targets: a denied switch call keeps the room action disabled, never the room's lights.
      const denied = ticket.plan.calls[index]?.targets ?? [];
      for (const target of denied) this.#denied.add(denialKey(ticket.plan.spec.family, target));
    }
    ticket.results[index] = Object.freeze({
      state: 'rejected',
      code: mapped.code,
      notSent: mapped.notSent,
      ...(mapped.haMessage !== undefined && { haMessage: mapped.haMessage }),
      ...(mapped.haCode !== undefined && { haCode: mapped.haCode }),
    });
    this.#applyOutcome(ticket, false);
  }

  /** A call whose outcome was observed while it was pending is confirmed even if HA's reply never arrives. */
  #onTimeout(ticket: Ticket): void {
    if (!isTicketInFlight(ticket.status)) return;
    this.#applyOutcome(ticket, true);
  }

  /**
   * Settles or advances the ticket from its calls' results (aggregate.ts). The outcome holding right now confirms only
   * a request whose every call resolved, as a resolved call always did; after a lost connection or at the timeout,
   * only an outcome observed while the calls were out counts, exactly as before multi-call rooms.
   */
  #applyOutcome(ticket: Ticket, atTimeout: boolean): void {
    const allResolved = ticket.results.every((result) => result.state === 'resolved');
    const observed = ticket.observedEarly || (!atTimeout && allResolved && this.#outcomeObserved(ticket));
    const outcome = aggregateOutcome(ticket.results, observed, atTimeout);
    if (!outcome.settled) {
      if (outcome.phase === 'sent' && ticket.status.phase !== 'sent') this.#update(ticket, { phase: 'sent' });
      return;
    }
    if (outcome.phase === 'confirmed') this.#settle(ticket, 'confirmed');
    else this.#settle(ticket, outcome.phase, this.#outcomeError(ticket, outcome), outcome.partial);
  }

  /** Runs on every store change for the ticket's targets while it is pending or sent. */
  #observe(ticket: Ticket): void {
    try {
      if (!isTicketInFlight(ticket.status) || !this.#reader.store.isConnected()) return;
      const { spec } = ticket.plan;
      const entities = this.#liveTargets(ticket);
      const reversed = spec.reversed;
      if (reversed !== undefined && ticket.progressSeen && entities.some((e) => e !== undefined && reversed(e))) {
        this.#settle(ticket, 'failed', this.#errorFor(ticket, 'reversed'));
        return;
      }
      const progress = spec.progress;
      if (progress !== undefined && entities.some((e) => e !== undefined && progress(e))) {
        ticket.progressSeen = true;
        if (ticket.status.progress === undefined) this.#update(ticket, { progress: 'moving' });
      }
      if (!this.#outcomeObserved(ticket)) return;
      if (ticket.status.phase === 'pending') ticket.observedEarly = true;
      else this.#applyOutcome(ticket, false);
    } catch {
      log.error('action-observe-failed');
    }
  }

  /** Target states that count as current: live, and refreshed since any reconnect (§4.4). */
  #liveTargets(ticket: Ticket): readonly (HassEntityLike | undefined)[] {
    const store = this.#reader.store;
    return ticket.plan.targets.map((target) => (store.freshSinceResync(target) ? store.get(target) : undefined));
  }

  /** The predicate holds for every target of every call, each read with its own call's context (scripts). */
  #outcomeObserved(ticket: Ticket): boolean {
    const store = this.#reader.store;
    if (!store.isConnected()) return false;
    const { spec, req, temperatureUnit, calls } = ticket.plan;
    return calls.every((planned, index) =>
      planned.targets.every((target) => {
        const entity = store.freshSinceResync(target) ? store.get(target) : undefined;
        if (entity === undefined) return false;
        const ctx: ObservationContext = {
          req,
          before: ticket.before.get(target),
          contextId: ticket.contextIds[index],
          temperatureUnit,
        };
        return spec.confirmed(entity, ctx);
      }),
    );
  }

  /** The error of a settled uncertain or failed outcome, worded for a partly sent request when it was one (§18). */
  #outcomeError(ticket: Ticket, outcome: Extract<Outcome, { phase: 'uncertain' | 'failed' }>): ActionError {
    const message = actionMessage(outcome.code, {
      stage: 'request',
      kind: ticket.plan.req.kind,
      subject: ticket.plan.subject,
      timeoutMs: ticket.plan.timeoutMs,
      ...(outcome.partial && { partial: true }),
      ...(outcome.haMessage !== undefined && { haMessage: outcome.haMessage }),
    });
    return Object.freeze({
      code: outcome.code,
      message,
      ...(outcome.haCode !== undefined && { haCode: outcome.haCode }),
    });
  }

  #errorFor(ticket: Ticket, code: ActionErrorCode): ActionError {
    const message = actionMessage(code, {
      stage: 'request',
      kind: ticket.plan.req.kind,
      subject: ticket.plan.subject,
      timeoutMs: ticket.plan.timeoutMs,
    });
    return Object.freeze({ code, message });
  }

  #update(ticket: Ticket, change: { readonly phase?: ActionPhase; readonly progress?: 'moving' }): void {
    ticket.status = Object.freeze({ ...ticket.status, ...change });
    this.#notify(ticket.status);
  }

  /** Terminal transition. Locks clear on confirmed and failed (including reversed); an uncertain call may still be
   *  executing, so its lock stays until it expires. */
  #settle(ticket: Ticket, phase: 'confirmed' | 'uncertain' | 'failed', error?: ActionError, partial = false): void {
    const { id, key, kind, startedAt } = ticket.status;
    ticket.status = Object.freeze({
      id,
      key,
      kind,
      phase,
      startedAt,
      settledAt: this.#now(),
      ...(error !== undefined && { error }),
      ...(partial && { partial: true as const }),
    });
    this.#clearTicketTimers(ticket);
    ticket.unobserve?.();
    ticket.unobserve = undefined;
    if (phase !== 'uncertain') this.#inflight.clear(ticket.plan.targets);
    if (!this.#disposed) {
      if (phase === 'confirmed') this.#addTicketTimer(ticket, CONFIRMED_DISPLAY_MS, () => this.#autoDismiss(ticket));
      if (phase === 'uncertain') this.#signalLockExpiry(ticket);
    }
    this.#remember(ticket.status);
    this.#notify(ticket.status);
  }

  #autoDismiss(ticket: Ticket): void {
    if (this.status(ticket.status.key) === ticket.status) this.dismiss(ticket.status.key);
  }

  /** Controls stay `busy` while an uncertain call's lock lasts; re-notify when it ends so views re-evaluate. */
  #signalLockExpiry(ticket: Ticket): void {
    const lockEnd = ticket.status.startedAt + ticket.plan.timeoutMs;
    const remaining = lockEnd - this.#now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      this.#lockTimers.delete(timer);
      // A newer ticket on the key has its own notifications; otherwise views may still show `busy`.
      const current = this.#tickets.get(ticket.status.key);
      if (current === undefined || current === ticket) this.#notify(ticket.status);
    }, remaining + LOCK_EXPIRY_MARGIN_MS);
    this.#lockTimers.add(timer);
  }

  #addTicketTimer(ticket: Ticket, delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      ticket.timers.delete(timer);
      try {
        run();
      } catch {
        log.error('action-timer-failed');
      }
    }, delayMs);
    ticket.timers.add(timer);
  }

  #clearTicketTimers(ticket: Ticket): void {
    for (const timer of ticket.timers) clearTimeout(timer);
    ticket.timers.clear();
  }

  #remember(status: ActionStatus): void {
    this.#recent = [status, ...this.#recent].slice(0, RECENT_LIMIT);
    this.#recentView = Object.freeze([...this.#recent]);
  }

  #notify(status: ActionStatus): void {
    const listeners = [...(this.#listeners.get(status.key) ?? []), ...(this.#listeners.get('*') ?? [])];
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        log.error('action-listener-failed');
      }
    }
  }

  // -----------------------------------------------------------------------------------------------------------
  // Epoch and meta

  #onMetaChange(change: HostChange): void {
    try {
      if (change.meta.has('connection')) this.#syncPhase();
      if (change.meta.has('user')) this.#denied.clear();
    } catch {
      log.error('action-meta-failed');
    }
  }

  /** Leaving 'connected' (to disconnected, loading or resyncing) moves the epoch, discarding drafts and dialogs. */
  #syncPhase(): void {
    const phase = this.#reader.connection().phase;
    const left = this.#lastPhase === 'connected' && phase !== 'connected';
    this.#lastPhase = phase;
    if (left) this.#advanceEpoch();
  }

  #advanceEpoch(): void {
    this.#epoch += 1;
    for (const listener of [...this.#epochListeners]) {
      try {
        listener(this.#epoch);
      } catch {
        log.error('epoch-listener-failed');
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------------------
// Pure helpers

function blocked(code: ActionErrorCode, ctx: MessageContext, storable: boolean): Blocked {
  return { ok: false, code, message: actionMessage(code, ctx), storable };
}

function genericMessage(code: ActionErrorCode, stage: Stage): string {
  return actionMessage(code, { stage, subject: UNNAMED_SUBJECT });
}

function denialKey(family: ActionFamily, target: EntityId): string {
  return `${family}|${target}`;
}

function isSwitch(target: EntityId): boolean {
  return domainOf(target) === 'switch';
}

/** Step 5 for single-target specs: the target is in the spec's own domain. */
function checkDomain(spec: ActionSpec, targets: readonly EntityId[]): ActionErrorCode | undefined {
  return targets.some((target) => domainOf(target) !== spec.domain) ? 'domain-mismatch' : undefined;
}

/**
 * §4.2 rules 6 and 12b at request time: one script per role, so Silence Sound can never run a disarm and the lights
 * shortcut can never run the curtains script.
 */
function boundToExactlyOneRole(
  script: EntityId | undefined,
  roles: Readonly<Partial<Record<string, EntityId>>>,
): boolean {
  return script !== undefined && Object.values(roles).filter((bound) => bound === script).length === 1;
}

/**
 * The calls for the request's available targets. A single-target spec makes one call naming its one entity. A room
 * makes one call per part with an available target, in part order (lights, then switches), each naming that part's
 * targets in configuration order, so a light-only room's call is exactly what it always was.
 */
function planCalls(req: ActionRequest, spec: ActionSpec, targets: readonly EntityId[]): readonly PlannedCall[] {
  const data = Object.freeze({ ...spec.data(req) });
  if (spec.parts === undefined) {
    const [single] = targets;
    const call: ServiceCall = Object.freeze({
      domain: spec.domain,
      service: spec.service,
      data,
      target: Object.freeze({ entity_id: single ?? Object.freeze([...targets]) }),
    });
    return Object.freeze([Object.freeze({ call, targets: Object.freeze([...targets]) })]);
  }
  const calls = spec.parts.flatMap((part) => {
    const partTargets = Object.freeze(targets.filter((target) => domainOf(target) === part.domain));
    if (partTargets.length === 0) return [];
    const call: ServiceCall = Object.freeze({
      domain: part.domain,
      service: part.service,
      data,
      target: Object.freeze({ entity_id: partTargets }),
    });
    return [Object.freeze({ call, targets: partTargets })];
  });
  return Object.freeze(calls);
}

/**
 * A step 6 refusal. `resyncing` marks a target whose object is still the resync base's: the store is connected, but
 * the reconnect snapshot has not replaced that entity (yet), so the honest copy is "Paused until Home Assistant
 * sends current states". A slow snapshot (§15 #25) and an entity deleted during the outage look the same from
 * here, so neither is called missing.
 */
interface TargetBlock {
  readonly code: ActionErrorCode;
  readonly resyncing?: true;
}

const NOT_YET_REFRESHED: TargetBlock = Object.freeze({ code: 'disconnected', resyncing: true });

/** Step 6 for one target. Unknown passes only where the catalog allows it; the garage always denies. */
function entityBlock(target: NormalizedEntity, spec: ActionSpec, storeConnected: boolean): TargetBlock | undefined {
  switch (target.status) {
    case 'available':
      return undefined;
    case 'unknown':
      return spec.unknownState === 'allow' ? undefined : { code: 'state-unknown' };
    case 'missing-binding':
      return { code: 'missing-entity' };
    case 'disconnected':
      // A live store with a stale object: the reconnect snapshot has not replaced this entity.
      return storeConnected ? NOT_YET_REFRESHED : { code: 'disconnected' };
    default:
      return { code: 'unavailable' };
  }
}

/** Step 6 for a room with no available light: unknown, then unavailable, then not yet refreshed, then missing. */
function roomBlock(lights: readonly NormalizedEntity[], storeConnected: boolean): TargetBlock {
  const statuses = new Set<EntityStatus>(lights.map((light) => light.status));
  if (lights.length === 0) return { code: 'not-allowed' };
  if (statuses.has('unknown')) return { code: 'state-unknown' };
  if (statuses.has('unavailable') || statuses.has('loading')) return { code: 'unavailable' };
  if (statuses.has('disconnected')) return storeConnected ? NOT_YET_REFRESHED : { code: 'disconnected' };
  return { code: 'missing-entity' };
}

function configuredNames(config: ResolvedConfig): ReadonlyMap<EntityId, string> {
  const names = new Map<EntityId, string>();
  for (const ref of [...config.climate, ...config.air, ...config.media, ...config.vacuums]) {
    if (ref.name !== undefined) names.set(ref.entity, ref.name);
  }
  return names;
}
