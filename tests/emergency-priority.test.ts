import { describe, expect, it } from "vitest";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import {
  classifyEmergencyMode, EMERGENCY_JOB_POLICY, EMERGENCY_TIERS, planEmergencyAdmission,
  type EmergencyPlan, type EmergencyPlanInput,
} from "@/lib/operations/emergency-priority";

/**
 * 비상 운영(PR16) 우선순위 — M3·mini가 모두 멈췄을 때 Oracle 1CPU 위에서 무엇을 먼저 들일지 정하는 순수 판정.
 * 순서는 DB/제어 → 번역·연결 확인·발행후 반영 → 이미 승인된 발행 → 준비된 후보 심사 → 근거 → 신규 발굴(로드맵 PR16 행).
 */
describe("비상 모드 상태", () => {
  const input = (m3: "alive" | "down", mini: "alive" | "down", writer: "active" | "fenced" | "unreachable" = "active", oracleTakeoverRoles = 0) =>
    ({ m3, mini, writer, oracleTakeoverRoles });
  it("M3 정상·부분·전면 장애와 인계 복귀를 구분한다", () => {
    expect(classifyEmergencyMode(input("alive", "alive"))).toEqual({ mode: "normal", reason: "all_alive" });
    expect(classifyEmergencyMode(input("down", "alive"))).toEqual({ mode: "partial", reason: "m3_down" });
    expect(classifyEmergencyMode(input("alive", "down"))).toEqual({ mode: "partial", reason: "mini_down" });
    expect(classifyEmergencyMode(input("down", "down"))).toEqual({ mode: "full", reason: "m3_and_mini_down" });
    expect(classifyEmergencyMode(input("down", "down", "active", 3))).toEqual({ mode: "full", reason: "m3_and_mini_down" });
    // 돌아온 host 가 Oracle 의 현 소유를 선점하지 않는다 — 계획 drain 전까지 비상 예산 그대로
    expect(classifyEmergencyMode(input("alive", "down", "active", 2))).toEqual({ mode: "recovering", reason: "oracle_holds_takeover_roles" });
    expect(classifyEmergencyMode(input("alive", "alive", "active", 1))).toEqual({ mode: "recovering", reason: "oracle_holds_takeover_roles" });
  });

  it("writer 가 확실하지 않으면 host 상태와 상관없이 제어만 남긴다", () => {
    expect(classifyEmergencyMode(input("down", "down", "unreachable"))).toEqual({ mode: "hold", reason: "writer_unreachable" });
    expect(classifyEmergencyMode(input("alive", "alive", "fenced"))).toEqual({ mode: "hold", reason: "writer_fenced" });
  });

  it("알 수 없는 입력은 거절한다", () => {
    expect(() => classifyEmergencyMode({ ...input("down", "down"), oracleTakeoverRoles: -1 })).toThrow("emergency_mode_input_invalid");
    expect(() => classifyEmergencyMode({ ...input("down", "down"), oracleTakeoverRoles: 0.5 })).toThrow("emergency_mode_input_invalid");
    expect(() => classifyEmergencyMode({ ...input("down", "down"), m3: "unknown" as "down" })).toThrow("emergency_mode_input_invalid");
  });
});

describe("비상 잡 분류", () => {
  it("카탈로그의 모든 잡을 한 번씩 분류하고, 없는 이름은 없다", () => {
    expect(Object.keys(EMERGENCY_JOB_POLICY).sort()).toEqual(JOB_CATALOG.map((job) => job.name).sort());
  });

  it("단계 순서와 대표 잡의 자리", () => {
    expect(EMERGENCY_TIERS).toEqual(["control", "translation-uptime", "approved-publish", "prepared-review", "evidence", "discovery"]);
    const tier = (job: string) => { const policy = EMERGENCY_JOB_POLICY[job]; return policy === "suspended" ? policy : policy.tier; };
    expect(tier("heartbeat")).toBe("control");
    for (const job of ["reason-translate", "product-tagline-ko", "product-translate", "uptime-ping", "cdn-purge", "product-search-refresh", "product-embedding"]) {
      expect(tier(job)).toBe("translation-uptime");
    }
    expect(tier("crawl-publish")).toBe("approved-publish");
    for (const job of ["crawl-judge", "crawl-agent-review", "second-review", "crawl-tagline"]) expect(tier(job)).toBe("prepared-review");
    for (const job of ["product-site-evidence-refresh", "product-evidence-refresh", "news-refresh"]) expect(tier(job)).toBe("evidence");
    for (const job of ["crawl-seed", "hn-show-seed", "crawl-fetch"]) expect(tier(job)).toBe("discovery");
    for (const job of ["product-audit", "product-repo-review", "product-spam-rescan", "click-rollup"]) expect(tier(job)).toBe("suspended");
  });
});

describe("비상 admission", () => {
  const AGING = 300_000;
  const base: EmergencyPlanInput = {
    mode: "full", due: [], paused: new Set(), verifiedModelJobs: new Set(), embedding: "degraded", hostPressure: null,
    budget: { jobs: 4, modelJobs: 1, httpJobs: 1, agingMs: AGING },
  };
  const due = (...rows: [string, number][]) => rows.map(([job, overdueMs]) => ({ job, overdueMs }));
  const decisions = (plan: EmergencyPlan) => {
    if (!plan.active) throw new Error("inactive");
    return plan.decisions.map((row) => [row.job, row.reason]);
  };

  it("정상·부분 장애에서는 끼어들지 않는다", () => {
    expect(planEmergencyAdmission({ ...base, mode: "normal", due: due(["reason-translate", 0]) })).toEqual({ active: false });
    expect(planEmergencyAdmission({ ...base, mode: "partial", due: due(["reason-translate", 0]) })).toEqual({ active: false });
  });

  it("단계 순서대로, 잡·모델·HTTP 예산 안에서만 들인다 — 제어는 예산 밖에서 늘 먼저", () => {
    const plan = planEmergencyAdmission({ ...base,
      verifiedModelJobs: new Set(["reason-translate", "crawl-publish", "crawl-agent-review"]),
      due: due(["crawl-seed", 0], ["crawl-agent-review", 0], ["uptime-ping", 0], ["reason-translate", 0], ["heartbeat", 0], ["crawl-publish", 0], ["crawl-judge", 0]) });
    expect(decisions(plan)).toEqual([
      ["heartbeat", "admitted"], ["reason-translate", "admitted"], ["uptime-ping", "admitted"], ["crawl-publish", "budget_model"],
      ["crawl-agent-review", "budget_model"], ["crawl-judge", "admitted"], ["crawl-seed", "budget_http"],
    ]);
    const tight = planEmergencyAdmission({ ...base, budget: { ...base.budget, jobs: 1 }, due: due(["uptime-ping", 0], ["crawl-judge", 0], ["heartbeat", 0]) });
    expect(decisions(tight)).toEqual([["heartbeat", "admitted"], ["uptime-ping", "admitted"], ["crawl-judge", "budget_jobs"]]);
  });

  it("기존 pause·api-stop 을 풀지 않는다 — 신규 발굴 중단도 그대로", () => {
    const plan = planEmergencyAdmission({ ...base, paused: new Set(["crawl-seed", "hn-show-seed", "heartbeat"]),
      due: due(["crawl-seed", 9 * AGING], ["hn-show-seed", 0], ["heartbeat", 0], ["crawl-fetch", 0]) });
    expect(decisions(plan)).toEqual([["heartbeat", "paused_preserved"], ["crawl-seed", "paused_preserved"], ["crawl-fetch", "admitted"], ["hn-show-seed", "paused_preserved"]]);
  });

  it("검증된 독립 모델이 없으면 모델 잡은 기다리고 HTTP 관리는 계속한다", () => {
    const plan = planEmergencyAdmission({ ...base, due: due(["reason-translate", 0], ["product-tagline-ko", 0], ["uptime-ping", 0], ["crawl-publish", 0]) });
    expect(decisions(plan)).toEqual([["product-tagline-ko", "model_unverified"], ["reason-translate", "model_unverified"],
      ["uptime-ping", "admitted"], ["crawl-publish", "model_unverified"]]);
  });

  it("같은 임베딩이 확인되지 않으면 벡터 잡을 돌리지 않는다", () => {
    for (const embedding of ["degraded", "legacy"] as const) {
      expect(decisions(planEmergencyAdmission({ ...base, embedding, due: due(["product-embedding", 0]) })))
        .toEqual([["product-embedding", "embedding_not_semantic"]]);
    }
    expect(decisions(planEmergencyAdmission({ ...base, embedding: "semantic", due: due(["product-embedding", 0]) })))
      .toEqual([["product-embedding", "admitted"]]);
  });

  it("비상 중 미루는 잡과 분류되지 않은 잡은 들이지 않는다", () => {
    expect(decisions(planEmergencyAdmission({ ...base, due: due(["product-audit", 0], ["brand-new-job", 0]) })))
      .toEqual([["brand-new-job", "unknown_job"], ["product-audit", "suspended"]]);
  });

  it("새 보강·독립 감사는 모델 검증 여부와 무관하게 미루고 기존 pause도 보존한다", () => {
    const jobs = ["product-automated-action-audit", "product-llm-assist-audit-review", "product-llm-assist-review"];
    for (const mode of ["full", "recovering"] as const) {
      const input = { ...base, mode, verifiedModelJobs: new Set(jobs), due: jobs.map(job => ({ job, overdueMs: 10 * AGING })) };
      expect(decisions(planEmergencyAdmission(input))).toEqual(jobs.map(job => [job, "suspended"]));
      expect(decisions(planEmergencyAdmission({ ...input, paused: new Set(jobs) })))
        .toEqual(jobs.map(job => [job, "paused_preserved"]));
    }
  });

  it("writer 가 확실하지 않거나 host 가 압박이면 제어만 들인다", () => {
    const work = due(["uptime-ping", 0], ["heartbeat", 0]);
    expect(decisions(planEmergencyAdmission({ ...base, mode: "hold", due: work }))).toEqual([["heartbeat", "admitted"], ["uptime-ping", "hold_control_only"]]);
    expect(decisions(planEmergencyAdmission({ ...base, hostPressure: "host_pressure_heartbeat", due: work })))
      .toEqual([["heartbeat", "admitted"], ["uptime-ping", "host_pressure"]]);
  });

  it("오래 기다린 아래 단계 잡이 결국 차례를 얻는다(공정 배분)", () => {
    const models = new Set(["reason-translate", "crawl-agent-review"]);
    const at = (reviewOverdue: number) => decisions(planEmergencyAdmission({ ...base, verifiedModelJobs: models,
      due: due(["reason-translate", 30_000], ["crawl-agent-review", reviewOverdue]) }));
    expect(at(AGING)).toEqual([["reason-translate", "admitted"], ["crawl-agent-review", "budget_model"]]);
    expect(at(2 * AGING)).toEqual([["crawl-agent-review", "admitted"], ["reason-translate", "budget_model"]]);
  });

  it("인계 복귀 중에도 비상 예산을 유지한다", () => {
    expect(planEmergencyAdmission({ ...base, mode: "recovering", due: due(["uptime-ping", 0]) }))
      .toEqual({ active: true, decisions: [{ job: "uptime-ping", tier: "translation-uptime", admitted: true, reason: "admitted" }] });
  });

  it("예산은 실측값을 모두 명시해야 하고 기본값이 없다", () => {
    for (const budget of [{ jobs: 1, modelJobs: 1, httpJobs: 1 }, { ...base.budget, jobs: -1 }, { ...base.budget, modelJobs: 0.5 },
      { ...base.budget, httpJobs: Number.NaN }, { ...base.budget, agingMs: 0 }, { ...base.budget, extra: 1 }]) {
      expect(() => planEmergencyAdmission({ ...base, budget: budget as EmergencyPlanInput["budget"] })).toThrow("emergency_budget_invalid");
    }
    expect(() => planEmergencyAdmission({ ...base, due: due(["uptime-ping", 0], ["uptime-ping", 1]) })).toThrow("emergency_due_invalid");
    expect(() => planEmergencyAdmission({ ...base, due: due(["uptime-ping", -1]) })).toThrow("emergency_due_invalid");
  });
});
