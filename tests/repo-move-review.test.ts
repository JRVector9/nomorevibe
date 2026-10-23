import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";
import { buildRepoMoveInput, decideRepositoryMove, repositoryMoveCandidate, repoMoveCandidateSchema, repoMoveProtected,
  repoMoveSnapshotMatches, repoMoveSource, type RepoMoveCandidate, type RepoMoveOutcome, type RepoMoveSnapshot } from "@/lib/domain/products/repo-move-review";

const snapshot = (over: Partial<RepoMoveSnapshot> = {}): RepoMoveSnapshot => ({
  id: 7, slug: "tool", url: "https://tool.example", repoUrl: "https://github.com/old/tool", repoLinkVersion: 3,
  updatedAt: "2026-10-23 09:00:00.123456", name: "Tool", description: "Tool helps draw maps.", status: "seeded", source: "crawler",
  accessMode: "website", claimedAt: null, activeMaker: false, repoStatus: "not_found", repoCheckedAt: "2026-10-23 08:00:00.123456",
  repoMissingSince: "2026-10-20 08:00:00.123456", repoRenamedTo: null, review: null, ...over,
});
const page = repoMoveSource("product_page", "page", "https://tool.example", "Tool helps draw maps. Source: https://github.com/new/tool",
  "2026-10-23 09:01:00.123456", "complete", 200);
const readme = repoMoveSource("new_readme", "readme", "https://github.com/new/tool", "Tool helps draw maps. This is the original Tool repository.",
  "2026-10-23 09:02:00.123456", "complete", 200);
const candidate = (over: Partial<RepoMoveCandidate> = {}): RepoMoveCandidate => ({ kind: "repo_move", snapshot: snapshot(),
  oldRepository: { state: "moved", to: "new/tool" }, page, candidates: [{ url: "https://github.com/new/tool", check: { state: "alive" } }],
  uncheckedRepositoryUrls: [], ...over });
const outcome = (over: Partial<RepoMoveOutcome> = {}): RepoMoveOutcome => ({ schema_version: ASSIST_SCHEMA_VERSION, task: "repo",
  state: { project_identity: "matches", code_lineage: "original", official_continuity: "explicit_move", relationship: "same_project" },
  evidence_quality: { status: "sufficient", limitations: ["none"] }, evidence: [
    { source_id: "new_readme", quote: "Tool helps draw maps.", supports: ["/state/project_identity", "/state/code_lineage"] },
    { source_id: "old_repository", quote: "GitHub redirected https://github.com/old/tool to https://github.com/new/tool.", supports: ["/state/official_continuity"] },
  ], action: { proposal: "update_repo_candidate", reason_ko: "공식 이전을 확인했습니다.", missing_items: [] }, ...over });

describe("저장소 이전의 독립 근거와 서버 guard", () => {
  it("공식 redirect·제품 정체성·계보 근거를 모두 가진 단일 후보만 주소 후보가 된다", () => {
    const source = candidate();
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), outcome())).toMatchObject({ kind: "update_repo_candidate", url: "https://github.com/new/tool" });
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), outcome())).toHaveProperty("officialEvidenceHash", expect.stringMatching(/^[a-f0-9]{64}$/));
  });

  it("이름·동일 주인·살아 있는 사이트 링크를 공식 이전으로 승격하지 않는다", () => {
    const source = candidate({ oldRepository: { state: "gone" } });
    const result = outcome({ state: { project_identity: "matches", code_lineage: "original", official_continuity: "author_continuity", relationship: "same_project" },
      evidence: [outcome().evidence[0], { source_id: "product_page", quote: "https://github.com/new/tool", supports: ["/state/official_continuity"] }] });
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), result)).toEqual({ kind: "human", reason: "official_move_not_verified" });
  });

  it("비공식 fork는 같은 제품도 다른 제품도 확정하지 않는다", () => {
    const source = candidate({ oldRepository: { state: "gone" } });
    const state = { project_identity: "different", code_lineage: "fork_or_copy", official_continuity: "unverified", relationship: "unrelated" } as const;
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), outcome({ state, evidence: [outcome().evidence[0]],
      action: { proposal: "delist_candidate", reason_ko: "포크입니다.", missing_items: [] } }))).toEqual({ kind: "human", reason: "unverified_unrelated_repository" });
  });

  it("무관한 SDK·동명 제품은 새 저장소의 긍정적인 다른 제품 근거가 있어야 한다", () => {
    const source = candidate({ oldRepository: { state: "gone" } });
    const sdk = repoMoveSource("sdk", "readme", "https://github.com/new/tool", "Tool SDK collects error reports for the Acme monitoring platform.", "now", "complete", 200);
    const result = outcome({ state: { project_identity: "different", code_lineage: "independent", official_continuity: "unverified", relationship: "unrelated" },
      evidence: [{ source_id: "sdk", quote: "Tool SDK collects error reports", supports: ["/state/project_identity"] }],
      action: { proposal: "delist_candidate", reason_ko: "다른 제품의 SDK입니다.", missing_items: [] } });
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [sdk]), result)).toEqual({ kind: "unrelated_candidate" });
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [sdk]), { ...result, evidence: [{ source_id: "product_page", quote: "Tool helps draw maps.", supports: ["/state/project_identity"] }] }))
      .toEqual({ kind: "collect_evidence", reason: "missing_positive_repository_evidence" });
  });

  it.each([null, { ...page, completeness: "missing" as const, httpStatus: 0 }, { ...page, completeness: "blocked" as const, httpStatus: 403 }])(
    "페이지 수집 실패를 unrelated 내림 근거로 쓰지 않는다 (%s)", failedPage => {
      const source = candidate({ oldRepository: { state: "gone" }, page: failedPage });
      const result = outcome({ state: { project_identity: "different", code_lineage: "independent", official_continuity: "unverified", relationship: "unrelated" },
        evidence: [outcome().evidence[0]], action: { proposal: "delist_candidate", reason_ko: "다른 제품입니다.", missing_items: [] } });
      expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), result)).toEqual({ kind: "collect_evidence", reason: "product_page_unavailable" });
    });

  it("일부 링크만 확인하거나 복수 저장소를 가진 결과는 URL을 선택할 수 없다", () => {
    for (const source of [candidate({ uncheckedRepositoryUrls: ["https://github.com/old/unchecked"] }),
      candidate({ candidates: [...candidate().candidates, { url: "https://github.com/old/other", check: { state: "alive" } }] })]) {
      expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), outcome())).toEqual({ kind: "human", reason: "multiple_or_unchecked_repositories" });
    }
  });

  it("README 누락·막힘·잘림은 제품 정체성의 충분한 근거가 아니다", () => {
    const source = candidate();
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [{ ...readme, completeness: "truncated" }]), outcome())).toEqual({ kind: "collect_evidence", reason: "missing_positive_repository_evidence" });
  });

  it("실제 인용 없이 모델이 제안한 공식 이전은 기각한다", () => {
    const source = candidate();
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), outcome({ evidence: [] }))).toEqual({ kind: "human", reason: "missing_complete_evidence" });
    expect(decideRepositoryMove(source, buildRepoMoveInput(source, [readme]), outcome({ evidence: [{ source_id: "new_readme", quote: "invented", supports: ["/state/project_identity"] }] })))
      .toEqual({ kind: "human", reason: "invalid_evidence_quote" });
  });

  it("동일 입력의 옛 저장소 근거를 바꾸거나 다른 URL을 집어넣으면 기각한다", () => {
    const source = candidate();
    const input = buildRepoMoveInput(source, [readme]);
    expect(decideRepositoryMove(source, { ...input, context: { ...input.context, candidateRepositoryUrls: ["https://github.com/evil/tool"] } }, outcome()))
      .toEqual({ kind: "human", reason: "source_binding_mismatch" });
    const changed = { ...input, sources: input.sources.map(item => item.sourceId === "old_repository" ? { ...item, revision: "forged" } : item) };
    expect(decideRepositoryMove(source, changed, outcome())).toEqual({ kind: "human", reason: "source_binding_mismatch" });
  });
});

describe("저장소 snapshot과 생산자", () => {
  it("raw timestamp의 마이크로초 차이·URL relink·운영자 변경을 구분한다", () => {
    expect(repoMoveSnapshotMatches(snapshot(), snapshot())).toBe(true);
    for (const changed of [snapshot({ updatedAt: "2026-10-23 09:00:00.123457" }), snapshot({ repoLinkVersion: 4 }),
      snapshot({ url: "https://another.example" }), snapshot({ review: { reviewedAt: "now", operatorDecision: "keep", operatorAt: "now" } })]) {
      expect(repoMoveSnapshotMatches(snapshot(), changed)).toBe(false);
    }
  });

  it.each([{ source: "skill" }, { claimedAt: "now" }, { activeMaker: true }, { status: "banned" },
    { review: { reviewedAt: "now", operatorDecision: "keep" as const, operatorAt: "now" } }])("주인·운영자 유지 보호를 다시 적용한다 (%s)", protection => {
    expect(repoMoveProtected(snapshot(protection))).toBe(true);
    expect(repoMoveProtected(snapshot())).toBe(false);
  });

  it("공식 redirect 후보는 생성하지만 기존 검수 answers를 변경하지 않는다", () => {
    const actual = repositoryMoveCandidate(snapshot(), { state: "moved", to: "new/tool" }, null, [], [], "now");
    expect(actual.candidates).toEqual([{ url: "https://github.com/new/tool", check: { state: "alive" } }]);
    expect(buildRepoMoveInput(actual, [readme])).toMatchObject({ task: "repo", subject: { id: 7 }, context: { oldRepositoryUrl: snapshot().repoUrl } });
  });

  it("원본/중복 후보와 과도한 링크는 거부한다", () => {
    expect(repoMoveCandidateSchema.safeParse(candidate({ candidates: [...candidate().candidates, ...candidate().candidates] })).success).toBe(false);
    expect(repoMoveCandidateSchema.safeParse(candidate({ candidates: [{ url: snapshot().repoUrl, check: { state: "alive" } }] })).success).toBe(false);
  });
});
