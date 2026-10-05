/**
 * Webfont registration (§11.4, D3). Faces are added to `document.fonts` through the FontFace API: @font-face inside a
 * shadow root is ignored by Chromium and Firefox, and this leaves no <style> in HA's document head. The URLs are
 * module-relative build assets (`base: './'`), so the fonts load from the same versioned /local directory as the
 * bundle.
 */
import serifUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url';
import sansUrl from '@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2?url';
import { log } from '../util/log.ts';

const FACES = [
  ['Agraharam Serif', serifUrl, '200 800'],
  ['Agraharam Sans', sansUrl, '100 900'],
] as const;

let registered = false;

/** Called from the root's connectedCallback, never at module load: the resource loads on every HA dashboard. */
export function ensureFonts(): void {
  if (registered || typeof FontFace === 'undefined' || !document.fonts) return;
  registered = true;
  for (const [family, url, weight] of FACES) {
    const face = new FontFace(family, `url(${url}) format('woff2')`, { weight, display: 'swap' });
    document.fonts.add(face);
    void face.load().catch(() => log.warn('font-load-failed')); // falls back to the system stacks
  }
}
