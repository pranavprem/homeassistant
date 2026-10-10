/**
 * Text contrast from the design tokens themselves (§1.2 item 10, §6.5): every text color the components use reaches
 * 4.5:1 (WCAG 2.x relative luminance) on every surface it sits on, in both themes, computed from the values in
 * tokens.ts, so retuning a token can never quietly break the floor. The tightest pair, the powered-device toggle's
 * surface glyph on olive, sits at 4.53:1 in the light theme.
 */
import { describe, expect, it } from 'vitest';
import { tokenStyles } from '../../src/styles/tokens.ts';

type Rgb = readonly [number, number, number];
type Palette = ReadonlyMap<string, Rgb>;

const AA_TEXT = 4.5;
const DARK_SELECTOR = ":host([data-theme='dark'])";

/** Text tokens on the backgrounds they appear on: panels, insets, the hero and quiet panels (§6.5). */
const TEXT_TOKENS = ['ink', 'muted', 'olive-ink', 'brass-ink', 'danger', 'plum'];
const SURFACES = ['canvas', 'surface', 'surface-inset', 'surface-hero', 'surface-quiet'];
/** Filled controls and tinted pills: [text, background, where]. */
const FILLED_PAIRS: readonly (readonly [string, string, string])[] = [
  ['surface', 'olive', 'powered device toggle glyph'],
  ['surface', 'plum', 'primary transport button'],
  ['surface', 'ink', 'confirm button'],
  ['surface', 'olive-ink', 'pressed choice option'],
  ['brass-ink', 'brass-tint', 'powered light toggle, attention pill, lit room chip'],
  ['olive-ink', 'olive-tint', 'ok pill, pressed toggle'],
  ['danger', 'danger-tint', 'danger pill'],
  ['ink', 'plum-tint', 'chosen media source or player'],
  ['ink', 'brass-tint', 'text on a lit room chip'],
  ['muted', 'brass-tint', 'meta on a lit room chip'],
];

/**
 * Non-text graphics that carry meaning reach 3:1 (WCAG 1.4.11) on the surface they sit on: the sky radar's marks and
 * its overhead ring on the inset disc (ARCHITECTURE.md §19). The range rings are decorative (--agr-radar-ring).
 */
const AA_NON_TEXT = 3;
const NON_TEXT_PAIRS: readonly (readonly [string, string, string])[] = [
  ['ink', 'surface-inset', 'live radar mark'],
  ['muted', 'surface-inset', 'radar mark while not live'],
  ['brass-ink', 'surface-inset', 'overhead or selected radar mark, overhead ring'],
];
/** The decorative range rings must still show as a hairline, yet stay quieter than any mark. */
const RING_MIN = 1.3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function hex(value: string): Rgb {
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16)) as unknown as Rgb;
}

/** `rgb(r g b / a)` composited over `under`, as the browser paints a translucent surface. */
function over(value: string, under: Rgb): Rgb {
  const match = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(value);
  if (match === null) throw new Error(`not an rgb() with alpha: ${value}`);
  const alpha = Number(match[4]);
  return [1, 2, 3].map((index, i) =>
    Math.round(Number(match[index]) * alpha + (under[i] ?? 0) * (1 - alpha)),
  ) as unknown as Rgb;
}

/** The color tokens of one theme block, with the quiet surface composited over its canvas. */
function palette(block: string): Palette {
  const raw = new Map([...block.matchAll(/--agr-([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]?.trim()]));
  const colors = new Map<string, Rgb>();
  for (const [name, value] of raw) {
    if (name !== undefined && value !== undefined && /^#[\da-f]{6}$/i.test(value)) colors.set(name, hex(value));
  }
  const canvas = colors.get('canvas');
  const quiet = raw.get('surface-quiet');
  if (canvas === undefined || quiet === undefined) throw new Error('the theme block has no canvas or quiet surface');
  colors.set('surface-quiet', over(quiet, canvas));
  return colors;
}

const css = tokenStyles.cssText;
const THEMES: Readonly<Record<'light' | 'dark', Palette>> = {
  light: palette(css.slice(0, css.indexOf(DARK_SELECTOR))),
  dark: palette(css.slice(css.indexOf(DARK_SELECTOR), css.indexOf('@media (prefers-color-scheme: dark)'))),
};

function color(theme: Palette, name: string): Rgb {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`no --agr-${name} token`);
  return value;
}

describe.each(Object.entries(THEMES))('token contrast, %s theme (§6.5)', (_name, theme) => {
  it.each(TEXT_TOKENS.flatMap((text) => SURFACES.map((surface) => [text, surface])))(
    '--agr-%s text on --agr-%s reaches 4.5:1',
    (text, surface) => {
      expect(contrast(color(theme, text), color(theme, surface))).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it.each(FILLED_PAIRS)('--agr-%s on --agr-%s (%s) reaches 4.5:1', (text, background) => {
    expect(contrast(color(theme, text), color(theme, background))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(NON_TEXT_PAIRS)('--agr-%s graphics on --agr-%s (%s) reach 3:1', (graphic, background) => {
    expect(contrast(color(theme, graphic), color(theme, background))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('draws the radar rings as a visible hairline that stays quieter than every mark', () => {
    const ring = contrast(color(theme, 'radar-ring'), color(theme, 'surface-inset'));
    expect(ring).toBeGreaterThanOrEqual(RING_MIN);
    expect(ring).toBeLessThan(AA_NON_TEXT);
  });
});

it('reads the tightest pair as documented: the light powered-device toggle at 4.53:1', () => {
  expect(contrast(color(THEMES.light, 'surface'), color(THEMES.light, 'olive'))).toBeCloseTo(4.53, 2);
});
