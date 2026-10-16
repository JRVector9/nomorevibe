import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EVIDENCE_SETTINGS } from "@/lib/domain/evidence/settings";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), source: vi.fn(), upsert: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/domain/evidence/repository", () => ({ findObservedSource: mocks.source, upsertObservedSource: mocks.upsert }));
vi.mock("@/lib/domain/evidence/settings-store", () => ({ currentEvidenceSettings: mocks.settings }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: vi.fn() }));

const { refreshSiteFingerprint } = await import("@/lib/domain/evidence/providers/site-fingerprint");
const now = new Date("2026-10-14T00:00:00Z");
const input = { slug: "test", productId: 1, url: "https://test.example" };
const response = { ok: true as const, status: 200, finalUrl: input.url, headers: new Headers(), body: Buffer.from("<p>Product</p>") };

function cutoff(mode: "abort" | "deadline" | "budget") {
  const controller = new AbortController();
  const deadlineAt = Date.now() + 60_000;
  let budget = true;
  return {
    options: { now, signal: controller.signal, deadlineAt, hasBudget: () => budget },
    stop: () => {
      if (mode === "abort") controller.abort();
      if (mode === "deadline") vi.spyOn(Date, "now").mockReturnValue(deadlineAt);
      if (mode === "budget") budget = false;
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.settings.mockResolvedValue(DEFAULT_EVIDENCE_SETTINGS);
  mocks.source.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async run => run({}));
  mocks.upsert.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it.each(["abort", "deadline", "budget"] as const)("does not report cached site success after %s during preparation", async mode => {
  const { options, stop } = cutoff(mode);
  mocks.source.mockImplementation(async () => {
    stop();
    return { sourceUrl: input.url, state: "ok", lastErrorCode: null, nextAttemptAt: new Date(now.getTime() + 86_400_000) };
  });
  const fetch = vi.fn().mockResolvedValue(response);
  expect(await refreshSiteFingerprint(input, { ...options, fetch })).toBe("budget_exhausted");
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it.each([
  ["abort", "success"], ["deadline", "success"], ["budget", "success"],
  ["abort", "failure"], ["deadline", "failure"], ["budget", "failure"],
] as const)("starts no site mutation after %s while awaiting the %s transaction callback", async (mode, outcome) => {
  const { options, stop } = cutoff(mode);
  mocks.transaction.mockImplementation(async run => { stop(); return run({}); });
  const fetch = vi.fn().mockResolvedValue(outcome === "success" ? response : { ok: false, reason: "timeout" });
  expect(await refreshSiteFingerprint(input, { ...options, fetch })).toBe("budget_exhausted");
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it("lets an already started site success write settle after abort", async () => {
  const controller = new AbortController();
  mocks.upsert.mockImplementation(async () => { controller.abort(); });
  expect(await refreshSiteFingerprint(input, { now, signal: controller.signal, fetch: vi.fn().mockResolvedValue(response) })).toBe(true);
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
});

it("an aborted permit wait keeps its deferred type instead of becoming generic budget exhaustion", async () => {
  const { HttpOriginPermitError } = await import("@/lib/net/http-origin-policy");
  const controller = new AbortController();
  const blocked = new HttpOriginPermitError("waiting_aborted");
  const fetch = vi.fn(async () => { controller.abort(); throw blocked; });
  await expect(refreshSiteFingerprint(input, { now, signal: controller.signal, fetch })).rejects.toBe(blocked);
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
});
