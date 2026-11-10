import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn(), cancelAdminModelOperation: vi.fn() }));
import { DELEGATE_CONFIDENCE_THRESHOLD_TEXT, DELEGATE_GROUP_GUIDE, DELEGATE_GROUPS, delegateGroupCounts, delegateGroupHref, delegateGroupOf, delegateOpinionText,
  groupDelegateFacts, type DelegateFacts, type DelegateOpinion } from "@/lib/crawl/delegate-groups";
import { DELEGATED_HOLD_CAUSES, type DelegatedModelOutcome } from "@/lib/crawl/delegated-hold";
import { DEEPSEEK_MIN_CONFIDENCE } from "@/lib/crawl/deepseek-review-policy";
import { prototypeReviewDelegateScope, prototypeReviewDelegateVisible, prototypeReviewFilter, prototypeReviewNeeds, prototypeReviewOptions } from "@/app/(operator)/admin/review/PrototypeReviewQuery";
import { PrototypeReviewDelegateNav } from "@/app/(operator)/admin/review/PrototypeReviewDelegate";
import { DelegateOpinionBox, DelegateOpinionTag } from "@/app/(operator)/admin/review/DelegateOpinion";
import { HumanDelegateCount } from "@/app/(operator)/admin/flow/HumanDelegateCounts";
import { PrototypeFlow } from "@/app/(operator)/admin/flow/PrototypeFlow";
import { buildConveyor } from "@/lib/operations/conveyor-model";
import { humanOverview } from "./fixtures/human-queue";

const outcome = (decision: DelegatedModelOutcome["decision"], confidence: number | null, holdCause: DelegatedModelOutcome["holdCause"]): DelegatedModelOutcome =>
  ({ decision, confidence, holdCause });
const auto = (attemptId: number | null, value: DelegatedModelOutcome | null) => ({ decidedBy: "auto", attemptId, outcome: value });

// 사람 몫 human 1·2 · 확정 3(fixtures/human-queue) + 다른 구간 4·5·6·7
const facts: DelegateFacts[] = [
  { id: 1, ...auto(11, outcome("needs_review", 0.4, "model_abstained")) },
  { id: 2, ...auto(12, outcome("approve", 0.8, "low_confidence")) },
  { id: 3, ...auto(13, null) },
  { id: 4, ...auto(14, outcome("needs_review", null, "model_abstained")) },
  { id: 5, ...auto(null, null) },
  { id: 6, decidedBy: "admin", attemptId: null, outcome: null },
  { id: 7, ...auto(17, outcome("approve", 0.97, "stale_evidence")) },
];
const groups = groupDelegateFacts(facts);

describe("AI 위임 결과 갈래(delegate-groups.ts)", () => {
  it("decides each held candidate's group in rule order — admin, no attempt, no recorded cause, then the hold cause", () => {
    expect(delegateGroupOf({ decidedBy: "admin", attemptId: 9, outcome: outcome("needs_review", 0.3, "model_abstained") })).toBe("admin");
    expect(delegateGroupOf({ decidedBy: null, attemptId: null, outcome: null })).toBe("admin");
    expect(delegateGroupOf(auto(null, null))).toBe("unreviewed");
    expect(delegateGroupOf(auto(9, null))).toBe("legacy");
    expect(delegateGroupOf(auto(9, outcome("needs_review", 0.95, "model_abstained")))).toBe("abstained");
    expect(delegateGroupOf(auto(9, outcome("reject", 0.6, "low_confidence")))).toBe("low_confidence");
    for (const cause of ["cannot_approve", "stale_evidence", "repo_changed", "repo_gone"] as const)
      expect(delegateGroupOf(auto(9, outcome("approve", 0.95, cause)))).toBe("human_only");
    // 결정이 적용된 뒤 되돌려진 시도(까닭 없음)도 사람만 승인 쪽 — AI 결정을 그대로 쓸 수 없다
    expect(delegateGroupOf(auto(9, outcome("approve", 0.95, null)))).toBe("human_only");
  });
  it("puts every candidate in exactly one group and counts inside the list's scope", () => {
    expect(groups.ids).toEqual({ abstained: [1, 4], low_confidence: [2], human_only: [7], legacy: [3], unreviewed: [5], admin: [6] });
    expect(DELEGATE_GROUPS.flatMap(group => groups.ids[group]).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(delegateGroupCounts(groups)).toEqual({ abstained: 2, low_confidence: 1, human_only: 1, legacy: 1, unreviewed: 1, admin: 1 });
    expect(delegateGroupCounts(groups, [1, 2, 3])).toEqual({ abstained: 1, low_confidence: 1, human_only: 0, legacy: 1, unreviewed: 0, admin: 0 });
  });
  it("words the delegate's opinion from the model's original answer, and admits when the cause was not recorded", () => {
    expect(delegateOpinionText({ model: outcome("approve", 0.8, "low_confidence"), applied: "needs_review" }))
      .toEqual({ leaning: "승인 의견", cause: `확신 부족 — 확신이 ${DELEGATE_CONFIDENCE_THRESHOLD_TEXT} 미만이라 적용하지 않음` });
    expect(delegateOpinionText({ model: outcome("needs_review", 0.5, "model_abstained"), applied: "needs_review" }))
      .toEqual({ leaning: "판단 보류", cause: "근거 부족 — AI가 스스로 판단을 보류" });
    expect(delegateOpinionText({ model: null, applied: "needs_review" })).toEqual({ leaning: "보류(원래 답 미기록)", cause: "까닭 미기록(0173 전 기록)" });
    expect(delegateOpinionText({ model: outcome("approve", 0.96, null), applied: "approve" }).cause).toBe("결정을 그대로 적용함");
    for (const cause of DELEGATED_HOLD_CAUSES) expect(delegateOpinionText({ model: outcome("approve", 0.5, cause), applied: "needs_review" }).cause).not.toBe("");
  });
  it("keeps the threshold printed on screen equal to the delegate's actual threshold", () => {
    expect(DELEGATE_CONFIDENCE_THRESHOLD_TEXT).toBe(String(DEEPSEEK_MIN_CONFIDENCE));
  });
});

describe("심사 목록의 ?delegate= 거르기", () => {
  const overview = humanOverview({ human: 2, agreed: 1 });
  it("parses only known groups and narrows the human tab to the group's ids", () => {
    expect(prototypeReviewFilter({ tab: "human", delegate: "abstained" }).delegate).toBe("abstained");
    expect(prototypeReviewFilter({ tab: "human", delegate: "bogus" }).delegate).toBe("");
    const filter = prototypeReviewFilter({ tab: "human", delegate: "abstained" });
    expect(prototypeReviewNeeds(filter)).toMatchObject({ overview: true, delegate: true });
    // 4 는 근거 부족이지만 사람 몫(1·2·3) 밖이다
    expect(prototypeReviewOptions(filter, null, overview, groups)).toMatchObject({ state: "needs_review", ids: [1] });
    expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "human", delegate: "legacy" }), null, overview, groups).ids).toEqual([3]);
    expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "human", stage: "agreed", delegate: "abstained" }), null, overview, groups).ids).toEqual([]);
  });
  it("never turns a missing group read into an unfiltered list", () => {
    expect(() => prototypeReviewOptions(prototypeReviewFilter({ tab: "human", delegate: "abstained" }), null, overview, null)).toThrow("review_delegate_unavailable");
  });
  it("is a held-only filter — it selects held candidates from the all tab and is ignored on rejected or publish lists", () => {
    const all = prototypeReviewFilter({ tab: "all", delegate: "abstained" });
    expect(prototypeReviewNeeds(all)).toMatchObject({ overview: false, delegate: true });
    expect(prototypeReviewOptions(all, null, null, groups)).toMatchObject({ state: "needs_review", ids: [1, 4] });
    const rejected = prototypeReviewFilter({ tab: "rejected", delegate: "abstained" });
    expect(prototypeReviewNeeds(rejected).delegate).toBe(false);
    expect(prototypeReviewOptions(rejected, null, null, null)).toMatchObject({ state: "rejected", ids: undefined });
    expect(prototypeReviewOptions(prototypeReviewFilter({ tab: "publish", delegate: "abstained" }), null, null, null).state).toBe("approved");
    expect(prototypeReviewDelegateVisible(rejected)).toBe(false);
    expect(prototypeReviewDelegateVisible(prototypeReviewFilter({ tab: "all" }))).toBe(false);
    expect(prototypeReviewDelegateVisible(prototypeReviewFilter({ tab: "human" }))).toBe(true);
    expect(prototypeReviewDelegateVisible(prototypeReviewFilter({ tab: "human", second: "published" }))).toBe(false);
  });
  it("counts chips over the same scope the list uses without the group, so a chip's count equals its list total", () => {
    const filter = prototypeReviewFilter({ tab: "human", delegate: "abstained" });
    const scope = prototypeReviewDelegateScope(filter, null, overview);
    expect(scope).toEqual([1, 2, 3]);
    const counts = delegateGroupCounts(groups, scope);
    for (const group of DELEGATE_GROUPS) {
      const list = prototypeReviewOptions(prototypeReviewFilter({ tab: "human", delegate: group }), null, overview, groups);
      expect(list.ids).toHaveLength(counts[group]);
    }
    expect(prototypeReviewDelegateScope(prototypeReviewFilter({ tab: "all", delegate: "abstained" }), null, null)).toBeUndefined();
  });
});

const hrefs = Object.fromEntries([["all", "/admin/review?tab=human"], ...DELEGATE_GROUPS.map(group => [group, `/admin/review?tab=human&delegate=${group}`])]) as
  Record<(typeof DELEGATE_GROUPS)[number] | "all", string>;
describe("화면", () => {
  it("renders the group chips with scoped counts and marks the open group", async () => {
    const html = renderToStaticMarkup(await PrototypeReviewDelegateNav({ load: async () => groups, scope: [1, 2, 3], active: "abstained", hrefs, narrowed: false }));
    expect(html).toContain('aria-label="AI 위임 결과"');
    expect(html).toMatch(/aria-current="page" data-delegate-group="abstained"[^>]*>근거 부족 · AI 판단 보류 1건</);
    expect(html).toContain('href="/admin/review?tab=human&amp;delegate=abstained"');
    expect(html).toMatch(/data-delegate-group="low_confidence"[^>]*>확신 부족 · AI 의견 있음 1건</);
    expect(html).toMatch(/data-delegate-group="admin"[^>]*>관리자 보류 · AI 대상 아님 0건</);
    expect(html).toContain(DELEGATE_GROUP_GUIDE.abstained.hint);
    const failed = renderToStaticMarkup(await PrototypeReviewDelegateNav({ load: async () => { throw new Error("db"); }, scope: undefined, active: "", hrefs, narrowed: true }));
    expect(failed).toContain("갈래별 수 미확인");
  });
  const opinion: DelegateOpinion = { model: outcome("approve", 0.82, "low_confidence"), applied: "needs_review", confidence: 0.82,
    reason: "제품 페이지는 있지만 설치 안내가 모호하다", reasonKo: null, modelName: "deepseek-v4", at: "2026-11-10T06:40:00.000Z", current: true };
  it("shows the delegate's leaning, confidence, hold cause and reason in the detail and a short tag in the list", () => {
    const html = renderToStaticMarkup(<DelegateOpinionBox opinion={opinion} />);
    expect(html).toContain("AI 위임 검수 · deepseek-v4 · 지금 원본 기준");
    expect(html).toContain('<span class="tag green">승인 의견</span>');
    expect(html).toContain("확신 0.82");
    expect(html).toContain("확신 부족 — 확신이 0.9 미만이라 적용하지 않음");
    expect(html).toContain("설치 안내가 모호하다");
    expect(renderToStaticMarkup(<DelegateOpinionTag opinion={opinion} />)).toContain("AI 위임 승인 의견 · 확신 0.82");
    const legacy = renderToStaticMarkup(<DelegateOpinionBox opinion={{ ...opinion, model: null, current: false, confidence: 0.5 }} />);
    expect(legacy).toContain("보류(원래 답 미기록)");
    expect(legacy).toContain("까닭 미기록(0173 전 기록)");
    expect(legacy).toContain("이전 원본·세대 기준");
    expect(renderToStaticMarkup(<DelegateOpinionTag opinion={{ ...opinion, current: false }} />)).toBe("");
    expect(renderToStaticMarkup(<DelegateOpinionTag opinion={null} />)).toBe("");
  });
  it("links the flow panel's 근거 부족·확신 부족 counts to their review lists and says 미확인 when unread", async () => {
    const summary = { counts: delegateGroupCounts(groups, [1, 2, 3]) };
    const abstained = renderToStaticMarkup(await HumanDelegateCount({ read: Promise.resolve(summary), group: "abstained" }));
    expect(abstained).toContain(`href="${delegateGroupHref("abstained").replace("&", "&amp;")}"`);
    expect(abstained).toContain('aria-label="근거 부족 · AI 판단 보류 1건 목록 보기"');
    expect(renderToStaticMarkup(await HumanDelegateCount({ read: Promise.resolve(null), group: "low_confidence" }))).toBe("미확인");

    const data = buildConveyor({ now: "2026-11-10T06:40:35.000Z", enabled: true, throughput: null, flow: null, hourly: null, human: humanOverview({ human: 2, agreed: 1 }),
      progress: null, search: null, holds: null, rejected: null, classification: null, sources: [] });
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={{ jobs: {}, csrf: null }} editor={null}
      humanAssist={{ "delegate-abstained": <>12건 →</>, "delegate-low_confidence": <>3건 →</>, "delegate-legacy": <>40건 →</>, "delegate-unreviewed": <>7건 →</> }} />);
    expect(html).toContain('<li><span>근거 부족 · AI 판단 보류<span class="flow-human-first">먼저</span></span><span>12건 →</span></li>');
    expect(html).toContain("<li><span>확신 부족 · AI 의견 있음</span><span>3건 →</span></li>");
    expect(html).toContain("<li><span>이전 기록 · 까닭 미기록</span><span>40건 →</span></li>");
    expect(html).toContain("<li><span>AI 미검토</span><span>7건 →</span></li>");
    const missing = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={{ jobs: {}, csrf: null }} editor={null} />);
    expect(missing).toContain('<li><span>근거 부족 · AI 판단 보류<span class="flow-human-first">먼저</span></span><span>—</span></li>');
  });
});
