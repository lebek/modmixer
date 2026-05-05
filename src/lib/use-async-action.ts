import { useCallback, useRef, useState } from 'react';

export interface AsyncAction<TArgs extends unknown[], TResult> {
  /**
   * Run the action. Catches errors into `error`. Returns the function's
   * return value on success (which may itself be `undefined`) and the
   * sentinel `null` on failure — so callers handling `Promise<void>` can
   * still distinguish the two.
   */
  run: (...args: TArgs) => Promise<TResult | null>;
  /** True while the action is in flight. */
  busy: boolean;
  /** The most recent error message, or null if the last run succeeded / hasn't been run. */
  error: string | null;
  /** Manually clear the error. */
  reset: () => void;
}

/**
 * Wrap an async function so its component doesn't have to repeat the
 * `try { setBusy(true); await ... } catch (err) { setError(...) } finally { setBusy(false) }`
 * dance for every IPC call.
 *
 * Concurrent calls: the most recent run wins. Stale completions don't
 * touch state.
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): AsyncAction<TArgs, TResult> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const runId = useRef(0);

  const run = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    const id = ++runId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      if (runId.current === id) setBusy(false);
      return result;
    } catch (err) {
      if (runId.current === id) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
      return null;
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, busy, error, reset };
}
