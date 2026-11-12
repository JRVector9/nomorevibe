import { describe, expect, it } from "vitest";
import { aiTaskSupportsPool } from "@/lib/llm/ai-task-execution-config";
import { buildChangeWatch, collectChanges } from "@/lib/operations/change-watch";
import { buildConsoleTasks, type ConsoleTaskInputs } from "@/lib/operations/console-tasks";
import { stagePanelHref, stagePanelKeyOf, STAGE_PANELS } from "@/lib/operations/stage-panel-catalog";
import {
  assignmentPreview, buildStagePanel, previewContext, stageChanges, stagePoolSupported, trendBreak,
  type AssignmentState, type StagePanelInput,
} from "@/lib/operations/stage-panel-model";
import { aiTaskPoolFeatures } from "@/lib/llm/ai-task-execution-config";
import { poolMemberIssues } from "@/lib/operations/task-pool-form";
import { consoleFixtureExecutions, consoleFixtureInputs, consoleFixtureJobStates, consoleFixtureRuntime } from "./fixtures/console-home";
import { CONN, WATCH_AUDIT, WATCH_CONTEXT, WATCH_LEDGER, WATCH_NOW } from "./fixtures/change-watch";

/** 2026-11-12 08:59 KST 실측(fixture) 그대로의 패널 입력 — 바꿀 칸만 덮어쓴다 */
function input(key: StagePanelInput["key"], patch: Partial<StagePanelInput> = {}, inputs: Partial<ConsoleTaskInputs> = {}): StagePanelInput {
  const base = { ...consoleFixtureInputs(), ...inputs };
  return { key, now: base.now, conveyor: base.conveyor as StagePanelInput["conveyor"], inputs: base, board: buildConsoleTasks(base),
    jobStates: consoleFixtureJobStates(), pauses: [], degraded: [], runtime: consoleFixtureRuntime(), executions: consoleFixtureExecutions(), ...patch };
}
const panel = (...args: Parameters<typeof input>) => buildStagePanel(input(...args))!;
const why = (key: StagePanelInput["key"], patch?: Partial<StagePanelInput>, inputs?: Partial<ConsoleTaskInputs>) =>
  panel(key, patch, inputs).why.map(line => `${line.label} | ${line.text}`);

describe("stage panel — the design's AI 1차 panel from the fixture", () => {
  const first = panel("first");

  it("heads with the same status as the flow table and the station's numbers", () => {
    expect([first.label, first.tone, first.status]).toEqual(["AI 1차", "bad", "거의 멈춤"]);
    expect(first.facts).toEqual([{ label: "대기", value: "857" }, { label: "가장 오래된 것", value: "8시간 2분" }, { label: "최근 1시간", value: "3" },
      { label: "24시간", value: "2,479" }]);
    // 지난 23시간(이번 시간은 덜 차서 뺀다)
    expect(first.spark).toHaveLength(23);
  });

  it("explains with read facts only — skips, slots and who holds them, where the hourly count broke", () => {
    expect(first.why.map(line => `${line.label} | ${line.text}`)).toEqual([
      "워커 | 틱마다 후보 2건을 「이미 처리 중」으로 건너뛰고 끝납니다(건너뜀 사유 running).",
      "1순위 | supa-direct는 3칸 중 3칸을 쓰고 있고, 쓰는 쪽은 키워드 검수입니다.",
      "2순위 | gpu3090-qwen은 5칸이 모두 비어 있습니다.",
      "추이 | 11-12 01시대에 시간당 139건에서 35건으로 떨어졌고, 06시대는 0건이었습니다. 원인 미확인.",
    ]);
  });

  it("lists the ranking with each model's slots, 24 hours and speed, and the idle models next to 「모델 붙이기」", () => {
    expect(first.models).toHaveLength(1);
    const line = first.models![0];
    expect(line).toMatchObject({ key: "first-review#1", label: "1차 AI 검수", mode: "fallback", poolSupported: true, apiOnly: false, archived: null });
    expect(line.members.map(member => [member.tag, member.name, member.facts])).toEqual([
      ["1순위", "supa-direct", "지금 3/3칸 · 24시간 88건 · 3.8초"], ["2순위", "gpu3090-qwen", "지금 0/5칸 · 24시간 639건 · 3.2초"]]);
    // 홈 「쌓임」과 같은 남는 모델 계산 — 이미 이 작업에 있는 gpu3090-qwen 은 빠진다
    expect(line.idle).toEqual([{ connectionId: "conn-m1max", name: "M1max", text: "0% · 2칸" }]);
    expect(first.jobs).toEqual([{ job: "crawl-agent-review", label: "AI 1차 심사", paused: false, text: "도는 중 · 주기 1분 · 마지막 성공 11-12 08:41", pause: null, notBefore: null }]);
    expect(first.routes).toEqual(["crawl-agent-review"]);
  });
});

describe("stage panel — other stages", () => {
  it("names who paused a job, when and why — or says the record is missing", () => {
    const pause = { job: "product-intro-check", actor: "JR", at: "2026-11-03T17:03:03.000Z", reason: "소개 검수 비용 확인" };
    expect(why("intro-check", { pauses: [pause] })[0]).toBe("사람이 멈춤 | 소개 검수 작업을 JR이 11-04 02:03에 멈췄습니다 — 사유: 소개 검수 비용 확인");
    expect(why("intro-check")[0]).toBe("사람이 멈춤 | 소개 검수 작업이 멈춰 있습니다 — 멈춘 기록(작업 로그)을 찾지 못했습니다.");
    expect(why("intro-check", { pauses: null })[0]).toBe("사람이 멈춤 | 소개 검수 작업이 멈춰 있습니다 — 멈춘 기록을 읽지 못했습니다.");
    // 공개 뒤 단계 — 머리는 워커 진행과 24시간 장부
    expect(panel("intro-check").facts).toEqual([{ label: "대기", value: "2,143" }, { label: "가장 오래된 것", value: "8.2일" }, { label: "최근 5분", value: "0" },
      { label: "24시간 모델 처리", value: "0" }]);
  });

  it("gives a stage without models its jobs (cycle, last success) and settings in the same frame", () => {
    const fetch = panel("fetch");
    expect([fetch.models, fetch.tasks, fetch.why]).toEqual([null, [], []]);
    expect(fetch.jobs.map(job => job.text)).toEqual(["도는 중 · 주기 1분 · 마지막 성공 11-12 08:58"]);
    expect(fetch.links.map(link => link.href)).toEqual(["/admin/settings?tab=collection", "/admin/status?tab=jobs&job=crawl-fetch"]);
    expect(panel("discover").jobs.map(job => job.label)).toEqual(["GitHub 검색", "Show HN", "Show GN", "한국어 프로젝트"]);
  });

  it("shows a pooled stage as 「함께」 with its members, and one line per device", () => {
    const publish = panel("publish");
    expect(publish.models![0]).toMatchObject({ mode: "workload_pool", apiOnly: true, poolSupported: true });
    expect(publish.models![0].members.map(member => [member.tag, member.name])).toEqual([["함께", "m3-deepseek"], ["함께", "gpu3090-qwen"]]);
    expect(publish.why.filter(line => line.label === "함께").map(line => line.text)).toEqual([
      "m3-deepseek가 있는 장비는 3칸 중 2칸을 쓰고 있고, 쓰는 쪽은 사람 몫 AI 위임 1칸 · 공개 번역 1칸입니다.", "gpu3090-qwen은 5칸이 모두 비어 있습니다."]);
    // 일감이 없을 때 꺾임은 지금 대기와 함께(까닭은 말하지 않는다)
    expect(publish.why.at(-1)!.text).toMatch(/지금 대기 0건\. 원인 미확인\.$/);
    // 키워드 등록 — 두 작업, 같은 장비의 두 모델은 한 줄, 이 단계가 쥔 칸은 「이 단계」
    expect(why("keywords").filter(line => line.split(" | ")[0].includes("순위"))).toEqual([
      "키워드 짓기 1순위 · 키워드 짓기 2순위 | m3-gpt-oss·m3-deepseek가 있는 장비는 3칸 중 2칸을 쓰고 있고, 쓰는 쪽은 사람 몫 AI 위임 1칸 · 공개 번역 1칸입니다.",
      "키워드 검수 1순위 | supa-direct는 3칸 중 3칸을 쓰고 있고, 쓰는 쪽은 이 단계입니다."]);
  });

  it("adds what the worker left: a degraded tick, the last error, the runtime's unusable ranks, a drained admission", () => {
    const now = consoleFixtureInputs().now;
    const lines = why("fetch", { degraded: [{ job: "crawl-fetch", code: "source_rate_limited", detail: "GitHub 한도", streak: 3, since: "2026-11-11T23:40:00.000Z", at: now }],
      jobStates: consoleFixtureJobStates().map(state => state.name === "crawl-fetch" ? { ...state, lastError: "fetch failed:\n timeout" } : state) });
    expect(lines).toEqual(["워커 | 원본 수집 작업의 마지막 틱이 제 일을 못 했습니다(source_rate_limited — GitHub 한도) · 3번 연속, 11-12 08:40부터.",
      "오류 | 원본 수집 작업의 마지막 틱이 오류로 끝났습니다 — fetch failed: timeout"]);
    // 30분 넘은 관측은 지금 사정이 아니다
    expect(why("fetch", { degraded: [{ job: "crawl-fetch", code: "x", detail: null, streak: 1, since: null, at: "2026-11-11T23:00:00.000Z" }] })).toEqual([]);
    const runtime = why("reason-translate", { runtime: [{ task: "reason-translate", at: now, served: [{ rank: 1, count: 4 }],
      unusable: [{ rank: 2, code: "slots_full", text: "칸 가득", count: 2 }], degraded: null }] });
    expect(runtime[0]).toBe("실행 쪽 | 마지막 틱(08:59): 1순위로 4건 · 2순위 못 씀(칸 가득) 2회");
    expect(why("reason-translate", {}, { admission: { mode: "draining", since: "2026-11-11T23:08:04.000Z" } })[0])
      .toBe("접수 | 모델 접수가 중단 상태입니다(11-12 08:08부터).");
  });

  it("does not guess: unread slots are said once, and a bad stage with nothing read says 「원인 미확인」", () => {
    const blind = panel("first", { runtime: [] }, { devices: null, progress: { stages: [] } });
    expect(blind.slotsUnknown).toBe(true);
    expect(blind.why.map(line => line.label)).toEqual(["추이"]);
    expect(blind.models![0].members[0].facts).toBe("칸 셀 수 없음 · 24시간 88건 · 3.8초");
    const flat = input("first", { runtime: [] }, { devices: null, progress: { stages: [] } });
    const station = flat.conveyor!.stations.find(row => row.key === "first")!;
    station.spark = station.spark!.map(() => 3);
    expect(buildStagePanel(flat)!.why).toEqual([{ label: "원인", text: "원인 미확인 — 위의 값 말고 까닭을 읽지 못했습니다." }]);
  });

  it("knows every stage on the flow table and nothing else", () => {
    expect(STAGE_PANELS.map(def => def.key)).toEqual(["discover", "fetch", "judge", "first", "second", "profile", "publish", "keywords",
      "tagline-ko", "product-translate", "reason-translate", "intro-check"]);
    expect(buildStagePanel(input("first", { key: "human" as never }))).toBeNull();
    expect([stagePanelKeyOf("keyword-verify"), stagePanelKeyOf("crawl-tagline"), stagePanelKeyOf("first"), stagePanelKeyOf("uptime")])
      .toEqual(["keywords", "profile", "first", null]);
    expect([stagePanelHref("keyword-verify", "models"), stagePanelHref("intro-check")]).toEqual(["/admin/flow?stage=keywords#sp-models", "/admin/flow?stage=intro-check"]);
    // 2차는 투표자 셋 — 「동시에」는 투표자 1에서만(지원 범위는 ai-task-execution-config 한 곳)
    expect(panel("second").models!.map(line => [line.label, line.poolSupported])).toEqual([["2차 AI 검수 · 투표자 1", true], ["2차 AI 검수 · 투표자 2", false],
      ["2차 AI 검수 · 투표자 3", false]]);
  });
});

describe("trend break", () => {
  const hours = Array.from({ length: 12 }, (_, index) => new Date(Date.parse("2026-11-11T12:00:00Z") + index * 3_600_000).toISOString());
  it("finds the first hour that fell to half and stayed there", () => {
    expect(trendBreak(hours, [20, 20, 20, 20, 20, 20, 9, 8, 2, 10, 4, 6])).toEqual({ at: hours[6], before: 20, value: 9, low: { at: hours[8], value: 2 } });
  });
  it("ignores small numbers, one bad hour and a slow decline", () => {
    expect(trendBreak(hours, [9, 9, 9, 9, 9, 9, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(trendBreak(hours, [20, 20, 20, 20, 20, 20, 2, 20, 20, 20, 20, 20])).toBeNull();
    expect(trendBreak(hours, [20, 20, 20, 20, 20, 20, 19, 18, 17, 16, 15, 14])).toBeNull();
  });
});

describe("recent changes for a stage", () => {
  it("keeps only the changes that touch this stage's routes, jobs or task", () => {
    const snapshot = buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW);
    expect(stageChanges(snapshot.rows, panel("first")).map(row => row.title)).toEqual(["1차 AI 검수 1순위를 supa로"]);
    expect(stageChanges(snapshot.rows, panel("reason-translate")).map(row => row.title)).toEqual(["모델 LG EXAONE 고침"]);
    expect(stageChanges(snapshot.rows, panel("fetch"))).toEqual([]);
  });
});

describe("save preview (저장 전 확인)", () => {
  const inputs = consoleFixtureInputs();
  const context = previewContext(inputs);
  const supa = { provider: "conn-supa-direct", model: "Inferact/Qwen3.8-27B-NVFP4" }, gpu = { provider: "conn-gpu3090-qwen", model: "qwen3.8-flash-next" };
  const m1max = { provider: "conn-m1max", model: "Qwen3.8" };
  const before: AssignmentState = { mode: "fallback", ranks: [supa, gpu], members: [] };

  it("shows nothing to save when nothing changed", () => {
    expect(assignmentPreview({ task: "first-review", slot: 1, before, after: { ...before }, context })).toEqual({ rows: [], impact: [], saves: [] });
  });

  it("turning to 「동시에」: way, concurrency and members before → after, then each model's slots and the other stages sharing it", () => {
    const preview = assignmentPreview({ task: "first-review", slot: 1, before, after: { mode: "workload_pool", ranks: [supa, gpu], members: [supa, gpu] }, context });
    expect(preview.rows).toEqual([
      { label: "방식", before: "순위대로", after: "동시에" },
      { label: "동시 처리", before: "한 모델씩(1순위가 막히면 다음 순위)", after: "모델 2개가 나눠 처리 · 장비 칸 합 8칸(다른 단계와 함께 씀)" },
      // 이름은 사용자가 정한 이름 하나 — supa 의 두 서버 이름(같은 root)은 따로 적지 않는다
      { label: "함께 쓰는 모델", before: "없음", after: "supa-direct + gpu3090-qwen" },
    ]);
    expect(preview.saves).toEqual(["execution"]);
    expect(preview.impact).toEqual([
      { tone: "warn", text: "supa-direct: 지금 3칸 중 3칸 사용(가득 참) · 같은 모델을 쓰는 다른 단계 2개(키워드 검수 · AI 2차)와 칸을 나눕니다" },
      { tone: "info", text: "gpu3090-qwen: 지금 5칸 중 0칸 사용 · 같은 모델을 쓰는 다른 단계 9개(LLM 보강 · 발행분 감사 · 직접 모델 · 감사 두 번째 의견 · 보류 재심사 외 5)와 칸을 나눕니다" },
    ]);
  });

  it("changing the ranking: the chain before → after, a model leaving, a model joining, and an emptied first rank", () => {
    const swap = assignmentPreview({ task: "first-review", slot: 1, before, after: { ...before, ranks: [m1max, gpu] }, context });
    // M1max 는 서버 목록 이름과 직접 적은 이름이 서로 다른 모델 — 가를 수 있게 그 이름을 덧붙인다
    expect(swap.rows).toEqual([{ label: "순위", before: "supa-direct → gpu3090-qwen", after: "M1max · Qwen3.8 → gpu3090-qwen" }]);
    expect(swap.saves).toEqual(["ranks"]);
    expect(swap.impact.map(item => item.text)).toEqual(["M1max: 지금 2칸 중 0칸 사용 · 다른 단계는 이 모델을 쓰지 않습니다",
      expect.stringMatching(/^gpu3090-qwen: /), "supa-direct를 이 단계에서 뺍니다 — 다른 단계 2개는 계속 씁니다."]);
    const emptied = assignmentPreview({ task: "first-review", slot: 1, before, after: { ...before, ranks: [null, gpu] }, context });
    expect(emptied.impact.at(-1)).toEqual({ tone: "bad", text: "1순위가 비면 이 단계가 멈춥니다(no_task_models)." });
  });

  it("back to 「순위대로」 restores the kept ranking through the execution save only", () => {
    const pooled: AssignmentState = { mode: "workload_pool", ranks: [supa, gpu], members: [gpu] };
    const back = assignmentPreview({ task: "first-review", slot: 1, before: pooled, after: { ...pooled, mode: "fallback" }, context });
    expect(back.rows.map(row => [row.label, row.before, row.after])).toEqual([["방식", "동시에", "순위대로"],
      ["동시 처리", "모델 1개가 나눠 처리 · 장비 칸 합 5칸(다른 단계와 함께 씀)", "한 모델씩(1순위가 막히면 다음 순위)"],
      ["순위", "쓰지 않음(보관)", "supa-direct → gpu3090-qwen"]]);
    expect(back.saves).toEqual(["execution"]);
  });

  it("「동시에」 with per-model slots (text stages): concurrency is the slot sum, members carry their slots, reserve is its own row", () => {
    const pooled: AssignmentState = { mode: "workload_pool", ranks: [supa], members: [supa, gpu], slots: ["", ""], reserve: false };
    const capped = assignmentPreview({ task: "product-translate", slot: 1, before: pooled, after: { ...pooled, slots: ["1", "5"], reserve: true }, context });
    expect(capped.rows).toEqual([
      { label: "동시 처리", before: "모델 2개가 나눠 처리 · 장비 칸 합 8칸(다른 단계와 함께 씀)", after: "모델 2개가 함께 · 최대 6건(칸 수 합)" },
      { label: "함께 쓰는 모델", before: "supa-direct + gpu3090-qwen", after: "supa-direct 1칸 + gpu3090-qwen 5칸" },
      { label: "예비", before: "없음", after: "순위(1·2·3)로 이어 처리" },
    ]);
    expect(capped.saves).toEqual(["execution"]);
    expect(capped.impact[0].text).toMatch(/^supa-direct: 이 단계에 1칸 · 지금 3칸 중 3칸 사용\(가득 참\)/);
    // 칸 수를 받지 않는 작업(1차)은 칸 수를 무시한다 — 예전 작업 분산 그대로
    const ignored = assignmentPreview({ task: "first-review", slot: 1, before: pooled, after: { ...pooled, slots: ["1", "5"], reserve: true }, context });
    expect(ignored.rows).toEqual([]);
    // 장비 한도보다 많이 적으면 알린다
    const over = assignmentPreview({ task: "product-translate", slot: 1, before: pooled, after: { ...pooled, slots: ["8", "1"] }, context });
    expect(over.impact[0]).toMatchObject({ tone: "warn" });
    expect(over.impact[0].text).toContain("장비 한도 3칸보다 많이 적어 장비 한도가 먼저 걸립니다");
  });

  it("checks pool members with the task assignment form's own function, and asks one function whether a task takes 「동시에」", () => {
    const connections = (inputs.connections ?? []).map(row => ({ id: row.id, enabled: row.enabled, kind: row.kind, cliTool: row.cliTool }));
    const plain = { apiOnly: false, features: aiTaskPoolFeatures("first-review") }, publish = { apiOnly: true, features: aiTaskPoolFeatures("publish-classify") };
    expect(poolMemberIssues([], [], connections, plain)).toEqual(["분산할 모델을 하나 이상 선택하세요."]);
    expect(poolMemberIssues([{ provider: "conn-claude-cli", model: "sonnet" }], [], connections, publish)).toEqual(["발행 분류에는 API 또는 OpenCode 연결을 선택하세요."]);
    expect(poolMemberIssues([{ provider: "gone", model: "x" }], [], connections, plain)).toEqual(["꺼졌거나 없는 연결을 바꿔주세요."]);
    expect(poolMemberIssues([gpu, gpu], [], connections, plain)).toEqual([]);
    // 칸 수는 받는 작업(공개 번역)에서만 검사한다 — 모두 적거나 모두 비움, 1~8
    const text = { apiOnly: false, features: aiTaskPoolFeatures("product-translate") };
    expect(poolMemberIssues([supa, gpu], ["2", ""], connections, text)).toEqual(["칸 수는 모든 모델에 적거나 모두 비워 주세요."]);
    expect(poolMemberIssues([supa, gpu], ["2", "9"], connections, text)).toEqual(["칸 수는 1~8 사이로 적어 주세요."]);
    expect(poolMemberIssues([supa, gpu], ["2", "9"], connections, plain)).toEqual([]);
    for (const [task, slot] of [["first-review", 1], ["second-review", 2], ["product-intro-check", 1], ["product-translate", 1]] as const)
      expect(stagePoolSupported(task, slot)).toBe(aiTaskSupportsPool(task, slot));
    expect(CONN.supa).toBeTruthy();
  });
});
