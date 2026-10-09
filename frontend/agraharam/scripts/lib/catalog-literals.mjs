/**
 * The §7.1 catalog identifiers a public literal may name (§11.1 rule (c)): every action kind (`light.set_brightness`)
 * and every `domain.service` the catalog calls (`cover.open_cover`). Read from the catalog itself through Node type
 * stripping, so the public-literal check and the catalog can never disagree.
 */
import { ACTION_CATALOG } from '../../src/ha/actions/catalog.ts';

const ACTION_KINDS = Object.keys(ACTION_CATALOG);

/** Every `domain.service` pair the catalog can call, including each room part (§18), de-duplicated. */
export const CATALOG_SERVICES = Object.freeze([
  ...new Set(
    ACTION_KINDS.flatMap((kind) => {
      const spec = ACTION_CATALOG[/** @type {keyof typeof ACTION_CATALOG} */ (kind)];
      const parts = spec.parts ?? [];
      return [`${spec.domain}.${spec.service}`, ...parts.map((part) => `${part.domain}.${part.service}`)];
    }),
  ),
]);

/** The `catalogLiterals` input of `checkPublicLiterals`: catalog services and action kinds. */
export const CATALOG_LITERALS = Object.freeze([...new Set([...CATALOG_SERVICES, ...ACTION_KINDS])]);
