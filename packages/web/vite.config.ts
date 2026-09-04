/**
 * Vite config for the game client.
 *
 * The one non-obvious thing here is QuickJS. `@rematch/sandbox` dynamically imports
 * `@jitl/quickjs-singlefile-cjs-release-sync` — a ~1.4 MB **CommonJS** file with the
 * WASM embedded as a byte string (see that package's README for why that variant).
 *
 * Measured, not assumed: Vite 8 handles it unaided in both dev (it discovers the CJS
 * import while crawling the linked workspace package and pre-bundles it) and build
 * (Rollup's CommonJS interop). The `optimizeDeps.include` below is therefore not a
 * workaround for a failure — it is there so that 1.4 MB is optimized when the dev
 * server starts rather than being discovered lazily on the first `createSandbox()`,
 * which costs a mid-session re-optimize and a full page reload exactly when the player
 * clicks Fight. `@rematch/web` declares both quickjs packages as direct dependencies
 * because `include` entries are resolved from *this* package's root, not the sandbox's.
 *
 * In the built bundle the variant is split into its own `quickjs` chunk so the game
 * code is not held hostage to a 730 kB parse, and so the embedded WASM string is never
 * a candidate for asset inlining.
 *
 * Everything else is stock: no framework, no PostCSS, no asset pipeline.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** This package's directory. `__dirname` does not exist: the config is ESM. */
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  // Relative base so `vite preview` and any static host (including a subpath on
  // Vercel) serve the same bundle.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // The QuickJS variant is one huge string; inlining anything near it is pointless.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('quickjs')) return 'quickjs';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    include: ['@jitl/quickjs-singlefile-cjs-release-sync', 'quickjs-emscripten-core'],
  },
  server: {
    port: 5173,
    strictPort: false,
    /**
     * `/api` → `@rematch/server` (`pnpm dev:server`, `PORT`, default 8787).
     *
     * The proxy is what keeps dev identical to production: the browser makes a
     * **same-origin** `POST /api/rewrite`, so the dev path has no preflight and no
     * CORS, exactly like the deployed URL where the bundle and the API share an
     * origin. `VITE_API_BASE` overrides the base when the server is elsewhere.
     *
     * `127.0.0.1` rather than `localhost`: on an IPv6 machine `localhost` resolves
     * to `::1`, and the server binds `127.0.0.1`.
     */
    proxy: { '/api': `http://127.0.0.1:${process.env['PORT'] ?? 8787}` },
  },
  preview: {
    port: 4173,
    strictPort: false,
  },
});
