import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { JobContext } from "@/lib/jobs/runner";

const state = vi.hoisted(() => ({ targets: [] as { item_id: number; product_id: number; slug: string; reason: string; reject_revision: string }[],
  observations: [] as unknown[], writes: [] as { decision: string }[], capacity: [] as Record<string, unknown>[], wire: [] as Record<string, unknown>[],
  decision: "approve" as "approve" | "reject" | "needs_review", deferred: false, stale: false, switchedOff: false, calls: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => ({ where: async () => [] }) }) } }));
vi.mock("@/lib/jobs/control", async load => ({ ...await load<typeof import("@/lib/jobs/control")>(),
  withJobLeaseWrite: async (_lease: unknown, write: (tx: unknown) => unknown) => write({ insert: () => ({ values: (row: unknown) => ({
    onConflictDoUpdate: async () => { state.observations.push(row); } }) }) }) }));
vi.mock("@/lib/crawl/product-audit", () => ({ loadAuditInput: async () => ({ inputHash: "a".repeat(64),
  validUntil: new Date(Date.now() + (state.stale ? -1 : 3600_000)), snapshot: { product: { url: "https://fixture.test", repo: "test/tool" } } }) }));
vi.mock("@/lib/crawl/same-model-recheck-repository", () => ({ sameModelRecheckTargets: async () => state.targets,
  writeSameModelRecheck: async (_target: unknown, review: { outcome: { decision: string } }) => {
    if (state.switchedOff) return "switched_off";
    state.writes.push(review.outcome); return "written";
  } }));
vi.mock("@/lib/crawl/qwen-endpoint-backoff", () => ({ qwenEndpointBackingOff: () => false,
  withQwenSecondarySlot: (run: () => unknown) => run(), noteQwenEndpointSuccess: async () => {}, noteQwenCallFailure: async () => ({ outage: false }) }));
vi.mock("@/lib/crawl/qwen-direct-review", async load => ({ ...await load<typeof import("@/lib/crawl/qwen-direct-review")>(),
  qwenDirectConfig: () => ({ model: "qwen3.8-flash-next", baseUrl: "http://fixture.invalid/v1", apiKey: null }) }));
vi.mock("@/lib/llm/local-model-capacity", () => ({ verifiedLocalModelContract: () => ({ model: "fixture" }),
  withLocalModelCapacity: async (context: Record<string, unknown>, run: (request: typeof fetch) => unknown) => {
    state.capacity.push(context); if (state.deferred) throw new ModelCapacityDeferredError("capacity"); return run(fetch);
  } }));
vi.mock("@/lib/crawl/agent-review-gateway", async load => ({ ...await load<typeof import("@/lib/crawl/agent-review-gateway")>(),
  reviewWithGateway: async (_input: unknown, options: Record<string, unknown>) => {
    state.calls++; state.wire.push(options);
    return { ok: true, outcome: { decision: state.decision, reason: "근거 있는 실제 소프트웨어", confidence: 0.95, evidenceIds: ["product"] } };
  } }));

const { runSameModelRechecks } = await import("@/lib/crawl/same-model-recheck");
const { SAME_MODEL_RECHECK_ADDENDUM } = await import("@/lib/crawl/same-model-recheck-review");
const { SAME_MODEL_RECHECK_LABEL, SAME_MODEL_RECHECK_PROMPT_VERSION } = await import("@/lib/crawl/same-model-recheck-policy");
const { QWEN_V2_ADDENDUM } = await import("@/lib/crawl/qwen-direct-review");
const { parseSetQwenAutoArgs } = await import("@/scripts/ops/set-qwen-auto");
const { storedQwenAuto } = await import("@/lib/crawl/settings");
const rank = (model = "qwen3.8-flash-next", rank = 1) => ({ task: "audit-second-opinion", slot: 1, rank, model, enabled: true, options: {},
  connection: { id: "00000000-0000-4000-8000-000000000001", label: "fixture", kind: "api" as const, baseUrl: "http://fixture.invalid/v1",
    cliTool: null, deviceId: "fixture", enabled: true, models: null, contextTokens: 32768, apiKey: null, keyUnreadable: false } });
const settings = (enabled = true, perTick = 1): CrawlSettings => ({ ...DEFAULT_CRAWL_SETTINGS, enabled: true,
  qwenAuto: { ...DEFAULT_CRAWL_SETTINGS.qwenAuto, auditSecondOpinion: { ...DEFAULT_CRAWL_SETTINGS.qwenAuto.auditSecondOpinion, enabled: true },
    sameModelRecheck: { enabled, perTick } } });
const context = (): JobContext<null> => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: () => {}, deadlineAt: Date.now() + 70_000,
  lease: { name: "audit-second-opinion", token: randomUUID(), requestedVersion: 1 } });
beforeEach(() => {
  state.targets = Array.from({ length: 3 }, (_, id) => ({ item_id: id + 1, product_id: id + 101, slug: `tool-${id}`, reason: "a company website", reject_revision: "f".repeat(32) }));
  state.observations = []; state.writes = []; state.capacity = []; state.wire = [];
  state.decision = "approve"; state.deferred = false; state.stale = false; state.switchedOff = false; state.calls = 0;
  setAiTaskModelsForTest([rank()]);
});
afterEach(() => setAiTaskModelsForTest(null));

describe("같은 모델 재검토 — 살리는 쪽만", () => {
  it("다른 모델이 있으면 재검토에 들어가지 않는다", async () => {
    setAiTaskModelsForTest([rank(), rank("deepseek-v4.1-flash-1017", 2)]);
    expect((await runSameModelRechecks(context(), settings())).asked).toBe(0);
    expect(state.capacity).toEqual([]); expect(state.calls).toBe(0);
  });
  it("다른 모델 없음 + 스위치 꺼짐이면 사람 몫 그대로", async () => {
    await runSameModelRechecks(context(), settings(false));
    expect(state.capacity).toEqual([]); expect(state.writes).toEqual([]);
  });
  it("켜짐 + 유지는 사람 확인 권고만 남긴다", async () => {
    expect(await runSameModelRechecks(context(), settings())).toMatchObject({ asked: 1, recommended: 1 });
    expect(state.writes).toMatchObject([{ decision: "approve" }]);
    expect(SAME_MODEL_RECHECK_LABEL).toBe("사람 확인 — 재검토가 유지 권함");
  });
  it.each(["reject", "needs_review"] as const)("켜짐 + %s는 사람 확인 상태를 바꾸지 않는다", async decision => {
    state.decision = decision;
    expect(await runSameModelRechecks(context(), settings())).toMatchObject({ asked: 1, recommended: 0 });
    expect(state.writes).toMatchObject([{ decision }]);
  });
  it("틱당 상한은 반환된 후보 수와 상관없이 고정한다", async () => {
    expect(await runSameModelRechecks(context(), settings(true, 2))).toMatchObject({ asked: 2, recommended: 2 });
    expect(state.capacity).toHaveLength(2);
  });
  it("기존 장부 경로로만 부르고 disabled 레거시 우회는 금지한다", async () => {
    state.deferred = true;
    await runSameModelRechecks(context(), settings());
    expect(state.capacity).toMatchObject([{ target: { kind: "audit", purpose: "second_opinion" }, allowLegacy: false,
      promptVersion: SAME_MODEL_RECHECK_PROMPT_VERSION }]);
    expect(state.calls).toBe(0); expect(state.writes).toEqual([]);
  });
  it("순위에 같은 모델 연결조차 없으면 기본 주소로 우회하지 않는다", async () => {
    setAiTaskModelsForTest([]); await runSameModelRechecks(context(), settings());
    expect(state.capacity).toEqual([]);
  });
  it("입력 기한은 기존 용량 증명과 같고 지난 근거를 거절 표로 바꾸지 않는다", async () => {
    state.stale = true;
    expect(await runSameModelRechecks(context(), settings())).toMatchObject({ inputStale: 1, asked: 0 });
    expect(state.capacity).toEqual([]); expect(state.writes).toEqual([]);
  });
  it("받는 동안 끄면 결과도 반영하지 않는다", async () => {
    state.switchedOff = true;
    expect(await runSameModelRechecks(context(), settings(true, 3))).toMatchObject({ asked: 1, recommended: 0 });
    expect(state.writes).toEqual([]);
  });
  it("공통 시스템 앞부분 보존 + 반대 입장·실제 제작·계속 AI 개발·오래됐다는 이유만의 거절 금지", async () => {
    await runSameModelRechecks(context(), settings());
    expect(SAME_MODEL_RECHECK_ADDENDUM.startsWith(QWEN_V2_ADDENDUM)).toBe(true);
    expect(SAME_MODEL_RECHECK_ADDENDUM).toContain("claim to challenge");
    expect(SAME_MODEL_RECHECK_ADDENDUM).toContain("actually built software");
    expect(SAME_MODEL_RECHECK_ADDENDUM).toContain("AI continues to build");
    expect(SAME_MODEL_RECHECK_ADDENDUM).toContain("Do not reject merely because the evidence is old");
    expect(state.wire[0]).toMatchObject({ sameModelRecheck: { initialRejectReason: "a company website" } });
  });
  it("출처는 별도 표만 쓴다 — 내리기·숨기기·유지 확정·독립 의견 writer가 없다", () => {
    const source = readFileSync(new URL("../lib/crawl/same-model-recheck-repository.ts", import.meta.url), "utf8");
    expect(source).toContain("tx.insert(productAuditSameModelRechecks)");
    expect(source).not.toMatch(/tx\.(update|delete)\(|writeAuditSecondOpinions|autoCloseOpinion|releaseAuditHold|setStatusWithAudit/);
    for (const file of ["audit-auto-close.ts", "audit-second-opinions.ts", "product-audit-hold.ts", "audit-policy.ts"]) {
      expect(readFileSync(new URL(`../lib/crawl/${file}`, import.meta.url), "utf8")).not.toContain("product_audit_same_model_rechecks");
    }
  });
  it("기존 운영 CLI는 새 스위치의 켜기·끄기·읽기 전용 예행을 받는다", () => {
    expect(parseSetQwenAutoArgs(["--step=sameModelRecheck", "--enable", "--per-tick=1", "--reason=사람 확인", "--dry-run"]))
      .toMatchObject({ step: "sameModelRecheck", enable: true, perTick: 1, dryRun: true });
    expect(parseSetQwenAutoArgs(["--step=sameModelRecheck", "--disable"])).toMatchObject({ enable: false });
    expect(() => parseSetQwenAutoArgs(["--step=sameModelRecheck", "--auto-close=on"])).toThrow("qwen_auto_usage");
  });
  it("옛 행·깨진 스위치는 기본 꺼짐이며 틱 상한을 검증한다", () => {
    expect(storedQwenAuto({}).sameModelRecheck).toEqual({ enabled: false, perTick: 1 });
    for (const perTick of [0, -1, 101, 1.5]) {
      expect(storedQwenAuto({ qwenAuto: { sameModelRecheck: { enabled: true, perTick } } }).sameModelRecheck.enabled).toBe(false);
    }
  });
});
