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
