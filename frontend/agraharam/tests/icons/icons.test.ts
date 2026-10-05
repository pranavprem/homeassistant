import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { render } from 'lit';
import { icons as lucideIcons, type IconNode } from 'lucide';
import { describe, expect, it } from 'vitest';
import { CUSTOM_ICONS } from '../../src/icons/custom-icons.ts';
import { ICONS } from '../../src/icons/icons.ts';
import { renderIcon } from '../../src/icons/render-icon.ts';
import type { IconName } from '../../src/model/types.ts';

/** The seven SVG element types render-icon.ts knows how to bind. */
const SUPPORTED_TAGS = ['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'];
const LUCIDE_ICON_DIR = join(dirname(createRequire(import.meta.url).resolve('lucide/package.json')), 'dist/esm/icons');

const ALL_ICONS: Readonly<Record<IconName, IconNode>> = { ...ICONS, ...CUSTOM_ICONS };
/** Lucide's runtime map of canonical names and aliases, keyed by PascalCase export name. */
const LUCIDE_BY_EXPORT_NAME: Readonly<Record<string, IconNode | undefined>> = lucideIcons;
const ICON_NAMES = Object.keys(ALL_ICONS) as IconName[];

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

describe('curated icon set (§6.5)', () => {
  it.each(Object.keys(ICONS))('%s is a canonical lucide name, not an alias', (name) => {
    // Lucide ships one module per canonical icon; aliases exist only as re-exports.
    expect(existsSync(join(LUCIDE_ICON_DIR, `${name}.mjs`))).toBe(true);
    expect(ICONS[name as keyof typeof ICONS]).toBe(LUCIDE_BY_EXPORT_NAME[pascalCase(name)]);
  });

  it.each(ICON_NAMES)('%s resolves to an IconNode of supported elements', (name) => {
    const node = ALL_ICONS[name];
    expect(node.length).toBeGreaterThan(0);
    for (const [tag, attributes] of node) {
      expect(SUPPORTED_TAGS).toContain(tag);
      expect(typeof attributes).toBe('object');
    }
  });

  it.each(ICON_NAMES)('%s renders as decorative SVG with one child per node', (name) => {
    const host = document.createElement('div');
    render(renderIcon(name, 24), host);
    const svg = host.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.children.length).toBe(ALL_ICONS[name].length);
  });
});
