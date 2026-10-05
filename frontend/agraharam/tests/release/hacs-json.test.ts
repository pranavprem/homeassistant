/**
 * hacs.json at the repository root (§17.4): exactly these keys and values. `filename` lets HACS find the card in a
 * monorepo whose name is not the file name, and must be the asset every release attaches.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLE_ENTRY } from '../../scripts/postbuild.mjs';
import { HACS_JSON } from './support/paths.ts';

describe('hacs.json (§17.4)', () => {
  const hacs = JSON.parse(readFileSync(HACS_JSON, 'utf8')) as Record<string, unknown>;

  it('has exactly the name, filename and homeassistant keys with their approved values', () => {
    expect(hacs).toStrictEqual({ name: 'Agraharam', filename: 'agraharam.js', homeassistant: '2026.9.0' });
    expect(Object.keys(hacs)).toEqual(['name', 'filename', 'homeassistant']);
  });

  it('names the module every release attaches', () => {
    expect(hacs['filename']).toBe(BUNDLE_ENTRY);
  });
});
