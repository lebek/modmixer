import { defineConfig } from 'vite';

// Bundle ESM-only deps (pi-agent-core, pi-ai, typebox) into the main process
// output so the CJS Electron main can require() them.
//
// steamworks.js is external: it's a native module whose .node binding and
// sibling Steam SDK libs (libsteam_api.dylib, steam_api64.dll, libsteam_api.so)
// must be resolved from disk at runtime — main.ts loads it from
// process.resourcesPath via the extraResource copy.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'electron',
        'steamworks.js',
        // Native module — .node binding can't be bundled by Rollup. Loaded
        // from process.resourcesPath/better-sqlite3 in packaged builds.
        'better-sqlite3',
        // Pure-WASM but ships the .wasm file as a sibling asset; let Node
        // resolve it from node_modules instead of trying to inline.
        'web-tree-sitter',
        // Bundles platform-specific ripgrep binaries.
        '@vscode/ripgrep',
        /^node:/,
      ],
    },
  },
  define: {
    __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ''),
    __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ''),
    __POSTHOG_HOST__: JSON.stringify(
      process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    ),
  },
});
