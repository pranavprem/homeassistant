/**
 * Demo card input (§4.2 rule 9, §10.2): the generic merge of the section fixtures' config fragments, plus
 * `controls: true`. It has no `demo` key; the root validates it to obtain the runtime config in demo mode.
 *
 * Dev-boundary note (§10.3): FakeHass imports this file, so it imports only fixtures, types and src/config.
 */
import type { CardConfigInput, DemoScenarioId } from '../config/schema.ts';
import { SECTION_FIXTURES } from './fixtures/index.ts';

export const CARD_TYPE = 'custom:agraharam-dashboard';

/** A config fragment tagged with the fixture that produced it, so a conflict names both owners. */
interface NamedFragment {
  readonly owner: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export function demoCardInput(id: DemoScenarioId): CardConfigInput {
  const fragments = Object.entries(SECTION_FIXTURES).map(([owner, fixture]) => ({ owner, value: fixture.config(id) }));
  return { type: CARD_TYPE, ...mergeConfigFragments(fragments), controls: true };
}

/**
 * Deep merge for fixture config fragments (§10.2): arrays concatenate, mappings merge, and two fixtures setting
 * the same scalar is a fixture bug, reported by throwing (the scenario tests fail on it).
 */
export function mergeConfigFragments(fragments: readonly NamedFragment[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  for (const { owner, value } of fragments) mergeInto(merged, value, '', owner, owners);
  return merged;
}

function mergeInto(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
  path: string,
  owner: string,
  owners: Map<string, string>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const at = path === '' ? key : `${path}.${key}`;
    const existing = target[key];
    if (existing === undefined) {
      target[key] = cloneValue(value);
      owners.set(at, owner);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value.map(cloneValue)];
    } else if (isMapping(existing) && isMapping(value)) {
      mergeInto(existing, value, at, owner, owners);
    } else {
      throw new Error(`Demo fixtures ${owners.get(at) ?? 'unknown'} and ${owner} both set "${at}".`);
    }
  }
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isMapping(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  return value;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
