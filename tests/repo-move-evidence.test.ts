import { describe, expect, it, vi } from "vitest";
import { checkRepoMoveBeforeApply, collectRepoMoveInput } from "@/lib/domain/products/repo-move-evidence";
import { repoMoveSource, type RepoMoveCandidate } from "@/lib/domain/products/repo-move-review";
import type { fetchCapped, CappedFetchResult } from "@/lib/net/fetch";

const candidate = (): RepoMoveCandidate => ({ kind: "repo_move", snapshot: { id: 1, slug: "tool", url: "https://tool.example",
  repoUrl: "https://github.com/old/tool", repoLinkVersion: 1, updatedAt: "2026-10-23 00:00:00.123456", name: "Tool", description: "Draw maps",
  status: "seeded", source: "crawler", accessMode: "website", claimedAt: null, activeMaker: false, repoStatus: "not_found",
  repoCheckedAt: "2026-10-22 00:00:00.123456", repoMissingSince: "2026-10-20 00:00:00.123456", repoRenamedTo: "new/tool", review: null },
  oldRepository: { state: "moved", to: "new/tool" }, candidates: [{ url: "https://github.com/new/tool", check: { state: "alive" } }],
  uncheckedRepositoryUrls: [], page: repoMoveSource("product_page", "page", "https://tool.example", "Draw maps with Tool", "now", "complete", 200) });
const ok = (url: string, body: string, truncated = false): CappedFetchResult => ({ ok: true, status: 200, finalUrl: url,
  headers: new Headers(), body: Buffer.from(body), truncated });
const fetcher = (readme: CappedFetchResult | null = null) => vi.fn<typeof fetchCapped>(async url => {
  if (url.startsWith("https://raw.githubusercontent.com/")) return readme ?? ok(url, "# Tool\nDraw maps with the original Tool project.");
  return ok("https://github.com/new/tool", "<title>Tool</title><main>Draw maps with Tool.</main>");
});

describe("저장소 비동기 근거 수집", () => {
  it("옛/새 README와 페이지를 별도 출처로 보존한다", async () => {
    const request = fetcher();
    const result = await collectRepoMoveInput(candidate(), { fetch: request });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.reason);
    expect(result.input.sources.map(source => source.sourceId)).toEqual(["old_repository", "product_page", "old_readme", "candidate_readme_0", "candidate_repository_0"]);
    expect(request).toHaveBeenCalledTimes(4);
    expect(result.input.sources.find(source => source.sourceId === "candidate_readme_0")).toMatchObject({ completeness: "complete", kind: "readme" });
  });

  it("막힘·연결 실패는 missing/blocked로 남고 unrelated로 변환하지 않는다", async () => {
    const request = vi.fn<typeof fetchCapped>(async url => url.startsWith("https://github.com/")
      ? { ok: false, reason: "http", status: 403 } : ok(url, "README"));
    expect(await collectRepoMoveInput(candidate(), { fetch: request })).toEqual({ kind: "waiting_evidence", reason: "repository_observation_unknown" });
  });

  it("생산 뒤 리다이렉트가 사라지거나 목적지가 바뀌면 오래된 후보를 폐기한다", async () => {
    const request = vi.fn<typeof fetchCapped>(async url => ok(url, "Tool"));
    expect(await collectRepoMoveInput(candidate(), { fetch: request })).toEqual({ kind: "obsolete", reason: "repository_observation_changed" });
  });

  it("README와 저장소 본문을 둘 다 못 읽으면 모델을 호출할 준비가 됐다고 하지 않는다", async () => {
    const request = vi.fn<typeof fetchCapped>(async url => url.startsWith("https://raw.githubusercontent.com/")
      ? { ok: false, reason: "http", status: 404 } : ok("https://github.com/new/tool", "", true));
    expect(await collectRepoMoveInput(candidate(), { fetch: request })).toEqual({ kind: "waiting_evidence", reason: "candidate_repository_content_unavailable" });
  });

  it("잘린 README는 complete로 위장하지 않는다", async () => {
    const result = await collectRepoMoveInput(candidate(), { fetch: fetcher(ok("https://raw.githubusercontent.com/new/tool/HEAD/README.md", "Draw maps.", true)) });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.input.sources.find(source => source.sourceId === "candidate_readme_0")?.completeness).toBe("truncated");
  });

  it("조치 직전에 old/new를 다시 열고 실제 확인 시각을 남긴다", async () => {
    const before = Date.now();
    const request = fetcher();
    expect(await checkRepoMoveBeforeApply(candidate(), { fetch: request })).toMatchObject({ oldRepository: { state: "moved", to: "new/tool" }, destination: { state: "alive" } });
    const checks = await checkRepoMoveBeforeApply(candidate(), { fetch: request });
    expect(Date.parse(checks.checkedAt)).toBeGreaterThanOrEqual(before);
  });
});
