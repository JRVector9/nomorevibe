const STORAGE_KEY = "nmv:render-recovery:v1";
const WINDOW_MS = 60_000;
const DELAYS_MS = [2_000, 5_000] as const;
export const RENDER_RECOVERY_QUERY = "__nmv_recover";

/** Derive only from the current document URL. A fresh nonce changes the edge
 * cache key without changing locale, filters, return targets or the fragment. */
export function renderRecoveryUrl(currentHref: string, nonce: string): string | null {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return null;
  try {
    const url = new URL(currentHref);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.searchParams.set(RENDER_RECOVERY_QUERY, nonce);
    return url.href;
  } catch { return null; }
}

type Budget = { startedAt: number; attempts: number };
type RecoveryEnvironment = {
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  automaticContinuation: boolean;
  available: () => boolean;
  schedule: (run: () => void, delayMs: number) => number;
  cancel: (timer: number) => void;
  onAvailabilityChange: (run: () => void) => () => void;
};

function readBudget(env: RecoveryEnvironment): Budget | null {
  try {
    const raw = env.storage.getItem(STORAGE_KEY);
    const now = env.now();
    if (raw === null) return { startedAt: now, attempts: 0 };
    const budget: unknown = JSON.parse(raw);
    if (!budget || typeof budget !== "object") return null;
    const { startedAt, attempts } = budget as Budget;
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > now
      || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > DELAYS_MS.length) return null;
    // A slow failed GET must not reopen its own window and navigate forever.
    return now - startedAt >= WINDOW_MS && !env.automaticContinuation
      ? { startedAt: now, attempts: 0 } : { startedAt, attempts };
  } catch {
    // Storage disabled/corrupt: retain manual recovery rather than risk a loop.
    return null;
  }
}

/** Two document GET navigations per tab/minute, shared by every boundary and route.
 * Nothing stores paths, errors or account data. A permanent failure stops after
 * the budget; no timer waits for that budget to reopen. Never pass a mutation.
 */
export function startRenderRecovery(refresh: () => void, env: RecoveryEnvironment): () => void {
  let timer: number | undefined;
  let stopped = false;
  let attempted = false;
  const cancel = () => {
    if (timer !== undefined) env.cancel(timer);
    timer = undefined;
  };
  const resume = () => {
    if (stopped || attempted) return;
    if (!env.available()) { cancel(); return; }
    if (timer !== undefined) return;
    const budget = readBudget(env);
    if (!budget || budget.attempts >= DELAYS_MS.length) return;
    timer = env.schedule(() => {
      timer = undefined;
      if (stopped || attempted || !env.available()) return;
      // Another mounted boundary may have consumed the shared budget meanwhile.
      const current = readBudget(env);
      if (!current || current.attempts >= DELAYS_MS.length || current.attempts !== budget.attempts) return;
      try {
        env.storage.setItem(STORAGE_KEY, JSON.stringify({ ...current, attempts: current.attempts + 1 }));
      } catch { return; }
      attempted = true;
      refresh();
    }, DELAYS_MS[budget.attempts]);
  };
  const unsubscribe = env.onAvailabilityChange(resume);
  resume();
  return () => { stopped = true; cancel(); unsubscribe(); };
}
