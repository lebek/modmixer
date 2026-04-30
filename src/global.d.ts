import type { ModMixerApi } from './preload';

declare global {
  interface Window {
    modmixer: ModMixerApi;
  }

  // Injected by @electron-forge/plugin-vite at build/dev time.
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
