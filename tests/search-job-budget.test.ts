import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({
  pendingProfiles: vi.fn(), pendingVerifications: vi.fn(),
  recordProfileResult: vi.fn(), recordVerificationResult: vi.fn(),
  writeKeywords: vi.fn(), verifyKeywords: vi.fn(),
}));
vi.mock("@/lib/domain/products/search-profiles", () => domain);
vi.mock("@/lib/domain/products/search-profile", () => ({
  PROFILE_MODEL: "generator", profileEvidence: () => ({}), profileHash: () => "hash",
  writeKeywords: domain.writeKeywords,
}));
vi.mock("@/lib/domain/products/search-verify", () => ({ VERIFY_MODEL: "verifier", verifyKeywords: domain.verifyKeywords }));
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import type { JobContext } from "@/lib/jobs/runner";

const tasks = (count: number) => Array.from({ length: count }, (_, id) => ({
  product: { id }, reviewerNote: null,
  profile: { keywordsEn: ["calendar"], keywordsKo: ["달력"], needsRefresh: true, sourceHash: "old" },
}));
const ctx = (): JobContext<null> => ({
  cursor: null, lease: { name: "test", token: "token", requestedVersion: 1 },
  hasBudget: () => true, log: vi.fn(), save: vi.fn(),
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("ABCLLM_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  domain.recordProfileResult.mockResolvedValue(true);
  domain.recordVerificationResult.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("search job time budget", () => {
  it("does not count a shortened generation deadline as a product failure", async () => {
    domain.pendingProfiles.mockResolvedValue(tasks(8));
    let calls = 0;
    domain.writeKeywords.mockImplementation(async (_evidence, options) => {
      if (++calls <= 6) {
        vi.setSystemTime(Date.now() + 6_000);
        return { ok: true, en: ["calendar"], ko: ["달력"] };
      }
      expect(options.timeoutMs).toBeLessThan(45_000);
      vi.setSystemTime(Date.now() + options.timeoutMs);
      return { ok: false, error: "timeout" };
    });
    expect(await writeSearchProfiles(ctx())).toEqual({ done: false });
    expect(domain.recordProfileResult).toHaveBeenCalledTimes(6);
    expect(domain.recordProfileResult.mock.calls.every((call) => call[2].kind === "success")).toBe(true);
  });

  it("does not count a shortened verification deadline as a product failure", async () => {
    domain.pendingVerifications.mockResolvedValue(tasks(12));
    let calls = 0;
    domain.verifyKeywords.mockImplementation(async (_item, options) => {
      if (++calls <= 8) {
        vi.setSystemTime(Date.now() + 10_000);
        return { ok: true, unsupported: [] };
      }
      expect(options.timeoutMs).toBeLessThan(60_000);
      vi.setSystemTime(Date.now() + options.timeoutMs);
      return { ok: false, error: "timeout" };
    });
    expect(await verifySearchKeywords(ctx())).toEqual({ done: false });
    expect(domain.recordVerificationResult).toHaveBeenCalledTimes(8);
    expect(domain.recordVerificationResult.mock.calls.every((call) => call[2].kind === "success")).toBe(true);
  });

  it("still records generation timeout with the full call deadline", async () => {
    domain.pendingProfiles.mockResolvedValueOnce(tasks(1)).mockResolvedValue([]);
    domain.writeKeywords.mockImplementation(async (_evidence, options) => {
      expect(options.timeoutMs).toBe(45_000);
      return { ok: false, error: "timeout" };
    });
    await writeSearchProfiles(ctx());
    expect(domain.recordProfileResult).toHaveBeenCalledWith(expect.anything(), expect.anything(), { kind: "failure", error: "timeout" });
  });

  it("still records verification timeout with the full call deadline", async () => {
    domain.pendingVerifications.mockResolvedValueOnce(tasks(1)).mockResolvedValue([]);
    domain.verifyKeywords.mockImplementation(async (_item, options) => {
      expect(options.timeoutMs).toBe(60_000);
      return { ok: false, error: "timeout" };
    });
    await verifySearchKeywords(ctx());
    expect(domain.recordVerificationResult).toHaveBeenCalledWith(expect.anything(), expect.anything(), { kind: "failure", error: "timeout" });
  });
});
