/**
 * Live OpenRouter credit-balance fetcher. Hits `GET /api/v1/credits` with
 * the user's stored API key and returns `total_credits - total_usage`.
 *
 * Unlike the pricing catalogue, the balance is per-user and changes after
 * every turn, so there's no on-disk cache. Single-flight only — concurrent
 * callers share one in-flight request.
 */

export interface OpenRouterCredits {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

let inflight: Promise<OpenRouterCredits> | null = null;

export async function fetchOpenRouterCredits(
  apiKey: string,
): Promise<OpenRouterCredits> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { total_credits?: unknown; total_usage?: unknown };
      };
      const totalCredits = numberOrZero(body.data?.total_credits);
      const totalUsage = numberOrZero(body.data?.total_usage);
      return {
        totalCredits,
        totalUsage,
        remaining: totalCredits - totalUsage,
      };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
