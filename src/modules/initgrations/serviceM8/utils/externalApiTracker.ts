// Tracks whether the ServiceM8 external API is reachable.
// In-memory per process — updated on every live attempt.

export interface Sm8Status {
  ok: boolean;
  source: "live" | "cache";
  reason: string | null;
  checked_at: string;
}

let _current: Sm8Status = {
  ok: true,
  source: "live",
  reason: null,
  checked_at: new Date().toISOString(),
};

export const getExternalStatus = (): Sm8Status => ({ ..._current });

/**
 * Tries liveFn first. If it throws (network error, 401, 5xx, etc.) marks the
 * external API as down, logs a warning, and serves data from cacheFn instead.
 * The sm8 status object is always included in the result so callers can surface
 * it to API consumers.
 */
export async function withFallback<T>(
  liveFn: () => Promise<T>,
  cacheFn: () => Promise<T>
): Promise<{ data: T; sm8: Sm8Status }> {
  try {
    const data = await liveFn();
    _current = { ok: true, source: "live", reason: null, checked_at: new Date().toISOString() };
    return { data, sm8: { ..._current } };
  } catch (err: any) {
    const reason =
      err?.response?.data?.error_description ??
      err?.response?.data?.message ??
      err?.message ??
      "ServiceM8 external API unavailable";

    _current = { ok: false, source: "cache", reason, checked_at: new Date().toISOString() };
    console.warn(`[SM8 Fallback] External API unavailable — serving cached data. Reason: ${reason}`);

    const data = await cacheFn();
    return { data, sm8: { ..._current } };
  }
}
