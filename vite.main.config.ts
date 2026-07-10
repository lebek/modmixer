import { defineConfig } from 'vite';

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
        // The pi agent packages (and typebox, their schema library, which
        // modmixer's tools also import) must NOT be bundled as of pi 0.80.x:
        // the OAuth flows load through deliberately bundler-proof dynamic
        // imports, extensions load via jiti, and disk assets resolve against
        // import.meta.url — all of which only work from real on-disk
        // node_modules. pi ships ESM-only with import-only exports maps; the
        // patches/ shims add a "default" condition so the CJS main can
        // require(esm) them. Packaged builds ship the whole dependency
        // closure at resources/node_modules (see stagePiNodeModules in
        // forge.config.ts), where bare-specifier walk-up resolution out of
        // the asar finds it — the same mechanism photon-node already uses.
        /^@earendil-works\//,
        'typebox',
        // Native module — .node binding can't be bundled by Rollup. Loaded
        // from process.resourcesPath/better-sqlite3 in packaged builds.
        'better-sqlite3',
        // Pure-WASM but ships the .wasm file as a sibling asset; let Node
        // resolve it from node_modules instead of trying to inline.
        'web-tree-sitter',
        // Pure-WASM SVG → PNG renderer used by the render_svg_to_png tool.
        // Same .wasm-sibling story as web-tree-sitter — keep external so the
        // bundled main.js does require() against the on-disk package.
        '@resvg/resvg-wasm',
        // Pure-WASM image library (photon-node, via pi-coding-agent's read
        // tool) used to resize images before sending them to the model. It
        // reads photon_rs_bg.wasm via readFileSync(__dirname + ...); bundling
        // breaks __dirname so the .wasm is never found and every image read
        // fails with "could not be resized". Keep external so require()
        // resolves the on-disk package next to its .wasm sibling.
        '@silvia-odwyer/photon-node',
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
