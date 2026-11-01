import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDER_RECOVERY_QUERY, renderRecoveryUrl, startRenderRecovery } from "@/lib/web/render-recovery";

describe("render recovery document URL", () => {
  const nonce = "0123456789abcdef0123456789abcdef";

  it("preserves the current origin, locale, repeated filters, return values and fragment", () => {
    const current = new URL("https://nomorevibe.com/en/login?tag=a&tag=b&q=two%20words&return=%2Fen%2Fme%3Fview%3Dpending%26next%3Dhttps%253A%252F%252Fexample.org#form");
    const target = new URL(renderRecoveryUrl(current.href, nonce)!);
    expect(target.origin).toBe(current.origin);
    expect(target.pathname).toBe(current.pathname);
    expect(target.hash).toBe(current.hash);
    for (const key of ["tag", "q", "return"]) expect(target.searchParams.getAll(key)).toEqual(current.searchParams.getAll(key));
    expect(target.searchParams.get(RENDER_RECOVERY_QUERY)).toBe(nonce);
  });

  it("replaces only the reserved parameter and gives every nonce a different GET key", () => {
    const current = "https://nomorevibe.com/?__nmv_recover=old&x=1&__nmv_recover=older#top";
    const first = new URL(renderRecoveryUrl(current, nonce)!);
    const next = new URL(renderRecoveryUrl(first.href, "f".repeat(32))!);
    expect(first.searchParams.getAll(RENDER_RECOVERY_QUERY)).toEqual([nonce]);
    expect(next.searchParams.getAll(RENDER_RECOVERY_QUERY)).toEqual(["f".repeat(32)]);
    expect(next.href).not.toBe(first.href);
    expect(next.searchParams.get("x")).toBe("1");
    expect(next.hash).toBe("#top");
  });

  it("declines non-document schemes, malformed URLs and nonces that could add URL syntax", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,error", "/relative", "broken"])
      expect(renderRecoveryUrl(href, nonce)).toBeNull();
    for (const bad of ["", "short", "a".repeat(31), "a".repeat(33), "f".repeat(30) + "&x"])
      expect(renderRecoveryUrl("https://nomorevibe.com/", bad)).toBeNull();
    expect(renderRecoveryUrl("http://localhost:3000/ko?return=%2Fme", nonce)).toBe("http://localhost:3000/ko?return=%2Fme&__nmv_recover=" + nonce);
  });
});

function fixture() {
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  const refresh = vi.fn();
  let available = true;
  const env = {
    storage: { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } },
    now: () => Date.now(),
    automaticContinuation: false,
    available: () => available,
    schedule: (run: () => void, delay: number) => Number(setTimeout(run, delay)),
    cancel: (timer: number) => clearTimeout(timer),
    onAvailabilityChange: (run: () => void) => { listeners.add(run); return () => { listeners.delete(run); }; },
  };
  return { env, values, refresh, listeners, start: () => startRenderRecovery(refresh, env),
    availability: (value: boolean) => { available = value; listeners.forEach(run => run()); } };
}

describe("render GET recovery budget", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("re-fetches a failed render after a delay, once per mount", () => {
    const f = fixture();
    const stop = f.start();
    vi.advanceTimersByTime(1_999); expect(f.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(f.refresh).toHaveBeenCalledTimes(1);
    f.availability(false); f.availability(true);
    vi.advanceTimersByTime(120_000); expect(f.refresh).toHaveBeenCalledTimes(1);
    stop(); expect(f.listeners.size).toBe(0);
  });

  it("shares two attempts across remounts and navigation and stops permanent failures", () => {
    const f = fixture();
    f.start(); vi.advanceTimersByTime(2_000);
    f.start(); vi.advanceTimersByTime(4_999); expect(f.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(f.refresh).toHaveBeenCalledTimes(2);
    f.start(); vi.advanceTimersByTime(120_000); expect(f.refresh).toHaveBeenCalledTimes(2);
    // A later, independent mount may use a new minute; no existing timer loops.
    f.start(); vi.advanceTimersByTime(2_000); expect(f.refresh).toHaveBeenCalledTimes(3);
  });

  it("does not reopen the budget when slow failing document GETs exceed a minute", () => {
    const f = fixture();
    f.start(); vi.advanceTimersByTime(61_000);
    f.env.automaticContinuation = true;
    f.start(); vi.advanceTimersByTime(61_000);
    f.start(); vi.advanceTimersByTime(120_000);
    f.availability(false); f.availability(true); vi.advanceTimersByTime(10_000);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    // Only a later mount without the recovery query may open another window.
    f.env.automaticContinuation = false;
    f.start(); vi.advanceTimersByTime(2_000);
    expect(f.refresh).toHaveBeenCalledTimes(3);
  });

  it("keeps only the budget across document GET attempts, never the current URL or nonce", () => {
    const f = fixture();
    const navigate = vi.fn();
    let href = "https://nomorevibe.com/en/login?return=%2Fen%2Fme#form";
    for (const nonce of ["a".repeat(32), "b".repeat(32)]) {
      startRenderRecovery(() => {
        href = renderRecoveryUrl(href, nonce)!;
        navigate(href);
      }, f.env);
      vi.advanceTimersByTime(5_000);
    }
    startRenderRecovery(() => navigate("must not run"), f.env);
    vi.advanceTimersByTime(120_000);
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(new URL(navigate.mock.calls[0][0]).searchParams.get(RENDER_RECOVERY_QUERY)).toBe("a".repeat(32));
    expect(new URL(navigate.mock.calls[1][0]).searchParams.get(RENDER_RECOVERY_QUERY)).toBe("b".repeat(32));
    expect([...f.values.values()].map(value => Object.keys(JSON.parse(value)))).toEqual([["startedAt", "attempts"]]);
  });

  it("does not consume attempts offline/hidden and resumes with a full delay", () => {
    const f = fixture(); f.availability(false); f.start();
    vi.advanceTimersByTime(10_000); expect(f.values.size).toBe(0);
    f.availability(true); vi.advanceTimersByTime(1_000); f.availability(false);
    vi.advanceTimersByTime(10_000); expect(f.refresh).not.toHaveBeenCalled();
    f.availability(true); vi.advanceTimersByTime(1_999); expect(f.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed re-fetches when navigation/unmount removes the fallback", () => {
    const f = fixture(); const stop = f.start(); stop();
    vi.advanceTimersByTime(10_000); f.availability(true);
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0);
  });

  it("rechecks the shared budget when several failed segments mount together", () => {
    const f = fixture(); f.start(); f.start(); f.start();
    vi.advanceTimersByTime(2_000); expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.values.size).toBe(1);
  });

  it("keeps manual recovery when storage cannot be read/written or is malformed", () => {
    for (const mode of ["read", "write", "corrupt", "future"] as const) {
      const f = fixture();
      if (mode === "read") f.env.storage.getItem = () => { throw new Error("storage blocked"); };
      if (mode === "write") f.env.storage.setItem = () => { throw new Error("storage blocked"); };
      if (mode === "corrupt") f.env.storage.getItem = () => "{";
      if (mode === "future") f.env.storage.getItem = () => JSON.stringify({ startedAt: Date.now() + 1, attempts: 0 });
      const stop = f.start(); vi.advanceTimersByTime(10_000);
      expect(f.refresh).not.toHaveBeenCalled(); stop();
    }
  });
});
