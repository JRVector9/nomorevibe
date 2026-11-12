import { describe, expect, it } from "vitest";
import {
  backlogFromProgress, buildChangeWatch, CHANGE_WATCH_ACTIONS, CHANGE_WATCH_RULES, changeWatchTasksFrom, collectChanges, collectOutages, indexLedger, isAutomaticActor,
  isWatchedAuditRow, judgeChange, measureChange, perHourText, runtimePathTasks, watchTexts, type ChangeMeasure, type WatchAuditRow,
} from "@/lib/operations/change-watch";
import { CONN, WATCH_AUDIT, WATCH_BACKLOG, WATCH_CONTEXT, WATCH_LEDGER, WATCH_NOW } from "./fixtures/change-watch";

const snapshot = () => buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW,
  { outages: collectOutages(WATCH_AUDIT, WATCH_NOW), backlog: backlogFromProgress(WATCH_BACKLOG) });
const measure = (patch: Partial<ChangeMeasure>): ChangeMeasure =>
  ({ beforePerHour: 17, beforeHours: [17, 17, 17, 17, 17, 17], early: 3, firstHour: 18, lastHour: 17, sinceChange: 40,
    excluded: { before: 0, first: 0, last: 0 }, firstRate: null, lastRate: null, ...patch });

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
    // 23:08~23:26 접수 중단과 겹친 5분 칸(첫 1시간 1칸 · 최근 1시간 2칸)을 빼고 시간당으로 고쳐 견준다 — 대기 857건이 있어 다시 떨어짐 그대로
    expect(row.measure).toMatchObject({ excluded: { before: 0, first: 5, last: 10 } });
    expect(row.measure!.firstRate).toBeCloseTo(86 / (55 / 60));
    expect(row.measure!.lastRate).toBeCloseTo(3 / (50 / 60));
    expect(row.notes).toEqual(["잰 구간에서 접수 중단·작업 멈춤 15분을 빼고 시간당으로 견줬습니다"]);
    expect(row.undo).toEqual(expect.objectContaining({ href: "/admin/models#tasks" }));
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
      actions: [{ label: "되돌리러 가기", href: "/admin/models#tasks" }, { label: "기록 보기", href: "/admin/activity?target=first-review%231" }],
    });
    expect(tasks[0].fact).toContain("1차 AI 검수 1순위를 supa로");
    expect(tasks[0].fact).toContain("시간당 17건 → 첫 1시간 86건 → 지금 3건");
    expect(tasks[0].why).toContain("접수 중단·작업 멈춤 15분");
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

  it("한 단계에는 가장 최근 변경만 — 그 뒤 같은 단계를 또 바꾸면(시간 제한 없이, 멈춤 → 재개 포함) 앞의 변경은 판정하지 않는다", () => {
    const changes = collectChanges([
      audit(1, 0, "ai-task-models-save", "first-review#1", { before: [], after: [{ rank: 1, connectionId: CONN.supa, model: "m" }] }),
      audit(2, 12, "ai-task-models-save", "first-review#1", { before: [{ rank: 1, connectionId: CONN.supa, model: "m" }], after: [{ rank: 1, connectionId: CONN.gpu, model: "q" }] }),
      audit(3, 300, "job-pause", "crawl-agent-review", { reason: "배포 창" }),
      audit(4, 314, "job-resume", "crawl-agent-review", { reason: "배포 창" }),
      // 다른 단계의 변경은 앞의 것을 덮지 않는다
      audit(5, 320, "ai-task-models-save", "second-review#1", { before: [], after: [{ rank: 1, connectionId: CONN.gpu, model: "q" }] }),
    ], WATCH_CONTEXT);
    const rows = buildChangeWatch(changes, [], Date.parse(at(400))).rows;
    expect(rows.find(row => row.key === "1")).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("12분 뒤 · 1차 AI 검수 1순위를 gpu3090-qwen로") });
    expect(rows.find(row => row.key === "2")).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("4시간 48분 뒤 · AI1 심사 멈춤 → 재개 (14분)") });
    expect(rows.find(row => row.key === "5")!.reason).not.toContain("그 뒤");
    expect("supersedeMinutes" in CHANGE_WATCH_RULES).toBe(false);
  });

  it("잡 멈춤 → 재개는 한 줄(걸린 분)로 합치고 견주지 않는다 — 원상 복구라 되돌릴 것도 없다. 멈춘 때를 모르는 재개도 견주지 않는다", () => {
    const rows = [audit(1, 0, "job-pause", "reason-translate", { reason: "배포 창" }), audit(2, 0, "job-pause", "product-translate", { reason: "배포 창" }),
      audit(3, 14, "job-resume", "reason-translate", { reason: "배포 창", previousControlVersion: 1 }),
      audit(4, 14, "job-resume", "product-translate", { reason: "배포 창", previousControlVersion: 2 }),
      audit(5, 30, "job-resume", "crawl-publish", { reason: "배포 창" })];
    const changes = collectChanges(rows, WATCH_CONTEXT);
    expect(changes.map(change => [change.title, change.ids, change.restore, change.until !== null])).toEqual([
      ["사유 번역 멈춤 → 재개 (14분)", [1, 3], true, true], ["공개 번역 멈춤 → 재개 (14분)", [2, 4], true, true], ["발행 재개", [5], true, false]]);
    const ledger = Array.from({ length: 12 * 8 }, (_, index) => ({ route: "reason-translate", bucket: Math.floor(Date.parse(at(-360)) / 300_000) + index, settled: index > 80 ? 0 : 20 }));
    const watch = buildChangeWatch(changes, ledger, Date.parse(at(120)), { outages: collectOutages(rows, Date.parse(at(120))), backlog: new Map([["reason-translate", 5000]]) });
    expect(watch.rows.map(row => [row.title, row.verdict, row.measure, row.undo])).toEqual([
      ["발행 재개", "unknown", null, expect.objectContaining({ text: expect.stringContaining("다시 멈춤") })],
      ["공개 번역 멈춤 → 재개 (14분)", "unknown", null, null], ["사유 번역 멈춤 → 재개 (14분)", "unknown", null, null]]);
    expect(watch.rows[2].reason).toContain("원상 복구");
    expect(changeWatchTasksFrom(watch)).toEqual([]);
    // 자동 처리자가 멈췄다면 재개 줄만 남지만 역시 견주지 않는다
    const automatic = collectChanges(rows.map(row => row.action === "job-pause" ? { ...row, actor: "system:deploy", actorKind: "system" } : row), WATCH_CONTEXT);
    expect(automatic.map(change => [change.title, change.restore])).toEqual([["사유 번역 재개", true], ["공개 번역 재개", true], ["발행 재개", true]]);
  });

  it("잰 구간이 접수 중단·그 단계 잡의 멈춤과 겹치면 겹친 칸을 빼고 시간당으로, 절반 넘게 겹치면 판정하지 않는다", () => {
    const bucket = (minutes: number) => Math.floor(Date.parse(at(minutes)) / 300_000);
    // 사유 번역: 시간당 120건(5분에 10건). 지금 1시간(70~130분) 가운데 접수 중단 30분(80~110분) 동안 0건 → 그대로 세면 60건(나빠짐)
    const ledger = Array.from({ length: 12 * 9 }, (_, index) => {
      const minutes = -360 + index * 5;
      return { route: "reason-translate", bucket: bucket(minutes), settled: minutes >= 80 && minutes < 110 ? 0 : 10 };
    }).filter(row => row.settled);
    const rows = [audit(1, 0, "runtime-settings-save", "runtime_settings:routes", { changes: [{ path: "routes.timeouts.reason-translate", label: "사유 번역 호출 상한(ms)" }] }),
      audit(2, 80, "pipeline-control-capacity-mode", "model_capacity_control", { mode: "draining", beforeMode: "open" }, "jr-claude"),
      audit(3, 110, "pipeline-control-capacity-mode", "model_capacity_control", { mode: "open", beforeMode: "draining" }, "jr-claude")];
    const now = Date.parse(at(132));
    const waiting = new Map([["reason-translate", 900]]);
    const plain = buildChangeWatch(collectChanges(rows, WATCH_CONTEXT), ledger, now, { backlog: waiting });
    const fixed = buildChangeWatch(collectChanges(rows, WATCH_CONTEXT), ledger, now, { outages: collectOutages(rows, now), backlog: waiting });
    const key = (watch: typeof plain) => watch.rows.find(row => row.key === "1")!;
    expect([key(plain).verdict, key(plain).measure!.lastHour]).toEqual(["worse", 60]);
    expect(key(fixed).measure).toMatchObject({ firstHour: 120, lastHour: 60, lastRate: 120, excluded: { before: 0, first: 0, last: 30 } });
    expect(key(fixed).verdict).toBe("same");
    expect(key(fixed).notes).toEqual(["잰 구간에서 접수 중단·작업 멈춤 30분을 빼고 시간당으로 견줬습니다"]);
    // 지금 1시간의 절반 넘게(35분) 겹치면 판정 못 함 — 기준은 CHANGE_WATCH_RULES.minCoveredShare
    expect(CHANGE_WATCH_RULES.minCoveredShare).toBe(0.5);
    const longer = rows.map(row => row.id === 3 ? { ...row, at: at(115) } : row);
    const short = buildChangeWatch(collectChanges(longer, WATCH_CONTEXT), ledger, now, { outages: collectOutages(longer, now), backlog: waiting });
    expect(key(short)).toMatchObject({ verdict: "unknown", reason: "지금 1시간의 절반 넘게 접수 중단·작업 멈춤과 겹쳐 견줄 수 없습니다" });
    // 그 단계 잡의 멈춤도 같다 — 바꾸기 전 6시간에 걸린 멈춤(-120~-60분)을 뺀다. 다른 단계 잡의 멈춤은 빼지 않는다
    // (바꾼 뒤 같은 단계의 멈춤 → 재개는 앞의 변경을 「그 뒤 또 바꿈」으로 만든다 — 위 시험)
    const paused = [audit(4, -120, "job-pause", "reason-translate", { reason: "점검" }), audit(5, -60, "job-resume", "reason-translate", { reason: "점검" }), rows[0],
      audit(6, 80, "job-pause", "product-translate", { reason: "점검" })].map((row, index) => ({ ...row, id: index + 1 }));
    const outages = collectOutages(paused, now);
    expect(outages.map(outage => [outage.kind, outage.routes, outage.ids])).toEqual([["pause", ["reason-translate"], [1, 2]], ["pause", ["product-translate"], [4]]]);
    const byJob = buildChangeWatch(collectChanges(paused, WATCH_CONTEXT), ledger, now, { outages, backlog: waiting });
    expect(byJob.rows.find(row => row.key === "3")!.measure!.excluded).toEqual({ before: 60, first: 0, last: 0 });
  });

  it("접수 열림 줄의 이전 상태가 중단이면 그 앞은 모르는 중단 — 짝 없는 멈춤은 자기 멈춤을 자기 잰 구간에서 빼지 않는다", () => {
    const now = Date.parse(at(200));
    const outages = collectOutages([audit(1, 30, "pipeline-control-capacity-mode", "model_capacity_control", { mode: "open", beforeMode: "draining" }),
      audit(2, 60, "pipeline-control-capacity-mode", "model_capacity_control", { mode: "open", beforeMode: "open" }),
      audit(3, 90, "job-pause", "product-intro-check", { reason: "점검" }, "system:capacity")], now);
    expect(outages.map(outage => [outage.kind, outage.from, outage.to])).toEqual([["drain", -Infinity, Date.parse(at(30))], ["pause", Date.parse(at(90)), now]]);
  });

  it("줄었다는 판정은 그 단계에 대기가 있을 때만 — 대기 0건은 일감 없음, 셀 수 없거나 못 읽으면 판정 못 함", () => {
    const fell = measure({ firstHour: 86, lastHour: 3 });
    expect(judgeChange(fell, { waiting: 857 }).verdict).toBe("fell_back");
    expect(judgeChange(fell, { waiting: 0 })).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("일감 없음") });
    expect(judgeChange(fell, { waiting: null })).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("대기를 셀 수 없어") });
    // 좋아짐·그대로는 대기와 상관없다
    expect(judgeChange(measure({ firstHour: 40, lastHour: 40 }), { waiting: 0 }).verdict).toBe("better");
    // 워커 진행 단계 → 장부 route(작업의 잡) — 발행분 감사처럼 진행 단계가 없는 작업은 셀 수 없음
    const backlog = backlogFromProgress(WATCH_BACKLOG);
    expect([backlog.get("crawl-agent-review"), backlog.get("product-search-verify"), backlog.get("product-audit")]).toEqual([857, 36882, undefined]);
    // 대기를 못 읽은 지켜보기는 할 일이 「셀 수 없음」이 되게 표시한다
    const unread = buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW, { outages: collectOutages(WATCH_AUDIT, WATCH_NOW), backlog: null });
    expect([unread.waitingUnread, unread.rows.find(row => row.key === "28853")!.verdict, changeWatchTasksFrom(unread)]).toEqual([true, "unknown", []]);
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
