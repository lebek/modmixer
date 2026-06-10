import type { ModMixerApi } from './preload';

declare global {
  interface Window {
    modmixer: ModMixerApi;
    // Dev-only demo-video harness seam; absent in production builds.
    __demo?: import('./demo-hooks').DemoHooks;
  }

  // Injected by @electron-forge/plugin-vite at build/dev time.
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;

  // Injected by Vite. Only DEV is consumed (gates the demo-hooks seam);
  // declared minimally here since the repo doesn't pull in vite/client types.
  interface ImportMeta {
    readonly env: { readonly DEV: boolean };
  }
}

export {};
