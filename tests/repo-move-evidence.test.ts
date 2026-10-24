import { describe, expect, it, vi } from "vitest";
import { checkRepoMoveBeforeApply, collectRepoMoveInput } from "@/lib/domain/products/repo-move-evidence";
import { buildRepoMoveInput, repoMoveSource, type RepoMoveCandidate } from "@/lib/domain/products/repo-move-review";
import { assistHash } from "@/lib/domain/llm-assist/contracts";
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
  if (url === "https://tool.example") return ok(url, "<h1>Current Tool</h1><p>Draw maps today.</p>");
  return ok("https://github.com/new/tool", "<title>Tool</title><main>Draw maps with Tool.</main>");
});

describe("저장소 비동기 근거 수집", () => {
  it("옛/새 README와 페이지를 별도 출처로 보존한다", async () => {
    const request = fetcher();
    const result = await collectRepoMoveInput(candidate(), { fetch: request });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.reason);
    expect(result.input.sources.map(source => source.sourceId)).toEqual(["old_repository", "product_page", "old_readme", "candidate_readme_0", "candidate_repository_0"]);
    expect(request).toHaveBeenCalledTimes(5);
    expect(result.input.sources.find(source => source.sourceId === "product_page")).toMatchObject({
      url: "https://tool.example", text: "Current Tool Draw maps today.", completeness: "complete" });
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
    expect(checks.page).toMatchObject({ text: "Current Tool Draw maps today.", completeness: "complete" });
  });

  it("생산 당시 page를 바꾸지 않고 현재 page 한 개만 입력에 남긴다", async () => {
    const original = candidate(), hash = assistHash(original);
    const result = await collectRepoMoveInput(original, { fetch: fetcher() });
    expect(assistHash(original)).toBe(hash);
    if (result.kind !== "ready") throw new Error(result.reason);
    expect(result.input.sources.filter(source => source.sourceId === "product_page")).toHaveLength(1);
    const page = result.input.sources.find(source => source.sourceId === "product_page")!;
    expect(() => buildRepoMoveInput(original, [page, page])).toThrow("duplicate_product_page");
  });

  it("옛 저장소가 없는 후보의 현재 page가 blocked/truncated/missing이면 모델 준비를 보류한다", async () => {
    const original = { ...candidate(), oldRepository: { state: "gone" as const } };
    for (const page of [{ ok: false as const, reason: "http" as const, status: 403 }, ok(original.snapshot.url, "Current Tool", true),
      ok(original.snapshot.url, "<h1>Just a moment</h1>"), { ok: false as const, reason: "timeout" as const }]) {
      const request = vi.fn<typeof fetchCapped>(async url => url === original.snapshot.url ? page
        : url === original.snapshot.repoUrl ? { ok: false, reason: "http", status: 404 }
          : url.startsWith("https://raw.githubusercontent.com/") ? ok(url, "# Monitoring SDK") : ok(url, "Monitoring SDK"));
      expect(await collectRepoMoveInput(original, { fetch: request })).toEqual({ kind: "waiting_evidence", reason: "product_page_unavailable" });
    }
  });
});
