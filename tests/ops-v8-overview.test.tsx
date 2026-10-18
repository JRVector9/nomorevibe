import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_LINKS, STATUS_TABS } from "@/app/(operator)/admin/status/action-links";
import type { SplitItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { ModelCards } from "@/app/(operator)/admin/status/dashboard/ModelCards";
import { EnrichmentCell, SourceCell, TransitionCell } from "@/app/(operator)/admin/status/dashboard/FlowCells";
import { enrichmentNodes, flowVerdict, otherModelSlots, sourceSummary, transitionSummary, xSummary } from "@/app/(operator)/admin/status/flow-model";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { ModelHealth } from "@/lib/operations/dashboard";
import { buildPipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import type { ThroughputStage } from "@/lib/operations/throughput-model";
import type { StageProgress } from "@/lib/operations/worker-progress";
import type { WorkerProgressReport } from "@/lib/operations/worker-progress-query";
import { readXStatus } from "@/lib/operations/x-status";
import { humanOverview } from "./fixtures/human-queue";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/status/actions", () => ({ requestOperation: vi.fn(), setCollectionEnabled: vi.fn(), codexOperation: vi.fn() }));

import { OperationsCenter } from "@/app/(operator)/admin/status/OperationsCenter";

/**
 * 운영센터 개편 v8 PR5 — 전체 현황에 더한 것만 본다(지금 블록의 글자·자리는 기존 테스트가 고정한다).
 * 판정 알약·레일 옆 칸 숨김·폰 묶음(N6)·탭 순서·모델 카드 한 줄.
 */
const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/(operator)/admin/status/dashboard/flow.css"), "utf8");
/** 선택자 하나의 선언 묶음 — 같은 선택자가 여러 번 나오면 모두 */
function rules(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
}
/** @media (max-width:N px) 묶음의 본문 */
function media(source: string, query: RegExp): string {
  const start = source.search(query);
  expect(start, `${query} 이 없다`).toBeGreaterThanOrEqual(0);
  let depth = 0, index = source.indexOf("{", start);
  const open = index;
  for (; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) break;
  }
  return source.slice(open + 1, index);
}

const NOW = "2026-10-18T08:44:06.000Z";
const item = (key: string, tone: SplitItem["tone"], fresh = false): SplitItem =>
  ({ key, tone, count: 1, unit: "건", title: key, detail: key, trend: null, fresh });
const stage = (key: ThroughputStage["key"], over: Partial<ThroughputStage> = {}): ThroughputStage => ({
  key, label: key, unit: "건", completed1m: 1, completed5m: 5, waiting: 0, oldestMinutes: null, enabled: true, errors5m: 0,
  queueNote: "", detail: "", status: "processing", ...over,
});
const throughput = (over: Partial<Record<ThroughputStage["key"], Partial<ThroughputStage>>> = {}) => ({
  measuredAt: NOW, stages: (["fetch", "judge", "first", "second", "publish"] as const).map((key) => stage(key, over[key])),
});
const progress = (stages: Partial<StageProgress>[] = []): WorkerProgressReport => ({
  measuredAt: NOW, overall: "ok", stages: stages as StageProgress[], lanes: [], activeJobs: [],
  scheduler: { role: "scheduler", reason: "scheduled", alarm: false, overdueJobs: [] },
  liveness: (["crawler", "reviewer", "publisher"] as const).map((role) => ({ role, reason: "present" as const, alarm: false })),
});

describe("판정 알약 — 조치와 같은 동기 입력만으로", () => {
  it("급한 일·새 일·흐름 상태를 한 줄로 답한다(목업 08:44)", () => {
    const urgent = [item("down", "critical"), item("repo-gone", "critical"), item("held", "hold", true),
      item("model-failures", "hold", true), item("health-overdue", "clear", true)];
    const verdict = flowVerdict({ split: { urgent }, throughput: throughput(), workerProgress: progress(),
      human: humanOverview({ human: 206, agreed: 4, oldestDays: 14, in24h: 5, decided: 0 }) });
    expect(verdict.text).toBe("지금 · 급한 일 2 · 새 일 3 · 흐름: 사람 심사 쌓임");
    // 레일이 주황으로 칠하는 "직접 확인"(자동 처리가 끝난 사람 몫)보다 쌓임을 먼저 말한다
    const manual = flowVerdict({ split: { urgent }, throughput: throughput({ fetch: { manualAttention: 1 } }), workerProgress: progress(),
      human: humanOverview({ human: 206, decided: 0 }) });
    expect(manual.text).toBe("지금 · 급한 일 2 · 새 일 3 · 흐름: 사람 심사 쌓임 외 1");
    expect(manual.dots[0]).toMatchObject({ key: "fetch", tone: "warn", text: "직접 확인 1건" });
    expect(verdict.short).toBe("급한 일 2");
    expect(verdict.tone).toBe("bad");
    expect(verdict.title).toContain("조치 입력");
    expect(verdict.dots.map((dot) => dot.short)).toEqual(["수집", "규칙", "1차", "2차", "사람", "발행"]);
    expect(verdict.dots.find((dot) => dot.key === "human")?.tone).toBe("warn");
  });

  it("정체·워커 경보는 레일과 같은 규칙으로 빨강, 조치가 없으면 그렇다고 말한다", () => {
    const verdict = flowVerdict({ split: { urgent: [] },
      throughput: throughput({ second: { waiting: 30, oldestMinutes: 40, completed5m: 0, status: "stalled" } }),
      workerProgress: progress([{ role: "reviewer", stage: "second", reason: "no_progress", alarm: true }]),
      human: humanOverview({ human: 3, decided: 2 }) });
    expect(verdict.text).toBe("지금 · 조치 없음 · 흐름: AI 2차 진행 없음");
    expect(verdict.tone).toBe("bad");
    const calm = flowVerdict({ split: { urgent: [] }, throughput: throughput(), workerProgress: progress(), human: humanOverview({ human: 3, decided: 2 }) });
    expect(calm.text).toBe("지금 · 조치 없음 · 흐름: 막힌 곳 없음");
    expect(calm.tone).toBe("ok");
  });

  it("처리량을 못 읽으면 흐름을 미확인으로 둔다", () => {
    const verdict = flowVerdict({ split: { urgent: [item("web", "hold")] }, throughput: null, workerProgress: null, human: humanOverview() });
    expect(verdict.text).toBe("지금 · 조치 1 · 흐름: 미확인");
    expect(verdict.tone).toBe("warn");
  });

  it("알약 계산 모듈은 DB 를 읽지 않는다", () => {
    const source = readFileSync(path.join(root, "app/(operator)/admin/status/flow-model.ts"), "utf8");
    expect(source).not.toMatch(/@\/lib\/db|readReplica|onReplica|await /);
  });
});

const centerProps = {
  jobs: [], reviewMode: "enforce", enabled: true, attention: createElement("p", null, "ATTENTION"), dashboard: createElement("p", null, "DASHBOARD"),
  statusChips: null, diagnostics: null, manual: null, crawlers: null,
  data: { fetchedAt: NOW, observations: [], serviceInstances: [], dbLatencyMs: 3, audit: [], held: 5, heldNextRetryAt: null },
} as unknown as Parameters<typeof OperationsCenter>[0];
const verdict = flowVerdict({ split: { urgent: [item("down", "critical")] }, throughput: throughput(), workerProgress: progress(), human: humanOverview() });

describe("탭 줄과 폰 묶음", () => {
  beforeEach(() => { nav.params = new URLSearchParams(); });

  it("흐름 상세는 진단 뒤 맨 끝이고 기존 탭의 순서는 그대로다", () => {
    expect(STATUS_TABS).toEqual(["overview", "jobs", "crawlers", "ai", "manual", "diagnostics", "flow"]);
    const html = renderToStaticMarkup(createElement(OperationsCenter, { ...centerProps, verdict }));
    const tabs = html.match(/<nav class="ops-tabs"[^>]*>(.*?)<\/nav>/)?.[1] ?? "";
    const labels = [...tabs.matchAll(/<button[^>]*>([^<]+)/g)].map((match) => match[1]);
    expect(labels).toEqual(["전체 현황", "작업 흐름", "크롤러 활동", "AI 연결", "수동 분류", "진단", "흐름 상세"]);
    // 알약은 탭 줄의 맨 끝(마지막 탭 뒤)에 있다
    expect(tabs.lastIndexOf("ops-v8-verdict")).toBeGreaterThan(tabs.lastIndexOf("흐름 상세"));
    expect(tabs).toContain(verdict.text);
  });

  it("흐름 상세 탭을 열면 탭 내용을 그리고 전체 현황은 그리지 않는다", () => {
    nav.params = new URLSearchParams("tab=flow");
    const html = renderToStaticMarkup(createElement(OperationsCenter, { ...centerProps, verdict, flow: createElement("p", null, "FLOW-DETAIL") }));
    expect(html).toContain("FLOW-DETAIL");
    expect(html).not.toContain("DASHBOARD");
  });

  it("AI 연결·설정 버튼은 그대로이고 흐름 미니와 한 묶음이다", () => {
    const html = renderToStaticMarkup(createElement(OperationsCenter, { ...centerProps, verdict, enrichmentDot: createElement("i", { className: "ENRICH" }) }));
    const bundle = html.match(/<span class="ops-ai-bundle">(.*?)<\/span><\/div><\/header>/)?.[1] ?? "";
    expect(bundle).toMatch(/^<button class="primary">AI 연결·설정<\/button><span class="ops-flow-mini">/);
    expect(bundle).toContain(verdict.short);
    for (const short of ["수집", "규칙", "1차", "2차", "사람", "발행"]) expect(bundle).toContain(`<b>${short}</b>`);
    // "보강" 점은 근거 판정을 따로 기다리는 서버 조각이 채운다
    expect(bundle.indexOf("ENRICH")).toBeGreaterThan(bundle.indexOf("<b>발행</b>"));
  });

  it("알약이 없으면(옛 호출) 머리와 탭 줄이 지금과 같다", () => {
    const html = renderToStaticMarkup(createElement(OperationsCenter, centerProps));
    expect(html).toContain('<button class="primary">AI 연결·설정</button></div></header>');
    expect(html).not.toContain("ops-v8-verdict");
    expect(html).not.toContain("ops-flow-mini");
  });

  it("폰 묶음 CSS — 묶음은 최소 폭을 지우지 않고, 미니만 폭 0 에서 남는 폭을 쓴다(N6)", () => {
    const phone = media(css, /@media\s*\(max-width:\s*760px\)/);
    const bundle = rules(phone, ".ops-ai-bundle").join(";");
    expect(bundle).toMatch(/display:\s*flex/);
    expect(bundle).toMatch(/flex:\s*1 1 auto|flex-grow:\s*1/);
    expect(bundle).not.toMatch(/min-width|overflow/);
    const mini = rules(css, ".ops-flow-mini").join(";");
    for (const declaration of [/width:\s*0/, /min-width:\s*0/, /flex-grow:\s*1/, /overflow:\s*hidden/]) expect(mini).toMatch(declaration);
    expect(mini).not.toMatch(/padding|border|margin|gap/);
    // 넓은 화면에서는 묶음이 사라져 버튼이 지금처럼 머리 줄의 항목이고, 미니는 그리지 않는다
    expect(rules(css, ".ops-ai-bundle").join(";")).toMatch(/display:\s*contents/);
    expect(css).toMatch(/\.ops-flow-mini\s*\{[^}]*display:\s*none/);
    expect(rules(phone, ".ops-flow-mini").join(";")).toMatch(/display:\s*block/);
    // 폰에서는 탭 줄 알약을 감춘다(미니 안의 알약을 쓴다)
    expect(rules(phone, ".ops-tabs .ops-v8-verdict").join(";")).toMatch(/display:\s*none/);
    // 이름 → 점 → 사라짐
    expect(css).toMatch(/@container ops-flow-mini \(max-width:\s*\d+px\)\s*\{[^}]*\.d b\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@container ops-flow-mini \(max-width:\s*\d+px\)\s*\{[^}]*\.d\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@container ops-flow-mini \(max-width:\s*\d+px\)\s*\{[^}]*\.ops-flow-mini-in\s*\{[^}]*display:\s*none/);
  });

  it("탭 줄 알약은 줄바꿈 없이 말줄임으로만 줄어든다", () => {
    const pill = rules(css, ".ops-tabs .ops-v8-verdict").join(";");
    for (const declaration of [/margin-left:\s*auto/, /min-width:\s*0/, /white-space:\s*nowrap/, /text-overflow:\s*ellipsis/, /overflow:\s*hidden/])
      expect(pill).toMatch(declaration);
    expect(css).not.toMatch(/\.ops-tabs\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("새 탭·알약의 꼬리는 탭 줄 길이에 0 을 보탠다 — 기존 여섯 탭은 어느 폭에서도 줄지 않는다", () => {
    const desktop = media(css, /@media\s*\(min-width:\s*761px\)/);
    const tail = rules(desktop, ".ops-tabs-tail").join(";");
    expect(tail).toMatch(/flex:\s*1 1 0px/);
    expect(tail).toMatch(/min-width:\s*0/);
    // 앞의 탭 줄 간격만큼 되돌린다 — 탭 줄 간격이 바뀌면 이 값도 같이 바꿔야 한다
    const gap = readFileSync(path.join(root, "app/(operator)/admin/status/operations.css"), "utf8").match(/\.ops-tabs\{display:flex;gap:(\d+)px/)?.[1];
    expect(tail).toContain(`margin-left:-${gap}px`);
    expect(tail).not.toMatch(/padding/);
    expect(rules(desktop, ".ops-tabs-tail>.ops-tab-new").join(";")).toMatch(/min-width:\s*0/);
    // 폰의 탭 줄은 옆으로 민다 — 꼬리를 풀어 새 탭이 다른 탭과 같다
    expect(rules(media(css, /@media\s*\(max-width:\s*760px\)/), ".ops-tabs-tail").join(";")).toMatch(/display:\s*contents/);
    const html = renderToStaticMarkup(createElement(OperationsCenter, { ...centerProps, verdict }));
    expect(html).toMatch(/<div class="ops-tabs-tail"><button class="ops-tab-new"[^>]*>흐름 상세<\/button><div class="dash-pill ops-v8-verdict"/);
  });
});

describe("레일 옆 칸", () => {
  it("1,180px 이하에서는 숨기고, 넓은 화면에서는 레일 높이 안에서만 채운다", () => {
    const narrow = media(css, /@media\s*\(max-width:\s*1180px\)/);
    expect(rules(narrow, ".ops-v8-side").join(";")).toMatch(/display:\s*none/);
    expect(rules(css, ".ops-v8-side").join(";")).toMatch(/position:\s*relative/);
    const inner = rules(css, ".ops-v8-side > .ops-v8-cells-in").join(";");
    expect(inner).toMatch(/position:\s*absolute/);
    expect(inner).toMatch(/inset:\s*0/);
    expect(inner).toMatch(/overflow:\s*hidden/);
  });

  it("전체 현황에서 레일 바로 뒤 4칸 자리에 놓인다", () => {
    const page = readFileSync(path.join(root, "app/(operator)/admin/status/page.tsx"), "utf8");
    const rail = page.indexOf("<StageSlot");
    const side = page.indexOf('<FlowSideCells variant="rail"');
    const ledger = page.indexOf("<PipelineControlSlot");
    expect(rail).toBeGreaterThan(0);
    expect(side).toBeGreaterThan(rail);
    expect(ledger).toBeGreaterThan(side);
    // 같은 ops-phone-rest 묶음 안 — 폰에서는 지금처럼 "나머지 지표 보기" 아래
    expect(page.slice(rail, side)).not.toContain("</div>");
  });

  it("들어오는 곳 — 쉬운 말과 DB 기준 시각, 못 읽으면 보류", () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, discover: { ...DEFAULT_CRAWL_SETTINGS.discover,
      queries: [{ ...DEFAULT_CRAWL_SETTINGS.discover.queries[0], label: "agent-trailer" }] } };
    const x = xSummary(readXStatus([], NOW, false));
    const ok = renderToStaticMarkup(createElement(SourceCell, { summary: sourceSummary({ ok: true, value: { at: "2026-10-17T23:44:02.000Z",
      signals: [{ signal: "agent-trailer", count: 449 }, { signal: "Show HN", count: 23 }, { signal: "admin-evidence-refresh", count: 2 }] } }, settings), x }));
    expect(ok).toContain("GitHub 449 · Show HN 23 · 기타 2");
    expect(ok).toContain("이번 시");
    expect(ok).toContain("X 연결 전");
    expect(ok).toContain("기준 08:44:02 (DB)");
    const held = renderToStaticMarkup(createElement(SourceCell, { summary: sourceSummary({ ok: false, reason: "lagging" }, settings), x }));
    expect(held).toContain("보류");
    expect(held).toContain("복제본이 10초 넘게 밀렸습니다");
    expect(held).not.toContain("GitHub 0");
  });

  it("설정 전환 · 재해 복구 — 장부 값을 쉬운 말(코드)로", () => {
    const status = buildPipelineControlStatus({ at: NOW,
      batch: { mode: "legacy", epoch: 1, contract: 0, policy: null, policyHash: null },
      model: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldestWaitingAt: null },
      http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0, oracleCharged: 0 },
      source: { enabled: false, epoch: 1, live: 0, unsettled: 0, due: 0, backoff: 0 },
      uptime: { observationsEnabled: false, gateEnabled: false, revision: 1, sources: [], rawOnly: 0, held: 0, applied: 0, latestAt: null },
      uptimeSplit: { at: NOW, control: { mode: "legacy", epoch: 1, policy: null, policyHash: null }, uptimeControl: { observationsEnabled: false, gateEnabled: false },
        queue: { due: 0, dueOldestMinutes: null, claimed: 0, submitted: 0, submittedOldestMinutes: null, confirm: 0, confirmOldestMinutes: null, applied5m: 0, missingRows: 0 },
        breakers: [], outcomes1h: {}, applied1h: {} },
      stages: ["fetch", "ai1", "ai2"].map((name) => ({ stage: name, mode: "legacy", epoch: 1, contract: 0, live: 0, unsettled: 0 })),
      owners: [], dr: { state: "active", epoch: 1, reason: null, updatedAt: NOW, promoted: 0, sealed: [] },
    }, null);
    const html = renderToStaticMarkup(createElement(TransitionCell, { summary: transitionSummary(status) }));
    expect(html).toContain("모두 기본 · 쓰기 가능(active)");
    expect(html).toContain("정산 안 된 호출(unsettled) 0 · 담당 권한(lease) 이상 0");
    const unread = renderToStaticMarkup(createElement(TransitionCell, { summary: transitionSummary(buildPipelineControlStatus(null, null)) }));
    expect(unread).toContain("확인 안 됨");
  });

  it("발행 후 보강 — 주의 단계 이름과 근거 판정 기준 시각, 근거를 못 읽으면 그 부분만 보류", () => {
    const evidence = { ok: true as const, value: { at: "2026-10-17T23:43:52.000Z", stages: [
      { role: "crawler", stage: "agent-evidence", reason: "upstream_stalled", alarm: true, waiting: 2_786, oldestMinutes: 37 * 1440 },
      { role: "crawler", stage: "evidence", reason: "progressing", alarm: false, waiting: 28 },
      { role: "crawler", stage: "ai-level", reason: "no_work", alarm: false, waiting: 0 },
    ] as StageProgress[] } };
    const nodes = enrichmentNodes({ actions: [item("health-overdue", "clear"), item("search-generation-stalled", "hold"),
      // 사람 몫의 쌓인 일(감사 거절·소개 확인·저장소 사라짐·스팸 차단)은 보강 흐름의 색이 아니다 — 쌓인 일 칸에 있다
      item("audit", "hold"), item("intro", "hold"), item("repo-gone", "critical"), item("spam-auto-ban", "hold")],
      jobs: [], evidence, health: null, attention: null, now: NOW });
    const html = renderToStaticMarkup(createElement(EnrichmentCell, { nodes, evidence }));
    expect(html).toContain("주의 2 · 개발 AI 근거 · 키워드 짓기");
    expect(nodes.find((node) => node.key === "uptime")).toMatchObject({ tone: "ok", state: "흐름" });
    for (const key of ["audit", "intro-check", "repo-review", "spam-rescan"]) expect(nodes.find((node) => node.key === key)?.tone).toBe("ok");
    // 근거 단계는 배포 관문과 같은 판정 글자
    expect(nodes.find((node) => node.key === "agent-evidence")).toMatchObject({ tone: "bad", state: "반복 오류", value: "2,786", note: "대기 · 최장 37일" });
    expect(html).toContain("근거 판정 기준 08:43:52 (DB)");
    const held = renderToStaticMarkup(createElement(EnrichmentCell, { evidence: { ok: false, reason: "error" },
      nodes: enrichmentNodes({ actions: [], jobs: [], evidence: { ok: false, reason: "error" }, health: null, attention: null, now: NOW }) }));
    expect(held).toContain("근거 판정 보류");
    expect(held).toContain("읽다가 실패했습니다");
  });
});

describe("모델 연결 카드 한 줄", () => {
  const rows: ModelHealth[] = [{ key: "first", label: "1차 심사", model: "gpt-oss-120b", calls1h: 70, failed1h: 0, avgSeconds: 10, agreement1h: null, lastSuccessAt: null }];

  it("지금 네 줄 뒤에 그 밖의 자리를 한 줄로 더하고 흐름 상세로 보낸다", () => {
    const others = otherModelSlots(DEFAULT_CRAWL_SETTINGS, {});
    expect(others.map((slot) => slot.label)).toEqual(expect.arrayContaining(["발행분 감사", "키워드 검수", "제품 번역", "사유 번역", "한국어 소개", "소개 검수"]));
    expect(others.map((slot) => slot.key)).not.toContain("keywords");
    const html = renderToStaticMarkup(createElement(ModelCards, { rows, probes: [], others }));
    expect(html).toContain(`그 밖의 자리 ${others.length}개`);
    expect(html).toContain(`href="${ACTION_LINKS.flow}"`);
    expect(html).toContain("→ 흐름 상세");
    expect(html.indexOf("ops-v8-model-more")).toBeGreaterThan(html.indexOf("1차 심사"));
  });

  it("그 밖의 자리가 없으면 카드가 지금과 같다", () => {
    expect(renderToStaticMarkup(createElement(ModelCards, { rows, probes: [], others: [] })))
      .toBe(renderToStaticMarkup(createElement(ModelCards, { rows, probes: [] })));
  });

  it("카드가 세로로 쌓이는 폭(700px 이하)에서는 한 줄을 그리지 않는다 — 아래 블록이 밀리지 않게", () => {
    const narrow = media(css, /@media\s*\(max-width:\s*700px\)/);
    expect(rules(narrow, ".ops-v8-model-more").join(";")).toMatch(/display:\s*none/);
    expect(rules(css, ".ops-v8-model-more").join(";")).toMatch(/white-space:\s*nowrap/);
  });
});
