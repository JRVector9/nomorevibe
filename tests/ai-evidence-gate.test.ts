import { describe, expect, it, vi } from "vitest";
import { PROBE_COMMITS, probeAiEvidence } from "@/lib/crawl/ai-evidence-gate";
import type { GitHubFailure, githubRequest } from "@/lib/crawl/github";

/**
 * AI 흔적 더듬기 — 루트 파일 목록과 최근 커밋만 본다(요청 두 번).
 */
type Reply = Awaited<ReturnType<typeof githubRequest>>;
const ok = (value: unknown): Reply => ({ ok: true, status: 200, value, etag: null, lastModified: null, link: null });
const fail = (error: GitHubFailure): Reply => ({ ok: false, error });
const commit = (message: string) => ({ commit: { message } });

function request(root: Reply, commits: Reply) {
  const calls: string[] = [];
  const fn = vi.fn(async (path: string) => { calls.push(path); return path.includes("/commits") ? commits : root; });
  return { request: fn as unknown as typeof githubRequest, calls };
}

describe("probeAiEvidence", () => {
  it("루트의 지침 파일과 에이전트 디렉터리를 흔적으로 센다", async () => {
    const { request: req, calls } = request(ok([
      { name: "README.md", type: "file" }, { name: "CLAUDE.md", type: "file" }, { name: ".cursor", type: "dir" }, { name: "src", type: "dir" },
    ]), ok([commit("chore: init")]));
    expect(await probeAiEvidence("owner/repo", req)).toEqual({ ok: true, found: ["file:CLAUDE.md", "dir:.cursor"] });
    expect(calls).toEqual(["/repos/owner/repo/contents/", `/repos/owner/repo/commits?per_page=${PROBE_COMMITS}`]);
  });

  it("최근 커밋의 도구 표기는 세고 사람끼리의 Co-authored-by 는 세지 않는다", async () => {
    const { request: req } = request(ok([{ name: "README.md", type: "file" }]), ok([
      commit("feat: login\n\nCo-authored-by: Claude <noreply@anthropic.com>"),
      commit("fix: typo\n\nCo-authored-by: Jane Doe <jane@example.com>"),
      commit("docs\n\nCo-authored-by: Claude <noreply@anthropic.com>"),
    ]));
    expect(await probeAiEvidence("owner/repo", req)).toEqual({ ok: true, found: ["trailer:claude-code"] });

    const { request: humans } = request(ok([{ name: "README.md", type: "file" }]), ok([
      commit("fix: typo\n\nCo-authored-by: Jane Doe <jane@example.com>"),
    ]));
    expect(await probeAiEvidence("owner/repo", humans)).toEqual({ ok: true, found: [] });
  });

  it("커밋이 없는 레포(409)는 흔적 없음이고, 루트가 없는 레포(404)는 not_found 다", async () => {
    const { request: empty } = request(ok([{ name: ".claude", type: "dir" }]), fail({ kind: "http", status: 409 }));
    expect(await probeAiEvidence("owner/repo", empty)).toEqual({ ok: true, found: ["dir:.claude"] });

    const { request: gone, calls } = request(fail({ kind: "not_found" }), ok([]));
    expect(await probeAiEvidence("owner/repo", gone)).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(calls).toHaveLength(1);
  });

  it("한도에 걸리면 그대로 돌려준다 — 부른 쪽이 틱을 접는다", async () => {
    const resetAt = new Date("2026-10-02T04:00:00Z");
    const { request: limited } = request(ok([]), fail({ kind: "rate_limited", resetAt }));
    expect(await probeAiEvidence("owner/repo", limited)).toEqual({ ok: false, error: { kind: "rate_limited", resetAt } });
  });
});
