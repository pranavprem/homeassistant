/**
 * HA rejection → ActionError code (§4.7). hass.callService rejects with HA's `{ code, message }` result error, with
 * home-assistant-js-websocket's bare ERR_CONNECTION_LOST (3), or, from our own ServicePort, with PortNotSent when
 * the port refused to call at all. Pure: the gateway logs and records sticky denials.
 */
import type { PortNotSent } from '../host.ts';
import type { ActionErrorCode } from './types.ts';

/** home-assistant-js-websocket ERR_CONNECTION_LOST: the socket closed while the message was being sent. */
const HAJS_CONNECTION_LOST = 3;
/** §4.7: HA's message is shown as text, capped at 160 characters. */
export const HA_MESSAGE_MAX_CHARS = 160;
/** HA messages are short; anything longer is cut before the entity-ID scan so a huge payload costs nothing. */
const HA_MESSAGE_SCAN_MAX_CHARS = 1_000;
const ELLIPSIS = '…';
const UNAUTHORIZED_MESSAGE = 'Unauthorized';
// C0 and C1 control characters plus bidirectional overrides, which could visually reorder the quoted text.
// Whitespace among them is collapsed to a single space first.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const WHITESPACE_RE = /\s+/g;
/**
 * An entity ID or `domain.service` token in HA's text ("Entity cover.demo_x does not support action
 * cover.open_cover"): a `domain.object_id` pair of lowercase slugs, the domain starting with a letter (so "21.5"
 * stays), not part of a longer dotted run. A list of them ("light.demo_a, light.demo_b and light.demo_c") is one
 * match, separators included. No lookbehind (§1.2 item 11): the character before is captured and put back.
 */
const ID_PATTERN = '[a-z][a-z\\d]*(?:_[a-z\\d]+)*\\.[a-z\\d]+(?:_[a-z\\d]+)*';
const ENTITY_ID_RUN_RE = new RegExp(
  `(^|[^\\w.])${ID_PATTERN}(?:(?:\\s*,\\s*|\\s+(?:and|or)\\s+)${ID_PATTERN})*(?!\\w|\\.\\w)`,
  'g',
);
/** Quotes or brackets left empty once an ID inside them is removed ("Entity '' not found"). */
const EMPTY_PAIR_RE = /(["'`])\s*\1|\u201c\s*\u201d|\u2018\s*\u2019|\(\s*\)|\[\s*\]/g;
const SPACE_BEFORE_PUNCTUATION_RE = /\s+([.,;:!?])/g;
const LEADING_PUNCTUATION_RE = /^[\s.,;:]+/;

type RejectionOutcome = 'failed' | 'uncertain';

interface MappedRejection {
  readonly code: ActionErrorCode;
  /** `uncertain` when the request may have reached HA; `failed` when it certainly changed nothing. */
  readonly outcome: RejectionOutcome;
  /** The port refused before calling: the copy may truthfully say nothing was sent. */
  readonly notSent: boolean;
  /** HA's error code (or the hajs number), for diagnostics only. */
  readonly haCode?: string | number;
  /** HA's message, sanitized and capped; only for codes whose copy quotes it. */
  readonly haMessage?: string;
}

export function isPortNotSent(error: unknown): error is PortNotSent {
  return typeof error === 'object' && error !== null && (error as { portError?: unknown }).portError === 'not-sent';
}

/**
 * Maps a rejection: `not_found` → service-missing; `invalid_format` → bad-request (our bug);
 * `service_validation_error` → rejected (quoting HA); Unauthorized → permission-denied; any other
 * `home_assistant_error` → device-error (quoting HA); a connection loss → connection-lost (uncertain);
 * anything else → unknown.
 */
export function mapRejection(error: unknown): MappedRejection {
  if (isPortNotSent(error)) return { code: 'disconnected', outcome: 'failed', notSent: true };
  const { code, message } = haError(error);
  if (code === HAJS_CONNECTION_LOST) {
    // Probably never sent, but "nothing changed" must not rest on a library detail (§4.7): uncertain.
    return { code: 'connection-lost', outcome: 'uncertain', notSent: false, haCode: code };
  }
  if (code === 'unauthorized' || (code === 'home_assistant_error' && message === UNAUTHORIZED_MESSAGE)) {
    return { code: 'permission-denied', outcome: 'failed', notSent: false, haCode: code };
  }
  switch (code) {
    case 'not_found':
      return { code: 'service-missing', outcome: 'failed', notSent: false, haCode: code };
    case 'invalid_format':
      return { code: 'bad-request', outcome: 'failed', notSent: false, haCode: code };
    case 'service_validation_error':
      return withMessage({ code: 'rejected', outcome: 'failed', notSent: false, haCode: code }, message);
    case 'home_assistant_error':
      return withMessage({ code: 'device-error', outcome: 'failed', notSent: false, haCode: code }, message);
    default:
      return {
        code: 'unknown',
        outcome: 'failed',
        notSent: false,
        ...(code !== undefined && { haCode: code }),
      };
  }
}

/**
 * HA's message as shown in normal UI: plain text (see plainText) with every entity-ID-shaped token removed, then
 * capped at HA_MESSAGE_MAX_CHARS. HA words errors with raw IDs ("Entity cover.demo_x does not support action …"), and
 * the dashboard never shows an entity ID outside Diagnostics (§7.3). Undefined when nothing readable remains, so the
 * caller falls back to its own copy.
 */
export function sanitizeHaMessage(raw: unknown): string | undefined {
  const text = plainText(raw, HA_MESSAGE_SCAN_MAX_CHARS);
  return text === undefined ? undefined : plainText(withoutEntityIds(text), HA_MESSAGE_MAX_CHARS);
}

/** Removes entity-ID-shaped tokens and tidies only what they leave behind (empty quotes, stray spaces). */
export function withoutEntityIds(text: string): string {
  const stripped = text.replace(ENTITY_ID_RUN_RE, '$1');
  if (stripped === text) return text;
  return stripped
    .replace(EMPTY_PAIR_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .replace(SPACE_BEFORE_PUNCTUATION_RE, '$1')
    .replace(LEADING_PUNCTUATION_RE, '')
    .trim();
}

/**
 * Runtime text (an HA message, a friendly_name) as plain, single-line text: control and bidirectional-override
 * characters removed, whitespace collapsed, at most `maxChars` characters. Undefined when nothing printable remains.
 * Escaping happens at render time (Lit text bindings), so no markup is added or removed here.
 */
export function plainText(raw: unknown, maxChars: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(WHITESPACE_RE, ' ').replace(CONTROL_CHARS_RE, '').trim();
  if (text === '') return undefined;
  const characters = [...text];
  if (characters.length <= maxChars) return text;
  return (
    characters
      .slice(0, maxChars - 1)
      .join('')
      .trimEnd() + ELLIPSIS
  );
}

function withMessage(mapped: MappedRejection, message: unknown): MappedRejection {
  const haMessage = sanitizeHaMessage(message);
  return haMessage === undefined ? mapped : { ...mapped, haMessage };
}

/** Reads `{ code, message }`, unwrapping `{ error: { code, message } }`; a bare number is the hajs code. */
function haError(error: unknown): { readonly code?: string | number; readonly message?: unknown } {
  if (typeof error === 'number') return { code: error };
  if (typeof error !== 'object' || error === null) return {};
  const nested = (error as { error?: unknown }).error;
  const source = typeof nested === 'object' && nested !== null ? nested : error;
  const code = (source as { code?: unknown }).code;
  return {
    ...((typeof code === 'string' || typeof code === 'number') && { code }),
    message: (source as { message?: unknown }).message,
  };
}
