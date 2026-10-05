/** The one type guard for dropping `undefined` from a list: `items.filter(isDefined)`. */
export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
