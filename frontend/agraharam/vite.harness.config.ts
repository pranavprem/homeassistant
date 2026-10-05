import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { APP_VERSION } from './build-env.ts';

/** Where scripts/stage-preview.mjs places the built card, mirroring HA's /local layout. */
const HARNESS_BUNDLE_URL = `/local/agraharam/${APP_VERSION}/agraharam.js`;

// Builds harness.html into dist/preview; `vite preview` then serves the BUILT card bundle next to it (§10.3).
export default defineConfig({
  base: '/',
  define: { __HARNESS_BUNDLE_URL__: JSON.stringify(HARNESS_BUNDLE_URL) },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    outDir: 'dist/preview',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: fileURLToPath(new URL('./harness.html', import.meta.url)),
      // Second guard after the String() + @vite-ignore dynamic import in main-harness.ts: the card bundle is
      // served by the preview server, never resolved or bundled here.
      external: [/^\/local\//],
    },
  },
});
