import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";
vi.mock("@/app/(operator)/admin/actions", () => ({ decideCrawlCandidate: vi.fn() }));
vi.mock("@/app/(operator)/admin/review/actions", () => ({ approveWithTagline: vi.fn(), collectCandidateEvidence: vi.fn(), undoCandidateDecisions: vi.fn(), resolvePublishedSecondReview: vi.fn() }));
vi.mock("@/app/(operator)/admin/components/Toast", () => ({ useAdminToast: () => ({ show: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/review/BulkDecision", () => ({ BulkDecision: () => <div>기존 일괄 결정</div> }));
vi.mock("@/app/(operator)/admin/review/ReasonText", () => ({ ReasonText: ({ text }: { text: string }) => text }));
const { PrototypeReviewConsole } = await import("@/app/(operator)/admin/review/PrototypeReviewConsole");
const { PrototypeReviewPublished } = await import("@/app/(operator)/admin/review/PrototypeReviewPublished");
const { PrototypeReviewDetail } = await import("@/app/(operator)/admin/review/PrototypeReviewDetail");
const entry = {
  candidate: { id: 31, repo: "real/project", state: "needs_review", reason: "ambiguous", decidedBy: "auto", productUrl: "https://product.test", publishedSlug: null, signals: {}, judgedAt: new Date("2026-11-04T12:00:00Z"), updatedAt: new Date("2026-11-04T12:00:00Z") },
  name: "실제 조회 이름", description: "수집한 원문 소개", inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), candidateRevisionHash: "c".repeat(64),
  relationship: "unknown", scanState: "complete", evidence: [], status: "succeeded", refreshCount: 0, latest: null,
  review: { decision: "approve", confidence: .42, model: "actual-model", reason: "실행한 판단 근거", reasonKo: null },
  verdict: null, bucket: null, tagline: null, seconds: [], tiebreak: null,
} as unknown as AdminReviewEntry;
it("시안의 좌측 큐와 우측 선택 상세를 사용하고 조회한 후보만 표시한다", () => {
  const html = renderToStaticMarkup(<PrototypeReviewConsole now={Date.parse("2026-11-04T15:00:00Z")} entries={[entry]} reasons={[]} title="지금 사람이 확인할 후보" total={1} />);
  expect(html).toContain('class="grid detail"'); expect(html).toContain('class="panel pad sticky-detail"'); expect(html).toContain("후보·유입"); expect(html).toContain("대기 사유·시간"); expect(html).toContain("실제 조회 이름"); expect(html).not.toContain("Mintboard");
});
it("선택 후보가 없으면 다른 후보의 결정 폼으로 바꾸지 않는다", () => {
  const html = renderToStaticMarkup(<PrototypeReviewConsole now={Date.parse("2026-11-04T15:00:00Z")} entries={[entry]} focus={999} reasons={[]} title="검수" total={1} />);
  expect(html).toContain("선택한 후보가 목록에서 빠졌습니다"); expect(html).not.toContain("승인 → 발행 대기");
});
it("기록된 모델과 실제 확신을 표시하며 긴 근거는 닫힌 details에 둔다", () => {
  const html = renderToStaticMarkup(<PrototypeReviewDetail entry={entry} reasons={[]} />);
  expect(html).toContain("actual-model"); expect(html).toContain("0.42"); expect(html).toContain("원문·규칙·AI 근거·시도 이력"); expect(html).not.toContain('<details class="panel" open'); expect(html).toContain("승인 → 발행 대기"); expect(html).toContain("반려 사유");
});

it("공개 후 확인도 시안 선택 상세에서 기존 ID·slug·결정을 제출한다", () => {
  const html = renderToStaticMarkup(<PrototypeReviewPublished rows={[{ id: 9, slug: "real-project", repo: "real/project", decision: "reject", confidence: .81, reason: "원본 판단", reasonKo: null, trigger: "risk", signals: [] }]} />);
  expect(html).toContain('class="grid detail"'); expect(html).toContain('name="id" value="9"'); expect(html).toContain('name="slug" value="real-project"'); expect(html).toMatch(/<button(?=[^>]*name="decision")(?=[^>]*value="keep")[^>]*>/); expect(html).toContain("공개 중단");
});
