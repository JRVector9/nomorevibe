import { describe, expect, it } from "vitest";
import { backlogFromProgress, buildChangeWatch, changeWatchTasksFrom, collectChanges, collectOutages, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { consoleFixtureInputs } from "./fixtures/console-home";
import sample from "./fixtures/change-watch-prod-ledger.json";
import { PROD_CONTEXT, PROD_LEDGER, PROD_NOW, PROD_PROGRESS, PROD_TASKS_BEFORE, prodAudit } from "./fixtures/change-watch-prod";

/**
 * 2026-11-12 배포 직후 운영 실측(바꾼 것 지켜보기 판정 31줄 · 할 일 12건)으로 잘못된 경고가 사라졌는지 본다.
 * 고치기 전에는 배포 창의 잡 재개·같은 단계의 옛 변경·일감 없는 단계가 모두 「줄었다」로 올라왔다(PROD_TASKS_BEFORE).
 */
const watch = (audit = prodAudit()): ChangeWatchSnapshot => {
  const changes = collectChanges(audit, PROD_CONTEXT).filter(change => Date.parse(change.until ?? change.at) > PROD_NOW - 24 * 3_600_000);
  return buildChangeWatch(changes, PROD_LEDGER, PROD_NOW, { outages: collectOutages(audit, PROD_NOW), backlog: backlogFromProgress(PROD_PROGRESS) });
};
const line = (snapshot: ChangeWatchSnapshot, id: number) => snapshot.rows.find(row => row.ids.includes(id))!;

describe("바꾼 것 지켜보기 — 11-12 운영 실측의 잘못된 경고", () => {
  it("장부는 실측 줄의 수를 그대로 다시 낸다(배포 창 밖의 변경)", () => {
    expect(sample.now).toBe("2026-11-12T05:57:00Z");
    const snapshot = watch();
    expect(line(snapshot, 28853).measure).toMatchObject({ beforeHours: [28, 41, 8, 3, 11, 1], early: 81, firstHour: 86, lastHour: 267, sinceChange: 1905 });
    expect(line(snapshot, 28010).measure).toMatchObject({ beforeHours: [0, 0, 0, 0, 0, 74], early: 21, firstHour: 86, lastHour: 0, sinceChange: 226 });
    expect(line(snapshot, 27972).title).toBe("한도 저장 · 키워드 검수 최소 남은 시간(ms) 외 1");
  });

  it("고치기 전 12건 → 고친 뒤 0건 — 홈 「평소와 다름」은 보류 급증 1건만 남는다", () => {
    expect(PROD_TASKS_BEFORE).toHaveLength(12);
    const tasks = changeWatchTasksFrom(watch());
    expect(tasks).toEqual([]);
    const home = (changeWatch: Parameters<typeof buildConsoleTasks>[0]["changeWatch"]) =>
      buildConsoleTasks({ ...consoleFixtureInputs(), changeWatch }).groups.find(group => group.key === "odd")!.tasks.map(task => task.rule);
    expect(home(PROD_TASKS_BEFORE.map(task => ({ ...task, verdict: task.verdict as "worse", fact: "", actions: [], notify: true })))).toHaveLength(13);
    expect(home(tasks)).toEqual(["hold-surge"]);
  });

  it("배포 창의 멈춤 → 재개는 한 줄로 합쳐 견주지 않는다(재개 10건의 할 일이 사라진 까닭)", () => {
    const snapshot = watch();
    for (const id of [30402, 30399, 30397, 28308, 28304, 28035, 28032, 28031, 27961, 27960]) {
      const row = line(snapshot, id);
      expect(row.title).toMatch(/ 멈춤 → 재개 \(1[34]분\)$/);
      expect(row).toMatchObject({ verdict: "unknown", measure: null, undo: null });
      expect(row.reason).toContain("원상 복구");
    }
    // 배포 창 5번의 잡 24개는 24줄(재개 줄이 따로 뜨지 않는다), 접수 중단 → 다시 열림 6줄
    expect(snapshot.rows.filter(row => / 멈춤 → 재개 /.test(row.title))).toHaveLength(24);
    expect(snapshot.rows.filter(row => / 재개$/.test(row.title))).toEqual([]);
    expect(snapshot.rows.filter(row => row.kind === "capacity").map(row => row.title).sort())
      .toEqual([...Array(5).fill("접수 중단 → 다시 열림 (14분)"), "접수 중단 → 다시 열림 (18분)"]);
  });

  it("같은 단계의 옛 변경은 그 뒤 또 바꿈 — 키워드 검수 한도 저장(11-11 15:37)은 그 뒤 배포 창의 멈춤 → 재개에 덮인다", () => {
    expect(line(watch(), 27972)).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("1시간 45분 뒤 · 키워드 검수 멈춤 → 재개 (13분)") });
  });

  it("대기를 셀 수 없는 단계(발행분 감사)는 줄었다고 하지 않는다 — 재판정할 것이 없을 뿐일 수 있다", () => {
    expect(line(watch(), 28010)).toMatchObject({ verdict: "unknown", reason: expect.stringContaining("대기를 셀 수 없어") });
  });

  it("배포 창 밖의 실제 변경은 그대로 판정한다 — 1차 AI 검수 순위(좋아짐) · LG EXAONE(좋아짐) · M1max(아직 안 씀)", () => {
    const snapshot = watch();
    expect(line(snapshot, 28853)).toMatchObject({ title: "1차 AI 검수 1순위를 supa-direct로", verdict: "better" });
    expect(line(snapshot, 28853).notes).toEqual([expect.stringMatching(/^잰 구간에서 접수 중단·작업 멈춤 \d+분을 빼고 시간당으로 견줬습니다$/)]);
    expect(line(snapshot, 28847)).toMatchObject({ stage: "한국어 소개 번역", verdict: "better" });
    expect([28845, 28371, 28353].map(id => line(snapshot, id).verdict)).toEqual(["unused", "unused", "unused"]);
  });

  it("배포 창의 멈춤을 자동 처리자가 했어도(재개 줄만 사람) 같은 결과다", () => {
    const snapshot = watch(prodAudit({ actor: "system:deploy", actorKind: "system" }));
    expect(changeWatchTasksFrom(snapshot)).toEqual([]);
    expect(line(snapshot, 30402)).toMatchObject({ title: "키워드 검수 재개", verdict: "unknown", measure: null });
    expect(line(snapshot, 27972).reason).toContain("키워드 검수 재개");
  });
});
