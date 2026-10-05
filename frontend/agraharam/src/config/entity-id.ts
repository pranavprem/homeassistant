/**
 * Entity ID checks. Erasable syntax only and no imports outside src/config: the private-config generator and
 * the public scanner import this file through Node type stripping.
 */

/** HA core's MAX_LENGTH_STATE_ENTITY_ID. */
const MAX_ENTITY_ID_LENGTH = 255;

// Equivalent to HA core's valid_entity_id pattern, written WITHOUT lookbehind: core's literal pattern uses a
// negative lookbehind for the trailing underscore, which is a parse-time SyntaxError for the whole bundle on
// Safari < 16.4. Each part is lowercase alphanumeric runs joined by single underscores: no leading, trailing or
// doubled underscore.
const SLUG_RE = /^[\da-z]+(?:_[\da-z]+)*$/;

export function isValidEntityId(s: string): boolean {
  if (s.length > MAX_ENTITY_ID_LENGTH) return false;
  const dot = s.indexOf('.');
  if (dot <= 0 || dot !== s.lastIndexOf('.')) return false;
  return SLUG_RE.test(s.slice(0, dot)) && SLUG_RE.test(s.slice(dot + 1));
}

/** The part before the first dot, or '' when there is none. */
export function domainOf(id: string): string {
  const dot = id.indexOf('.');
  return dot === -1 ? '' : id.slice(0, dot);
}
