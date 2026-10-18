import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { ModelHealth } from "@/lib/operations/dashboard";
import { buildPipelineCompletions } from "@/lib/operations/pipeline-completions";
import { buildPipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { resolveModelSlots } from "@/lib/operations/stage-registry";
import type { ThroughputStage } from "@/lib/operations/throughput-model";
import type { StageProgress } from "@/lib/operations/worker-progress";
import { readXStatus } from "@/lib/operations/x-status";
import { humanOverview } from "./fixtures/human-queue";
import { AI1_EXPECTED, AI2_EXPECTED } from "./pipeline-completions-fixture";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params, useRouter: () => ({ refresh: vi.fn() }) }));

import { PipelineCompletions } from "@/app/(operator)/admin/status/PipelineCompletions";
import { FlowDetailView } from "@/app/(operator)/admin/status/FlowDetail";
import { modelTone } from "@/app/(operator)/admin/status/dashboard/ModelCards";
import { deferralLabel, enrichmentNodes, ledgerRows, slotRows } from "@/app/(operator)/admin/status/flow-model";
import { modelSlotCallsSql } from "@/lib/operations/flow-reads";
import { FIRST_MODEL_CALL_SQL } from "@/lib/operations/dashboard";

/**
 * 운영센터 개편 v8 PR6 — 흐름 상세 탭. 소스 → 심사 흐름 노드 → 보강 12(+그 밖), 노드 상세(처리 지표 칸 그대로 · 모델 · 미룬 이유),
 * 모델 자리 전체 표, 장부 쉬운 말 요약, X 노드. 새 숫자는 복제본 전용·DB 기준 시각·실패는 보류.
 */
const NOW = "2026-10-17T23:44:06.000Z";
const at = "2026-10-17T23:40:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }, { provider: "abcllm", model: "[MLX] qwen3.6" }],
    fallbacks: [{ provider: "abcllm", model: "qwen3-coder:30b" }] } } as typeof DEFAULT_CRAWL_SETTINGS;
const slots = resolveModelSlots(settings, {});
const models: ModelHealth[] = [
  { key: "first", label: "1차 심사", model: "[MLX] gpt-oss-120b", calls1h: 70, failed1h: 0, avgSeconds: 10, agreement1h: null, lastSuccessAt: null },
  { key: "second", label: "2차 투표", model: "[supa] Qwen3.8-27B-NVFP4", calls1h: 35, failed1h: 9, avgSeconds: 11.6, agreement1h: 0.85, lastSuccessAt: null },
  { key: "fallback", label: "2차 예비 모델", model: "qwen3-coder:30b", calls1h: 8, failed1h: 0, avgSeconds: 32, agreement1h: 0.88, lastSuccessAt: null },
  { key: "keywords", label: "키워드 짓기", model: "[MLX] gpt-oss-120b", calls1h: 247, failed1h: 0, avgSeconds: null, agreement1h: null, lastSuccessAt: null },
];
const row = (slot: string, calls: number, failed: number, calls1h = 0, failed1h = 0, agree1h: number | null = null) =>
  ({ slot, observed: null, calls1h, failed1h, calls, failed, agree1h, agree: null });
const day = { ok: true as const, value: { at, window: "24h" as const, rows: [row("first", 900, 0), row("second-voter-1", 800, 210), row("second-voter-2", 40, 2, 6, 1, 0.5),
  row("second-fallback-1", 60, 2), row("keywords", 3000, 0), row("audit", 4503, 3, 200, 0), row("product-translate", 1400, 457, 30, 10), row("embedding", 120, 0, 12, 0)] } };
const week = { ok: true as const, value: { at, window: "7d" as const, rows: [row("first", 7000, 910), row("second-voter-1", 5000, 4525)] } };

describe("모델 자리 전체 — 같은 판정, 근사 자리는 중립 색, 24h·7일은 회색 참고", () => {
  const rows = slotRows({ settings, slots, models, day, week });
  const byKey = (key: string) => rows.find((item) => item.key === key)!;

  it("카드 네 자리의 최근 1시간은 모델 카드와 같은 수·같은 색 규칙이다", () => {
    expect(byKey("first").chip).toEqual({ tone: "ok", text: "0% (0/70)" });
    expect(byKey("second-voter-1").chip).toEqual({ tone: modelTone(models[1]).tone, text: "26% (9/35)" });
    expect(byKey("second-voter-1").chip.tone).toBe("bad");
    expect(byKey("second-fallback-1").chip).toEqual({ tone: "ok", text: "0% (0/8)" });
    expect(byKey("second-fallback-1").agree).toBe("88%");
  });

  it("카드 밖의 정확한 자리(2차 투표 2·감사)는 복제본 1시간 수에 같은 규칙", () => {
    // 2차 투표의 일치 70% 미만은 주황 — 모델 카드의 2차 투표와 같은 규칙
    expect(byKey("second-voter-2").chip).toEqual({ tone: "warn", text: "일치 50% · 17% (1/6)" });
    expect(byKey("audit").chip).toEqual({ tone: "ok", text: "0% (0/200)" });
    expect(byKey("first").day).toBe("0%");
    expect(byKey("first").week).toBe("13%");
    expect(byKey("second-voter-1").week).toBe("90.5%");
  });

  it("결과 행으로 근사한 자리는 빨강·주황 없이 '참고'", () => {
    const translate = byKey("product-translate");
    expect(translate.approximated).toBe(true);
    expect(translate.chip).toEqual({ tone: undefined, text: "참고 · 실패 33%" });
    expect(byKey("embedding").chip).toEqual({ tone: undefined, text: "참고 · 결과 12건" });
    expect(byKey("product-translate").day).toBe("32.6%");
    expect(byKey("reason-translate").chip).toEqual({ tone: undefined, text: "참고 · 결과 없음" });
  });

  it("복제본을 못 읽으면 카드 밖 자리와 참고 칸은 보류(카드 네 자리의 1시간은 지금 수 그대로)", () => {
    const held = slotRows({ settings, slots, models, day: { ok: false, reason: "lagging" }, week: { ok: false, reason: "error" } });
    expect(held.find((item) => item.key === "first")!.chip.text).toBe("0% (0/70)");
    expect(held.find((item) => item.key === "audit")!.chip).toEqual({ tone: undefined, text: "보류" });
    expect(held.find((item) => item.key === "first")!.week).toBe("보류");
  });
});

describe("새 숫자의 SQL — 모델 카드와 같은 1차 호출 기준, DB 시계", () => {
  it("1차 자리는 modelHealth 와 같은 firstModelCall 조건으로 센다", () => {
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(modelSlotCallsSql(slots, "24h")).sql;
    expect(query).toContain(dialect.sqlToQuery(FIRST_MODEL_CALL_SQL).sql);
    expect(query).toContain("clock_timestamp()");
    expect(query).toContain("interval '24 hours'");
    expect(dialect.sqlToQuery(modelSlotCallsSql(slots, "7d")).sql).toContain("interval '7 days'");
  });
});

describe("미룬 이유 · 장부 쉬운 말 — 코드 이름을 함께", () => {
  it("미룬 이유는 쉬운 말(코드)", () => {
    expect(deferralLabel("model_capacity")).toBe("모델 자리(model_capacity)");
    expect(deferralLabel("stage_blocked")).toBe("앞 단계 막힘(stage_blocked)");
    expect(deferralLabel("http_origin_permit")).toBe("접속 허가(http_origin_permit)");
    expect(deferralLabel("host_budget_rss")).toBe("host 예산(host_budget_rss)");
    expect(deferralLabel("weird_new_reason")).toBe("미룬 이유(weird_new_reason)");
  });

  it("장부 요약은 전체 현황 장부와 같은 값을 쉬운 말(코드)로", () => {
    const rows = ledgerRows(control);
    const text = rows.map((item) => `${item.name} | ${item.state} | ${item.numbers}`).join("\n");
    expect(text).toContain("작업 배치 | 기존 방식(legacy) | 담당 차례(epoch) 1 · 설정 판(revision) 확인 안 됨 · 쓰기 규약 판(writer 계약) 0");
    expect(text).toContain("보낸 호출(dispatched) 0 · 결과 확인 안 됨(indeterminate) 0");
    expect(text).toContain("재해 복구 쓰기 잠금(DR writer fence) | 쓰기 가능(active) | 쓰기 담당 차례(writer epoch) 1");
    expect(text).toContain("서버별 담당 권한(lease)");
  });
});

const stage = (key: ThroughputStage["key"], label: string, over: Partial<ThroughputStage> = {}): ThroughputStage => ({ key, label, unit: "건", completed1m: 1,
  completed5m: 5, waiting: 0, oldestMinutes: null, enabled: true, errors5m: 0, queueNote: "", detail: "", status: "processing", ...over });
const control = buildPipelineControlStatus({ at: NOW,
  batch: { mode: "legacy", epoch: 1, contract: 0, policy: null, policyHash: null },
  model: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldestWaitingAt: null },
  http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0, oracleCharged: 0 },
  source: { enabled: false, epoch: 1, live: 0, unsettled: 0, due: 0, backoff: 0 },
  uptime: { observationsEnabled: false, gateEnabled: false, revision: 1, sources: [], rawOnly: 0, held: 0, applied: 0, latestAt: null },
  stages: ["fetch", "ai1", "ai2"].map((name) => ({ stage: name, mode: "legacy", epoch: 1, contract: 0, live: 0, unsettled: 0 })),
  owners: [{ role: "crawler", instanceId: "m3", release: "abc", epoch: 1, live: true }],
  dr: { state: "active", epoch: 1, reason: null, updatedAt: NOW, promoted: 0, sealed: [] },
}, null);
const completions = buildPipelineCompletions({ at: NOW,
  ai1: { windows: AI1_EXPECTED, backoff: 0, human: 1, humanOldestAt: ago(125) },
  ai2: { windows: AI2_EXPECTED, ready: 1, readyOldestAt: ago(1), backoff: 0, human: 186, humanCandidates: 186, humanOldestAt: ago(90) },
  publish: { windows: { "1h": { published: 5, transitions: 5, withdrawn: 0 }, "24h": { published: 23, transitions: 23, withdrawn: 1 } }, approved: 1 },
  fetch: { ready: 0, readyOldestAt: null, backoff: 1, inFlight: 0, human: 1, humanOldestAt: ago(300) } });
const evidence = { ok: true as const, value: { at, stages: [
  { role: "crawler", stage: "agent-evidence", reason: "upstream_stalled", alarm: true, waiting: 2_786, oldestMinutes: 37 * 1440 },
] as StageProgress[] } };
const view = (over: Record<string, unknown> = {}) => createElement(FlowDetailView, {
  now: NOW, settings, models, held: 5, quota: null,
  throughput: { measuredAt: NOW, stages: [stage("fetch", "원본 수집", { completed5m: 89 }), stage("judge", "규칙 판정", { status: "idle", completed5m: 0 }),
    stage("first", "AI 1차"), stage("second", "AI 2차", { unit: "표", waiting: 1, oldestMinutes: 0.5 }), stage("publish", "발행", { waiting: 1 })] },
  workerProgress: null, human: humanOverview({ human: 206, agreed: 4, oldestDays: 14, in24h: 5, decided: 0 }),
  jobs: [{ name: "second-review", lastError: null, lastRunAt: new Date(ago(1)), nextScheduledAt: null, notBefore: null, lastSuccessAt: new Date(ago(1)) }],
  flow: { bottleneck: "review", published: 0, stages: [{ key: "fetch", label: "원본 수집 대기", waiting: 0, entered: 472, left: 463, job: "crawl-fetch" }] },
  hourly: null, completions, control,
  split: { ok: true, value: { at, signals: [{ signal: settings.discover.queries[0].label, count: 449 }, { signal: "Show HN", count: 23 }] } },
  x: readXStatus([], NOW, false),
  evidence, enrichment: enrichmentNodes({ actions: [], jobs: [], evidence, health: null, attention: null, now: NOW }),
  slots: slotRows({ settings, slots, models, day, week }), day, week,
  deferrals: { ok: true, value: { at, jobs: [{ job: "second-review", reason: "model_capacity", lastDeferredAt: at, lastHour: 3, lastHourByReason: { model_capacity: 3 } }] } },
  ...over,
} as unknown as Parameters<typeof FlowDetailView>[0]);

describe("흐름 상세 탭", () => {
  beforeEach(() => { nav.params = new URLSearchParams("tab=flow"); });

  it("소스 → 심사 흐름 → 보강 12(+그 밖) → 노드 상세 → 장부 요약 · 모델 자리 표 → 미룬 이유 차례로 그린다", () => {
    const html = renderToStaticMarkup(view());
    const nodes = ["github", "show-hn", "x", "fetch", "judge", "first", "second", "human", "publish", "evidence", "agent-evidence", "intro-check", "others"]
      .map((key) => `data-node="${key}"`);
    const order = [...nodes, "ops-flow-panel", "장부 쉬운 말 요약", "모델 자리 전체", "미룬 이유 · 최근 1시간"].map((text) => html.indexOf(text));
    expect(order.every((index) => index >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/class="ops-flow-node"/g)?.length).toBe(3 + 6 + 13);
    for (const label of ["GitHub 검색", "Show HN", "원본 수집", "규칙 심사", "AI 1차", "AI 2차", "사람 심사", "발행", "공개 근거", "개발 AI 근거", "소개 검수", "그 밖의 보강"])
      expect(html).toContain(`<span class="nm">${label}</span>`);
    expect(html).toContain("GitHub 449");
    expect(html).toContain("기준 08:40:00 (DB)");
  });

  it("노드 상세에는 지금 처리 지표 카드의 그 단계 칸이 칸 하나 빠짐없이 그대로 들어간다", () => {
    nav.params = new URLSearchParams("tab=flow&node=second");
    const html = renderToStaticMarkup(view());
    const card = renderToStaticMarkup(createElement(PipelineCompletions, { status: completions }));
    const section = card.match(/<section[^>]*aria-labelledby="completions-ai2"[^>]*>.*?<\/section>/)?.[0];
    expect(section).toBeTruthy();
    expect(html).toContain(section!);
    // 이 단계의 모델과 미룬 이유
    expect(html).toContain("모델 자리(model_capacity) 3");
    expect(html).toMatch(/투표 1.*26% \(9\/35\)/);
  });

  it("노드를 고르지 않으면 흐름 차례로 가장 급한 노드(빨강 → 주황)를 연다", () => {
    // 2차 투표 모델 실패 26%(빨강) — 심사 흐름이 보강보다 앞이다
    expect(renderToStaticMarkup(view())).toMatch(/data-node="second" data-tone="bad" aria-pressed="true"/);
    const calm = models.map((row) => ({ ...row, failed1h: 0 }));
    const html = renderToStaticMarkup(view({ models: calm, slots: slotRows({ settings, slots, models: calm, day, week }) }));
    expect(html).toMatch(/data-node="agent-evidence" data-tone="bad" aria-pressed="true"/);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
  });

  it("X 노드 — 연결 전과 수집 규칙(하루 1회 · 최대 n건 읽기 · 후보만 저장)", () => {
    nav.params = new URLSearchParams("tab=flow&node=x");
    const html = renderToStaticMarkup(view());
    expect(html).toContain("연결 전");
    expect(html).toContain("하루 1회");
    expect(html).toContain("후보만 저장");
  });

  it("미룬 이유를 못 읽으면 보류(복제본 사유)", () => {
    nav.params = new URLSearchParams("tab=flow&node=second");
    const html = renderToStaticMarkup(view({ deferrals: { ok: false, reason: "no_replica" } }));
    expect(html).toContain("보류");
    expect(html).toContain("복제본 설정이 없습니다");
  });

  it("새 탭의 글자는 13px 아래로 내려가지 않는다", () => {
    const css = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/status/dashboard/flow.css"), "utf8");
    const flowRules = css.slice(css.indexOf("/* 흐름 상세 탭"));
    expect(flowRules.length).toBeGreaterThan(100);
    expect(flowRules).not.toMatch(/font-size:\s*(?:[0-9]|1[0-2])(?:\.\d+)?px/);
  });
});
