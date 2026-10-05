import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { APP_VERSION, BUNDLE_SIZE_TARGET_BYTES, GIT_SHA } from './build-env.ts';
import { legalBanner } from './scripts/lib/font-licenses.mjs';
import { litCssMinify } from './vite-lit-css.ts';

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));

// A plain build, not library mode, producing one self-contained module (§11.3, §17.2): the fonts are embedded
// through `?inline` imports in src/styles/fonts.ts, and every other asset would be emitted as a separate file, which
// the postbuild allowlist rejects.
export default defineConfig({
  base: './',
  plugins: [litCssMinify()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __GIT_SHA__: JSON.stringify(GIT_SHA) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: `dist/agraharam/${APP_VERSION}`,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: 'hidden', // .map produced, no sourceMappingURL; moved out by postbuild
    modulePreload: false,
    // Nothing is inlined implicitly: an accidental asset import becomes its own file and fails the allowlist.
    assetsInlineLimit: 0,
    copyPublicDir: false,
    // Vite counts kB as 1000 B; one file is the point (§17.2), so it warns only above the size target.
    chunkSizeWarningLimit: BUNDLE_SIZE_TARGET_BYTES / 1000,
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rolldownOptions: {
      input: 'src/agraharam.ts',
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: 'agraharam.js',
        codeSplitting: false,
        // After minification, so the font notices always lead the shipped file (§17.2).
        postBanner: legalBanner(PACKAGE_DIR),
      },
    },
  },
});
