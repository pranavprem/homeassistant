/**
 * The only console access in src (§4.9). Callers pass a short kebab-case code and, at most, a few primitive
 * details such as version strings. Never pass objects, errors, URLs, entity IDs or HA messages: they can carry
 * access tokens and household data into browser logs and bug reports.
 */
type LogDetail = string | number | boolean;

const PREFIX = '[agraharam]';

export const log = Object.freeze({
  warn(code: string, ...details: readonly LogDetail[]): void {
    console.warn(PREFIX, code, ...details);
  },
  error(code: string, ...details: readonly LogDetail[]): void {
    console.error(PREFIX, code, ...details);
  },
});

/**
 * Wraps an event handler or callback so an exception is logged by `code` instead of escaping (§4.9 rule 2): HA's
 * logging mixin would turn an uncaught error into a system_log.write service call made on our behalf.
 */
export function contained<A extends readonly unknown[]>(
  code: string,
  handler: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      handler(...args);
    } catch {
      log.error(code);
    }
  };
}
