/**
 * User-facing copy per ActionErrorCode (§7.3) and per not-applicable reason (§7.1). `{name}` is always a friendly
 * subject (a configured name, the entity's friendly_name, or a generic noun), never an entity ID. The garage's and the
 * security controller's own timeout and reversal lines live here too: panels never word an outcome themselves, they
 * show the ticket's message (model/action-copy.ts ticketPhaseCopy).
 *
 * Runtime text (names, HA messages) is returned as plain strings; Lit text bindings escape it when rendered.
 */
import type { NotApplicableReason } from './catalog.ts';
import type { ActionErrorCode, ActionKind } from './types.ts';

/** Who an action is about, for message wording. `plural` picks verb agreement ("The Kitchen lights are …"). */
export interface ActionSubject {
  readonly name: string;
  readonly plural: boolean;
}

export interface MessageContext {
  readonly kind?: ActionKind;
  readonly subject: ActionSubject;
  /** evaluate() reports a paused control; request() reports a refused or failed tap. */
  readonly stage: 'evaluate' | 'request';
  /** The connection phase was resyncing (the socket is back, current states have not arrived). */
  readonly resyncing?: boolean;
  /** HA's message, already sanitized by error-map.ts. */
  readonly haMessage?: string;
  readonly timeoutMs?: number;
  readonly notApplicable?: NotApplicableReason;
  /**
   * A garage, gate or door cover was asked to move through a curtain control (§4.7 step 5a): 'garage-panel' when it
   * is the configured garage cover (the Garage panel moves it, behind its confirmation), 'elsewhere' otherwise.
   */
  readonly garageLikeCover?: GarageLikeCover;
  /** A settings or diagnostic switch (registry entity_category) was asked to switch (§4.7 step 5b, §18). */
  readonly settingsSwitch?: boolean;
  /** HA has not delivered its entity registry yet, so no switch can be told from a settings switch (step 5b). */
  readonly registryPending?: boolean;
  /**
   * A request of several calls where some went out and the rest did not (§18): the message must never claim that
   * nothing changed. `code` then names why the rest failed.
   */
  readonly partial?: boolean;
}

/** Used when a request is malformed or names nothing configured, so there is no friendly name to show. */
export const UNNAMED_SUBJECT: ActionSubject = Object.freeze({ name: 'this device', plural: false });

export const NOT_APPLICABLE_COPY: Readonly<Record<NotApplicableReason, string>> = Object.freeze({
  'already-on': 'Already on',
  'already-off': 'Already off',
  'all-lights-on': 'All lights are already on',
  'all-lights-off': 'All lights are already off',
  'current-mode': 'Current mode',
  'current-preset': 'Current preset',
  'current-source': 'Current source',
  'already-cleaning': 'Already cleaning',
  'not-cleaning': 'Not cleaning right now',
  'already-docked': 'Already docked',
  'already-returning': 'Already returning to the dock',
  'already-open': 'Already open',
  'already-closed': 'Already closed',
  'already-opening': 'Already opening',
  'already-closing': 'Already closing',
  'door-moving': 'The door is moving. Wait until it stops.',
  'already-playing': 'Already playing',
  'not-playing': 'Not playing',
  'nothing-playing': 'Nothing is playing',
  'player-off': 'The player is off',
  'already-running': 'Already running',
});

const MS_PER_SECOND = 1000;

/**
 * The security controller's own timeout line (§8.2). The UI never claims an arm or disarm happened ("Requested");
 * only the live Alarm row reports it.
 */
export const SECURITY_TICKET_COPY = Object.freeze({
  uncertain: 'No response from the security controller after 10 seconds. Check the alarm state before trying again.',
});

/** The garage's own timeout and reversal lines (§8.5), for the requested direction. */
export const GARAGE_TICKET_COPY = Object.freeze({
  uncertainOpen: "The door hasn't reported open after 60 seconds. Check the garage before trying again.",
  uncertainClose: "The door hasn't reported closed after 60 seconds. Check the garage before trying again.",
  reversedClose: 'The door reversed and is opening again. Check the doorway before trying again.',
  reversedOpen: 'The door stopped opening and is closing again. Check the garage before trying again.',
});

const DISCONNECTED_COPY = Object.freeze({
  paused: 'Paused while Home Assistant is disconnected.',
  resyncing: 'Paused until Home Assistant sends current states.',
  notSent: 'Not sent: Home Assistant was disconnected. Nothing was changed.',
  notSentResyncing: 'Not sent: paused until Home Assistant sends current states. Nothing was changed.',
});
/** Which garage-like cover a curtain control refused (§4.7 step 5a); it picks the accurate copy below. */
export type GarageLikeCover = 'garage-panel' | 'elsewhere';
/**
 * Room controls never move garage, gate or door covers, because curtain actions have no confirmation. Only the
 * configured garage cover has a place that does move it; any other such cover has none on this dashboard.
 */
export const GARAGE_LIKE_COVER_COPY: Readonly<Record<GarageLikeCover, string>> = Object.freeze({
  'garage-panel': 'This garage door is moved from the Garage panel, which asks for confirmation first.',
  elsewhere: "Garage, gate and door covers can't be moved from this dashboard.",
});
/**
 * Step 5b.1 (§18): until HA has delivered its entity registry, a switch cannot be told from a settings switch, so
 * switch controls, and room actions in rooms with switches, wait. `control` words the disabled reason; `notice` is the
 * one line a panel shows when that is the reason its controls are disabled.
 */
export const REGISTRY_PENDING_COPY = Object.freeze({
  control: (name: string): string => `Waiting for Home Assistant's device list before switching ${name}.`,
  notice: "Lamp switches are waiting for Home Assistant's device list.",
});
/** Step 5b.2: a plug's settings switch (child lock, LED) listed in a room is never switched from the dashboard. */
export const SETTINGS_SWITCH_COPY = "This is a settings switch, not a lamp, so it can't be switched from here.";
export const GARAGE_STATE_UNKNOWN_COPY =
  "The garage door hasn't reported its position, so it can't be moved from here.";
/** A disposed gateway stops watching; the call itself may still complete. */
const STOPPED_WATCHING_COPY = (name: string): string =>
  `${name} hadn't confirmed when the dashboard stopped watching. It may still respond. Check it before trying again.`;

/** Verb forms that follow `{name}`, so plural subjects read naturally. */
function verbs(subject: ActionSubject): {
  readonly is: string;
  readonly was: string;
  readonly has: string;
  readonly does: string;
  readonly its: string;
  readonly it: string;
  readonly accepts: string;
} {
  return subject.plural
    ? { is: 'are', was: 'were', has: 'have', does: 'do', its: 'their', it: 'they', accepts: 'accept' }
    : { is: 'is', was: 'was', has: 'has', does: 'does', its: 'its', it: 'it', accepts: 'accepts' };
}

/** The message for an error code in context. Always starts with a capital letter. */
export function actionMessage(code: ActionErrorCode, ctx: MessageContext): string {
  return capitalize(ctx.partial === true ? partialMessage(code, ctx) : rawMessage(code, ctx));
}

/**
 * Part of a room action went out and the rest did not (§18). Some lighting may have switched, so the copy never says
 * nothing changed; it says why the rest failed and asks for a look before trying again.
 */
function partialMessage(code: ActionErrorCode, ctx: MessageContext): string {
  return `Some of ${ctx.subject.name} may have switched, but ${partialClause(code, ctx)}. Check the room before trying again.`;
}

function partialClause(code: ActionErrorCode, ctx: MessageContext): string {
  switch (code) {
    case 'permission-denied':
      return "your Home Assistant user can't control the rest";
    case 'disconnected':
      return "the rest wasn't sent because Home Assistant disconnected";
    default:
      return ctx.haMessage === undefined
        ? "Home Assistant didn't accept the rest"
        : `Home Assistant didn't accept the rest (${withoutFinalPeriod(ctx.haMessage)})`;
  }
}

/** The message shown when the gateway stopped watching an unsettled ticket (dispose). */
export function stoppedWatchingMessage(subject: ActionSubject): string {
  return capitalize(STOPPED_WATCHING_COPY(subject.name));
}

function rawMessage(code: ActionErrorCode, ctx: MessageContext): string {
  const name = ctx.subject.name;
  const v = verbs(ctx.subject);
  switch (code) {
    case 'disconnected':
      return disconnectedMessage(ctx);
    case 'preview':
      return 'Controls are off while you edit the dashboard.';
    case 'controls-off':
      return 'Controls are turned off in the dashboard configuration.';
    case 'not-allowed':
      if (ctx.garageLikeCover !== undefined) return GARAGE_LIKE_COVER_COPY[ctx.garageLikeCover];
      if (ctx.settingsSwitch === true) return SETTINGS_SWITCH_COPY;
      return `This control isn't set up for ${name} in the dashboard configuration.`;
    case 'domain-mismatch':
      return `This control isn't set up for ${name} in the dashboard configuration.`;
    case 'missing-entity':
      // Household copy: what to check in the configuration is a Diagnostics matter (every binding and its status).
      return `${name} ${v.was}n't found in Home Assistant.`;
    case 'unavailable':
      return `${name} ${v.is} unavailable right now.`;
    case 'state-unknown':
      if (isGarage(ctx.kind)) return GARAGE_STATE_UNKNOWN_COPY;
      if (ctx.registryPending === true) return REGISTRY_PENDING_COPY.control(name);
      return `${name} ${v.has}n't reported ${v.its} state, so this control is paused until ${v.it} ${v.does}.`;
    case 'not-applicable':
      return ctx.notApplicable === undefined ? 'Not available right now.' : NOT_APPLICABLE_COPY[ctx.notApplicable];
    case 'unsupported':
      return `${name} ${v.does}n't support this control.`;
    case 'service-missing':
      return "Home Assistant isn't offering this control right now. The integration may still be loading.";
    case 'invalid-argument':
      return `That value is outside what ${name} ${v.accepts}.`;
    case 'confirmation-required':
      return 'Confirm this action first.';
    case 'busy':
      return `Waiting for ${name} to respond to the last request.`;
    case 'permission-denied':
      return `Your Home Assistant user can't control ${name}. Ask an administrator for access.`;
    case 'not-sent':
      return 'Not sent. Nothing was changed. Use the control again to send it.';
    case 'reversed':
      return reversedMessage(ctx);
    case 'rejected':
      return ctx.haMessage === undefined
        ? "Home Assistant didn't accept the request."
        : `Home Assistant didn't accept the request: ${ctx.haMessage}`;
    case 'bad-request':
      return "The dashboard sent a request Home Assistant couldn't read. Nothing changed. Please report this.";
    case 'device-error':
      return ctx.haMessage === undefined
        ? `${name} reported an error. Check the device, then try again.`
        : `${name} reported an error: ${withoutFinalPeriod(ctx.haMessage)}. Check the device, then try again.`;
    case 'connection-lost':
      return `The connection dropped while sending. The request may or may not have reached ${name}. Check it before trying again.`;
    case 'timeout':
      return timeoutMessage(ctx);
    case 'unknown':
      return 'Something went wrong sending the request. Nothing will be retried automatically.';
  }
}

function disconnectedMessage(ctx: MessageContext): string {
  const resyncing = ctx.resyncing === true;
  if (ctx.stage === 'request') return resyncing ? DISCONNECTED_COPY.notSentResyncing : DISCONNECTED_COPY.notSent;
  return resyncing ? DISCONNECTED_COPY.resyncing : DISCONNECTED_COPY.paused;
}

/** §8.5 garage copy; the generic §7.3 line for anything else that can reverse. */
function reversedMessage(ctx: MessageContext): string {
  if (ctx.kind === 'garage.open') return GARAGE_TICKET_COPY.reversedOpen;
  if (ctx.kind === 'garage.close') return GARAGE_TICKET_COPY.reversedClose;
  return `${ctx.subject.name} reversed before finishing. Check it before trying again.`;
}

/** §8.5 garage and §8.2 security copy; the generic §7.3 line otherwise. */
function timeoutMessage(ctx: MessageContext): string {
  if (ctx.kind === 'garage.open') return GARAGE_TICKET_COPY.uncertainOpen;
  if (ctx.kind === 'garage.close') return GARAGE_TICKET_COPY.uncertainClose;
  if (ctx.kind === 'security.run') return SECURITY_TICKET_COPY.uncertain;
  const seconds = Math.round((ctx.timeoutMs ?? 0) / MS_PER_SECOND);
  return `${ctx.subject.name} didn't confirm within ${seconds} seconds. It may still respond. Check it before trying again.`;
}

function isGarage(kind: ActionKind | undefined): boolean {
  return kind === 'garage.open' || kind === 'garage.close';
}

function withoutFinalPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
