import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { firstReviewer } from "@/lib/crawl/agent-review";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import type { ThroughputSnapshot } from "@/lib/operations/throughput-model";
import { buildWorkerProgress } from "@/lib/operations/worker-progress-query";
import { ENV_MODEL_SLOTS, PIPELINE_STAGES, STAGE_EXCLUDED_JOBS, resolveModelSlots, stageForJob } from "@/lib/operations/stage-registry";

/**
 * 단계 레지스트리(운영센터 개편 v8 PR2) — 흐름 상세·레일 옆 칸이 읽을 순수 표.
 *
 * 첫 describe 가 "미등록 잡 CI"다: 카탈로그에 잡을 더하면 단계에 넣거나 제외 까닭을 적기 전에는 CI 가 빨갛다.
 */
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("미등록 잡 — 카탈로그의 잡은 정확히 한 단계에 들어가거나, 까닭과 함께 제외 목록에 있다", () => {
  it.each(JOB_CATALOG.map((job) => job.name))("%s", (name) => {
    const stages = PIPELINE_STAGES.filter((row) => row.jobs.includes(name)).map((row) => row.key);
    const excluded = Object.hasOwn(STAGE_EXCLUDED_JOBS, name);
    expect(stages.length + (excluded ? 1 : 0), `${name} — 단계 [${stages.join(", ")}]${excluded ? " · 제외 목록" : ""}`).toBe(1);
  });

  it("단계와 제외 목록은 카탈로그에 있는 잡만 가리키고, 제외 까닭은 비어 있지 않다", () => {
    const names = new Set(JOB_CATALOG.map((job) => job.name));
    for (const row of PIPELINE_STAGES) for (const job of row.jobs) expect(names.has(job), `${row.key} → ${job}`).toBe(true);
    for (const [job, reason] of Object.entries(STAGE_EXCLUDED_JOBS)) {
      expect(names.has(job), job).toBe(true);
      expect(reason.trim().length, job).toBeGreaterThan(0);
    }
  });

  it("잡에서 단계를 찾는다 — 제외한 잡과 모르는 잡은 없다", () => {
    expect(stageForJob("crawl-tagline")?.key).toBe("publish");
    expect(stageForJob("product-site-evidence-refresh")?.key).toBe("evidence");
    expect(stageForJob("heartbeat")).toBeNull();
    expect(stageForJob("no-such-job")).toBeNull();
  });
});

describe("단계 표", () => {
  const labels = (group: string, headline?: boolean) => PIPELINE_STAGES
    .filter((row) => row.group === group && (headline === undefined || (row.headline === true) === headline)).map((row) => row.label);

  it("들어오는 곳 3 · 심사 흐름 6 · 발행 후 보강 12칸과 그 밖 — 쉬운 말과 차례", () => {
    expect(labels("source")).toEqual(["GitHub 검색", "Show HN", "X"]);
    expect(labels("review")).toEqual(["원본 수집", "규칙 심사", "AI 1차", "AI 2차", "사람 심사", "발행"]);
    expect(labels("enrichment", true)).toEqual([
      "공개 근거", "개발 AI 근거", "AI 단계", "키워드 짓기", "키워드 검수", "의미 검색 벡터", "제품 번역", "사유 번역", "발행분 감사", "저장소·스타", "응답 점검", "소개 검수",
    ]);
    expect(labels("enrichment", false)).toEqual([
      "한국어 소개", "저장소 사라진 사이트 확인", "8시간 스타 관측", "README 갱신", "프로젝트 이미지", "검색 데이터 갱신", "스팸 재검사",
    ]);
    // 소스 → 심사 → 보강 차례로 놓인다
    expect(PIPELINE_STAGES.map((row) => row.group)).toEqual([...PIPELINE_STAGES.map((row) => row.group)]
      .sort((a, b) => ["source", "review", "enrichment"].indexOf(a) - ["source", "review", "enrichment"].indexOf(b)));
  });

  it("X 만 연결 전이고 잡이 없다", () => {
    expect(PIPELINE_STAGES.filter((row) => !row.connected).map((row) => row.key)).toEqual(["x"]);
    expect(PIPELINE_STAGES.find((row) => row.key === "x")).toMatchObject({ jobs: [], role: null, code: "x-pilot" });
  });

  it("열쇠·코드 이름은 겹치지 않고, 역할은 첫 잡의 카탈로그 역할이다 — 잡이 없는 단계는 역할이 없다", () => {
    const keys = PIPELINE_STAGES.map((row) => row.key), codes = PIPELINE_STAGES.map((row) => row.code);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(codes).size).toBe(codes.length);
    const roles = new Map(JOB_CATALOG.map((job) => [job.name, job.role]));
    for (const row of PIPELINE_STAGES) {
      expect(row.role, row.key).toBe(row.jobs.length ? roles.get(row.jobs[0]) : null);
      // 코드 이름은 잡이 있으면 첫 잡 이름이다
      if (row.jobs.length) expect(row.code, row.key).toBe(row.jobs[0]);
    }
    expect(PIPELINE_STAGES.filter((row) => !row.jobs.length).map((row) => row.key)).toEqual(["x", "human"]);
  });

  it("처리량·진행 열쇠는 지금 모듈의 단계를 한 번씩 가리키고, 진행 열쇠의 잡은 worker-progress 가 보는 잡과 같다", () => {
    const throughputKeys = PIPELINE_STAGES.flatMap((row) => row.throughputKey ? [row.throughputKey] : []);
    expect(throughputKeys).toEqual(["fetch", "judge", "first", "second", "publish"]);
    const stage = (key: string) => ({ key, enabled: true, waiting: 0, oldestMinutes: null, completed5m: 0, progress5m: 0, errors5m: 0 });
    const report = buildWorkerProgress({ measuredAt: new Date(0).toISOString(), stages: throughputKeys.map(stage) } as unknown as ThroughputSnapshot,
      [], [], new Date(0), { mode: "legacy", writerContractVersion: 0 }, ["evidence", "agent-evidence", "ai-level", "uptime"].map(stage) as never);
    const watched = new Map(report.stages.map((row) => [row.stage, row.job]));
    const progress = PIPELINE_STAGES.flatMap((row) => row.progressKey ? [[row.progressKey, row.jobs[0]] as const] : []);
    expect(new Map(progress)).toEqual(watched);
    expect(progress).toHaveLength(watched.size);
  });

  it("흐름(pipelineFlow)·처리 지표 열쇠는 한 단계에만 붙는다", () => {
    for (const field of ["flowKey", "completionKey"] as const) {
      const keys = PIPELINE_STAGES.flatMap((row) => row[field] ? [row[field]] : []);
      expect(new Set(keys).size, field).toBe(keys.length);
    }
    expect(PIPELINE_STAGES.find((row) => row.flowKey === "review")?.key).toBe("human");
    expect(PIPELINE_STAGES.flatMap((row) => row.completionKey ? [[row.completionKey, row.key]] : []))
      .toEqual([["fetch", "fetch"], ["ai1", "first"], ["ai2", "second"], ["publish", "publish"]]);
  });
});

describe("모델 자리 — 설정만으로 정해진다", () => {
  const settings = (review: Partial<Pick<CrawlSettings, "firstReview" | "secondReview">> = {}) =>
    ({ ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, ...review }) as CrawlSettings;
  const second = (voters: CrawlSettings["secondReview"]["voters"], fallbacks?: CrawlSettings["secondReview"]["fallbacks"]) =>
    ({ secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters, fallbacks } });
  const pick = (slots: ReturnType<typeof resolveModelSlots>, stage: string) =>
    slots.filter((slot) => slot.stage === stage).map(({ key, label, code, provider, model, source }) => ({ key, label, code, provider, model, source }));

  it("2차 투표·예비는 저장된 목록 전부다 — 투표자를 더하면 설정만으로 자리가 생긴다", () => {
    const one = resolveModelSlots(settings(second([{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }], [{ provider: "abcllm", model: "qwen3-coder:30b" }])), {});
    expect(pick(one, "second")).toEqual([
      { key: "second-voter-1", label: "투표 1", code: "secondReview.voters[0]", provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4", source: "settings" },
      { key: "second-fallback-1", label: "예비 1", code: "secondReview.fallbacks[0]", provider: "abcllm", model: "qwen3-coder:30b", source: "settings" },
    ]);
    const three = resolveModelSlots(settings(second([
      { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }, { provider: "grok-cli", model: "grok-4.7" }, { provider: "claude-cli", model: "opus" },
    ], [{ provider: "abcllm", model: "qwen3-coder:30b" }, { provider: "claude-cli", model: "sonnet" }])), {});
    expect(pick(three, "second").map((slot) => [slot.label, slot.provider, slot.model])).toEqual([
      ["투표 1", "abcllm", "[supa] Qwen3.8-27B-NVFP4"], ["투표 2", "grok-cli", "grok-4.7"], ["투표 3", "claude-cli", "opus"],
      ["예비 1", "abcllm", "qwen3-coder:30b"], ["예비 2", "claude-cli", "sonnet"],
    ]);
    // 1차와 같은 모델도 자리로는 남긴다 — 그 후보에 표를 낼지는 2차 심사가 후보마다 정한다
    const echo = resolveModelSlots(settings(second([{ provider: "abcllm", model: "gpt-oss-120b" }])), {});
    expect(pick(echo, "second").map((slot) => slot.model)).toEqual(["gpt-oss-120b"]);
  });

  it("1차는 설정 → CRAWL_REVIEW_MODEL(claude-cli) → 없음 — agent-review 의 firstReviewer 와 같고, 새 감사도 그 심사자를 쓴다", () => {
    const withFirst = settings();
    expect(pick(resolveModelSlots(withFirst, {}), "first")).toEqual([
      { key: "first", label: "주", code: "firstReview", provider: "abcllm", model: "[MLX] gpt-oss-120b", source: "settings" }]);
    const withoutFirst = { ...withFirst, firstReview: undefined } as CrawlSettings;
    for (const value of ["sonnet", " opus ", "bad model!", undefined]) {
      if (value === undefined) vi.stubEnv("CRAWL_REVIEW_MODEL", undefined); else vi.stubEnv("CRAWL_REVIEW_MODEL", value);
      const [slot] = pick(resolveModelSlots(withoutFirst, process.env), "first");
      const expected = firstReviewer(withoutFirst);
      expect({ provider: slot.provider, model: slot.model }, String(value)).toEqual({ provider: expected?.provider ?? null, model: expected?.model ?? null });
      expect(slot.source, String(value)).toBe(expected ? "env" : "unset");
      expect(pick(resolveModelSlots(withoutFirst, process.env), "audit").map(({ provider, model }) => ({ provider, model })))
        .toEqual([{ provider: slot.provider, model: slot.model }]);
    }
  });

  /** 환경변수 모델 — 각 잡 모듈은 import 할 때 환경변수를 읽는다. 같은 환경에서 모듈을 다시 읽어 레지스트리와 견준다 */
  const MODULE_CONSTANTS: Record<string, () => Promise<string>> = {
    tagline: async () => (await import("@/lib/crawl/tagline")).TAGLINE_MODEL,
    keywords: async () => (await import("@/lib/domain/products/search-profile")).PROFILE_MODEL,
    "keyword-verify": async () => (await import("@/lib/domain/products/search-verify")).VERIFY_MODEL,
    embedding: async () => (await import("@/lib/domain/products/embedding")).EMBEDDING_MODEL,
    "product-translate": async () => (await import("@/lib/crawl/translate")).TRANSLATE_MODEL,
    "reason-translate": async () => (await import("@/lib/crawl/translate")).TRANSLATE_MODEL,
    "tagline-ko": async () => (await import("@/lib/crawl/translate")).TRANSLATE_MODEL,
    "intro-check": async () => (await import("@/lib/domain/products/intro-check")).INTRO_CHECK_MODEL,
  };

  it("환경변수 모델 자리는 잡 모듈 상수와 같은 환경변수·기본값을 읽는다", async () => {
    expect(ENV_MODEL_SLOTS.map((slot) => slot.key).sort()).toEqual(Object.keys(MODULE_CONSTANTS).sort());
    for (const name of new Set(ENV_MODEL_SLOTS.flatMap((slot) => slot.env ? [slot.env] : []))) vi.stubEnv(name, undefined);
    vi.resetModules();
    const defaults = resolveModelSlots(settings(), process.env);
    for (const slot of ENV_MODEL_SLOTS) {
      const found = defaults.find((row) => row.key === slot.key)!;
      expect(found.model, slot.key).toBe(await MODULE_CONSTANTS[slot.key]());
      expect(found.source, slot.key).toBe("default");
    }
    for (const slot of ENV_MODEL_SLOTS) if (slot.env) vi.stubEnv(slot.env, `env:${slot.env}`);
    vi.resetModules();
    const overridden = resolveModelSlots(settings(), process.env);
    for (const slot of ENV_MODEL_SLOTS) {
      const found = overridden.find((row) => row.key === slot.key)!;
      expect(found.model, slot.key).toBe(await MODULE_CONSTANTS[slot.key]());
      expect(found.source, slot.key).toBe(slot.env ? "env" : "default");
      expect(found.code, slot.key).toBe(slot.env ?? "EMBEDDING_MODEL");
    }
  });

  it("호출마다 남는 기록이 없는 텍스트·벡터 자리만 근사다 — 1차·2차·감사(호출 기록)와 키워드 짓기(지금 카드 판정)는 아니다", () => {
    const slots = resolveModelSlots(settings(second([{ provider: "abcllm", model: "a" }], [{ provider: "abcllm", model: "b" }])), {});
    expect(slots.filter((slot) => slot.approximated).map((slot) => slot.key))
      .toEqual(["tagline", "keyword-verify", "embedding", "product-translate", "reason-translate", "intro-check", "tagline-ko"]);
    expect(slots.filter((slot) => !slot.approximated).map((slot) => slot.key))
      .toEqual(["first", "second-voter-1", "second-fallback-1", "keywords", "audit"]);
  });

  it("자리 열쇠는 겹치지 않고, 자리의 단계는 표에 있으며, 흐름 차례로 나온다", () => {
    const slots = resolveModelSlots(settings(second([{ provider: "abcllm", model: "a" }, { provider: "abcllm", model: "b" }], [{ provider: "abcllm", model: "c" }])), {});
    expect(new Set(slots.map((slot) => slot.key)).size).toBe(slots.length);
    const order = PIPELINE_STAGES.map((row) => row.key);
    const stages = slots.map((slot) => order.indexOf(slot.stage));
    expect(stages.every((index) => index >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect([...new Set(slots.map((slot) => slot.stage))]).toEqual([
      "first", "second", "publish", "keywords", "keyword-verify", "embedding", "product-translate", "reason-translate", "audit", "intro-check", "tagline-ko",
    ]);
  });
});
