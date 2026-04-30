import type { ThemePreference } from '../agent/settings';

const STORAGE_KEY = 'modmixer:theme';

export function readStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  } catch {
    // localStorage may be unavailable in some contexts.
  }
  return 'dark';
}

export function resolveTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return pref;
}

export function applyTheme(pref: ThemePreference): void {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Mirroring is best-effort — the boot script falls back to "dark".
  }
}

/**
 * Watch OS-level light/dark changes and re-apply when pref is "auto".
 * Returns an unsubscribe function.
 */
export function watchSystemTheme(
  getPref: () => ThemePreference,
): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getPref() === 'auto') applyTheme('auto');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
