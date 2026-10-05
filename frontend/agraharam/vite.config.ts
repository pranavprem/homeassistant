import { defineConfig } from 'vite';
import { APP_VERSION, GIT_SHA } from './build-env.ts';
import { litCssMinify } from './vite-lit-css.ts';

// A plain build, not library mode: library mode force-inlines the fonts as base64 (§11.3).
export default defineConfig({
  base: './', // asset URLs become new URL('fonts/x.woff2', import.meta.url)
  plugins: [litCssMinify()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __GIT_SHA__: JSON.stringify(GIT_SHA) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: `dist/agraharam/${APP_VERSION}`,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: 'hidden', // .map produced, no sourceMappingURL; moved out by postbuild
    modulePreload: false,
    assetsInlineLimit: 0,
    copyPublicDir: false,
    license: { fileName: 'LICENSES/THIRD_PARTY_LICENSES.md' },
    rolldownOptions: {
      input: 'src/agraharam.ts',
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: 'agraharam.js',
        assetFileNames: 'fonts/[name]-[hash][extname]',
        codeSplitting: false,
      },
    },
  },
});
