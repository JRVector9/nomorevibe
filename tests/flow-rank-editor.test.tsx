import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// 서랍은 「작업 ↔ AI 모델」 줄 저장을 부른다 — 시험에서는 서버 동작을 막아 둔다(부르지 않는다)
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));

import { RankDrawer } from "@/app/(operator)/admin/flow/RankDrawer";
import { FlowBoard } from "@/app/(operator)/admin/flow/FlowBoard";
import { aiTaskRanksInputFromForm, type AiConnectionView, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { rankOptionKey } from "@/lib/operations/admin-first-review-ranks";
import { buildConveyor, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import { buildStationLlm } from "@/lib/operations/conveyor-llm";
import {
  buildFlowRankEditor, flowOptionBlocked, flowRankLinesFor, needsAcknowledge, rankChanges, rankForm, rankWarnings, type FlowRankEditor,
} from "@/lib/operations/flow-rank-editor";
import type { ThroughputStage } from "@/lib/operations/throughput-model";
import { emptySearchHealth } from "@/lib/operations/search-health-model";

const QWEN = "08e71fe8-0000-4000-8000-000000000001", M3 = "5a1b2c3d-0000-4000-8000-000000000002", CLAUDE = "c1c1c1c1-0000-4000-8000-000000000003",
  M1 = "6e6e6e6e-0000-4000-8000-000000000006", SUPA = "5d5d5d5d-0000-4000-8000-000000000005";
const conn = (id: string, label: string, patch: Partial<AiConnectionView> = {}): AiConnectionView => ({ id, label, kind: "api", baseUrl: null, host: null, hasKey: true,
  cliTool: null, cliModels: [], models: null, modelsReadAt: "2026-11-02T20:58:00.000Z", modelsError: null, deviceId: label, capacitySlots: 2, contextTokens: null,
  enabled: true, version: 1, note: null, updatedBy: "jr", updatedAt: "2026-11-02T10:00:00.000Z", cliVersion: null, ...patch });
const CONNECTIONS: AiConnectionView[] = [
  conn(QWEN, "gpu3090-qwen", { models: [{ id: "qwen3.8-flash-next", maxModelLen: null }] }),
  conn(M3, "m3-mlx (2)", { deviceId: "m3-mlx", models: [{ id: "gpt-oss-120b", maxModelLen: 131072 }] }),
  conn(SUPA, "supa-direct", { hasKey: false, baseUrl: "http://100.78.219.124:8000/v1", models: [{ id: "supa", maxModelLen: null }] }),
  conn(M1, "m1-qwen", { enabled: false, models: [{ id: "qwen3.6-35b", maxModelLen: null }] }),
  conn(CLAUDE, "Claude CLI", { kind: "cli", cliTool: "claude", cliModels: ["sonnet", "haiku"], deviceId: "connect", models: null }),
];
const row = (task: string, connectionId: string, model: string, slot = 1, rank = 1): AiTaskRankRow => ({ task, slot, rank, connectionId, model, options: {}, enabled: true });
const REV = (rows: readonly AiTaskRankRow[]) => (rows.map((r) => r.model).join(",") || "empty").padEnd(64, "0").replace(/[^a-f0-9]/g, "a").slice(0, 64);
const BASE_ROWS = [row("first-review", QWEN, "qwen3.8-flash-next"), row("second-review", M3, "gpt-oss-120b"), row("product-intro-check", CLAUDE, "sonnet"),
  row("publish-classify", CLAUDE, "sonnet"), row("crawl-tagline", QWEN, "qwen3.8-flash-next")];
const editorOf = (rows: AiTaskRankRow[] = BASE_ROWS) => buildFlowRankEditor(CONNECTIONS, rows, REV);
const line = (editor: FlowRankEditor, key: string) => editor.lines.find((entry) => entry.key === key)!;

describe("처리 LLM 바꾸기 — 서랍의 줄 (2026-11-04 5차)", () => {
  it("puts no change control on stations that call no LLM, and one line per task (per voter for 2차)", () => {
    const editor = editorOf();
    for (const station of ["discover", "fetch", "judge", "sink"] as const) expect(flowRankLinesFor(editor, station), station).toEqual([]);
    expect(flowRankLinesFor(editor, "second").map((entry) => entry.label)).toEqual(["2차 AI 검수 · 투표자 1", "2차 AI 검수 · 투표자 2", "2차 AI 검수 · 투표자 3"]);
    expect(flowRankLinesFor(editor, "profile").map((entry) => entry.task)).toEqual(
      ["crawl-tagline", "product-tagline-ko", "korean-translation-direct", "product-translate", "reason-translate", "product-intro-check"]);
    expect(flowRankLinesFor(null, "first")).toEqual([]);
  });

  it("locks 소개 검수 with the reason (Claude CLI only, contract in reviewer env) and marks non-live tasks as 설정값", () => {
    const editor = editorOf();
    expect(line(editor, "product-intro-check#1").lock).toMatch(/Claude CLI 전용.*reviewer 앱 env\(CLI_SERVING_CONTRACTS\)/);
    expect(line(editor, "publish-classify#1")).toMatchObject({ live: false, lock: null });
    expect(line(editor, "first-review#1")).toMatchObject({ live: true, lock: null });
  });

  it("labels each option group with connection · device · recent state and shows a switched-off connection without letting it be picked", () => {
    const editor = editorOf();
    const first = line(editor, "first-review#1");
    const group = (id: string) => first.options.find((option) => option.provider === id)?.group;
    expect(group(QWEN)).toBe("gpu3090-qwen · 응답");
    expect(group(M3)).toBe("m3-mlx (2) · 장비 m3-mlx · 응답");
    expect(group(SUPA)).toBe("supa-direct · 로컬 직접 · 키 없이 응답");
    expect(group(M1)).toBe("m1-qwen · 꺼짐");
    const off = first.options.find((option) => option.provider === M1)!;
    expect(off.off).toBe(true);
    expect(flowOptionBlocked(editor, first, 0, off, first.saved)).toBe(true);
  });

  it("uses the same value key as 작업 ↔ AI 모델 — no control characters (2026-11-02 NUL key cleared the ranks)", () => {
    for (const option of editorOf().lines.flatMap((entry) => entry.options)) expect(rankOptionKey(option)).not.toMatch(/[\u0000-\u001f�]/);
  });

  it("sends exactly the form the existing rank save reads (task · slot · revision · rank<N>Connection/Model)", () => {
    const editor = editorOf();
    const voter = line(editor, "second-review#1");
    const form = rankForm(voter, [{ provider: SUPA, model: "supa" }, { provider: M3, model: "gpt-oss-120b" }, null]);
    expect(aiTaskRanksInputFromForm(form)).toEqual({ issues: [], input: { task: "second-review", slot: 1, revision: voter.revision,
      ranks: [{ provider: SUPA, model: "supa" }, { provider: M3, model: "gpt-oss-120b" }, null] } });
  });

  it("does not reuse a new save path — the drawer imports the tasks screen's server action and the flow page writes nothing itself", () => {
    const drawer = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/flow/RankDrawer.tsx"), "utf8");
    expect(drawer).toContain('import { saveAiTaskRanksAction } from "../models/tasks/actions";');
    expect(drawer).toContain('import { RankSelects } from "../models/RankSelects";');
    const read = readFileSync(path.resolve(__dirname, "../lib/operations/flow-rank-editor-read.ts"), "utf8");
    expect(read).not.toMatch(/readAiTasksAdminView\(|maybeFillConnectionKeys|ensureReviewTaskRanks|insert|update\(/);
    const actions = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/tasks/actions.ts"), "utf8");
    expect(actions).toMatch(/const PATHS = \[[^\]]*"\/admin\/flow"/);
  });
});

describe("처리 LLM 바꾸기 — 전→후와 경고", () => {
  it("shows before → after only for changed lines", () => {
    const editor = editorOf();
    const lines = flowRankLinesFor(editor, "second");
    const changes = rankChanges(editor, lines, { "second-review#1": [{ provider: SUPA, model: "supa" }, null, null], "second-review#2": [null, null, null] });
    expect(changes.map((change) => [change.line.key, change.beforeText, change.afterText])).toEqual([
      ["second-review#1", "1순위 m3-mlx (2) · gpt-oss-120b", "1순위 supa-direct · supa"]]);
  });

  it("warns when a 2차 voter gets the 1차 model (same-model hold incident) — as a change and as the current state", () => {
    const editor = editorOf();
    const lines = flowRankLinesFor(editor, "second");
    const made = rankWarnings(editor, lines, { "second-review#1": [{ provider: QWEN, model: "qwen3.8-flash-next" }] });
    // gpt-oss 를 빼므로 재심사 안내도 함께
    expect(made).toEqual([expect.objectContaining({ code: "same_model", tone: "bad", line: "second-review#1", existing: false }), expect.objectContaining({ code: "voter_reopen" })]);
    expect(made[0].text).toContain("「2차 갈림」 보류");
    expect(needsAcknowledge(made)).toBe(true);
    const already = editorOf([row("first-review", QWEN, "qwen3.8-flash-next"), row("second-review", QWEN, "qwen3.8-flash-next")]);
    const now = rankWarnings(already, flowRankLinesFor(already, "second"), {});
    expect(now).toEqual([expect.objectContaining({ code: "same_model", existing: true })]);
    expect(now[0].text).toMatch(/^지금 /);
    expect(needsAcknowledge(now)).toBe(false);
    // 1차 칸에서 1차를 2차 투표자의 모델로 바꿔도 같은 경고(1차 줄에)
    const fromFirst = rankWarnings(editor, flowRankLinesFor(editor, "first"), { "first-review#1": [{ provider: M3, model: "gpt-oss-120b" }] });
    expect(fromFirst).toEqual([expect.objectContaining({ code: "same_model", line: "first-review#1" })]);
  });

  it("warns that clearing rank 1 stops a live task (11-02 21:13Z), says so softly for 설정값, and ignores empty voters 2·3", () => {
    const editor = editorOf();
    const first = rankWarnings(editor, flowRankLinesFor(editor, "first"), { "first-review#1": [null, null, null] });
    expect(first).toEqual([expect.objectContaining({ code: "first_cleared", tone: "bad", existing: false })]);
    expect(first[0].text).toContain("21:13Z");
    const publish = rankWarnings(editor, flowRankLinesFor(editor, "publish"), { "publish-classify#1": [null] });
    expect(publish).toEqual([expect.objectContaining({ code: "set_only_cleared", tone: "warn" })]);
    expect(rankWarnings(editor, flowRankLinesFor(editor, "second"), {})).toEqual([]);
    const cleared = editorOf(BASE_ROWS.filter((entry) => entry.task !== "first-review"));
    expect(rankWarnings(cleared, flowRankLinesFor(cleared, "first"), {})).toEqual([expect.objectContaining({ code: "first_cleared", existing: true })]);
  });

  it("tells that removing a voter's model closes its open votes and re-reviews them (11-03 829 rows), with the current 2차 queue", () => {
    const editor = editorOf();
    const warnings = rankWarnings(editor, flowRankLinesFor(editor, "second"), { "second-review#1": [{ provider: SUPA, model: "supa" }] }, { secondWaiting: 414 });
    expect(warnings).toEqual([expect.objectContaining({ code: "voter_reopen", tone: "warn" })]);
    expect(warnings[0].text).toMatch(/gpt-oss-120b.*model_removed.*829행.*2차 대기 414표/);
    // 2순위를 더하기만 하면(모델을 빼지 않으면) 재심사 안내가 없다
    expect(rankWarnings(editor, flowRankLinesFor(editor, "second"), { "second-review#1": [{ provider: M3, model: "gpt-oss-120b" }, { provider: SUPA, model: "supa" }] })).toEqual([]);
  });
});

describe("처리 LLM 바꾸기 — 서랍 그림", () => {
  const editor = editorOf();
  it("edit step: a select per rank, the locked task disabled with its reason, a connection state table", () => {
    const html = renderToStaticMarkup(<RankDrawer editor={editor} lines={flowRankLinesFor(editor, "profile")} title="프로필 준비" secondWaiting={null} onClose={() => {}} />);
    expect(html).toContain("처리 LLM 바꾸기 — 프로필 준비");
    expect(html.match(/<select /g)).toHaveLength(18);
    expect(html).toMatch(/aria-label="소개 검수 1순위" disabled=""/);
    expect(html).toContain("바꿀 수 없음");
    expect(html).toContain("CLI_SERVING_CONTRACTS");
    expect(html).toContain("설정값");
    expect(html).toContain("연결 상태 5개");
    expect(html).toMatch(/바뀌는 내용 확인 →<\/button>/);
    expect(html).toMatch(/<button type="button" class="fr-btn fr-primary" disabled="">/);
  });

  it("confirm step: before → after table, the warnings, and the save stays off until the danger is acknowledged", () => {
    const html = renderToStaticMarkup(<RankDrawer editor={editor} lines={flowRankLinesFor(editor, "second")} title="AI 2차" secondWaiting={0} onClose={() => {}}
      initial={{ step: "confirm", drafts: { "second-review#1": [{ provider: QWEN, model: "qwen3.8-flash-next" }, null, null] } }} />);
    expect(html).toMatch(/<th scope="col">작업<\/th><th scope="col">전<\/th><th scope="col">후<\/th>/);
    expect(html).toContain("1순위 m3-mlx (2) · gpt-oss-120b");
    expect(html).toContain("1순위 gpu3090-qwen · qwen3.8-flash-next");
    expect(html).toContain('data-code="same_model"');
    expect(html).toContain('data-code="voter_reopen"');
    expect(html).toContain("경고를 읽었습니다 — 그래도 저장합니다");
    expect(html).toMatch(/data-danger="yes" disabled="">저장<\/button>/);
  });
});

// ── 단계 표 ──────────────────────────────────────────────────────────────────────────────
const NOW = "2026-11-02T21:00:00.000Z";
const stage = (key: ThroughputStage["key"], patch: Partial<ThroughputStage> = {}): ThroughputStage => ({ key, label: key, unit: key === "second" ? "표" : "건",
  completed1m: 1, completed5m: 5, progress5m: 5, waiting: 3, manualAttention: 0, oldestMinutes: 2, enabled: true, errors5m: 0, queueNote: "", detail: "", status: "processing", ...patch });
function conveyor() {
  const points = Array.from({ length: 24 }, (_, index) => ({ hour: new Date(Date.parse("2026-11-01T22:00:00.000Z") + index * 3_600_000).toISOString(),
    discovered: 40, judged: 30, firstReviews: 20, firstFailed: 0, secondReviews: 0, secondAgreed: 0, published: 0, publishedKorean: 0, keywords: 6, taglines: 7 }));
  const inputs: ConveyorInputs = {
    now: NOW, enabled: true,
    throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first"), stage("second", { waiting: 0, completed5m: 0, status: "idle" }),
      stage("publish", { waiting: 2_207, oldestMinutes: 780, completed5m: 0, status: "stalled" })] },
    flow: { stages: [{ key: "discover", label: "발견 누적", waiting: 90_000, entered: 900, left: null, job: "crawl-seed" }], bottleneck: null, published: 12_345 },
    hourly: { measuredAt: NOW, points, lastHour: { ...points.at(-1)!, hour: undefined } as never },
    human: null, progress: { stages: [], liveness: [] },
    search: { ...emptySearchHealth(), total: 100, pendingGeneration: 4, pendingVerification: 2, oldestVerificationMinutes: 12, generatedRecent: 3, verifiedRecent: 2 },
    holds: [{ reason: "second_review_split", count: 3_701, recent24h: 1_724 }], rejected: 1, classification: { held: 0, nextRetryAt: null }, sources: [],
    models: buildStationLlm({ now: NOW, connections: CONNECTIONS.map((c) => ({ id: c.id, label: c.label, kind: c.kind, baseUrl: c.baseUrl, cliTool: c.cliTool, hasKey: c.hasKey, enabled: c.enabled })),
      rows: BASE_ROWS.map((entry) => ({ task: entry.task, slot: entry.slot, rank: entry.rank, connectionId: entry.connectionId, model: entry.model, enabled: entry.enabled })), used: [], runtime: {} }),
  };
  return buildConveyor(inputs);
}

describe("4차 카드에서 바꾸기 (A안: 카드 유지)", () => {
  const data = conveyor();
  const html = renderToStaticMarkup(<FlowBoard data={data} editor={editorOf()} />);

  it("offers 바꾸기 only where an LLM is called — no button on 탐색·원본 수집·규칙 심사·공개", () => {
    const changes = [...html.matchAll(/aria-label="([^"]+) 처리 LLM 바꾸기"/g)].map((match) => match[1]);
    for (const none of ["탐색", "원본 수집", "규칙 심사", "공개"]) expect(changes, none).not.toContain(none);
    expect(changes).toEqual(expect.arrayContaining(["AI 1차", "AI 2차", "프로필 준비", "발행", "키워드 등록"]));
  });

  it("keeps the card as a div with a full-card hit button and a sibling 바꾸기 button — no nested buttons", () => {
    const first = html.slice(html.indexOf('data-key="first"'), html.indexOf('data-key="second"'));
    expect(first).toContain('<div class="cv-card" data-tone=');
    expect(first).toContain('<button type="button" class="cv-card-hit"');
    expect(first).toContain('<button type="button" class="cv-change cv-card-change" aria-label="AI 1차 처리 LLM 바꾸기">바꾸기</button>');
    // 카드 본문 안에는 단추가 없다 — 바꾸기는 형제 단추다(중첩 단추 금지)
    const body = first.slice(first.indexOf('<span class="cv-card-body">'), first.indexOf("</span><button type=\"button\" class=\"cv-change"));
    expect(body).not.toContain("<button");
  });

  it("offers the same change control in the station detail's model section", () => {
    expect(html).toContain('class="cv-sec-head"');
    expect(html).toMatch(/<h3 class="cv-sec-h" id="cv-sec-model">지금 쓰는 모델[^<]*<\/h3><button[^>]*aria-label="AI 2차 처리 LLM 바꾸기"/);
  });

  it("without the rank read there is no 바꾸기 — only the link to 작업 ↔ AI 모델", () => {
    const plain = renderToStaticMarkup(<FlowBoard data={data} />);
    expect(plain).not.toContain("처리 LLM 바꾸기");
    expect(plain).toContain('href="/admin/models/tasks#tasks"');
  });
});
