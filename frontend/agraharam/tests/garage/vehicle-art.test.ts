/**
 * The vehicle drawing (§18, design §8). `vehicle.model: generic` (the default) renders exactly the cf0c182 markup,
 * captured once from cf0c182's own renderVehicleArt and pinned below as a literal (Lit comment markers removed), so a
 * deployed config sees no change. `tesla-model-3` is a static, self-contained, decorative SVG: no text, image, link or
 * URL, no word mark, no <style> element (happy-dom cannot parse one inside <svg>), and every part painted by an inline
 * style whose colours come only from the --agr-vehicle-* tokens, which both themes define.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, type TemplateResult } from 'lit';
import { describe, expect, it } from 'vitest';
import { renderVehicleArt } from '../../src/components/garage/vehicle-art.ts';
import { VEHICLE_MODELS } from '../../src/config/schema.ts';

/** cf0c182's generic drawing, exactly as it rendered. */
const CF0C182_GENERIC_MARKUP =
  '<svg class="vehicle-art" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" viewBox="0 0 160 60">\n    <path class="ground" d="M4 56.5H156"></path>\n    <path class="glass" d="M41.5 27.6C48 23.4 54.5 20.4 62 19.8L77 19.4V27.6Z"></path>\n    <path class="glass" d="M80.5 19.4L94 19.8C101 20.6 107 23.6 112.5 27.6H80.5Z"></path>\n    <path d="M15 46H26.5A12 12 0 0 1 49.5 46H110.5A12 12 0 0 1 133.5 46H146C149 46 151 44 151 41V38.5C151 35.5 149 34 145 33.2L119 28.6C111.5 22 104 17.6 95 16.6C86 15.6 70 15.6 62 16.8C52 18.4 42.5 23.6 34.5 28C26.5 29.2 18.5 30.2 14 31.5C11.2 32.4 10 34.4 10 37V42C10 44.6 12 46 15 46Z"></path>\n    <path class="detail" d="M15 34.2C48 32.4 108 31.8 146 34.8"></path>\n    <path class="detail" d="M78.7 29V45"></path>\n    <path class="detail" d="M60 34.4H65M93 34.4H98"></path>\n    <path class="detail" d="M113.5 28.2L117.5 26.8"></path>\n    <path d="M140.5 35.4L147.5 36.6"></path>\n    <path d="M11 35.8H15.5"></path>\n    <circle class="tyre" cy="46" cx="38" r="9.5"></circle>\n        <circle class="detail" cy="46" cx="38" r="3.6"></circle><circle class="tyre" cy="46" cx="122" r="9.5"></circle>\n        <circle class="detail" cy="46" cx="122" r="3.6"></circle>\n  </svg>';

/** The 2017–2023 Model 3's published proportions (design §8): wheelbase about 61 % of the length. */
const WHEELBASE_SHARE = { min: 0.58, max: 0.64 } as const;
const MAX_OVERHANG_SHARE = 0.25;

function markup(template: TemplateResult): string {
  const host = document.createElement('div');
  render(template, host);
  return host.innerHTML.replace(/<!--[^>]*-->/g, '');
}

function svgOf(template: TemplateResult): SVGSVGElement {
  const host = document.createElement('div');
  render(template, host);
  const svg = host.querySelector('svg');
  if (svg === null) throw new Error('no svg rendered');
  return svg;
}

describe('generic (the default): unchanged from cf0c182', () => {
  it('renders byte-identical markup with no argument and with "generic"', () => {
    expect(markup(renderVehicleArt())).toBe(CF0C182_GENERIC_MARKUP);
    expect(markup(renderVehicleArt('generic'))).toBe(CF0C182_GENERIC_MARKUP);
  });

  it('carries no data-model, so the panel keeps its generic column', () => {
    expect(svgOf(renderVehicleArt()).hasAttribute('data-model')).toBe(false);
  });
});

describe('tesla-model-3', () => {
  const art = () => svgOf(renderVehicleArt('tesla-model-3'));

  it('is decorative and identifiable: vehicle-art class, aria-hidden, unfocusable, data-model, its own viewBox', () => {
    const svg = art();
    expect(svg.getAttribute('class')).toBe('vehicle-art');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('data-model')).toBe('tesla-model-3');
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 66');
    expect(markup(renderVehicleArt('tesla-model-3'))).not.toBe(CF0C182_GENERIC_MARKUP);
  });

  it('contains no text, word mark, image, link, script, foreign content or reference to another document', () => {
    const svg = art();
    expect(svg.querySelectorAll('text, tspan, image, a, use, script, foreignObject, iframe')).toHaveLength(0);
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
      for (const attribute of element.attributes) {
        expect(attribute.name, element.tagName).not.toMatch(/href|^on/i);
        expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toMatch(/url\(|https?:|data:|javascript:/i);
      }
    }
    // There is no text at all: nothing is drawn as letters (no "Tesla" or "T" mark).
    const visibleText = [svg, ...svg.querySelectorAll('*')]
      .flatMap((element) => [...element.childNodes])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('');
    expect(visibleText.trim()).toBe('');
  });

  it('paints every part inline from a defined vehicle token, with an m3- hook, and loads nothing', () => {
    const svg = art();
    expect(svg.querySelector('style')).toBeNull();
    const parts = [...svg.querySelectorAll('path, circle, ellipse, rect, polygon, line')];
    expect(parts.length).toBeGreaterThan(10);
    for (const part of parts) {
      expect(part.getAttribute('style'), part.outerHTML).toMatch(/var\(--agr-vehicle-/);
      expect(part.getAttribute('class') ?? '', part.outerHTML).toMatch(/\bm3-[a-z-]+/);
    }
    const styles = [...svg.querySelectorAll('[style]')].map((element) => element.getAttribute('style') ?? '');
    for (const style of styles) expect(style).not.toMatch(/@import|url\(|@font-face|expression\(/);
    const tokens = new Set(styles.flatMap((style) => [...style.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])));
    expect(tokens.size).toBeGreaterThan(5);
    expect([...tokens].filter((token) => !token?.startsWith('--agr-vehicle-'))).toEqual([]);
    const tokenSource = readFileSync(resolve(process.cwd(), 'src/styles/tokens.ts'), 'utf8');
    for (const token of tokens) {
      // Defined once for light and once for dark.
      expect(tokenSource.split(`${token}:`).length - 1, token).toBe(2);
    }
  });

  it('draws two wheels on a long wheelbase with short overhangs (the proportions that make it read as the car)', () => {
    const svg = art();
    const tyres = [...svg.querySelectorAll('circle.m3-tyre')].map((circle) => Number(circle.getAttribute('cx')));
    expect(tyres).toHaveLength(2);
    const [rear, front] = [Math.min(...tyres), Math.max(...tyres)];
    const [, , width] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    const length = (width ?? 0) - 12; // the body runs from x 6 to x 194
    expect((front - rear) / length).toBeGreaterThanOrEqual(WHEELBASE_SHARE.min);
    expect((front - rear) / length).toBeLessThanOrEqual(WHEELBASE_SHARE.max);
    expect((rear - 6) / length).toBeLessThan(MAX_OVERHANG_SHARE);
    expect((194 - front) / length).toBeLessThan(MAX_OVERHANG_SHARE);
  });

  it('renders the same markup every time (static, no per-render input)', () => {
    expect(markup(renderVehicleArt('tesla-model-3'))).toBe(markup(renderVehicleArt('tesla-model-3')));
  });
});

describe('every model', () => {
  it.each(VEHICLE_MODELS)('%s renders one aria-hidden svg.vehicle-art', (model) => {
    const host = document.createElement('div');
    render(renderVehicleArt(model), host);
    expect(host.querySelectorAll('svg.vehicle-art[aria-hidden="true"]')).toHaveLength(1);
  });
});
