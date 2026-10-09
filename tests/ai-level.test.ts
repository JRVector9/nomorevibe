import { describe, expect, it } from "vitest";
import { agentPullRequests, classifyAiLevel, commitAiClaims, scanEvidence, toolFiles, type CommitFacts } from "@/lib/domain/evidence/ai-level";
import { aiLevelBatchQuery, aiLevelDetailQuery, parseAiLevelBatch, parseAiLevelDetail } from "@/lib/domain/evidence/ai-level-query";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";

const SHA = "a".repeat(40);
const commit = (message: string, author: Partial<CommitFacts> = {}): CommitFacts =>
  ({ sha: SHA, message, parents: 1, authorName: "Kim", authorEmail: "kim@example.com", authorLogin: "kim", ...author });

describe("commitAiClaims — 2026-10-10 공개분 커밋에서 본 표기", () => {
  it("모델 이름 뒤 괄호·Fable·Code 표기를 Claude Code 로 읽는다", () => {
    for (const label of ["Claude", "Claude Code", "Claude Opus 5.5 (1M context)", "Claude Fable 5.1", "Claude Opus 5 (1M context)", "Claude Sonnet 4.6", "Claude Haiku 4.5"]) {
      expect(commitAiClaims(commit(`fix: x\n\nCo-Authored-By: ${label} <noreply@anthropic.com>`))).toEqual([{ client: "claude-code", basis: "coauthor" }]);
    }
  });

  it("사람 이름이기도 한 표기는 주소가 맞아야 한다", () => {
    expect(commitAiClaims(commit("fix\n\nCo-authored-by: Claude <claude.dupont@gmail.com>"))).toEqual([]);
    expect(commitAiClaims(commit("fix\n\nCo-authored-by: Devin <devin@example.com>"))).toEqual([]);
    expect(commitAiClaims(commit("fix\n\nCo-authored-by: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>")))
      .toEqual([{ client: "devin", basis: "coauthor" }]);
  });

  it("다른 도구들", () => {
    const one = (trailer: string) => commitAiClaims(commit(`feat\n\n${trailer}`)).map((claim) => claim.client);
    expect(one("Co-authored-by: Cursor Agent <cursoragent@cursor.com>")).toEqual(["cursor"]);
    expect(one("Co-authored-by: Codex <noreply@openai.com>")).toEqual(["codex"]);
    expect(one("Co-authored-by: copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>")).toEqual(["github-copilot"]);
    expect(one("Co-authored-by: Grok 4.7 <noreply@x.ai>")).toEqual(["grok-build"]);
    expect(one("Co-authored-by: claude[bot] <209825114+claude[bot]@users.noreply.github.com>")).toEqual(["claude-code"]);
    // 의존성·검토 봇은 도구 표기가 아니다
    expect(one("Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>")).toEqual([]);
    expect(one("Co-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>")).toEqual([]);
  });

  it("작성자 자체가 도구인 커밋", () => {
    expect(commitAiClaims(commit("feat: x", { authorName: "Claude", authorEmail: "noreply@anthropic.com", authorLogin: "claude" })))
      .toEqual([{ client: "claude-code", basis: "author" }]);
    expect(commitAiClaims(commit("feat: x", { authorName: "Cursor Agent", authorEmail: "cursoragent@cursor.com", authorLogin: "cursoragent" })))
      .toEqual([{ client: "cursor", basis: "author" }]);
    expect(commitAiClaims(commit("feat: x", { authorName: "copilot-swe-agent[bot]", authorEmail: "198982749+Copilot@users.noreply.github.com", authorLogin: "Copilot" })))
      .toEqual([{ client: "github-copilot", basis: "author" }]);
    expect(commitAiClaims(commit("feat: x", { authorName: "Kim (aider)" }))).toEqual([{ client: "aider", basis: "author" }]);
  });

  it("도구가 붙이는 꼬리 줄은 정해진 문구만", () => {
    expect(commitAiClaims(commit("feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>")))
      .toEqual([{ client: "claude-code", basis: "coauthor" }, { client: "claude-code", basis: "footer" }]);
    expect(commitAiClaims(commit("docs: README now says it was Generated with Claude Code by someone"))).toEqual([]);
  });

  it("병합 커밋과 본문 속 예시는 보지 않는다", () => {
    expect(commitAiClaims(commit("Merge branch 'x'\n\nCo-Authored-By: Claude <noreply@anthropic.com>", { parents: 2 }))).toEqual([]);
    expect(commitAiClaims(commit("docs: how to credit\n\n```\nexample\n\nCo-Authored-By: Claude <noreply@anthropic.com>"))).toEqual([]);
  });
});

describe("agentPullRequests — PR 을 연 계정", () => {
  const pr = (authorLogin: string, authorType = "Bot", baseRefName = "main") => ({ number: 7, mergedAt: "2026-10-01T00:00:00Z", baseRefName, authorLogin, authorType });
  it("서비스 에이전트는 1단계, 주인 워크플로의 claude 는 2단계", () => {
    expect(agentPullRequests([pr("copilot-swe-agent")], "main")).toMatchObject([{ client: "github-copilot", level: 1 }]);
    expect(agentPullRequests([pr("devin-ai-integration"), pr("google-labs-jules"), pr("cursor")], "main").map((item) => item.level)).toEqual([1, 1, 1]);
    expect(agentPullRequests([pr("claude")], "main")).toMatchObject([{ client: "claude-code", level: 2 }]);
  });
  it("사람 계정·기본 브랜치가 아닌 곳·AI 아닌 봇은 아니다", () => {
    expect(agentPullRequests([pr("cursor", "User")], "main")).toEqual([]);
    expect(agentPullRequests([pr("copilot-swe-agent", "Bot", "develop")], "main")).toEqual([]);
    expect(agentPullRequests([pr("dependabot"), pr("renovate"), pr("nappy-claude-coder")], "main")).toEqual([]);
  });
});

describe("toolFiles — 3단계 파일", () => {
  const blob = (path: string) => ({ path, type: "blob", mode: 0o100644 });
  it("도구가 정해진 설정·규칙만, 공유 지침과 예제 폴더는 빼고", () => {
    expect(toolFiles([blob(".claude/settings.json"), blob(".cursor/rules/style.mdc"), blob(".github/copilot-instructions.md"), blob(".windsurfrules")])
      .map((file) => file.client)).toEqual(["claude-code", "cursor", "github-copilot", "windsurf"]);
    expect(toolFiles([blob("CLAUDE.md"), blob("AGENTS.md"), blob(".claude/skills/x/SKILL.md")])).toEqual([]);
  });
});

describe("classifyAiLevel", () => {
  const base = { isFork: false, pullRequests: [], commits: [], files: [] };
  const agentPr = { number: 1, mergedAt: "2026-10-01T00:00:00Z", agent: "copilot-swe-agent", client: "github-copilot", level: 1 as const };
  it("코드 파일을 바꾼 에이전트 PR 이 1단계", () => {
    expect(classifyAiLevel({ ...base, pullRequests: [{ ...agentPr, development: true }] }).level).toBe(1);
    // 문서만 바꾼 PR·아직 모르는 PR 은 세지 않는다
    expect(classifyAiLevel({ ...base, pullRequests: [{ ...agentPr, development: false }, { ...agentPr, number: 2, development: null }] }).level).toBeNull();
  });
  it("개발 커밋 표기는 2단계, 도구 파일만이면 3단계", () => {
    expect(classifyAiLevel({ ...base, commits: [{ sha: SHA, client: "claude-code", basis: "coauthor", development: true }], files: [{ path: ".cursorrules", client: "cursor" }] }))
      .toMatchObject({ level: 2, clients: ["claude-code", "cursor"] });
    expect(classifyAiLevel({ ...base, files: [{ path: ".cursorrules", client: "cursor" }] }).level).toBe(3);
  });
  it("포크는 커밋 표기도 도구 파일도 원본에서 물려받으므로 보지 않는다 — 기존 근거 수집이 이미 거른 커밋만", () => {
    const commits = [{ sha: SHA, client: "claude-code", basis: "coauthor" as const, development: true }];
    expect(classifyAiLevel({ ...base, isFork: true, commits }).level).toBeNull();
    expect(classifyAiLevel({ ...base, isFork: true, files: [{ path: ".cursorrules", client: "cursor" }] }).level).toBeNull();
    expect(classifyAiLevel({ ...base, isFork: true, commits: [{ ...commits[0], basis: "scan" as const }] }).level).toBe(2);
  });
});

describe("scanEvidence — 기존 근거 수집에서 셀 것", () => {
  const observation = (overrides: Partial<AgentObservation>): AgentObservation => ({
    kind: "instruction_file", client: null, compatibleClients: [], modelDeveloper: null, declaredModelId: null, gateway: null, routing: "unknown",
    role: null, scope: "", keyPath: null, ruleId: "x", sourcePath: "CLAUDE.md", commitSha: SHA, blobSha: null, sourceUrl: "https://github.com/a/b/blob/x/CLAUDE.md",
    ...overrides,
  });
  it("개발 커밋 표기와 도구가 정해진 파일만", () => {
    const result = scanEvidence([
      observation({}),
      observation({ client: "cursor", sourcePath: ".cursorrules" }),
      observation({ kind: "commit_attribution", client: "claude-code", role: "coauthor", sourcePath: null,
        commitEvidence: { basis: "coauthor", changedPaths: ["src/a.ts"], changeKind: "development", headSha: SHA } }),
      observation({ kind: "commit_attribution", client: "codex", role: "coauthor", sourcePath: null,
        commitEvidence: { basis: "coauthor", changedPaths: ["README.md"], changeKind: "other", headSha: SHA } }),
    ]);
    expect(result).toEqual({ commits: [{ sha: SHA, client: "claude-code" }], files: [{ path: ".cursorrules", client: "cursor" }] });
  });
});

describe("GraphQL 질의와 읽기", () => {
  it("묶음 크기·이름을 막고, 없는 저장소와 모르는 답을 가른다", () => {
    expect(() => aiLevelBatchQuery([{ owner: "a", name: "b c" }])).toThrow();
    expect(aiLevelBatchQuery([{ owner: "acme", name: "app" }])).toContain('r0: repository(owner: "acme", name: "app")');
    const answers = parseAiLevelBatch([{ owner: "a", name: "b" }, { owner: "c", name: "d" }, { owner: "e", name: "f" }], {
      r0: { isFork: false, defaultBranchRef: { name: "main", target: { oid: SHA, history: { nodes: [{ oid: SHA, message: "m", parents: { totalCount: 1 }, author: { name: "Claude", email: "noreply@anthropic.com", user: { login: "claude" } } }] } } },
        pullRequests: { nodes: [{ number: 3, mergedAt: "2026-10-01T00:00:00Z", baseRefName: "main", author: { __typename: "Bot", login: "copilot-swe-agent" } }] },
        root: { entries: [{ name: ".cursor", type: "tree", mode: 16384 }, { name: ".windsurfrules", type: "blob", mode: 33188 }] } },
      r1: null, r2: null,
    }, [{ type: "NOT_FOUND", path: ["r1"] }]);
    expect(answers.map((answer) => answer.kind)).toEqual(["found", "not_found", "unknown"]);
    const scan = answers[0].kind === "found" ? answers[0].scan : null;
    expect(scan).toMatchObject({ defaultBranch: "main", headSha: SHA, commits: [{ authorLogin: "claude" }], pullRequests: [{ number: 3, authorType: "Bot" }] });
    expect(scan?.rootEntries.map((entry) => entry.path)).toEqual([".cursor", ".windsurfrules"]);
  });

  it("두 번째 질의 — 정해진 에이전트 폴더만, 두 겹과 PR 파일", () => {
    const request = { repo: { owner: "a", name: "b" }, directories: [".cursor"], pullRequests: [3] };
    expect(() => aiLevelDetailQuery([{ ...request, directories: ["src"] }])).toThrow();
    const [detail] = parseAiLevelDetail([request], { r0: {
      d0: { entries: [{ name: "rules", type: "tree", mode: 16384, object: { entries: [{ name: "style.mdc", type: "blob", mode: 33188 }] } }] },
      p0: { files: { nodes: [{ path: "src/app.ts" }, { path: "README.md" }], pageInfo: { hasNextPage: true } } },
    } });
    expect(detail?.entries.map((entry) => entry.path)).toEqual([".cursor/rules", ".cursor/rules/style.mdc"]);
    expect(detail?.pullRequestFiles.get(3)).toEqual({ paths: ["src/app.ts", "README.md"], more: true });
  });
});
