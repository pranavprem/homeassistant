/**
 * Webfont registration (§11.4, §17.2, D3). Both faces are embedded in the bundle (Vite `?inline` gives a base64
 * `data:` URL), decoded to bytes once and added to `document.fonts` as binary FontFace sources: the card is one file
 * whichever way it is installed, and loading never depends on a `font-src` policy. @font-face inside a shadow root
 * is ignored by Chromium and Firefox, and this leaves no <style> in HA's document head.
 */
import serifData from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?inline';
import sansData from '@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2?inline';
import { log } from '../util/log.ts';

const FACES = [
  ['Agraharam Serif', serifData, '200 800'],
  ['Agraharam Sans', sansData, '100 900'],
] as const;

/** The separator between a base64 data URL's header and its payload. */
const BASE64_MARKER = ';base64,';

let registered = false;

/**
 * The bytes of a base64 `data:` URL, or undefined when it is not one.
 * @throws DOMException from `atob` when the payload is not valid base64
 */
function decodeDataUrl(dataUrl: string): ArrayBuffer | undefined {
  const marker = dataUrl.indexOf(BASE64_MARKER);
  if (!dataUrl.startsWith('data:') || marker === -1) return undefined;
  const binary = atob(dataUrl.slice(marker + BASE64_MARKER.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** Decodes and registers one face; false when it cannot (the card then uses the system stack for that family). */
function registerFace(family: string, dataUrl: string, weight: string): boolean {
  try {
    const bytes = decodeDataUrl(dataUrl);
    if (bytes === undefined) return false;
    const face = new FontFace(family, bytes, { weight, display: 'swap' });
    document.fonts.add(face);
    void face.load().catch(() => log.warn('font-load-failed')); // falls back to the system stacks
    return true;
  } catch {
    // A font must never break the card: this runs inside the root's connectedCallback.
    return false;
  }
}

/**
 * Called from the root's connectedCallback, never at module load: the resource loads on every HA dashboard, so the
 * fonts are decoded and parsed only once a card mounts, and only once per page. Never throws.
 */
export function ensureFonts(): void {
  if (registered || typeof FontFace === 'undefined' || !document.fonts) return;
  registered = true;
  for (const [family, dataUrl, weight] of FACES) {
    if (!registerFace(family, dataUrl, weight)) log.warn('font-load-failed');
  }
}
