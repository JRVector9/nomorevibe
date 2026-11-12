import { describe, expect, it } from "vitest";
import {
  buildChangeWatch, CHANGE_WATCH_ACTIONS, changeWatchTasksFrom, collectChanges, indexLedger, isAutomaticActor, isWatchedAuditRow, judgeChange, measureChange,
  perHourText, runtimePathTasks, watchTexts, type ChangeMeasure, type WatchAuditRow,
} from "@/lib/operations/change-watch";
import { CONN, WATCH_AUDIT, WATCH_CONTEXT, WATCH_LEDGER, WATCH_NOW } from "./fixtures/change-watch";

const snapshot = () => buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW);
const measure = (patch: Partial<ChangeMeasure>): ChangeMeasure =>
  ({ beforePerHour: 17, beforeHours: [17, 17, 17, 17, 17, 17], early: 3, firstHour: 18, lastHour: 17, sinceChange: 40, ...patch });

describe("바꾼 것 지켜보기 — 대표 사례(11-12 07:10 1차 AI 검수 순위 변경)", () => {
  it("바꾸기 전 시간당 17건 → 첫 1시간 86건 → 지금 3건을 「다시 떨어짐」으로 판정한다", () => {
    const row = snapshot().rows.find(entry => entry.key === "28853")!;
    expect(row.title).toBe("1차 AI 검수 1순위를 supa로");
    expect(row.stage).toBe("1차 AI 검수");
    expect(row.measure).toMatchObject({ beforeHours: [33, 40, 16, 3, 11, 0], early: 50, firstHour: 86, lastHour: 3 });
    expect(row.beforeText).toBe("시간당 17건");
    expect(row.afterText).toBe("첫 1시간 86건 → 지금 3건");
    expect(row.verdict).toBe("fell_back");
    expect(row.provisional).toBe(false);
    // 23:08~23:26 접수 중단이 첫 1시간(2분 남짓)과 최근 1시간(6분 남짓)에 겹친 것을 적는다 — 판정은 바꾸지 않는다
    expect(row.notes).toEqual(["잰 구간에 접수 중단 9분이 겹칩니다"]);
    expect(row.undo).toEqual(expect.objectContaining({ href: "/admin/models/tasks" }));
    expect(row.recordHref).toBe("/admin/activity?target=first-review%231");
  });

  it("다른 단계의 장부 수(2차 AI 검수)는 섞지 않는다", () => {
    expect(snapshot().rows.find(entry => entry.key === "28853")!.measure!.lastHour).toBe(3);
  });

  it("모델 M1max — 세 번 저장은 첫 저장 한 줄(추가)로 합치고, 쓰는 단계가 없으면 「아직 안 씀」", () => {
    const row = snapshot().rows.find(entry => entry.title.startsWith("모델 M1max"))!;
    expect(row.ids).toEqual([28845, 28846, 28848]);
    expect(row.at).toBe("2026-11-11T22:06:12Z");
    expect(row.title).toBe("모델 M1max 추가 · 키 바꿈");
    expect(row.verdict).toBe("unused");
    expect(row.afterText).toBe("호출 0건 · 쓰는 단계 없음");
    expect(row.stage).toBeNull();
  });

  it("모델 저장은 그 모델을 지금 쓰는 단계(LG EXAONE → 사유 번역)를 잰다", () => {
    const row = snapshot().rows.find(entry => entry.title.startsWith("모델 LG EXAONE"))!;
    expect(row.title).toBe("모델 LG EXAONE 고침");
    expect(row.stage).toBe("심사 사유 번역");
    expect(row.measure).toMatchObject({ beforePerHour: 100, firstHour: 105, lastHour: 100 });
    expect(row.verdict).toBe("same");
  });

  it("접수 중단 → 다시 열림은 한 줄로 합쳐 걸린 분을 적고, 단계별로 견주지 않는다", () => {
    const row = snapshot().rows.find(entry => entry.action === "pipeline-control-capacity-mode")!;
    expect(row.title).toBe("접수 중단 → 다시 열림 (18분)");
    expect(row.ids).toEqual([28863, 28864]);
    expect(row.until).toBe(WATCH_AUDIT.find(entry => entry.id === 28864)!.at);
    expect(row.verdict).toBe("unknown");
    expect(row.afterText).toBe("—");
    expect(row.undo).toBeNull();
  });

  it("자동 처리자(system·model)의 줄은 빼고, 최근 것부터 놓는다", () => {
    const rows = snapshot().rows;
    expect(rows.some(entry => entry.ids.includes(28842))).toBe(false);
    expect(rows.map(entry => entry.key)).toEqual(["28863", "28853", "28847", "28845"]);
  });

  it("다시 떨어짐은 홈 할 일 「평소와 다름」의 입력이 된다(알림 보냄, 되돌리는 곳·기록)", () => {
    const tasks = changeWatchTasksFrom(snapshot());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      key: "change-watch:28853", verdict: "fell_back", notify: true,
      title: "1차 AI 검수 처리가 바꾼 뒤 다시 줄었습니다",
      actions: [{ label: "되돌리러 가기", href: "/admin/models/tasks" }, { label: "기록 보기", href: "/admin/activity?target=first-review%231" }],
    });
    expect(tasks[0].fact).toContain("1차 AI 검수 1순위를 supa로");
    expect(tasks[0].fact).toContain("시간당 17건 → 첫 1시간 86건 → 지금 3건");
    expect(tasks[0].why).toContain("접수 중단 9분");
  });
});

describe("판정(순수)", () => {
  it("10분 전에는 세는 중, 1시간 전에는 첫 10분으로 본 판정(provisional)", () => {
    expect(judgeChange(measure({ early: null, firstHour: null, lastHour: null })).verdict).toBe("counting");
    const early = judgeChange(measure({ early: 10, firstHour: null, lastHour: null }));
    expect(early).toMatchObject({ verdict: "better", provisional: true });
    expect(early.reason).toContain("첫 10분");
  });

  it("좋아짐·나빠짐·그대로 — 비율과 최소 차이를 함께 넘어야 한다", () => {
    expect(judgeChange(measure({ firstHour: 40, lastHour: 40 })).verdict).toBe("better");
    expect(judgeChange(measure({ firstHour: 5, lastHour: 5 })).verdict).toBe("worse");
    expect(judgeChange(measure({ firstHour: 19, lastHour: 15 })).verdict).toBe("same");
    // 시간당 2건 → 0건: 비율은 넘지만 차이가 3건이 안 된다
    expect(judgeChange(measure({ beforePerHour: 2, firstHour: 0, lastHour: 0, sinceChange: 0 })).verdict).toBe("same");
  });

  it("다시 떨어짐 — 첫 1시간은 늘었고 지금은 바꾸기 전과 비슷하거나 낮다", () => {
    expect(judgeChange(measure({ firstHour: 86, lastHour: 3 })).verdict).toBe("fell_back");
    expect(judgeChange(measure({ firstHour: 86, lastHour: 18 })).verdict).toBe("fell_back");
    expect(judgeChange(measure({ firstHour: 86, lastHour: 60 })).verdict).toBe("better");
  });

  it("아직 안 씀(호출 0)·판정 못 함(단계 없음·같은 단계를 곧 또 바꿈)", () => {
    expect(judgeChange(measure({ beforePerHour: 0, beforeHours: [0, 0, 0, 0, 0, 0], early: 0, firstHour: 0, lastHour: 0, sinceChange: 0 })).verdict).toBe("unused");
    expect(judgeChange(null, { noStage: true }).verdict).toBe("unused");
    expect(judgeChange(null).verdict).toBe("unknown");
    expect(judgeChange(measure({}), { superseded: "12분 뒤" })).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("12분 뒤") });
  });

  it("전 → 후 글", () => {
    expect(watchTexts(measure({ early: null, firstHour: null, lastHour: null }), "counting")).toEqual({ beforeText: "시간당 17건", afterText: "세는 중" });
    expect(watchTexts(measure({ early: 4, firstHour: null, lastHour: null }), "same").afterText).toBe("첫 10분 4건 · 1시간 세는 중");
    expect(perHourText(0.5)).toBe("0.5");
    expect(perHourText(1234.4)).toBe("1,234");
  });
});

describe("변경 → 단계", () => {
  const at = (minutes: number) => new Date(Date.parse("2026-11-11T20:00:00Z") + minutes * 60_000).toISOString();
  const audit = (id: number, minutes: number, action: string, target: string, detail: Record<string, unknown> = {}, actor = "jr"): WatchAuditRow =>
    ({ id, at: at(minutes), actor, actorKind: "github", action, target, detail });

  it("실시간 한도의 바뀐 칸 → 그 칸을 쓰는 작업(경로 이름이 장부와 다르면 잡의 호출 경로표로)", () => {
    expect(runtimePathTasks("routes.timeouts.reason-translate").map(task => task.id)).toEqual(["reason-translate"]);
    expect(runtimePathTasks("routes.limits.review-gateway.concurrency").map(task => task.id)).toEqual(expect.arrayContaining(["first-review", "second-review", "product-audit"]));
    expect(runtimePathTasks("budgets.crawl-agent-review").map(task => task.id)).toEqual(["first-review"]);
    expect(runtimePathTasks("translation.product.batchMax").map(task => task.id)).toEqual(["product-translate"]);
    expect(runtimePathTasks("capacity.unknownHoldSeconds")).toEqual([]);
  });

  it("같은 사람의 연달은 한도 저장(10분)은 한 줄로 — 바뀐 칸과 단계를 모은다", () => {
    const [row] = collectChanges([
      audit(1, 0, "runtime-settings-save", "runtime_settings:routes", { changes: [{ path: "routes.timeouts.reason-translate", label: "사유 번역 호출 상한(ms)" }] }),
      audit(2, 3, "runtime-settings-save", "runtime_settings:budgets", { changes: [{ path: "budgets.crawl-agent-review", label: "AI1 심사 틱 예산(ms)" }] }),
    ], WATCH_CONTEXT);
    expect(row.ids).toEqual([1, 2]);
    expect(row.title).toBe("한도 저장 · 사유 번역 호출 상한(ms) 외 1");
    expect(row.routes).toEqual(["crawl-agent-review", "reason-translate"]);
    expect(row.stage).toBe("심사 사유 번역 · 1차 AI 검수");
  });

  it("같은 단계를 1시간 안에 또 바꾸면 앞의 변경은 판정하지 않는다", () => {
    const changes = collectChanges([
      audit(1, 0, "ai-task-models-save", "first-review#1", { before: [], after: [{ rank: 1, connectionId: CONN.supa, model: "m" }] }),
      audit(2, 12, "ai-task-models-save", "first-review#1", { before: [{ rank: 1, connectionId: CONN.supa, model: "m" }], after: [{ rank: 1, connectionId: CONN.gpu, model: "q" }] }),
    ], WATCH_CONTEXT);
    const rows = buildChangeWatch(changes, [], Date.parse(at(300))).rows;
    expect(rows.find(row => row.key === "1")).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("12분 뒤") });
    expect(rows.find(row => row.key === "2")!.title).toBe("1차 AI 검수 1순위를 gpu3090-qwen로");
  });

  it("옛 순위 기록 지움·모르는 작업·모델 단계가 아닌 작업 멈춤은 단계를 정하지 않는다", () => {
    const changes = collectChanges([
      audit(1, 0, "ai-task-models-save", "screen-review#1", { reason: "unread_records_cleared", before: [{ rank: 1, connectionId: CONN.gpu, model: "q" }], after: [] }),
      audit(2, 1, "job-pause", "crawl-seed", { reason: "점검" }),
      audit(3, 2, "job-pause", "product-intro-check", { reason: "점검" }),
      audit(4, 3, "settings-save", "crawl_settings", { changes: [] }),
    ], WATCH_CONTEXT);
    expect(changes.map(change => [change.title, change.routes])).toEqual([
      ["화면 판별 옛 순위 기록 지움", []], ["검색 수집 멈춤", []], ["소개 검수 멈춤", ["product-intro-check"]], ["settings-save · crawl_settings", []]]);
    // 사람이 일부러 멈춘 작업은 줄었어도 할 일로 올리지 않는다
    const ledger = Array.from({ length: 6 }, (_, hour) => ({ route: "product-intro-check", bucket: Math.floor(Date.parse(at(-360 + hour * 60)) / 300_000), settled: 20 }));
    const watch = buildChangeWatch(changes, ledger, Date.parse(at(180)));
    expect(watch.rows.find(row => row.key === "3")!.verdict).toBe("worse");
    expect(changeWatchTasksFrom(watch)).toEqual([]);
  });

  it("자동 처리자와 지켜보는 작업", () => {
    expect(isAutomaticActor("system:ai-connection-key-fill", "token")).toBe(true);
    expect(isAutomaticActor("auto:repo-gone", null)).toBe(true);
    expect(isAutomaticActor("m3-deepseek", "model")).toBe(true);
    expect(isAutomaticActor("jr-claude", null)).toBe(false);
    expect(CHANGE_WATCH_ACTIONS).toEqual(expect.arrayContaining(["ai-task-models-save", "ai-connection-save", "runtime-settings-save", "pipeline-control-capacity-mode", "job-pause", "job-resume"]));
    expect(CHANGE_WATCH_ACTIONS).not.toContain("model-capacity-unknown-reviewed");
    const recent = { action: "ai-task-models-save", ok: true, actor: "jr", actorKind: "github", createdAt: new Date(WATCH_NOW - 3_600_000) };
    expect(isWatchedAuditRow(recent, WATCH_NOW)).toBe(true);
    expect(isWatchedAuditRow({ ...recent, ok: false }, WATCH_NOW)).toBe(false);
    expect(isWatchedAuditRow({ ...recent, createdAt: new Date(WATCH_NOW - 25 * 3_600_000) }, WATCH_NOW)).toBe(false);
  });

  it("장부 칸 — 바꾼 때를 가까운 5분 경계로 맞추고, 지금 칸(세는 중)은 다 센 칸에 넣지 않는다", () => {
    const change = { at: "2026-11-11T22:12:31Z", routes: ["r"], prefixes: [] };
    const b = (iso: string) => Math.floor(Date.parse(iso) / 300_000);
    const ledger = indexLedger([{ route: "r", bucket: b("2026-11-11T22:10:00Z"), settled: 7 }, { route: "r", bucket: b("2026-11-11T22:15:00Z"), settled: 5 },
      { route: "local-assist-x-backend", bucket: b("2026-11-11T22:15:00Z"), settled: 100 }]);
    const m = measureChange(change, ledger, Date.parse("2026-11-11T22:27:00Z"));
    // 22:12:31 → 22:15 칸부터(22:10 칸은 바꾸기 전)
    expect(m.beforeHours.at(-1)).toBe(7);
    expect(m.early).toBe(5);
    expect(m.firstHour).toBeNull();
    expect(measureChange({ ...change, prefixes: ["local-assist-x-"] }, ledger, Date.parse("2026-11-11T22:27:00Z")).early).toBe(105);
  });
});
