import { describe, expect, it, vi } from "vitest";
import type { ReviewSnapshot, ReviewSource } from "@/lib/crawl/agent-review-contract";

vi.mock("@/lib/crawl/first-reviewers", async (original) => ({
  ...await original<typeof import("@/lib/crawl/first-reviewers")>(),
  firstReviewers: () => [{ provider: "abcllm", model: "fixture-model" }],
}));

// SQL 글자만 만든다 — 연결하지 않는다(lib/db 는 첫 쿼리 때 연결한다)
vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@127.0.0.1:1/fixture");

const WAIT = "agent_repository_claims evidence_claim";
const settingsFor = async () => (await import("@/lib/crawl/settings")).mergeWithDefaults({ enabled: true, reviewMode: "enforce" });
const predicateText = async (options: Parameters<typeof import("@/lib/crawl/agent-review-repository")["reviewCandidatePredicate"]>[1]) => {
  const { reviewCandidatePredicate } = await import("@/lib/crawl/agent-review-repository");
  const { db } = await import("@/lib/db");
  const { crawlCandidates } = await import("@/lib/db/schema");
  return db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(reviewCandidatePredicate(await settingsFor(), options)).toSQL();
};

/**
 * 2026-11-14 실측: 1차 모델 호출의 26%가 AI 제작 근거 스캔이 아직 없을 때 먼저 심사한 뒤, 스캔이 complete 되며 원본 그대로 다시 심사한 것이었다.
 * 준비된 1차 대상(readyOnly)만 근거를 기다린다 — 쪽 커서·consumer hint·「일 있음」 판단이 같은 기준이라 고르지도, 건너뛰지도, 다시 요청하지도 않는다.
 */
describe("1차 대기열 — AI 제작 근거 스캔을 기다린다", () => {
  it("1차 잡의 쪽 쿼리는 스캔 대기열에 있고 근거가 자리 잡지 않은 후보를 6시간까지 뺀다", async () => {
    const { firstReviewPoolQuery } = await import("@/lib/crawl/agent-review-repository");
    const query = firstReviewPoolQuery(await settingsFor(), 20, null).toSQL();
    expect(query.sql).toContain(WAIT);
    expect(query.sql).toContain("evidence_claim.state = 'active'");
    // 상한: 원본을 본 시각(판정 시각·수집 시각 중 늦은 것)에서 6시간
    expect(query.sql).toMatch(/greatest\(coalesce\("crawl_candidates"\."judged_at", '-infinity'::timestamp\), fd\.fetched_at\)/);
    expect(query.params).toContain(21_600);
    // 자리 잡은 근거: complete(오류 없음·지금 탐지기·남은 범위 없음)·범위 제한으로 끝난 partial·failed
    expect(query.sql).toContain("fres.state = 'complete' AND fres.last_error_code IS NULL");
    expect(query.sql).toContain("fres.state = 'failed'");
    expect(query.sql).toContain("fres.state = 'partial' AND fres.last_error_code IS NULL");
  });

  it("AI1 consumer 의 hint 쪽과 「1차에 일 있음」(재판정 양보·잡 이어 돌기)도 같은 기준이다", async () => {
    const { firstReviewConsumerHintsQuery } = await import("@/lib/crawl/consumers/first");
    expect(firstReviewConsumerHintsQuery(await settingsFor(), null).toSQL().sql).toContain(WAIT);
    expect((await predicateText({ readyOnly: true })).sql).toContain(WAIT);
  });

  it("이미 모델 줄에 세운 후보 다시 보기·스캔 묵음 대상·사람 넘김 대상 판단은 기다리지 않는다(예전 그대로)", async () => {
    expect((await predicateText({ readyOnly: true, includeEvidenceWaiting: true })).sql).not.toContain(WAIT);
    expect((await predicateText({ staleScanOnly: true })).sql).not.toContain(WAIT);
    expect((await predicateText({})).sql).not.toContain(WAIT);
  });

  it("격리 replay 는 근거가 얼어 있어 기다리지 않는다 — 고정 권한 프로필에 스캔 대기열 표가 없다", async () => {
    const { withReviewReplayContext } = await import("@/lib/crawl/review-replay-context");
    const text = await withReviewReplayContext({ referenceTime: new Date("2026-11-14T00:00:00.000Z") }, () => predicateText({ readyOnly: true }));
    expect(text.sql).not.toContain(WAIT);
  });
});

const snapshot = (over: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  product: { repo: "maker/app", name: "App", description: "An app", pageText: "Run it", url: "https://app.example", topics: [], language: "TypeScript",
    accessMode: "website", repositoryUrl: "https://github.com/maker/app", readme: "# App", linksOwnGithub: true },
  repoFacts: { stars: 3, pushedAt: "2026-11-14T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z" },
  rules: { stoppedAt: null, detail: null, cause: null },
  policy: { rulesVersion: "r", promptVersion: "p", detectorVersion: "d", policyVersion: "v", enforceEligibility: false },
  evidence: [], evidenceSummary: { eligible: false, reason: "ai_evidence_pending" } as never,
  relationship: "same_product", scanState: "pending", evidenceTruncated: false, ...over,
});
const source = (over: Partial<ReviewSource> = {}): ReviewSource => ({ candidateJudgedAt: "2026-11-14T10:00:00.000Z", documentId: 1,
  documentFetchedAt: "2026-11-14T10:00:00.000Z", productUrl: "https://app.example", scanId: null, scanSha: null, scanStartedAt: null,
  scanCompletedAt: null, scanState: null, scanError: null, detectorVersion: "d", ...over });
const observation = (sha: string) => ({ kind: "commit_attribution", scope: "", sha, client: "claude-code" }) as never;
const evidence = (...shas: string[]) => shas.map((sha, index) => ({ id: `observation:${index + 100}`, observation: observation(sha) }));
const complete = (...shas: string[]) => ({ snapshot: snapshot({ scanState: "complete", evidence: evidence(...shas),
  evidenceSummary: { eligible: true, reason: null } as never }),
  source: source({ scanId: 9, scanState: "complete", scanCompletedAt: "2026-11-14T11:00:00.000Z", documentFetchedAt: "2026-11-14T11:30:00.000Z" }) });

/** 「근거만 늘었다」의 정의(PR 본문과 같다) — 이미 승인된 후보는 이때 다시 1차 심사하지 않고 그 승인을 잇는다 */
describe("근거만 늘었다 — evidenceOnlyGrew", () => {
  it("스캔이 없을 때(pending) 승인했고 스캔이 complete 되며 근거가 붙었다 — 원본 수집 시각·스캔 id 가 달라도 근거만 는 것이다", async () => {
    const { evidenceOnlyGrew } = await import("@/lib/crawl/first-review-evidence");
    expect(evidenceOnlyGrew({ snapshot: snapshot(), source: source() }, complete("a", "b"))).toBe(true);
    // 근거 0건으로 complete 된 것도 스캔 결과만 바뀐 것이다
    expect(evidenceOnlyGrew({ snapshot: snapshot(), source: source() }, complete())).toBe(true);
    // partial → complete, 앞 근거를 그대로 품고 늘었다(관측 id 는 달라도 내용이 같다)
    const partial = { snapshot: snapshot({ scanState: "partial", evidence: [{ id: "observation:7", observation: observation("a") }] }), source: source() };
    expect(evidenceOnlyGrew(partial, complete("a", "b"))).toBe(true);
  });

  it("원본(README·본문·메타·판정 시각·주소·규칙 멈춤·정책)이 바뀌었으면 아니다 — 다시 심사한다", async () => {
    const { evidenceOnlyGrew } = await import("@/lib/crawl/first-review-evidence");
    const after = complete("a");
    const before = (over: Partial<ReviewSnapshot>, src: Partial<ReviewSource> = {}) => ({ snapshot: snapshot(over), source: source(src) });
    expect(evidenceOnlyGrew(before({ product: { ...snapshot().product, readme: "# Old" } }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({ product: { ...snapshot().product, pageText: "Old page" } }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({ repoFacts: { ...snapshot().repoFacts, stars: 2 } }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({ rules: { stoppedAt: "x", detail: null, cause: null } }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({ relationship: "unknown" }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({ policy: { ...snapshot().policy, policyVersion: "old" } }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({ adminFirstReviewRerunId: "6a0f3f2e-3a3c-4c55-8f5b-0d8ef9a0a111" }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({}, { candidateJudgedAt: "2026-11-13T10:00:00.000Z" }), after)).toBe(false);
    expect(evidenceOnlyGrew(before({}, { productUrl: "https://old.example" }), after)).toBe(false);
  });

  it("근거가 줄거나 바뀌었거나, 스캔이 뒤로 갔거나 실패했거나, 아무것도 늘지 않았으면 아니다", async () => {
    const { evidenceOnlyGrew } = await import("@/lib/crawl/first-review-evidence");
    const had = (state: ReviewSnapshot["scanState"], ...shas: string[]) => ({ snapshot: snapshot({ scanState: state, evidence: evidence(...shas) }), source: source() });
    expect(evidenceOnlyGrew(had("complete", "a", "b"), complete("a"))).toBe(false);
    expect(evidenceOnlyGrew(had("partial", "a"), complete("b", "c"))).toBe(false);
    expect(evidenceOnlyGrew(had("complete", "a"), { ...complete("a", "b"), snapshot: { ...complete("a", "b").snapshot, scanState: "partial" } })).toBe(false);
    expect(evidenceOnlyGrew(had("pending"), { ...complete("a"), snapshot: { ...complete("a").snapshot, scanState: "failed" } })).toBe(false);
    expect(evidenceOnlyGrew(had("failed"), complete("a"))).toBe(false);
    expect(evidenceOnlyGrew(had("complete", "a"), complete("a"))).toBe(false);
  });
});

describe("근거 기다림 상한", () => {
  it("6시간 — 스캔 완료 지연 실측(6시간 안 98.4%)과 입력 유효기간(24시간) 안이다", async () => {
    const { FIRST_REVIEW_EVIDENCE_WAIT_MS } = await import("@/lib/crawl/first-review-evidence");
    expect(FIRST_REVIEW_EVIDENCE_WAIT_MS).toBe(6 * 3600_000);
    expect(FIRST_REVIEW_EVIDENCE_WAIT_MS).toBeLessThan(24 * 3600_000);
  });
});
