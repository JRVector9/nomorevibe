import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({
  pendingProfiles: vi.fn(), pendingVerifications: vi.fn(),
  recordProfileResult: vi.fn(), recordVerificationResult: vi.fn(),
  writeKeywords: vi.fn(), verifyKeywords: vi.fn(), verifyKeywordsInChunks: vi.fn(),
}));
// 이어받은 일감의 순위(resumedProfileModel)는 없다 — 잡이 1순위부터 부른다
vi.mock("@/lib/domain/products/search-profiles", () => ({ ...domain, resumedProfileModel: () => null }));
vi.mock("@/lib/domain/products/search-profile-model-capacity", () => ({
  writeKeywordsWithModelCapacity: async (_task: unknown, _lease: unknown, options: { timeoutMs: number; signal?: AbortSignal }) => ({
    kind: "result", result: await domain.writeKeywords({}, options),
  }),
}));
vi.mock("@/lib/domain/products/search-verify-model-capacity", () => ({
  verifyKeywordsWithModelCapacity: async (_task: unknown, _lease: unknown,
    options: { timeoutMs: number; chunked: boolean; signal?: AbortSignal; request?: typeof fetch }) => ({ kind: "result",
    result: await (options.chunked ? domain.verifyKeywordsInChunks : domain.verifyKeywords)({}, { request: options.request, signal: options.signal, timeoutMs: options.timeoutMs }),
  }),
}));
vi.mock("@/lib/domain/products/search-profile", () => ({
  profileEvidence: () => ({}), profileHash: () => "hash",
  writeKeywords: domain.writeKeywords,
}));
vi.mock("@/lib/domain/products/search-verify", () => ({ verifyKeywords: domain.verifyKeywords,
  verifyKeywordsInChunks: domain.verifyKeywordsInChunks }));
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import type { JobContext } from "@/lib/jobs/runner";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract } from "./text-task-ranks-fixture";

const tasks = (count: number) => Array.from({ length: count }, (_, id) => ({
  product: { id }, reviewerNote: null,
  profile: { keywordsEn: ["calendar"], keywordsKo: ["달력"], needsRefresh: true, sourceHash: "old" },
}));
const ctx = (): JobContext<null> => ({
  cursor: null, lease: { name: "test", token: "token", requestedVersion: 1 },
  hasBudget: () => true, log: vi.fn(), save: vi.fn(),
});
// Both jobs open only on an engine connected directly (admin contract, transport direct); the gateway key env is gone (2026-10-30).
// 모델은 「작업 ↔ 모델」 순위가 고른다(PR B) — 두 작업에 순위 하나씩과 그 연결을 가리키는 직접 계약을 둔다.
beforeEach(() => {
  vi.resetAllMocks();
  pinTextRanks({ "product-search-profile": "generator", "product-search-verify": "verifier" });
  setServingContractSnapshotForTest([textContract("product-search-profile", "generator"), textContract("product-search-verify", "verifier")]);
  vi.useFakeTimers({ toFake: ["Date"] });
  domain.recordProfileResult.mockResolvedValue(true);
  domain.recordVerificationResult.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setRuntimeSettingsForTest(null); setServingContractSnapshotForTest(null); pinTextRanks(null); });

describe("search job time budget", () => {
  it.each(["invalid_output", "timeout"])("uses chunk verification only on a later %s retry", async (verifyError) => {
    const task = { ...tasks(1)[0], profile: { ...tasks(1)[0].profile, verifyError } };
    domain.pendingVerifications.mockResolvedValueOnce([task]).mockResolvedValue([]);
    domain.verifyKeywordsInChunks.mockResolvedValue({ ok: true, unsupported: [] });
    await verifySearchKeywords(ctx());
    expect(domain.verifyKeywordsInChunks).toHaveBeenCalledTimes(1);
    expect(domain.verifyKeywords).not.toHaveBeenCalled();
    expect(domain.recordVerificationResult).toHaveBeenCalledTimes(1);
  });
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

  it("reads the route timeout and the job knobs per tick — an admin save applies without a module reload", async () => {
    // routes.limits.product-search-profile.timeoutMs 30초 → 다음 틱의 호출 상한; jobs.product-search-profile.minCallMs 50초 → 첫 호출 뒤에는 남은 시간이 모자라 접는다
    setRuntimeSettingsForTest({ version: 1, routes: { limits: { "product-search-profile": { timeoutMs: 30_000 } } },
      jobs: { "product-search-profile": { minCallMs: 50_000 } } });
    domain.pendingProfiles.mockResolvedValue(tasks(8));
    domain.writeKeywords.mockImplementation(async (_evidence, options) => {
      expect(options.timeoutMs).toBe(30_000);
      vi.setSystemTime(Date.now() + 6_000);
      return { ok: true, en: ["calendar"], ko: ["달력"] };
    });
    expect(await writeSearchProfiles(ctx())).toEqual({ done: false });
    expect(domain.writeKeywords).toHaveBeenCalledTimes(1);
    expect(domain.recordProfileResult).toHaveBeenCalledTimes(1);
    // 기본값으로 돌아오면 같은 프로세스에서 바로 45초·동시 둘로 돈다 — 모듈이 값을 로드 시점에 붙들지 않는다
    setRuntimeSettingsForTest(null);
    vi.resetAllMocks(); domain.recordProfileResult.mockResolvedValue(true);
    domain.pendingProfiles.mockResolvedValueOnce(tasks(1)).mockResolvedValue([]);
    domain.writeKeywords.mockImplementation(async (_evidence, options) => { expect(options.timeoutMs).toBe(45_000); return { ok: false, error: "timeout" }; });
    await writeSearchProfiles(ctx());
    expect(domain.writeKeywords).toHaveBeenCalledTimes(1);
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
