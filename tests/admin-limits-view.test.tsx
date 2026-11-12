import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// 「실시간 한도」 개편(2026-11-11) — 작업 줄 모형·장부 실측 조립·「지금 볼 것」 규칙과 권장값·편집기 그리기와 폼 왕복·화면의 옛 닻. DB 없이 본다.
const holder = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "operator" }) }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/llm/serving-contract-store", () => ({ ensureServingContracts: async () => undefined }));
vi.mock("@/lib/operations/admin-limits-repository", () => ({ readLimitsAdminView: async () => holder.view }));

import { LimitsEditor } from "@/app/(operator)/admin/models/limits/LimitsEditor";
import LimitsPage from "@/app/(operator)/admin/models/limits/page";
import { buildLimitsView, HIDDEN_BUDGET_JOBS, LIMITS_TASKS, limitsMeasurementFromRows, limitsMeasureMap, type LimitsMeasurement, type LimitsRow,
  type LimitsTaskMeasure, type LimitsView, type LimitsViewInput } from "@/lib/operations/admin-limits-view";
import { LIMITS_PAGE_GROUPS, runtimeSettingsPatchFromForm } from "@/lib/operations/admin-runtime-settings";
import { DEFAULT_RUNTIME_SETTINGS, resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";

const NOW = new Date("2026-11-11T04:30:00.000Z");
/** 2026-11-10 운영 판(revision 6) — 권장값을 넣기 전 */
const BEFORE = { version: 1, jobs: { "second-review": { consumerConcurrency: 2 }, "published-recheck": { askBatch: 2, dailyCap: 100, scanBatch: 200, yieldHours: 1, minSimilarity: 60 } },
  routes: { limits: { "review-cli": { maxTokens: 2000, timeoutMs: 60_000, concurrency: 1 } } }, assignments: { tableReads: "off" } };
/** 2026-11-11 05:07 운영 판(revision 9) — 사유 번역 100초·45초, 소개 생성 자동, 키워드 검수 동시 3, 공개 번역 120초 */
const AFTER = { ...BEFORE, jobs: { ...BEFORE.jobs, "reason-translate": { minCallMs: 45_000 } },
  routes: { limits: { ...BEFORE.routes.limits, "product-translate": { maxTokens: 30_000, concurrency: 1, timeoutMs: 120_000 },
    "product-search-verify": { maxTokens: 3000, concurrency: 3, timeoutMs: 60_000 } } }, budgets: { "crawl-tagline": "auto", "reason-translate": 100_000 } };
const row = (values: unknown, revision = 6) => ({ values, revision, updatedBy: "jr-claude", updatedAt: "2026-11-11T04:00:00.000Z" });

const measure = (over: Partial<LimitsTaskMeasure>): LimitsTaskMeasure => ({ calls: 1_000, p50Ms: 5_000, p99Ms: 12_000, maxMs: 20_000, cutAtCap: 0, unknown: 0, tickCut: 0,
  tickCutMinMs: null, tickCutMaxMs: null, unknownAtCap: 0, cancelled: 0, ...over });
/** 운영 24시간 실측(2026-11-11 04:30 장부)의 모양 */
const MEASUREMENT: LimitsMeasurement = {
  measuredAt: NOW.toISOString(),
  tasks: {
    "reason-translate": measure({ calls: 2_297, p50Ms: 8_300, p99Ms: 19_700, maxMs: 41_800, cutAtCap: 0, unknown: 25, tickCut: 22, tickCutMinMs: 20_130, tickCutMaxMs: 36_807, unknownAtCap: 3 }),
    "product-translate": measure({ calls: 2_460, p50Ms: 6_600, p99Ms: 20_500, maxMs: 34_000 }),
    "product-search-verify": measure({ calls: 6_479, p50Ms: 17_900, p99Ms: 26_600, maxMs: 40_500, unknown: 6, tickCut: 2, unknownAtCap: 4 }),
    "first-review": measure({ calls: 3_610, p50Ms: 6_600, p99Ms: 60_700, maxMs: 62_300, cutAtCap: 90, cancelled: 395 }),
    "product-audit": measure({ calls: 0, p50Ms: null, p99Ms: null, maxMs: null, cancelled: 1_219 }),
    "audit-qwen": measure({ calls: 0, p50Ms: null, p99Ms: null, maxMs: null }),
    "search-query-translate": measure({ calls: 1, p50Ms: 1_200, p99Ms: 1_200, maxMs: 1_200 }),
  },
  mix: [{ task: "product-search-verify", provider: "abcllm", model: "supa", groupId: "supa-direct", calls: 6_479 },
    { task: "product-translate", provider: "abcllm", model: "gpt-oss-120b", groupId: "m3-mlx", calls: 1_224 },
    { task: "product-translate", provider: "abcllm", model: "m1-gemma", groupId: "m1-qwen", calls: 1_236 }],
  devices: [{ deviceId: "supa-direct", limitSlots: 3, enabled: true, modelLimits: [] }, { deviceId: "m1-qwen", limitSlots: 2, enabled: true, modelLimits: [] },
    { deviceId: "m3-mlx", limitSlots: 3, enabled: true, modelLimits: [{ model: "gpt-oss-120b", maxSlots: 2 }] }],
  policyRoutes: [{ routeId: "crawl-tagline", provider: "abcllm", model: "supa", groupId: "supa-direct" }],
  ranks: [{ task: "reason-translate", slot: 1, rank: 1, model: "m1-gemma", enabled: true },
    { task: "product-tagline-ko", slot: 1, rank: 2, model: "k-exaone_v2.5", enabled: true }, { task: "product-tagline-ko", slot: 1, rank: 1, model: "gpt-oss-120b", enabled: true },
    { task: "second-review", slot: 1, rank: 1, model: "supa", enabled: true }, { task: "second-review", slot: 2, rank: 1, model: "supa", enabled: true },
    { task: "second-review", slot: 3, rank: 1, model: "gpt-oss-120b", enabled: true }, { task: "first-review", slot: 1, rank: 1, model: "off-model", enabled: false }],
};
const PAUSES = [...new Set(LIMITS_TASKS.flatMap(task => task.jobs))].map(name => ({ name, paused: name === "product-intro-check" }));
const build = (over: Partial<LimitsViewInput> = {}) => buildLimitsView({ row: row(BEFORE), measurement: MEASUREMENT, pauses: PAUSES, now: NOW, ...over });
const rowOf = (view: LimitsView, id: string): LimitsRow => view.groups.flatMap(group => group.rows).find(entry => entry.id === id)!;
const paths = (view: LimitsView) => [view.margin.path, ...view.groups.flatMap(group => group.rows).flatMap(entry => [entry.cap.kind === "field" ? entry.cap.field.path : null,
  entry.tick.kind === "field" ? entry.tick.field.path : null, entry.concurrency.kind === "field" ? entry.concurrency.field.path : null, ...entry.details.map(field => field.path)]),
  ...view.advanced.flatMap(group => group.rows.map(entry => entry.field.path))].filter((path): path is string => !!path);

/** 그린 HTML 의 칸을 브라우저가 보내는 그대로 모은다(체크 칸은 이름이 없고, 자동은 숨은 auto: 칸으로 간다) */
function submitted(html: string): FormData {
  const data = new FormData();
  for (const match of html.matchAll(/<input([^>]*)>/g)) {
    const attrs = match[1];
    const name = /name="([^"]+)"/.exec(attrs)?.[1], value = /value="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (name && !/type="checkbox"/.test(attrs) && !/disabled=""/.test(attrs)) data.append(name, value.replace(/&amp;/g, "&"));
  }
  return data;
}

describe("작업 줄 — 실제로 읽는 칸만", () => {
  it("세 묶음에 열아홉 줄, 시안 순서대로; 닻은 row-<id>", () => {
    const view = build();
    expect(view.groups.map(group => [group.label, group.rows.map(entry => entry.label)])).toEqual([
      ["글 작업", ["사유 번역", "공개 번역", "한국어 소개", "소개 생성", "검색 키워드", "키워드 검수", "검색어 번역"]],
      ["심사", ["1차 심사", "2차 심사", "사람 큐 심사", "보류 재심사", "갈림 판정", "갈림 확인", "발행 분류"]],
      ["감사 · 쉬는 작업", ["제품 감사", "Qwen 직접 감사", "감사 2차 의견", "화면 판별", "소개 검수"]]]);
    expect(rowOf(view, "reason-translate").anchor).toBe("row-reason-translate");
  });

  it("죽은 칸(중계·Grok·직접 연결·분류·CLI 덮어쓴 값·옛 경로 값·사다리 선언 층·배정 표 읽기·옮긴 칸)은 그리지 않는다", () => {
    const view = build({ row: row(AFTER, 9) });
    const shown = paths(view);
    for (const dead of ["routes.limits.relay.", "routes.timeouts.grok-", "routes.limits.direct-review.", "routes.limits.classify-claude.", "routes.timeouts.classify-cli",
      "routes.limits.review-cli.maxTokens", "routes.limits.review-cli.concurrency", "routes.limits.product-tagline-ko.maxTokens", "jobs.product-tagline-ko.batchChars",
      "jobs.product-search-profile.slowCallMs", "routes.limits.gateway-review.timeoutMs", "routes.limits.gateway-review.concurrency", "routes.deadlines.review-gateway.engineMs",
      "routes.deadlines.review-gateway.gatewayMs", "routes.deadlines.review-gateway.relayMs", "assignments.", "capacity.", "jobs.published-recheck.",
      "jobs.second-review.consumerConcurrency", "jobs.crawl-publish.classifierConcurrency", "translation.product.maxSourceChars", "translation.product.batchChars",
      "translation.product.demandLimit", "translation.product.maxAttempts", "translation.product.batchMax", ...HIDDEN_BUDGET_JOBS.map(job => `budgets.${job}`)])
      expect(shown.filter(path => path.startsWith(dead)), dead).toEqual([]);
    // 동시 호출은 실제로 읽히는 다섯만
    expect(shown.filter(path => path.endsWith(".concurrency")).sort()).toEqual(["routes.limits.crawl-tagline.concurrency", "routes.limits.product-search-profile.concurrency",
      "routes.limits.product-search-verify.concurrency", "routes.limits.product-tagline-ko.concurrency", "routes.limits.product-translate.concurrency"]);
    // 한 경로는 한 칸만(같은 이름의 입력이 둘이면 저장이 엇갈린다)
    expect(new Set(shown).size).toBe(shown.length);
    // AI 밖 잡의 틱 시간은 고급으로 — 작업 줄의 잡과 겹치지 않는다
    const advanced = view.advanced.flatMap(group => group.rows.map(entry => entry.job));
    expect(advanced).toEqual(expect.arrayContaining(["crawl-seed", "crawl-fetch", "product-embedding", "product-llm-assist-review"]));
    expect(advanced).not.toEqual(expect.arrayContaining(["reason-translate"]));
    expect(view.advanced.map(group => group.role)[0]).toBe("crawler");
  });

  it("호출 상한 칸은 그 경로가 실제로 읽는 자리 — 1차 CLI 는 review-cli, 2차는 심사 사다리, 사람 큐는 숨은 모델 상한 60초를 칸에 보인다", () => {
    const view = build();
    expect(rowOf(view, "first-review").cap).toMatchObject({ kind: "field", field: { path: "routes.limits.review-cli.timeoutMs", initial: "60", defaultInput: "20", overridden: true } });
    expect(rowOf(view, "second-review").cap).toMatchObject({ kind: "field", field: { path: "routes.deadlines.review-gateway.clientMs", initial: "60", min: 15 } });
    expect(rowOf(view, "human-review")).toMatchObject({ capMs: 60_000, cap: { kind: "field", field: { path: "routes.limits.human-review.timeoutMs", initial: "60", defaultInput: "", overridden: false,
      ceilingMs: 60_000 }, note: expect.stringContaining("등록부 모델 상한 60초") } });
    expect(rowOf(view, "crawl-tagline").cap).toMatchObject({ kind: "field", field: { path: "routes.timeouts.crawl-tagline", initial: "45" } });
    expect(rowOf(view, "product-intro-check").cap).toMatchObject({ kind: "field", field: { path: "jobs.product-intro-check.callMs", initial: "90" } });
    expect(rowOf(view, "publish-classify").cap).toMatchObject({ kind: "text", text: "60초", note: expect.stringContaining("코드에 고정") });
    // 제품 감사의 상한은 1차 CLI·심사 상한 중 긴 쪽 — 화면이 두 칸에서 바로 다시 센다
    expect(rowOf(view, "product-audit").cap).toMatchObject({ kind: "text", text: "60초", sources: [{ path: "routes.deadlines.review-gateway.clientMs", fixedMs: 60_000 },
      { path: "routes.limits.review-cli.timeoutMs", fixedMs: 60_000 }] });
    expect(rowOf(view, "screen-review")).toMatchObject({ capMs: 90_000, tick: { kind: "field", field: { autoExtraMs: 40_000 } } });
  });

  it("틱 시간 — 자동은 지금 풀이(초)를, 적지 않은 잡은 runner 기본 25초를 글자로 그린다(빈칸 없음); 틱 없는 작업은 까닭을 쓴다", () => {
    const before = build();
    expect(rowOf(before, "crawl-tagline").tick).toMatchObject({ kind: "field", field: { path: "budgets.crawl-tagline", initial: "25", declared: false, auto: false, autoAllowed: true,
      note: expect.stringContaining("기본 25초") } });
    expect(rowOf(before, "product-translate").tick).toMatchObject({ kind: "field", field: { auto: true, initial: "315", autoFrom: [{ path: "routes.limits.product-translate.timeoutMs",
      fixedMs: 300_000, ceilingMs: 300_000 }] } });
    const after = build({ row: row(AFTER, 9) });
    expect(rowOf(after, "crawl-tagline").tick).toMatchObject({ kind: "field", field: { auto: true, initial: "60", declared: true, overridden: true } });
    expect(rowOf(after, "product-translate").tick).toMatchObject({ kind: "field", field: { initial: "135" } });
    expect(rowOf(after, "second-review").tick).toEqual({ kind: "text", text: "소비자가 처리 — 틱 없음" });
    expect(rowOf(after, "search-query-translate").tick).toEqual({ kind: "text", text: "틱 없음 — 웹 요청" });
    for (const entry of after.groups.flatMap(group => group.rows)) if (entry.tick.kind === "field") expect(entry.tick.field.initial, entry.id).not.toBe("");
    expect(after.margin).toMatchObject({ path: "translation.product.jobMarginMs", initial: "15", unit: "초" });
  });

  it("묶음 칸·응답 토큰은 펼침에; 동시 칸이 없는 작업은 누가 정하는지 쓴다; 지금 모델은 순위(여러 칸이면 칸 수), 없으면 장부", () => {
    const view = build({ row: row(AFTER, 9) });
    expect(rowOf(view, "reason-translate").details.map(field => [field.path, field.label, field.unit, field.initial])).toEqual([
      ["jobs.reason-translate.minCallMs", "새 호출을 시작할 최소 남은 시간", "초", "45"], ["jobs.reason-translate.batch", "한 번에 묶는 수", "건", "4"],
      ["jobs.reason-translate.batchChars", "한 묶음 글자 수", "자", "1600"], ["jobs.reason-translate.soloAttempts", "이만큼 실패하면 혼자 보냄", "회", "3"],
      ["routes.limits.reason-translate.maxTokens", "응답 토큰 상한", "토큰", "6000"]]);
    expect(rowOf(view, "reason-translate").minCallPath).toBe("jobs.reason-translate.minCallMs");
    expect(rowOf(view, "second-review").details.map(field => field.path)).toEqual(["routes.limits.gateway-review.maxTokens"]);
    expect(rowOf(view, "second-review").concurrency).toEqual({ kind: "text", text: "작업 배정에서 정함 (지금 소비자 동시 2)", href: "/admin/models/tasks#concurrency" });
    expect(rowOf(view, "human-review").concurrency).toEqual({ kind: "text", text: "장비 한도가 정함", href: "/admin/models/devices" });
    expect(rowOf(view, "reason-translate").models).toBe("1순위 m1-gemma");
    expect(rowOf(view, "product-tagline-ko").models).toBe("1순위 gpt-oss-120b · 2순위 k-exaone_v2.5");
    expect(rowOf(view, "second-review").models).toBe("3칸 · supa · gpt-oss-120b");
    expect(rowOf(view, "product-translate").models).toBe("m1-gemma · gpt-oss-120b");
    expect(rowOf(view, "first-review").models).toBeNull();
  });
});

describe("장부 실측 — SQL 행 조립·지도", () => {
  it("지도: 작업 줄의 장부 route 마다 분류 상한, 1차 심사는 공급자마다(CLI 는 review-cli, Qwen 직접은 심사 사다리)", () => {
    const { settings } = resolveRuntimeSettings(AFTER);
    const map = limitsMeasureMap(settings);
    expect(map["reason-translate"]).toEqual({ task: "reason-translate", capMs: 45_000 });
    expect(map["product-translate"]).toEqual({ task: "product-translate", capMs: 120_000 });
    expect(map["crawl-agent-review"]).toEqual({ task: "first-review", capMs: 60_000, providers: { abcllm: 60_000, "local-direct": 60_000 } });
    expect(map["local-published-filter"]).toEqual({ task: "audit-second-opinion", capMs: 45_000 });
    expect(map["local-screen"]).toEqual({ task: "screen-review", capMs: 90_000 });
    expect(map["crawl-publish-classify"]).toEqual({ task: "publish-classify", capMs: 60_000 });
    expect(Object.keys(map)).toHaveLength(20);
    expect(limitsMeasureMap(DEFAULT_RUNTIME_SETTINGS)["crawl-agent-review"].capMs).toBe(20_000);
  });
  it("SQL 행(문자열 수·jsonb)을 숫자로 — 모르는 모양의 장비 상한·정책 route 는 버린다", () => {
    const result = limitsMeasurementFromRows({ measuredAt: NOW.toISOString(),
      tasks: [{ task: "reason-translate", calls: "2304", p50: "8369.5", p99: 19050, maxMs: "41800", cutAtCap: "0" }],
      mix: [{ task: "reason-translate", provider: "abcllm", model: "m1-gemma", groupId: "m1-qwen", calls: "2304" }],
      unknowns: [{ task: "reason-translate", unknown: "25", tickCut: "22", tickMin: "20130", tickMax: null, atCap: "3", cancelled: "24" },
        { task: "product-audit", unknown: 0, tickCut: 0, tickMin: null, tickMax: null, atCap: 0, cancelled: "1219" }],
      devices: [{ deviceId: "m3-mlx", limitSlots: "3", enabled: true, modelLimits: [{ model: "gpt-oss-120b", max_slots: 2, engine_max: 4 }, { bogus: 1 }] }],
      policyRoutes: [{ routeId: "crawl-tagline", provider: "abcllm", model: "supa", groupId: "supa-direct" }, "junk"], ranks: [{ task: "x", slot: "1", rank: "2", model: "m", enabled: true }] });
    expect(result.tasks["reason-translate"]).toEqual({ calls: 2_304, p50Ms: 8_369.5, p99Ms: 19_050, maxMs: 41_800, cutAtCap: 0, unknown: 25, tickCut: 22, tickCutMinMs: 20_130,
      tickCutMaxMs: null, unknownAtCap: 3, cancelled: 24 });
    expect(result.tasks["product-audit"]).toMatchObject({ calls: 0, cancelled: 1_219, p50Ms: null });
    expect(result.devices).toEqual([{ deviceId: "m3-mlx", limitSlots: 3, enabled: true, modelLimits: [{ model: "gpt-oss-120b", maxSlots: 2 }] }]);
    expect(result.policyRoutes).toHaveLength(1);
    expect(result.ranks).toEqual([{ task: "x", slot: 1, rank: 2, model: "m", enabled: true }]);
    expect(limitsMeasurementFromRows({ measuredAt: "x", tasks: [], mix: [], unknowns: [], devices: [], policyRoutes: null, ranks: [] }).policyRoutes).toEqual([]);
  });
});

describe("「지금 볼 것」 — 24시간 실측으로 고른 것과 권장값", () => {
  it("(a) 틱 끝에서 잘린 미확정 — 시작 조건 ≥ 상한, 틱 ≥ 시작 조건 + 상한 + 10초를 권한다(사유 번역 30→45초, 55→100초)", () => {
    const view = build();
    const todo = view.todos.find(item => item.id === "reason-translate:tick-cut")!;
    expect(todo).toMatchObject({ level: "bad", tag: "고칠 것", rowId: "reason-translate", fills: [{ path: "jobs.reason-translate.minCallMs", value: "45" },
      { path: "budgets.reason-translate", value: "100", auto: false }] });
    expect(todo.evidence).toContain("24시간 미확정 25건 중 22건이 상한 45초보다 짧은 20초~37초에 끊겼습니다");
    expect(todo.evidence).toContain("장비 칸 하나를 600초 동안");
    expect(todo.evidence).toContain("틱 시간 55초→100초");
    expect(rowOf(view, "reason-translate").status).toEqual({ level: "bad", text: "틱 끝에서 잘림", note: null });
    // 권장값을 저장한 뒤의 판 — 같은 24시간 숫자는 바꾸기 전의 호출일 수 있다(확인할 것, 넣을 값 없음)
    const after = build({ row: row(AFTER, 9) });
    expect(after.todos.find(item => item.id === "reason-translate:tick-cut")).toMatchObject({ level: "info", tag: "확인할 것", fills: [] });
    expect(rowOf(after, "reason-translate").status).toMatchObject({ level: "info", text: "바꾼 뒤 지켜봄" });
    // 문턱(3건) 아래는 올리지 않는다
    expect(build({ measurement: { ...MEASUREMENT, tasks: { ...MEASUREMENT.tasks, "reason-translate": measure({ unknown: 2, tickCut: 2 }) } } }).todos
      .some(item => item.id === "reason-translate:tick-cut")).toBe(false);
  });

  it("(b) 동시 호출이 장비 칸보다 크다 — 키워드 검수 4 > supa 3칸 → 3", () => {
    const view = build();
    expect(view.todos.find(item => item.id === "product-search-verify:concurrency")).toMatchObject({ level: "warn", tag: "고칠 것",
      title: "동시 호출 4이(가) 장비 칸 수(supa-direct 3칸)보다 큽니다", fills: [{ path: "routes.limits.product-search-verify.concurrency", value: "3" }] });
    expect(rowOf(view, "product-search-verify").slots).toEqual({ deviceId: "supa-direct", slots: 3 });
    // 모델 상한이 있으면 그 칸 수(공개 번역: m3-mlx 의 gpt-oss 2칸, m1 2칸)
    expect(rowOf(view, "product-translate").slots).toEqual({ deviceId: "m3-mlx", slots: 2 });
    // 24시간 호출이 없으면 정책 route 의 장비
    expect(rowOf(view, "crawl-tagline").slots).toEqual({ deviceId: "supa-direct", slots: 3 });
    expect(build({ row: row(AFTER, 9) }).todos.some(item => item.id === "product-search-verify:concurrency")).toBe(false);
  });

  it("(c) 상한이 실측보다 훨씬 길다(낮은 우선) — 공개 번역 300초 vs 최대 34초 → 120초, 자동 틱은 135초로", () => {
    const view = build();
    const todo = view.todos.find(item => item.id === "product-translate:loose-cap")!;
    expect(todo).toMatchObject({ level: "info", tag: "참고", fills: [{ path: "routes.limits.product-translate.timeoutMs", value: "120" }] });
    expect(todo.evidence).toContain("가장 긴 호출이 34초");
    expect(todo.evidence).toContain("함께 135초로 줄어듭니다");
    expect(view.todos.at(-1)!.tag).toBe("참고");
    // 이미 120초면 올리지 않는다; 호출이 적으면 판단하지 않는다
    expect(build({ row: row(AFTER, 9) }).todos.some(item => item.id === "product-translate:loose-cap")).toBe(false);
    expect(build({ measurement: { ...MEASUREMENT, tasks: { ...MEASUREMENT.tasks, "product-translate": measure({ calls: 150, maxMs: 30_000 }) } } }).todos
      .some(item => item.id === "product-translate:loose-cap")).toBe(false);
  });

  it("(d) 호출이 상한에서 1% 넘게 끊긴다 — 1차 심사 90/3,610건(2.5%), 넣을 값은 없다", () => {
    const todo = build().todos.find(item => item.id === "first-review:cap-hit")!;
    expect(todo).toMatchObject({ level: "info", tag: "확인할 것", title: "호출의 2.5%가 상한 60초에서 끊깁니다", fills: [] });
    expect(rowOf(build(), "first-review").status.text).toBe("상한에 닿음");
  });

  it("(e) 멈추지 않은 잡의 호출이 0건이고 예약은 모두 취소 — 제품 감사; 예약도 없으면 조용히 「호출 없음」, 멈춘 잡·멈춤을 모르면 올리지 않는다", () => {
    const view = build();
    expect(view.todos.find(item => item.id === "product-audit:zero")).toMatchObject({ level: "info", evidence: expect.stringContaining("예약 1,219건이 모두 보내기 전에 취소") });
    expect(rowOf(view, "product-audit").status.text).toBe("호출 없음 · 조사 필요");
    expect(view.todos.some(item => item.id === "audit-qwen:zero")).toBe(false);
    expect(rowOf(view, "audit-qwen").status).toMatchObject({ level: "off", text: "호출 없음" });
    expect(rowOf(view, "product-intro-check")).toMatchObject({ paused: true, status: { level: "off", text: "쉬는 중" } });
    const paused = build({ pauses: PAUSES.map(entry => ({ ...entry, paused: entry.name === "product-audit" || entry.paused })) });
    expect(paused.todos.some(item => item.id === "product-audit:zero")).toBe(false);
    expect(build({ pauses: null }).todos.some(item => item.id === "product-audit:zero")).toBe(false);
    // 실측 규칙은 멈춘 잡에도 본다(배포 창처럼 잠깐 멈춰도 24시간 근거를 숨기지 않는다)
    const windowPaused = build({ pauses: PAUSES.map(entry => ({ ...entry, paused: true })) });
    expect(windowPaused.todos.some(item => item.id === "reason-translate:tick-cut")).toBe(true);
  });

  it("순서는 고칠 것(빨강·노랑) → 확인할 것 → 참고; 적은 호출은 「자료 부족」; 실측을 못 읽으면 규칙도 상태도 없다", () => {
    const view = build();
    expect(view.todos.map(item => item.level)).toEqual(["bad", "warn", "info", "info", "info"]);
    expect(rowOf(view, "search-query-translate").status).toMatchObject({ level: "off", text: "자료 부족" });
    const failed = build({ measurement: null, measureError: "statement_timeout" });
    expect(failed).toMatchObject({ measuredAt: null, measureError: "statement_timeout", todos: [] });
    expect(rowOf(failed, "reason-translate")).toMatchObject({ measure: null, status: { level: "off", text: "측정 없음" }, models: null });
    // 칸은 그대로 저장할 수 있다
    expect(failed.readOnly).toBe(false);
  });

  it("행을 못 읽으면 기본값·읽기 전용; 저장 문서 문제는 한국어", () => {
    const missing = build({ row: null, rowError: "runtime_settings_row_missing" });
    expect(missing).toMatchObject({ revision: null, readOnly: true, rowError: "runtime_settings_row_missing", shortVersion: "default" });
    const broken = build({ row: row({ version: 1, budgets: { "product-translate": 100_000 } }) });
    expect(broken.issues).toContain("공개 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초");
  });
});

describe("편집기 — 그리기와 폼 왕복", () => {
  it("칸 이름 규약(value:·initial:·stored:·initialAuto:·auto:)·사다리 지금 값·지금 볼 것의 권장값 단추", () => {
    const view = build();
    const html = renderToStaticMarkup(createElement(LimitsEditor, { view }));
    expect(html).toContain('name="expectedRevision" value="6"');
    expect(html).toContain('name="value:routes.limits.reason-translate.timeoutMs"');
    expect(html).toContain('aria-label="사유 번역 호출 상한(초)"');
    expect(html).toContain('name="initialAuto:budgets.product-translate" value="1"');
    expect(html).toContain('name="auto:budgets.product-translate" value="on"');
    expect(html).toContain('name="value:budgets.crawl-tagline" value="25"');
    expect(html).toContain('name="current:routes.deadlines.review-gateway.gatewayMs" value="55"');
    expect(html).toContain("권장값 넣기");
    expect(html).toContain("기본 20초에서 바꿈");
    expect(html).toContain('id="row-first-review"');
    expect(html).toContain('id="routes"');
    expect(html).toContain('id="budgets"');
    expect(html).toContain("틱 끝에서 끊김 22");
    expect(html).toContain('role="img"');
    // 같은 이름의 value: 칸이 둘 생기지 않는다
    const names = [...html.matchAll(/name="(value:[^"]+)"/g)].map(match => match[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("그려진 그대로 보내면 바뀐 것이 없고(빈칸·자동·사다리 칸 때문에 거절되지 않는다), 한 칸만 바꾸면 그 칸만 간다", () => {
    for (const values of [BEFORE, AFTER]) {
      const html = renderToStaticMarkup(createElement(LimitsEditor, { view: build({ row: row(values, 9) }) }));
      const data = submitted(html);
      expect(runtimeSettingsPatchFromForm(LIMITS_PAGE_GROUPS, data)).toEqual({ patch: {}, changed: [], issues: [] });
      data.set("value:budgets.product-search-profile", "60");
      expect(runtimeSettingsPatchFromForm(LIMITS_PAGE_GROUPS, data)).toEqual({ patch: { budgets: { "product-search-profile": 60_000 } }, changed: ["budgets.product-search-profile"], issues: [] });
      // 2차 심사 상한을 낮추면 선언 층이 함께 따라간다 — 저장 검사를 통과하는 patch
      data.set("value:routes.deadlines.review-gateway.clientMs", "45");
      const lowered = runtimeSettingsPatchFromForm(LIMITS_PAGE_GROUPS, data);
      expect(lowered.issues).toEqual([]);
      const doc = structuredClone(values) as unknown as Record<string, Record<string, unknown>>;
      const routes = (doc.routes ??= {}), budgets = (doc.budgets ??= {});
      routes.deadlines = (lowered.patch.routes as Record<string, unknown>).deadlines;
      Object.assign(budgets, lowered.patch.budgets);
      expect(resolveRuntimeSettings(doc).issues).toEqual([]);
    }
  });

  it("읽기 전용이면 칸이 잠기고 저장할 수 없다; 실측을 못 읽으면 그렇게 쓴다", () => {
    const html = renderToStaticMarkup(createElement(LimitsEditor, { view: build({ readOnly: true }) }));
    expect(html.split("<input").filter(part => part.includes('name="value:routes.limits.reason-translate.timeoutMs"'))[0]).toContain('disabled=""');
    expect(html).toContain("읽기 전용입니다");
    expect(html).not.toContain("권장값 넣기");
    const failed = renderToStaticMarkup(createElement(LimitsEditor, { view: build({ measurement: null, measureError: "x" }) }));
    expect(failed).toContain("측정을 읽지 못했습니다");
  });
});

describe("화면 — 머리·옮긴 칸·옛 닻", () => {
  it("읽은 판 줄(#apply)과 옛 닻(#routes·#budgets·#capacity·#translation·#assignments·#audit)·진단(#diag)이 남는다", async () => {
    holder.view = build({ apply: { savedVersion: "abcdef1234567890", allApplied: true, attention: null, roles: [
      { role: "text", label: "소개·사유 번역", reportedVersion: "abcdef1234567890", observedAt: NOW.getTime() - 30_000, state: "applied", lagging: false }] } });
    const html = renderToStaticMarkup(await LimitsPage());
    for (const id of ["apply", "routes", "budgets", "capacity", "translation", "assignments", "audit", "diag", "todo", "tasks"]) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain("모든 역할이 지금 판으로 도는 중");
    expect(html).toContain('href="/admin/models/devices#unknown-hold"');
    expect(html).toContain('href="/admin/translations#limits"');
    expect(html).toContain('href="/admin/audit?tab=recheck"');
    expect(html).toContain('href="/admin/models/tasks#concurrency"');
    expect(html).toContain("2차 심사 소비자 · 웹");
    expect(html).toContain("보고 안 함");
    // 경로 id 를 큰 이름으로 쓰지 않는다
    expect(html).not.toMatch(/<b>(gateway-review|review-gateway|review-cli)<\/b>/);
  });
});
