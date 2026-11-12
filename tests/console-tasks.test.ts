import { describe, expect, it } from "vitest";
import type { Conveyor, Station } from "@/lib/operations/conveyor-model";
import {
  buildConsoleTasks, CONSOLE_TASK_LIMITS, formatDays, formatDuration, formatShare, josa,
  type ConsoleConnection, type ConsoleTaskBoard, type ConsoleTaskInputs,
} from "@/lib/operations/console-tasks";
import { buildConsoleFlow, buildConsoleStrip } from "@/lib/operations/console-home-model";
import { consoleFixtureInputs } from "./fixtures/console-home";

const NOW = "2026-11-12T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function station(key: Station["key"], patch: Partial<Station> = {}): Station {
  return { key, phase: "review", label: key, what: "", waiting: 0, oldestMinutes: null, done5m: 0, doneHour: 0, done24h: 0, unit: "건",
    spark: null, tone: "flow", status: "흐름", reason: null, holds: [], facts: [], links: [], llm: null, ...patch };
}
function conveyor(patch: Partial<Pick<Conveyor, "stations" | "human" | "holdsByReason">> = {}): Pick<Conveyor, "stations" | "human" | "holdsByReason"> {
  return { stations: [], human: human(10), holdsByReason: [], ...patch };
}
const human = (waiting: number): NonNullable<Conveyor["human"]> => ({ waiting, direct: waiting, agreed: 0, awaitingSecond: 0, awaitingAi: 0,
  decided24h: 3, oldestDays: 4, in24h: 10, tone: "flow", status: "처리 중", reason: null, llm: null });
function connection(id: string, patch: Partial<ConsoleConnection> = {}): ConsoleConnection {
  return { id, label: id, kind: "api", cliTool: null, deviceId: id, capacitySlots: 2, enabled: true, models: [`${id}-model`], allowedTasks: [],
    keySetAt: null, keyValidDays: null, updatedAt: at(DAY), ...patch };
}
/** 모든 읽기가 성공했고 아무 일도 없는 입력 */
function quiet(patch: Partial<ConsoleTaskInputs> = {}): ConsoleTaskInputs {
  return { now: NOW, conveyor: conveyor({ human: human(10) }), progress: { stages: [] }, jobs: [], admission: { mode: "open", since: at(HOUR) },
    takedown: { count: 0, overdue: 0 }, agreed: { approve: 0, reject: 0 }, audit: { open: 0, overdue: 0, oldestWaitDays: null },
    connections: [], ranks: [], pools: [], devices: [], ledger: [], ...patch };
}
const titles = (board: ConsoleTaskBoard, group?: string) => board.groups.filter(row => !group || row.key === group).flatMap(row => row.tasks.map(task => task.title));
const unknowns = (board: ConsoleTaskBoard) => board.groups.flatMap(row => row.unknown);

describe("console tasks — fixture (2026-11-12 08:59 KST)", () => {
  const board = buildConsoleTasks(consoleFixtureInputs());
  const all = board.groups.flatMap(group => group.tasks);

  it("gives the design's ten home tasks in the four groups, in order", () => {
    // 시안 홈 목록(build.py)의 10건. 순위 중복 할 일은 시안 「할 일이 생기는 조건」 표의 「지금」에만 있고 홈 목록에는 빠져 있었다 — 아래 따로 본다
    const design = all.filter(task => task.id !== "tidy:duplicate-ranks");
    expect(design.map(task => [task.group, task.title, task.fact])).toEqual([
      ["stop", "AI 1차가 거의 멈췄습니다", "대기 857건 · 가장 오래된 것 8시간 2분 · 최근 1시간 3건"],
      ["stop", "소개 검수가 8일째 멈춰 있습니다", "대기 2,143건 · 사람이 멈춤"],
      ["odd", "규칙 심사 보류가 갑자기 늘었습니다", "규칙으로 못 가름 · 24시간 +323건 · 누적 325건"],
      ["pile", "공개 번역이 쌓입니다", "대기 187,380건 · 하루 1,958건 처리 · 지금 속도로 96일"],
      ["pile", "사유 번역이 쌓입니다", "대기 78,863건 · 하루 2,619건 처리 · 지금 속도로 30일"],
      ["pile", "키워드 검수가 쌓입니다", "대기 36,882건 · 하루 6,451건 처리 · 지금 속도로 5.7일"],
      ["pile", "사람 확인이 줄지 않습니다", "대기 4,467건 · 가장 오래된 것 15일 · 24시간 동안 사람이 끝낸 것 0건"],
      ["pile", "감사 거절이 쌓여 있습니다", "열린 거절 563건 · 7일 넘은 것 553건 · 가장 오래된 것 27일"],
      ["tidy", "LG EXAONE이 자주 거절합니다", "24시간 135건 중 57건을 거절함(42%)"],
      ["tidy", "M1max를 아직 안 씁니다", "11-12 07:07 저장 · 호출 0건 · 쓰는 단계 없음"],
    ]);
    expect(["stop", "odd", "pile", "tidy"].map(group => design.filter(task => task.group === group).length)).toEqual([2, 1, 5, 2]);
    expect(unknowns(board)).toEqual([]);
  });

  it("also reports the duplicated ranks the design's rule table lists for the same moment", () => {
    const duplicate = all.find(task => task.id === "tidy:duplicate-ranks");
    expect(duplicate?.fact).toBe("수집 소개 짓기(1·3순위) · 제품 다국어 번역(1·2순위)");
    expect(board.total).toBe(11);
  });

  it("explains with read values only", () => {
    const why = Object.fromEntries(all.map(task => [task.id, task.why]));
    expect(why["stop:stage:first"]).toBe("워커가 틱마다 후보 2건을 「이미 처리 중」으로 건너뛰고 끝납니다. gpu3090-qwen은 5칸이 모두 비어 있습니다.");
    expect(why["odd:hold:ambiguous"]).toBe("어제까지는 거의 없던 보류입니다. 어제 들어간 변경과 나란히 볼 것.");
    expect(why["pile:stage:product-translate"]).toBe("남는 모델: gpu3090-qwen(1%) · M1max(0%)");
    expect(why["pile:stage:keyword-verify"]).toBe("쓰는 모델이 supa-direct 하나입니다. 남는 모델: gpu3090-qwen(1%) · M1max(0%)");
    expect(why["pile:human"]).toBe("두 모델이 모두 승인한 27건은 표본만 보고 한 번에 끝낼 수 있습니다.");
  });

  it("marks notification, tone and the existing screens each button opens", () => {
    const first = all.find(task => task.id === "stop:stage:first")!;
    // 「단계 열기」는 단계 패널(조각 2a) — 주소로도 열린다
    expect(first).toMatchObject({ tone: "bad", notify: true, actions: [{ kind: "link", label: "단계 열기", href: "/admin/flow?stage=first" }] });
    expect(all.find(task => task.id === "stop:job:product-intro-check")!.actions).toEqual([
      { kind: "job-resume", label: "재개", job: "product-intro-check", fallbackHref: "/admin/status?tab=jobs&job=product-intro-check" },
      { kind: "keep", label: "사유 남기고 유지", taskId: "stop:job:product-intro-check" },
      { kind: "link", label: "작업 보기", href: "/admin/status?tab=jobs&job=product-intro-check" }]);
    expect(all.find(task => task.id === "odd:hold:ambiguous")).toMatchObject({ tone: "warn", notify: true });
    expect(all.find(task => task.id === "pile:stage:product-translate")).toMatchObject({ tone: "warn", notify: false,
      actions: [{ label: "모델 붙이기", href: "/admin/flow?stage=product-translate#sp-models" }] });
    // 키워드 검수(워커 진행 단계)는 키워드 등록 패널을 연다
    expect(all.find(task => task.id === "pile:stage:keyword-verify")!.actions[0]).toMatchObject({ href: "/admin/flow?stage=keywords#sp-models" });
    // 「1인 운영 콘솔 시안」의 두 단추 — 묶어서 결정(묶음 화면) · 문턱 보기(같은 화면의 문턱 칸)
    expect(all.find(task => task.id === "pile:human")!.actions).toMatchObject([{ label: "묶어서 결정", href: "/admin/review/batches" },
      { label: "문턱 보기", href: "/admin/review/batches#threshold" }]);
    expect(all.find(task => task.id === "tidy:no-result:conn-lg-exaone")).toMatchObject({ tone: "off", notify: false,
      actions: [{ label: "쉬게 하기", href: "/admin/models?model=conn-lg-exaone#model-detail" },
        { kind: "keep", label: "그대로 두기", taskId: "tidy:no-result:conn-lg-exaone" }] });
    expect(board.marks).toEqual({ stopped: ["first"], piling: ["reason-translate", "keyword-verify", "product-translate"] });
    // 정리: 쓰는 단계 없는 모델은 모델 추가 ③(쓸 단계)·상세로, 순위에 같은 모델이 두 번이면 그 단계 패널의 모델 구역으로(운영 콘솔 통합)
    expect(all.find(task => task.id === "tidy:unused:conn-m1max")!.actions).toEqual([
      { kind: "link", label: "단계에 붙이기", href: "/admin/models/new?id=conn-m1max&step=3" },
      { kind: "link", label: "모델 상세", href: "/admin/models?model=conn-m1max#model-detail" }]);
    expect(all.find(task => task.id === "tidy:duplicate-ranks")!.actions[0]).toMatchObject({ label: "순위 고치기", href: expect.stringMatching(/^\/admin\/flow\?stage=[a-z-]+#sp-models$/) });
    expect(all.find(task => task.id === "pile:audit")!.actions[0]).toMatchObject({ label: "거절 목록 보기", href: "/admin/audit?tab=audit" });
  });

  it("draws the strip and the flow table from the same reads", () => {
    const inputs = consoleFixtureInputs();
    expect(buildConsoleStrip({ conveyor: inputs.conveyor as Conveyor, admission: inputs.admission, progress: inputs.progress }).map(item => `${item.label} ${item.value}`))
      .toEqual(["접수 열림 · 08:26부터", "발행 6/시간", "24시간 발행 1,374", "공개 78,919", "워커 6/6 정상"]);
    const flow = buildConsoleFlow(inputs.conveyor as Conveyor, inputs.progress, board);
    expect(flow.main.map(row => [row.label, row.status, row.waiting, row.rate && `${row.rate.value}/${row.rate.per}`])).toEqual([
      ["탐색", "흐름", null, "541/시간"], ["원본 수집", "흐름", 0, "20/5분"], ["규칙 심사", "흐름", 0, "544/시간"],
      ["AI 1차", "거의 멈춤", 857, "3/시간"], ["AI 2차", "갈림 보류 늘어남", 0, "1/시간"], ["프로필 준비", "흐름", 133, "0/시간"],
      ["발행", "일감 없음", 0, "6/시간"], ["키워드 등록", "흐름", 36885, "136/시간"], ["사람 확인", "쌓임", 4467, "0/24시간"], ["공개", "게시 중", null, "6/시간"]]);
    expect(flow.main.find(row => row.key === "first")).toMatchObject({ tone: "bad" });
    expect(flow.main.find(row => row.key === "first")!.spark).toHaveLength(23);
    expect(flow.post.map(row => [row.label, row.tone, row.status, row.waiting])).toEqual([
      ["한국어 소개", "off", "일감 없음", 0], ["공개 번역", "warn", "쌓임", 187380], ["사유 번역", "warn", "쌓임", 78863], ["소개 검수", "bad", "멈춤", 2143]]);
  });
});

describe("console tasks — 한국어 소개 쌓임은 표본 비교로 먼저 보는 길을 함께", () => {
  it("adds 「표본 비교」 next to 「모델 붙이기」 only for a task the sample comparison runs (3a), with the first idle model", () => {
    const inputs = consoleFixtureInputs();
    // 한국어 소개 대기를 늘려(24시간 1,188건 처리 → 3일 넘게) 쌓임으로 올린다
    const progress = { ...inputs.progress!, stages: inputs.progress!.stages.map(stage => stage.stage === "tagline-ko" ? { ...stage, reason: "ok", waiting: 50_000 } : stage) };
    const board = buildConsoleTasks({ ...inputs, progress });
    const tagline = board.groups.flatMap(group => group.tasks).find(task => task.id === "pile:stage:tagline-ko")!;
    expect(tagline.actions).toEqual([
      { kind: "link", label: "모델 붙이기", href: "/admin/flow?stage=tagline-ko#sp-models" },
      { kind: "link", label: "표본 비교", href: "/admin/models/compare?task=product-tagline-ko&candidate=conn-gpu3090-qwen" }]);
    // 공개 번역(표본 비교 지원 안 함)은 「모델 붙이기」 하나
    expect(board.groups.flatMap(group => group.tasks).find(task => task.id === "pile:stage:product-translate")!.actions).toHaveLength(1);
  });
});

describe("console tasks — rules and their limits", () => {
  it("keeps the limits in one place", () => {
    expect(CONSOLE_TASK_LIMITS).toMatchObject({ stalledRatio: 0.1, pausedJobMs: DAY, admissionPausedMs: 30 * MIN, holdSurge: 50, holdNewShare: 0.5,
      backlogDays: 3, humanWaiting: 500, auditOverdueDays: 7, rejectedPerDay: 10, rejectedShare: 0.1, keyExpiryDays: 7, idleUtilization: 0.05 });
    expect(Object.isFrozen(CONSOLE_TASK_LIMITS)).toBe(true);
  });

  it("has nothing to do when every read is quiet", () => {
    const board = buildConsoleTasks(quiet());
    expect(board.total).toBe(0);
    expect(unknowns(board)).toEqual([]);
  });

  it("stop: a queue stage whose hour is below a tenth of its waiting", () => {
    const at10 = buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("first", { label: "AI 1차", waiting: 100, doneHour: 10 })] }) }));
    expect(titles(at10, "stop")).toEqual([]);
    const at9 = buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("first", { label: "AI 1차", waiting: 100, doneHour: 9, oldestMinutes: 30 })] }) }));
    expect(at9.groups[0].tasks.map(task => [task.title, task.fact])).toEqual([["AI 1차가 거의 멈췄습니다", "대기 100건 · 가장 오래된 것 30분 · 최근 1시간 9건"]]);
    expect(titles(buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("first", { label: "AI 1차", waiting: 1, doneHour: 0 })] }) }))))
      .toEqual(["AI 1차가 멈췄습니다"]);
    // 1시간 수가 없는 칸은 5분 처리를 12배로 본다
    expect(buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("fetch", { label: "원본 수집", waiting: 600, doneHour: null, done5m: 4 })] }) })).groups[0].tasks[0].fact)
      .toBe("대기 600건 · 최근 5분 4건");
    expect(titles(buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("fetch", { label: "원본 수집", waiting: 600, doneHour: null, done5m: 5 })] }) })))).toEqual([]);
    // 프로필 준비의 대기는 보류·재분류 수, 키워드 등록은 쌓임 규칙이 본다
    expect(titles(buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("profile", { waiting: 133, doneHour: 0 }), station("keywords", { waiting: 9000, doneHour: 1 })] }) })))).toEqual([]);
    // 사람이 멈춘 작업의 칸은 멈춘 작업 규칙이 맡는다
    expect(titles(buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("first", { waiting: 100, doneHour: 0 })] }),
      progress: { stages: [{ stage: "first", job: "crawl-agent-review", reason: "paused" }] } })))).toEqual([]);
    const unknown = buildConsoleTasks(quiet({ conveyor: conveyor({ stations: [station("fetch", { label: "원본 수집", waiting: 5, doneHour: null, done5m: null })] }) }));
    expect(unknowns(unknown)).toEqual(["원본 수집 처리 수"]);
  });

  it("stop: a job a person paused more than a day ago, and what the job still has waiting", () => {
    const job = (lastRunAt: string | null) => quiet({ jobs: [{ name: "product-intro-check", paused: true, lastRunAt }],
      progress: { stages: [{ stage: "intro-check", job: "product-intro-check", reason: "paused", waiting: 12 }] } });
    expect(titles(buildConsoleTasks(job(at(DAY))))).toEqual([]);
    expect(buildConsoleTasks(job(at(DAY + 1))).groups[0].tasks.map(task => [task.title, task.fact])).toEqual([["소개 검수가 1일째 멈춰 있습니다", "대기 12건 · 사람이 멈춤"]]);
    expect(titles(buildConsoleTasks(job(null)))).toEqual(["소개 검수가 멈춰 있습니다"]);
    expect(titles(buildConsoleTasks(quiet({ jobs: [{ name: "product-intro-check", paused: false, lastRunAt: at(9 * DAY) }] })))).toEqual([]);
    // 진행 단계가 아닌 작업은 AI 작업 이름, 그것도 없으면 잡 이름
    expect(titles(buildConsoleTasks(quiet({ jobs: [{ name: "audit-qwen", paused: true, lastRunAt: at(3 * DAY) }, { name: "x-unknown", paused: true, lastRunAt: at(2 * DAY) }] }))))
      .toEqual(["발행분 감사 · 직접 모델이 3일째 멈춰 있습니다", "x-unknown이 2일째 멈춰 있습니다"]);
  });

  it("stop: model admission drained for more than thirty minutes — opening it stays a person's decision", () => {
    expect(titles(buildConsoleTasks(quiet({ admission: { mode: "draining", since: at(30 * MIN) } })))).toEqual([]);
    const board = buildConsoleTasks(quiet({ admission: { mode: "draining", since: at(30 * MIN + 1000) } }));
    expect(board.groups[0].tasks[0]).toMatchObject({ title: "접수가 30분째 멈춰 있습니다", fact: "모델 접수 중단 · 11-12 08:29부터",
      actions: [{ kind: "link", label: "접수 열기", href: "/admin/models/dashboard#admission" }] });
    expect(titles(buildConsoleTasks(quiet({ admission: { mode: "open", since: at(9 * HOUR) } })))).toEqual([]);
    expect(unknowns(buildConsoleTasks(quiet({ admission: null })))).toEqual(["접수 상태"]);
  });

  describe("stop: while admission is drained, model stages fold into one line (console 4b)", () => {
    // 시안 흐름 6 — 중단 중에 「1시간 처리 1/10」로 뜬 모델 단계 멈춤은 「접수 중단 때문」 한 줄로 접힌다. 규칙 심사(모델 없음)는 그대로 둔다
    const stalled = (admission: ConsoleTaskInputs["admission"]) => quiet({ admission,
      conveyor: conveyor({ stations: [station("first", { label: "AI 1차", waiting: 857, doneHour: 3 }), station("second", { label: "AI 2차", waiting: 40, doneHour: 0 }),
        station("judge", { label: "규칙 심사", waiting: 100, doneHour: 1 })] }),
      progress: { stages: [{ stage: "first", job: "crawl-agent-review", reason: "running", waiting: 857 }] } });

    it("keeps every stalled stage as its own line while admission is open", () => {
      const board = buildConsoleTasks(stalled({ mode: "open", since: at(HOUR) }));
      expect(titles(board, "stop")).toEqual(["AI 1차가 거의 멈췄습니다", "AI 2차가 멈췄습니다", "규칙 심사가 거의 멈췄습니다"]);
    });

    it("folds the model stages under thirty minutes into one silent line that opens admission", () => {
      const board = buildConsoleTasks(stalled({ mode: "draining", since: at(18 * MIN) }));
      const stop = board.groups[0].tasks;
      expect(stop.map(task => task.title)).toEqual(["규칙 심사가 거의 멈췄습니다", "모델 단계 2개가 접수 중단 때문에 멈춰 있습니다"]);
      expect(stop[1]).toMatchObject({ id: "stop:admission", rule: "admission-paused", notify: false, tone: "bad",
        fact: "AI 1차 · AI 2차 · 접수 중단 11-12 08:42부터 · 18분",
        why: "접수를 다시 열면 풀립니다. 중단이 30분을 넘으면 알림을 보냅니다.",
        actions: [{ kind: "link", label: "접수 열기", href: "/admin/models/dashboard#admission" }, { kind: "link", label: "단계 열기", href: "/admin/flow?stage=first" }] });
      // 흐름 표는 그대로 「멈춤」을 그린다 — 접는 것은 할 일뿐이다
      expect(board.marks.stopped).toEqual(["first", "second", "judge"]);
      expect(board.total).toBe(2);
    });

    it("names the single folded stage", () => {
      const board = buildConsoleTasks(quiet({ admission: { mode: "draining", since: at(5 * MIN) },
        conveyor: conveyor({ stations: [station("first", { label: "AI 1차", waiting: 10, doneHour: 0 })] }) }));
      expect(titles(board)).toEqual(["AI 1차가 접수 중단 때문에 멈춰 있습니다"]);
    });

    it("past thirty minutes, the admission task carries the folded stages and notifies", () => {
      const board = buildConsoleTasks(stalled({ mode: "draining", since: at(45 * MIN) }));
      expect(titles(board, "stop")).toEqual(["규칙 심사가 거의 멈췄습니다", "접수가 45분째 멈춰 있습니다"]);
      expect(board.groups[0].tasks[1]).toMatchObject({ id: "stop:admission", notify: true,
        why: "접수 중단 때문에 모델 단계 2개가 멈춰 있습니다: AI 1차 · AI 2차." });
    });

    it("still folds when the drain time is unknown, and says it cannot count it", () => {
      const board = buildConsoleTasks(stalled({ mode: "draining", since: null }));
      expect(titles(board, "stop")).toEqual(["규칙 심사가 거의 멈췄습니다", "모델 단계 2개가 접수 중단 때문에 멈춰 있습니다"]);
      expect(board.groups[0].tasks[1]).toMatchObject({ notify: false, fact: "AI 1차 · AI 2차 · 접수 중단" });
      expect(unknowns(board)).toEqual(["접수 중단 시각"]);
    });

    it("does not fold when admission cannot be read", () => {
      const board = buildConsoleTasks(stalled(null));
      expect(titles(board, "stop")).toEqual(["AI 1차가 거의 멈췄습니다", "AI 2차가 멈췄습니다", "규칙 심사가 거의 멈췄습니다"]);
    });
  });

  it("stop: takedown requests past their 24 hours", () => {
    expect(titles(buildConsoleTasks(quiet({ takedown: { count: 3, overdue: 0 } })))).toEqual([]);
    expect(buildConsoleTasks(quiet({ takedown: { count: 3, overdue: 1 } })).groups[0].tasks[0])
      .toMatchObject({ title: "내림 요청이 24시간을 넘겼습니다", fact: "요청 3건 · 24시간 넘은 것 1건" });
    expect(unknowns(buildConsoleTasks(quiet({ takedown: null })))).toEqual(["내림 요청"]);
  });

  it("odd: one hold reason grew by more than fifty in a day and at least half of it is new", () => {
    const hold = (count: number, recent: number) => quiet({ conveyor: conveyor({ stations: [station("judge", { label: "규칙 심사" })],
      holdsByReason: [{ reason: "ambiguous", label: "규칙으로 못 가름", count, recent24h: recent, href: null, station: "judge" }] }) });
    expect(titles(buildConsoleTasks(hold(60, 50)))).toEqual([]);
    expect(titles(buildConsoleTasks(hold(102, 51)))).toEqual(["규칙 심사 보류가 갑자기 늘었습니다"]);
    expect(titles(buildConsoleTasks(hold(103, 51)))).toEqual([]);
    const board = buildConsoleTasks(hold(102, 51));
    expect(board.groups[1].tasks[0].why).toBe("누적의 절반 넘게 최근 24시간에 생겼습니다. 어제 들어간 변경과 나란히 볼 것.");
    expect(board.groups[1].tasks[0].actions[0]).toMatchObject({ href: "/admin/review?tab=all&stage=judge" });
  });

  it("odd: a change followed by less throughput — judged once by the change watch, listed here as it comes", () => {
    // 판정은 change-watch.ts judgeChange 가 한다 — 엔진은 그 결과(changeWatchTasks)를 다시 판정하지 않고 그대로 올린다
    const watched = { key: "change-watch:28853", verdict: "fell_back" as const, title: "1차 AI 검수 처리가 바꾼 뒤 다시 줄었습니다",
      fact: "1차 AI 검수 1순위를 supa로 · 07:10 · 시간당 17건 → 첫 1시간 86건 → 지금 3건", why: "바꾼 직후에는 늘었다가 지금은 바꾸기 전과 비슷하거나 낮습니다",
      actions: [{ label: "되돌리러 가기", href: "/admin/models/tasks" }, { label: "기록 보기", href: "/admin/activity?target=first-review%231" }], notify: true };
    expect(titles(buildConsoleTasks(quiet()))).toEqual([]);
    expect(titles(buildConsoleTasks(quiet({ changeWatch: [] })))).toEqual([]);
    expect(buildConsoleTasks(quiet({ changeWatch: [watched] })).groups[1].tasks[0]).toMatchObject({
      id: "odd:change-watch:28853", rule: "change-drop", tone: "warn", notify: true, title: watched.title, fact: watched.fact, why: watched.why,
      actions: [{ kind: "link", label: "되돌리러 가기", href: "/admin/models/tasks" }, { kind: "link", label: "기록 보기", href: "/admin/activity?target=first-review%231" }] });
    // 못 읽었으면 0건이 아니라 「셀 수 없음」
    expect(unknowns(buildConsoleTasks(quiet({ changeWatch: null })))).toEqual(["바꾼 뒤 처리량"]);
    expect(unknowns(buildConsoleTasks(quiet()))).toEqual([]);
  });

  it("keeps a paused job or a refusing model off the list for a week after a person keeps it with a reason", () => {
    const paused = (controlVersion?: number) => ({ jobs: [{ name: "product-intro-check", paused: true, lastRunAt: at(8 * DAY), ...(controlVersion !== undefined ? { controlVersion } : {}) }],
      progress: { stages: [{ stage: "intro-check", job: "product-intro-check", reason: "paused", waiting: 12 }] } });
    const keep = { taskId: "stop:job:product-intro-check", at: at(HOUR), until: new Date(Date.parse(NOW) + 6 * DAY).toISOString(), actor: "JR", reason: "소개 검수는 이번 주 끈다", ref: "41" };
    expect(CONSOLE_TASK_LIMITS.keepMs).toBe(7 * DAY);
    const kept = buildConsoleTasks(quiet({ ...paused(41), kept: [keep] }));
    expect(titles(kept)).toEqual([]);
    expect(kept.kept.map(row => [row.task.title, row.keep.reason])).toEqual([["소개 검수가 8일째 멈춰 있습니다", "소개 검수는 이번 주 끈다"]]);
    // 기간이 지났거나, 그 사이 재개했다가 다시 멈춰 판이 바뀌었으면 다시 올라온다
    expect(titles(buildConsoleTasks(quiet({ ...paused(41), kept: [{ ...keep, until: at(1) }] })))).toEqual(["소개 검수가 8일째 멈춰 있습니다"]);
    expect(titles(buildConsoleTasks(quiet({ ...paused(52), kept: [keep] })))).toEqual(["소개 검수가 8일째 멈춰 있습니다"]);
    // 받는 규칙만 — 다른 할 일 열쇠의 표시는 무시한다
    const stalled = quiet({ conveyor: conveyor({ stations: [station("first", { label: "AI 1차", waiting: 100, doneHour: 0 })] }),
      kept: [{ ...keep, taskId: "stop:stage:first" }] });
    expect(titles(buildConsoleTasks(stalled))).toEqual(["AI 1차가 멈췄습니다"]);
    // 표시를 못 읽으면 모두 보인다
    const unread = buildConsoleTasks(quiet({ ...paused(41), kept: null }));
    expect([titles(unread), unread.keptUnknown]).toEqual([["소개 검수가 8일째 멈춰 있습니다"], true]);
    // 자주 거절하는 모델의 「그대로 두기」
    const refusing = quiet({ connections: [connection("exa")], ranks: [{ task: "reason-translate", slot: 1, rank: 1, connectionId: "exa", model: "exa-model", enabled: true }],
      ledger: [{ routeId: "reason-translate", groupId: "exa", model: "exa-model", calls: 40, settled: 30, avgSeconds: 2, rejected: 12, notStarted: 0 }],
      kept: [{ taskId: "tidy:no-result:exa", at: at(HOUR), until: new Date(Date.parse(NOW) + DAY).toISOString(), actor: "JR", reason: "약관상 번역에만 씀" }] });
    expect(titles(buildConsoleTasks(refusing), "tidy")).toEqual([]);
  });

  it("pile: stages that need more than three days at the last 24 hours' pace, longest first", () => {
    const stages = (waiting: Record<string, number>, settled: Record<string, number>) => quiet({
      progress: { stages: Object.entries(waiting).map(([stage, value]) => ({ stage, job: stage === "keyword-verify" ? "product-search-verify" : stage, reason: "progressing", waiting: value })) },
      ledger: Object.entries(settled).map(([routeId, value]) => ({ routeId, groupId: "g", model: "m", calls: value, settled: value, avgSeconds: 1, rejected: 0, notStarted: 0 })),
    });
    expect(titles(buildConsoleTasks(stages({ "reason-translate": 300 }, { "reason-translate": 100 })))).toEqual([]);
    expect(buildConsoleTasks(stages({ "reason-translate": 301 }, { "reason-translate": 100 })).groups[2].tasks[0].fact).toBe("대기 301건 · 하루 100건 처리 · 지금 속도로 3.0일");
    const order = buildConsoleTasks(stages({ "reason-translate": 400, "keyword-verify": 5000, "product-translate": 90 }, { "reason-translate": 100, "product-search-verify": 100 }));
    expect(titles(order, "pile")).toEqual(["공개 번역이 쌓입니다", "키워드 검수가 쌓입니다", "사유 번역이 쌓입니다"]);
    expect(order.groups[2].tasks[0].fact).toBe("대기 90건 · 24시간 처리 0건 · 지금 속도로는 줄지 않음");
    expect(unknowns(buildConsoleTasks(quiet({ ledger: null })))).toContain("지금 속도(24시간 장부)");
  });

  it("pile: more than 500 waiting for a person, or audit rejects older than seven days", () => {
    expect(titles(buildConsoleTasks(quiet({ conveyor: conveyor({ human: human(500) }) })))).toEqual([]);
    expect(buildConsoleTasks(quiet({ conveyor: conveyor({ human: human(501) }), agreed: { approve: 2, reject: 1 } })).groups[2].tasks[0]).toMatchObject({
      title: "사람 확인이 줄지 않습니다", why: "두 모델이 같은 결론을 낸 3건(승인 2 · 거절 1)은 표본만 보고 한 번에 끝낼 수 있습니다." });
    expect(titles(buildConsoleTasks(quiet({ audit: { open: 9, overdue: 0, oldestWaitDays: 6 } })))).toEqual([]);
    expect(titles(buildConsoleTasks(quiet({ audit: { open: 9, overdue: 1, oldestWaitDays: 8 } })))).toEqual(["감사 거절이 쌓여 있습니다"]);
  });

  it("tidy: models refusing ten calls a day and at least a tenth of their calls — calls ended before sending are not refusals", () => {
    const calls = (rejected: number, notStarted = 0, total = 40) => quiet({ connections: [connection("exa")],
      ranks: [{ task: "reason-translate", slot: 1, rank: 1, connectionId: "exa", model: "exa-model", enabled: true }],
      ledger: [{ routeId: "reason-translate", groupId: "exa", model: "exa-model", calls: total, settled: total - rejected, avgSeconds: 2, rejected, notStarted }] });
    expect(titles(buildConsoleTasks(calls(9)), "tidy")).toEqual([]);
    expect(buildConsoleTasks(calls(10)).groups[3].tasks.map(task => [task.title, task.fact, task.why])).toEqual([["exa가 자주 거절합니다", "24시간 40건 중 10건을 거절함(25%)", null]]);
    // 거절 10건이어도 호출의 10%에 못 미치면 올리지 않는다(101건 중 10건)
    expect(titles(buildConsoleTasks(calls(10, 0, 101)), "tidy")).toEqual([]);
    expect(titles(buildConsoleTasks(calls(10, 0, 100)), "tidy")).toEqual(["exa가 자주 거절합니다"]);
    // 보내기 전에 끝난 것(gateway_not_started — 틱 기한·사전 예산)은 거절이 아니다 — 11-12 실측 gpu3090-qwen 244건이 이것이었다
    expect(titles(buildConsoleTasks(calls(0, 244, 3000)), "tidy")).toEqual([]);
    expect(buildConsoleTasks(calls(12, 30)).groups[3].tasks[0].why).toBe("그 밖에 보내기 전에 끝난 30건은 모델의 거절이 아니라 세지 않았습니다.");
  });

  it("tidy: 11-12 실측 — LG EXAONE 58/135 거절은 올리고, gpu3090-qwen 의 보내기 전에 끝난 244건은 올리지 않는다", () => {
    const inputs = consoleFixtureInputs();
    const ledger = inputs.ledger!.map(row => row.groupId === "Exaone" ? { ...row, rejected: 58 }
      : row.groupId === "gpu3090-qwen" && row.routeId === "crawl-agent-review" ? { ...row, calls: 3000, settled: 2756, rejected: 0, notStarted: 244 } : row);
    const board = buildConsoleTasks({ ...inputs, ledger });
    expect(board.groups[3].tasks.filter(task => task.rule === "no-result").map(task => [task.title, task.fact]))
      .toEqual([["LG EXAONE이 자주 거절합니다", "24시간 135건 중 58건을 거절함(43%)"]]);
    // 보내기 전에 끝난 호출이 많아도 남는 모델에서 빼지 않는다
    expect(board.groups[2].tasks.find(task => task.id === "pile:stage:product-translate")!.why).toContain("gpu3090-qwen");
  });

  it("tidy: models no stage uses (pool members count) and the same model twice in one ranking", () => {
    const board = buildConsoleTasks(quiet({ connections: [connection("idle"), connection("pooled")], pools: [{ task: "publish-classify", slot: 1, connectionId: "pooled", model: "pooled-model" }],
      ranks: [{ task: "crawl-tagline", slot: 1, rank: 1, connectionId: "pooled", model: "pooled-model", enabled: true },
        { task: "crawl-tagline", slot: 1, rank: 2, connectionId: "pooled", model: "pooled-model", enabled: true }] }));
    expect(titles(board, "tidy")).toEqual(["idle을 아직 안 씁니다", "순위에 같은 모델이 두 번 들어 있습니다"]);
    expect(board.groups[3].tasks[1].fact).toBe("수집 소개 짓기(1·2순위)");
    expect(unknowns(buildConsoleTasks(quiet({ connections: [connection("idle")], pools: null })))).toEqual(["모델을 쓰는 단계"]);
  });

  it("tidy: a key within seven days of its end", () => {
    const key = (setAgo: number) => quiet({ connections: [connection("exa", { keySetAt: at(setAgo), keyValidDays: 30 })],
      ranks: [{ task: "reason-translate", slot: 1, rank: 1, connectionId: "exa", model: "exa-model", enabled: true }] });
    expect(titles(buildConsoleTasks(key(23 * DAY - 1)))).toEqual([]);
    expect(titles(buildConsoleTasks(key(23 * DAY)))).toEqual(["exa 키가 7일 뒤 만료됩니다"]);
    expect(titles(buildConsoleTasks(key(31 * DAY)))).toEqual(["exa 키가 만료됐습니다"]);
  });

  it("offers idle models under five percent use that the stage accepts", () => {
    const idle = (seconds: number) => quiet({
      progress: { stages: [{ stage: "reason-translate", job: "reason-translate", reason: "progressing", waiting: 1000 }] },
      connections: [connection("busy"), connection("spare", { capacitySlots: 1 }), connection("cli", { kind: "cli", cliTool: "claude", models: ["sonnet"] })],
      ranks: [{ task: "reason-translate", slot: 1, rank: 1, connectionId: "busy", model: "busy-model", enabled: true },
        { task: "second-review", slot: 1, rank: 1, connectionId: "spare", model: "spare-model", enabled: true },
        { task: "second-review", slot: 1, rank: 2, connectionId: "cli", model: "sonnet", enabled: true }],
      ledger: [{ routeId: "reason-translate", groupId: "busy", model: "busy-model", calls: 100, settled: 100, avgSeconds: 1000, rejected: 0, notStarted: 0 },
        { routeId: "second-review", groupId: "spare", model: "spare-model", calls: 10, settled: 10, avgSeconds: seconds / 10, rejected: 0, notStarted: 0 }],
    });
    // 86,400초 × 한도 1 의 5% = 4,320초 — 미만이면 남는다. CLI(claude)는 사유 번역이 받지 않는다
    expect(buildConsoleTasks(idle(4319)).groups[2].tasks[0].why).toBe("쓰는 모델이 busy 하나입니다. 남는 모델: spare(5%)");
    expect(buildConsoleTasks(idle(4320)).groups[2].tasks[0].why).toBe("쓰는 모델이 busy 하나입니다.");
  });

  it("still lists every other task when one read fails", () => {
    const inputs = consoleFixtureInputs();
    const board = buildConsoleTasks({ ...inputs, connections: null, audit: null, progress: null });
    expect(titles(board, "stop")).toEqual(["AI 1차가 거의 멈췄습니다", "소개 검수가 8일째 멈춰 있습니다"]);
    expect(titles(board, "pile")).toEqual(["사람 확인이 줄지 않습니다"]);
    expect(unknowns(board)).toEqual(["단계 대기", "감사 거절", "모델 목록"]);
  });
});

describe("console words", () => {
  it("picks the particle from how the name ends", () => {
    expect([josa("gpu3090-qwen", "은/는"), josa("supa", "은/는"), josa("LG EXAONE", "이/가"), josa("M1max", "을/를"), josa("AI 1차", "이/가"),
      josa("공개 번역", "이/가"), josa("키워드 검수", "이/가"), josa("LLM", "이/가"), josa("GPT", "이/가"), josa("모델 3", "이/가")])
      .toEqual(["gpu3090-qwen은", "supa는", "LG EXAONE이", "M1max를", "AI 1차가", "공개 번역이", "키워드 검수가", "LLM이", "GPT가", "모델 3이"]);
  });
  it("cuts durations, days and shares like the design", () => {
    expect([formatDuration(0.5), formatDuration(59), formatDuration(482.1139), formatDuration(120), formatDuration(4320), formatDuration(15_000)])
      .toEqual(["1분 미만", "59분", "8시간 2분", "2시간", "3.0일", "10일"]);
    expect([formatDays(95.7), formatDays(30.1), formatDays(5.717)]).toEqual(["96일", "30일", "5.7일"]);
    expect([formatShare(0.0122, 5), formatShare(0.004, 5), formatShare(0, 0), formatShare(0.38, 9)]).toEqual(["1%", "1% 미만", "0%", "38%"]);
  });
});
