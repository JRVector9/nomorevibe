import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { buildRepoMoveInput, decideRepositoryMove, repoMoveSource, type RepoMoveCandidate,
  type RepoMoveOutcome } from "@/lib/domain/products/repo-move-review";
import { checkRepoMoveBeforeApply, collectRepoMoveInput } from "@/lib/domain/products/repo-move-evidence";
import type { fetchCapped } from "@/lib/net/fetch";

const now = () => new Date().toISOString();
const candidate = (): RepoMoveCandidate => ({ kind: "repo_move", snapshot: { id: 7, slug: "editor", url: "https://editor.example/",
  repoUrl: "https://github.com/old/editor-fork", repoLinkVersion: 1, updatedAt: "2026-10-23 00:00:00.123456", name: "Editor",
  description: "The official collaborative editor", status: "seeded", source: "crawler", accessMode: "website", claimedAt: null,
  activeMaker: false, repoStatus: "ok", repoCheckedAt: "2026-10-23 00:00:00.123456", repoMissingSince: null,
  repoRenamedTo: "new/editor-fork", review: null }, oldRepository: { state: "moved", to: "new/editor-fork" }, page: null,
  candidates: [{ url: "https://github.com/new/editor-fork", check: { state: "alive" } }], uncheckedRepositoryUrls: [] });
const readme = () => repoMoveSource("candidate_readme_0", "readme", "https://github.com/new/editor-fork",
  "A local editor based on Editor. Online collaboration is removed.", now(), "complete", 200);
// Deliberately false but schema-valid claims reproduce the guard gap, not a repaired model response.
const adversarial = (): RepoMoveOutcome => ({ schema_version: ASSIST_SCHEMA_VERSION, task: "repo",
  evidence_quality: { status: "sufficient", limitations: ["none"] },
  evidence: [{ source_id: "candidate_readme_0", quote: "A local editor based on Editor.", supports: ["/state/project_identity", "/state/code_lineage"] },
    { source_id: "old_repository", quote: "GitHub redirected https://github.com/old/editor-fork to https://github.com/new/editor-fork.",
      supports: ["/state/official_continuity"] }],
  state: { project_identity: "matches", code_lineage: "original", official_continuity: "explicit_move", relationship: "same_project" },
  action: { proposal: "update_repo_candidate", reason_ko: "모델의 허위 공식 연결 주장을 서버가 검증해야 합니다.", missing_items: [] } });
const page = () => repoMoveSource("product_page", "page", "https://editor.example/", "Editor: collaboration and source code.", now(), "complete", 200);
const binding = (current: AssistSource, repositoryKeys: string[]) => repoMoveSource("product_page_repositories", "metadata", current.url,
  JSON.stringify({ version: "repo-page-repositories-2026-10-25.1", pageRevision: current.revision,
    bodyHash: "a".repeat(64), repositoryKeys }), current.observedAt, current.completeness, current.httpStatus);

describe("저장소 이전의 현재 공식 홈페이지 연결", () => {
  it("fork의 GitHub redirect와 모델 주장은 제품의 공식 연결을 대신하지 못한다", () => {
    const c = candidate();
    expect(decideRepositoryMove(c, buildRepoMoveInput(c, [page(), readme()]), adversarial()).kind).toBe("human");
  });
  it.each([{ keys: [] }, { keys: ["upstream/editor"] }, { keys: ["new/editor-fork", "upstream/editor"] }])("명시 Source 링크가 없거나 다르거나 여럿이면 보류한다 ($keys)", ({ keys }) => {
    const c = candidate(), current = page();
    expect(decideRepositoryMove(c, buildRepoMoveInput(c, [current, binding(current, keys), readme()]), adversarial()).kind).toBe("human");
  });
  it.each(["old/editor-fork", "new/editor-fork"])("완전한 현재 홈페이지의 유일한 공식 링크 %s는 허용한다", key => {
    const c = candidate(), current = page();
    expect(decideRepositoryMove(c, buildRepoMoveInput(c, [current, binding(current, [key]), readme()]), adversarial()).kind).toBe("update_repo_candidate");
  });
  it.each(["truncated", "blocked", "missing"] as const)("%s 페이지에서 관측한 양성 링크도 완전한 공식 권한이 아니다", completeness => {
    const c = candidate(), current = { ...page(), completeness };
    expect(decideRepositoryMove(c, buildRepoMoveInput(c, [current, binding(current, ["new/editor-fork"]), readme()]), adversarial()).kind).toBe("human");
  });
  it("링크 metadata는 같은 현재 페이지 revision과 시각에 묶여야 한다", () => {
    const c = candidate(), current = page();
    for (const changed of [{ ...binding(current, ["new/editor-fork"]), observedAt: "2020-01-01T00:00:00Z" },
      binding({ ...current, revision: "other-page" }, ["new/editor-fork"]),
      { ...binding(current, ["new/editor-fork"]), revision: "invented" }]) {
      expect(decideRepositoryMove(c, buildRepoMoveInput(c, [current, changed, readme()]), adversarial()).kind).toBe("human");
    }
  });
  it("다른 URL·오래된 페이지·미래 시각·원문 hash 누락은 공식 권한이 아니다", () => {
    const c = candidate();
    for (const current of [repoMoveSource("product_page", "page", "https://other.example/", "Source code", now(), "complete", 200),
      repoMoveSource("product_page", "page", c.snapshot.url, "Source code", new Date(Date.now() - 181_000).toISOString(), "complete", 200),
      repoMoveSource("product_page", "page", c.snapshot.url, "Source code", new Date(Date.now() + 60_000).toISOString(), "complete", 200)]) {
      expect(decideRepositoryMove(c, buildRepoMoveInput(c, [current, binding(current, ["new/editor-fork"]), readme()]), adversarial()).kind).toBe("human");
    }
    const current = page(), links = binding(current, ["new/editor-fork"]);
    const facts = { ...JSON.parse(links.text), bodyHash: null };
    const missingHash = repoMoveSource(links.sourceId, links.kind, links.url, JSON.stringify(facts), links.observedAt, links.completeness, links.httpStatus);
    expect(decideRepositoryMove(c, buildRepoMoveInput(c, [current, missingHash, readme()]), adversarial()).kind).toBe("human");
  });
  it("collector가 href를 잃지 않고 원 본문 hash와 별도 source를 수집·재검증한다", async () => {
    const c = candidate(), html = '<h1>Editor</h1><a href="https://github.com/new/editor-fork">Source code</a>';
    const request: typeof fetchCapped = async url => ({ ok: true, status: 200,
      finalUrl: url === c.snapshot.repoUrl ? c.candidates[0].url : url,
      headers: new Headers(), body: Buffer.from(url === c.snapshot.url ? html : "A local editor based on Editor."), truncated: false });
    const collected = await collectRepoMoveInput(c, { fetch: request });
    expect(collected.kind).toBe("ready");
    if (collected.kind !== "ready") throw new Error(collected.reason);
    const current = collected.input.sources.find(s => s.sourceId === "product_page")!;
    const links = collected.input.sources.find(s => s.sourceId === "product_page_repositories");
    expect(links).toMatchObject({ kind: "metadata", url: c.snapshot.url, observedAt: current.observedAt, completeness: "complete" });
    expect(JSON.parse(links!.text)).toEqual({ version: "repo-page-repositories-2026-10-25.1", pageRevision: current.revision,
      bodyHash: createHash("sha256").update(html).digest("hex"), repositoryKeys: ["new/editor-fork"] });
    const fresh = await checkRepoMoveBeforeApply(c, { fetch: request });
    expect(fresh).toHaveProperty("pageRepositories");
    expect((fresh as unknown as { pageRepositories: AssistSource }).pageRepositories.revision).toBe(links!.revision);
  });
});
