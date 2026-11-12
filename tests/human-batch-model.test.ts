import { describe, expect, it } from "vitest";
import { MAX_BULK_DECISIONS } from "@/app/(operator)/admin/review/contract";
import { DELEGATE_CONFIDENCE_THRESHOLD_TEXT } from "@/lib/crawl/delegate-groups";
import { agreedSplit, HUMAN_BATCH_MAX, humanBatchConfirmLines, humanBatchGateView, humanBatchMembers, humanBatchResultLine, humanBatchStrip,
  humanBatchUndo, humanHoldRows, humanWhyRows, pickSample, type HumanBatchGateLike } from "@/lib/crawl/human-batch-model";
import { PEOPLE_BATCHES_HREF } from "@/app/(operator)/admin/workspace-navigation";
import { HUMAN_BATCHES_HREF } from "@/lib/crawl/human-batch-model";

/** 2026-11-12 실측(조각 3b 지시) — 보류 사유별 수와 24시간 증가 */
const HOLDS = [
  { reason: "ai_review_exhausted", count: 1, recent24h: 0 }, { reason: "ambiguous", count: 325, recent24h: 323 },
  { reason: "no_description", count: 133, recent24h: 2 }, { reason: "repo_deleted", count: 30, recent24h: 7 },
  { reason: "review_approval_changed", count: 8, recent24h: 8 }, { reason: "second_review_split", count: 4283, recent24h: 101 },
  { reason: "source_refresh_failed", count: 7, recent24h: 0 }, { reason: "suspected_spam", count: 5, recent24h: 0 },
];

describe("묶음 모델", () => {
  it("보류 묶음은 많은 순이고, 사유마다 기존 동작으로만 잇는다", () => {
    const rows = humanHoldRows(HOLDS, { seen: 1183, rejected: 4 });
    expect(rows.map(row => [row.label, row.count, row.action.kind, row.action.label])).toEqual([
      ["2차 심사가 갈림", 4283, "auto", "AI 재확인이 처리 중"],
      ["규칙으로 못 가름", 325, "link", "하나씩 보기"],
      ["소개 문구 없음", 133, "link", "소개 넣기"],
      ["저장소가 없어짐", 30, "batch", "한 번에 거절"],
      // 다시 심사로 보내는 기존 동작이 없다 — 단추를 만들지 않고 하나씩 보기
      ["승인 근거가 바뀜", 8, "link", "하나씩 보기"],
      // 일괄 「다시 받기」가 없다 — 상세의 추가 수집 요청으로
      ["원본을 다시 못 받음", 7, "link", "하나씩 보기"],
      ["스팸 의심", 5, "link", "하나씩 보기"],
      ["1차 재시도 소진", 1, "link", "하나씩 보기"],
    ]);
    expect(rows[0].action).toMatchObject({ detail: "24시간 1,183건 다시 봄 · 거절 4건", href: "#threshold" });
    expect(rows[3].action).toEqual({ kind: "batch", label: "한 번에 거절", key: "repo_deleted" });
    // 하나씩 보기는 심사 큐의 가벼운 사유 거르기(?reason=)로 연다
    expect(rows[1].action).toMatchObject({ href: "/admin/review?tab=all&state=needs_review&reason=ambiguous#review-list" });
    expect(rows[5].action).toMatchObject({ note: "상세의 추가 수집 요청" });
    // 모르는 사유는 운영 흐름의 이름표, 그것도 없으면 코드 그대로. 0건은 그리지 않는다
    expect(humanHoldRows([{ reason: "source_changed", count: 2, recent24h: 0 }, { reason: "zzz", count: 1, recent24h: 0 },
      { reason: "ambiguous", count: 0, recent24h: 0 }], null).map(row => row.label)).toEqual(["발행 URL 바뀜", "zzz"]);
    expect(humanHoldRows([{ reason: "second_review_split", count: 1, recent24h: 0 }], null)[0].action).toMatchObject({ detail: null });
  });

  it("사람에게 남은 까닭은 0건 갈래를 빼고, 확신 부족은 문턱 보기·미검토는 대기 수로 잇는다", () => {
    const rows = humanWhyRows({ abstained: 313, low_confidence: 2897, human_only: 30, legacy: 0, unreviewed: 1103, admin: 122 }, 602);
    expect(rows.map(row => [row.label, row.count, row.next.label, row.next.href])).toEqual([
      [`AI 확신이 문턱 ${DELEGATE_CONFIDENCE_THRESHOLD_TEXT} 아래`, 2897, "문턱 보기", "#threshold"],
      ["아직 AI가 안 봄", 1103, "AI가 보는 중 · 대기 602건", null],
      ["AI가 판단을 포기", 313, "하나씩 보기", "/admin/review?tab=human&delegate=abstained"],
      ["관리자가 보류해 둠", 122, "하나씩 보기", "/admin/review?tab=human&delegate=admin"],
      ["사람만 볼 것", 30, "하나씩 보기", "/admin/review?tab=human&delegate=human_only"],
    ]);
    expect(humanWhyRows({ abstained: 0, low_confidence: 0, human_only: 0, legacy: 0, unreviewed: 1, admin: 0 }, null)[0].next.label).toBe("AI가 보는 중");
  });

  it("머리줄은 직접 판단·2주 넘음·24시간 들어옴·사람이 끝냄·AI가 대신 끝냄이고, 못 읽은 칸은 비운다", () => {
    const overview = { stages: { ai: 0, second: 0, agreed: 27, human: 4440 }, wait: { oldestDays: 15, stalled: 79, in24h: 101 }, decided24h: { approve: 0, reject: 0 } };
    expect(humanBatchStrip({ overview, assistDay: { approve: 199, reject: 18 } }).map(item => [item.label, item.value])).toEqual([
      ["직접 판단", 4440], ["2주 넘음", 79], ["24시간 들어옴", 101], ["사람이 끝냄", 0], ["AI가 대신 끝냄", 217]]);
    expect(humanBatchStrip({ overview: { ...overview, wait: null, decided24h: null }, assistDay: null }).map(item => item.value)).toEqual([4440, null, null, null, null]);
  });

  it("확정 구간을 두 모델 승인·거절로 가르고, 겹치면 거절 쪽에 둔다", () => {
    const overview = { ids: { ai: [], second: [], human: [9], agreed: [1, 2, 3, 4] },
      secondIds: { unanimous_approve: [1, 4], agreed_approve: [2, 99], unanimous_reject: [3], agreed_reject: [4], needs_human: [9] } };
    expect(agreedSplit(overview)).toEqual({ approve: [1, 2], reject: [3, 4] });
    expect(humanBatchMembers(overview, [7, 8])).toEqual({ agreed_approve: [1, 2], agreed_reject: [3, 4], repo_deleted: [7, 8] });
  });

  it("표본은 겹치지 않게 무작위로 뽑고, 묶음이 작으면 전부다", () => {
    let seed = 7;
    const random = (max: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
    const sample = pickSample([10, 11, 12, 13, 14, 15, 16, 17], 5, random);
    expect(sample).toHaveLength(5);
    expect(new Set(sample).size).toBe(5);
    for (const id of sample) expect([10, 11, 12, 13, 14, 15, 16, 17]).toContain(id);
    expect(pickSample([3, 3, 4], 5, () => 0).sort()).toEqual([3, 4]);
    expect(pickSample([], 5, () => 0)).toEqual([]);
  });

  it("한 번에 결정하는 상한은 심사 큐 일괄 상한과 같고, 메뉴 주소는 한 곳에서 온다", () => {
    expect(HUMAN_BATCH_MAX).toBe(MAX_BULK_DECISIONS);
    expect(HUMAN_BATCHES_HREF).toBe(PEOPLE_BATCHES_HREF);
  });
});

describe("표본 관문", () => {
  const members = [1, 2, 3, 4, 5, 6, 7].map(id => ({ id }));
  const gate = (verdicts: Record<string, "ok" | "wrong">, over: Partial<HumanBatchGateLike> = {}): HumanBatchGateLike =>
    ({ members, sampleIds: [1, 2, 3, 4, 5], verdicts, excluded: [], executedAt: null, ...over });
  const allOk = { 1: "ok", 2: "ok", 3: "ok", 4: "ok", 5: "ok" } as const;
  const current = [1, 2, 3, 4, 5, 6, 7];

  it("표본 5건이 모두 「맞음」일 때만 켜진다", () => {
    const four = humanBatchGateView(gate({ 1: "ok", 2: "ok", 3: "ok", 4: "ok" }), current);
    expect(four).toMatchObject({ open: false, judged: 4, ok: 4, pendingIds: [5] });
    const five = humanBatchGateView(gate(allOk), current);
    expect(five).toMatchObject({ open: true, judged: 5, ok: 5, pendingIds: [], wrongIds: [], targets: [1, 2, 3, 4, 5, 6, 7], added: 0, gone: 0 });
  });

  it("하나라도 「아님」이면 꺼지고 그 건은 따로 보이며 대상에서 빠진다", () => {
    const view = humanBatchGateView(gate({ ...allOk, 3: "wrong" }), current);
    expect(view).toMatchObject({ open: false, wrongIds: [3], ok: 4, judged: 5 });
    expect(view.targets).not.toContain(3);
  });

  it("스냅숏이 바뀌면 새로 들어온 건은 일괄 대상에서 빼고, 이미 처리된 건도 뺀다", () => {
    const view = humanBatchGateView(gate(allOk), [2, 3, 4, 5, 6, 7, 40, 41]);
    expect(view.open).toBe(true);
    expect(view.targets).toEqual([2, 3, 4, 5, 6, 7]);
    expect(view.targets).not.toContain(40);
    expect(view).toMatchObject({ added: 2, gone: 1 });
    // 앞선 표본에서 「아님」으로 뺀 것은 다시 들어와도 새 건으로 세지 않고 대상도 아니다
    const carried = humanBatchGateView(gate(allOk, { excluded: [7] }), current);
    expect(carried.targets).toEqual([1, 2, 3, 4, 5, 6]);
    expect(carried.added).toBe(0);
  });

  it("실행한 줄·지금 묶음을 못 읽은 때·대상이 없을 때는 켜지 않는다", () => {
    expect(humanBatchGateView(gate(allOk, { executedAt: new Date() }), current)).toMatchObject({ open: false, executed: true });
    expect(humanBatchGateView(gate(allOk), null)).toMatchObject({ open: false, unknownCurrent: true });
    expect(humanBatchGateView(gate(allOk), [])).toMatchObject({ open: false, targets: [] });
    // 묶음이 표본보다 작으면 그 전부가 표본이다 — 3/3 이면 켜진다
    expect(humanBatchGateView({ members: [{ id: 1 }, { id: 2 }, { id: 3 }], sampleIds: [1, 2, 3], verdicts: { 1: "ok", 2: "ok", 3: "ok" },
      excluded: [], executedAt: null }, [1, 2, 3]).open).toBe(true);
  });

  it("저장 전 확인은 몇 건·다음 단계·되돌리는 방법을 적는다", () => {
    const view = humanBatchGateView(gate(allOk), [2, 3, 4, 5, 6, 7, 40]);
    const lines = humanBatchConfirmLines("agreed_approve", view);
    expect(lines[0]).toBe("승인 6건 — 표본 5건 중 5건 맞음");
    expect(lines[1]).toMatch(/^다음 단계 · 승인 → 발행 워커가/);
    expect(lines[2]).toMatch(/^되돌리기 · 「일괄 결정 기록」에서 묶음째 되돌립니다/);
    expect(lines).toContain("표본을 뽑은 뒤 들어온 1건은 이번에 넣지 않습니다(다음 표본에서)");
    expect(humanBatchConfirmLines("repo_deleted", view)[1]).toMatch(/GitHub 에 저장소를 한 건씩 다시 묻고, 정말 없는\(404\) 것만 거절/);
  });

  it("결과 한 줄과 작업 로그의 되돌리는 곳", () => {
    expect(humanBatchResultLine({ decision: "approve", decided: [{ id: 1, repo: "a/b", attemptId: 9 }], failures: [], skipped: [] })).toBe("승인 1건");
    expect(humanBatchResultLine({ decision: "reject", decided: [], failures: [{ id: 1, repo: "a/b", message: "x" }],
      skipped: [{ id: 2, repo: "c/d", why: "y" }] })).toBe("거절 0건 · 실패 1건 · 남김 1건");
    expect(humanBatchUndo("human-batch-run", "batch:12")).toEqual({ text: expect.stringContaining("12번 묶음"), href: "/admin/review/batches#batch-log" });
    expect(humanBatchUndo("human-batch-sample", "batch:12")).toBeNull();
    expect(humanBatchUndo("human-batch-run", "acme/app")).toBeNull();
  });
});
