/**
 * Backwards compatibility of the configuration contract (§18 compatibility contract, design §2). Every config that
 * existed at cf0c182 must resolve exactly as it did then, plus only the new defaults: `rooms[].switches: []`,
 * `collections: []`, `shortcuts: {}` and `vehicle.model: 'generic'` when a vehicle exists. The bindings (the gateway
 * allowlist and the subscription set) and the runtime key must not change, so no deployed config gains a role or a
 * control.
 *
 * `fixtures/cf0c182-configs.json` was captured from an exported archive of cf0c182 (never a worktree): the inputs are
 * the nine demo inputs, demo mode for each scenario, both install/ example dashboards and the private-config
 * generator's output for tests/scripts/fixtures/candidates.fictional.json (with and without
 * install/overrides.example.json); each case holds the input, the resolved config (bindings as an object) and the
 * warnings. All data is fictional (`*.demo_*`). The inputs are frozen here on purpose: the live demo fixtures and
 * example YAML gain the new keys, and this file proves the old shapes still mean the same thing.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { runtimeKey } from '../../src/ha/host.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface CompatCase {
  readonly id: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly resolved: JsonObject;
  readonly warnings: Json[];
}

const SNAPSHOT = JSON.parse(
  readFileSync(resolvePath(process.cwd(), 'tests/compat/fixtures/cf0c182-configs.json'), 'utf8'),
) as {
  readonly capturedFrom: string;
  readonly cases: readonly CompatCase[];
};

/** The minimum the snapshot must hold, so a truncated fixture can never pass vacuously. */
const EXPECTED_CASE_IDS = [
  ...['normal', 'degraded', 'offline', 'empty', 'alert', 'loading', 'restricted', 'starting', 'dense'].flatMap(
    (scenario) => [`demo-input:${scenario}`, `demo-mode:${scenario}`],
  ),
  'install/dashboard.example.yaml#0',
  'install/dashboard.demo.yaml#0',
  'generator:candidates.fictional',
  'generator:candidates.fictional+overrides.example',
];

/** `bindings` is a read-only map view, not a Map instance, so a map is recognized by its methods. */
function isMapLike(value: unknown): value is ReadonlyMap<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<ReadonlyMap<string, unknown>>).entries === 'function' &&
    typeof (value as Partial<ReadonlyMap<string, unknown>>).get === 'function'
  );
}

/** A resolved config as plain JSON, with the bindings map as an object (as the snapshot stores it). */
function serialize(value: unknown): JsonObject {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (isMapLike(item) ? Object.fromEntries(item.entries()) : item)),
  ) as JsonObject;
}

/** What cf0c182 resolved, plus exactly the new defaults and nothing else. */
function withNewDefaults(old: JsonObject): JsonObject {
  const rooms = (old['rooms'] as JsonObject[]).map((room) => ({ ...room, switches: [] }));
  const vehicle = old['vehicle'] as JsonObject | undefined;
  return {
    ...old,
    rooms,
    ...(vehicle !== undefined && { vehicle: { ...vehicle, model: 'generic' } }),
    shortcuts: {},
    collections: [],
  };
}

function resolve(input: JsonObject) {
  const result = validateConfig(structuredClone(input));
  if (!result.ok) throw new Error(`no longer valid: ${JSON.stringify(result.issues)}`);
  return result;
}

describe('the cf0c182 snapshot', () => {
  it('was captured from cf0c182 and holds every expected case, with rooms and a vehicle among them', () => {
    expect(SNAPSHOT.capturedFrom).toBe('cf0c182');
    expect(SNAPSHOT.cases.map((item) => item.id).sort()).toEqual([...EXPECTED_CASE_IDS].sort());
    expect(SNAPSHOT.cases.some((item) => (item.resolved['rooms'] as Json[]).length > 0)).toBe(true);
    expect(SNAPSHOT.cases.some((item) => item.resolved['vehicle'] !== undefined)).toBe(true);
    expect(SNAPSHOT.cases.some((item) => item.resolved['vehicle'] === undefined)).toBe(true);
  });
});

describe.each(SNAPSHOT.cases.map((item) => [item.id, item] as const))('%s', (_id, item) => {
  it('still validates, with the same warnings', () => {
    expect(serialize(resolve(item.input).warnings)).toEqual(item.warnings);
  });

  it('resolves to the cf0c182 config plus only the new defaults', () => {
    expect(serialize(resolve(item.input).config)).toEqual(withNewDefaults(item.resolved));
  });

  it('gains no airspace key at all: JSON would hide an undefined one (AIRSPACE.md §1)', () => {
    expect(Object.hasOwn(resolve(item.input).config, 'airspace')).toBe(false);
  });

  it('keeps the bindings (allowlist and subscriptions) and the runtime key unchanged', () => {
    const { config } = resolve(item.input);
    expect(serialize(config.bindings)).toEqual(item.resolved['bindings']);
    const oldBound = Object.keys(item.resolved['bindings'] as JsonObject) as EntityId[];
    expect(runtimeKey('hass', undefined, config.bindings.keys())).toBe(runtimeKey('hass', undefined, oldBound));
  });
});
