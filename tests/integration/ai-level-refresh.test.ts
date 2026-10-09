import { createHash } from "node:crypto";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, products, repositoryAiLevels } from "@/lib/db/schema";
import type { githubGraphql, githubRequest } from "@/lib/crawl/github";
import { getRepositoryAiLevel, storedAiLevel } from "@/lib/domain/evidence/ai-level-store";
import { dueRepositories, refreshAiLevelsJob, type AiLevelCursor } from "@/lib/jobs/products/ai-level-refresh";
import type { JobContext } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

/** AI 제작 근거 단계 잡(ai-level-refresh) — 차례, 단계마다의 판정, 제품에 옮겨 적기, 실패를 가두기(GitHub 은 가짜) */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
});

const SHA = (n: number) => n.toString(16).padStart(40, "0");
const TREE = 0o40000;
const BLOB = 0o100644;
type Entry = { name: string; type: "tree" | "blob"; children?: Entry[] };
type Fixture = {
  commits?: { sha: string; message: string; authorName?: string; authorEmail?: string; authorLogin?: string | null }[];
  prs?: { number: number; login: string; type?: string; base?: string }[];
  root?: Entry[];
  prFiles?: Record<number, string[]>;
  commitFiles?: Record<string, string[]>;
  missing?: boolean;
  fail?: boolean;
};

function fakeGithub(fixtures: Record<string, Fixture>) {
  const restPaths: string[] = [];
  type Node = { name: string; type: string; mode: number; object: { entries: Node[] } | null };
  const entry = (item: Entry): Node => ({ name: item.name, type: item.type, mode: item.type === "tree" ? TREE : BLOB,
    object: item.children ? { entries: item.children.map(entry) } : null });
  const graphql = vi.fn(async (query: string) => {
    const chunks = query.split(/(?=r\d+: repository\()/).slice(1);
    const repos = chunks.map((chunk) => {
      const [, alias, owner, name] = chunk.match(/^(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/)!;
      return { alias, key: `${owner}/${name}`.toLowerCase(), chunk };
    });
    if (repos.some(({ key }) => fixtures[key]?.fail)) return { ok: false as const, error: { kind: "transport" as const } };
    const data: Record<string, unknown> = { rateLimit: { cost: 1, remaining: 4000, resetAt: null } };
    const errors: { type: string; path: string[] }[] = [];
    for (const { alias, key, chunk } of repos) {
      const fixture = fixtures[key];
      if (!fixture || fixture.missing) { data[alias] = null; errors.push({ type: "NOT_FOUND", path: [alias] }); continue; }
      if (query.includes("fragment T on Tree")) {
        const node: Record<string, unknown> = {};
        for (const [, at, directory] of chunk.matchAll(/d(\d+): object\(expression: "HEAD:([^"]+)"\)/g)) {
          const dir = (fixture.root ?? []).find((item) => item.name === directory);
          node[`d${at}`] = dir ? { entries: (dir.children ?? []).map(entry) } : null;
        }
        for (const [, at, number] of chunk.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) {
          node[`p${at}`] = { files: { nodes: (fixture.prFiles?.[Number(number)] ?? []).map((path) => ({ path })) } };
        }
        data[alias] = node;
      } else {
        data[alias] = {
          isFork: false,
          defaultBranchRef: { name: "main", target: { oid: SHA(999), history: { nodes: (fixture.commits ?? []).map((commit) => ({
            oid: commit.sha, message: commit.message, parents: { totalCount: 1 },
            author: { name: commit.authorName ?? "Kim", email: commit.authorEmail ?? "kim@example.com", user: commit.authorLogin === null ? null : { login: commit.authorLogin ?? "kim" } },
          })) } } },
          pullRequests: { nodes: (fixture.prs ?? []).map((pr) => ({ number: pr.number, mergedAt: "2026-10-01T00:00:00Z", baseRefName: pr.base ?? "main",
            author: { __typename: pr.type ?? "Bot", login: pr.login } })) },
          root: { entries: (fixture.root ?? []).map(({ name, type }) => ({ name, type, mode: type === "tree" ? TREE : BLOB })) },
        };
      }
    }
    return { ok: true as const, data, errors };
  });
  const request = vi.fn(async (path: string) => {
    restPaths.push(path);
    const [, key, sha] = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/([a-f0-9]+)$/)!;
    const files = fixtures[key]?.commitFiles?.[sha] ?? [];
    return { ok: true as const, status: 200 as const, value: { files: files.map((filename) => ({ filename })) }, etag: null, lastModified: null, link: null };
  });
  return { graphql: graphql as unknown as typeof githubGraphql, request: request as unknown as typeof githubRequest, calls: graphql, restPaths };
}

const context = (cursor: AiLevelCursor | null = null): JobContext<AiLevelCursor> => ({ cursor, save: vi.fn(), hasBudget: () => true, log: vi.fn() });

let serial = 0;
async function product(repoUrl: string, overrides: Partial<typeof products.$inferInsert> = {}) {
  const slug = `ai-${++serial}`;
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "t", description: "d", category: "Dev",
    repoUrl, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64), ...overrides }).returning();
  return row;
}
const levelOf = async (id: number) => (await db.select({ level: products.aiLevel }).from(products).where(eq(products.id, id)))[0].level;
const row = async (key: string) => (await db.select().from(repositoryAiLevels).where(eq(repositoryAiLevels.repositoryKey, key)))[0];

it("차례: 새로 수집한 후보가 먼저, 그다음 아직 보지 않은 공개 제품을 최신부터 — 내려간 제품·거절된 후보는 보지 않는다", async () => {
  await product("https://github.com/acme/old");
  await product("https://github.com/acme/new");
  await product("https://github.com/acme/banned", { status: "banned" });
  await db.insert(crawlCandidates).values([{ repo: "Cand/Fresh", state: "new" }, { repo: "cand/rejected", state: "rejected" }]);
  expect(await dueRepositories(10)).toEqual({ keys: ["cand/fresh", "acme/new", "acme/old"], unseenExhausted: true });
  // 쉬는 동안은 안 본 공개 제품을 찾지 않는다
  expect(await dueRepositories(10, { skipUnseen: true })).toEqual({ keys: ["cand/fresh"], unseenExhausted: false });
});

it("단계마다 판정하고 같은 저장소의 제품(대소문자·.git 이 달라도)에 옮긴다", async () => {
  const claude = "feat: x\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>";
  const github = fakeGithub({
    "acme/agent": { prs: [{ number: 5, login: "copilot-swe-agent" }], prFiles: { 5: ["src/app.ts", "README.md"] } },
    "acme/docs-agent": { prs: [{ number: 6, login: "devin-ai-integration" }], prFiles: { 6: ["README.md"] } },
    "acme/human-cursor": { prs: [{ number: 8, login: "cursor", type: "User" }], prFiles: { 8: ["src/a.ts"] } },
    "acme/signed": { commits: [{ sha: SHA(1), message: claude }], commitFiles: { [SHA(1)]: ["src/a.ts"] } },
    "acme/signed-docs": { commits: [{ sha: SHA(2), message: claude }], commitFiles: { [SHA(2)]: ["docs/guide.md"] } },
    "acme/claude-pr": { prs: [{ number: 7, login: "claude" }], prFiles: { 7: ["lib/x.py"] } },
    "acme/config": { root: [{ name: ".cursor", type: "tree", children: [{ name: "rules", type: "tree", children: [{ name: "style.mdc", type: "blob" }] }] }] },
    "acme/shared": { root: [{ name: "CLAUDE.md", type: "blob" }, { name: "AGENTS.md", type: "blob" }] },
    "acme/scanned": { commits: [{ sha: SHA(3), message: claude }] },
    "acme/gone": { missing: true },
  });
  const ids: Record<string, number> = {};
  for (const key of ["acme/agent", "acme/docs-agent", "acme/human-cursor", "acme/signed", "acme/signed-docs", "acme/claude-pr", "acme/config", "acme/shared", "acme/scanned", "acme/gone"]) {
    ids[key] = (await product(`https://github.com/${key}`)).id;
  }
  const alias = await product("https://github.com/Acme/Signed.git");
  // 기존 근거 수집이 개발 커밋 표기를 이미 찾은 저장소 — REST 로 다시 묻지 않는다
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(9), repositoryKey: "acme/scanned", commitSha: SHA(999),
    detectorVersion: "2026-09-14.1", scope: "", scopeHash: createHash("sha256").update(JSON.stringify("")).digest("hex"), state: "complete", completedAt: new Date() }).returning();
  await db.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: "k", facts: {
    kind: "commit_attribution", client: "claude-code", compatibleClients: [], modelDeveloper: null, declaredModelId: null, gateway: null, routing: "unknown",
    role: "coauthor", scope: "", keyPath: null, ruleId: "commit.coauthor.v2", sourcePath: null, commitSha: SHA(4), blobSha: null,
    sourceUrl: `https://github.com/acme/scanned/commit/${SHA(4)}`, commitEvidence: { basis: "coauthor", changedPaths: ["src/b.ts"], changeKind: "development", headSha: SHA(999) } } });

  const outcome = await refreshAiLevelsJob(context(), github);
  expect(outcome).toMatchObject({ done: true, cursor: { unseenIdleUntil: expect.any(String) } });
  const levels = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([key, id]) => [key, await levelOf(id)])));
  expect(levels).toEqual({
    "acme/agent": 1, "acme/docs-agent": null, "acme/human-cursor": null, "acme/signed": 2, "acme/signed-docs": null,
    "acme/claude-pr": 2, "acme/config": 3, "acme/shared": null, "acme/scanned": 2, "acme/gone": null,
  });
  expect(await levelOf(alias.id)).toBe(2);
  // REST 는 표기 커밋이 코드를 바꿨는지 볼 때만 — 기존 근거가 있는 acme/scanned 는 묻지 않는다
  expect(github.restPaths.sort()).toEqual([`/repos/acme/signed-docs/commits/${SHA(2)}`, `/repos/acme/signed/commits/${SHA(1)}`]);
  expect((await row("acme/agent")).evidence).toMatchObject({ pullRequests: [{ number: 5, agent: "copilot-swe-agent", level: 1 }] });
  expect((await row("acme/docs-agent")).evidence).toMatchObject({ nonDevelopment: { pullRequests: [6] } });
  expect((await row("acme/signed-docs")).evidence).toMatchObject({ nonDevelopment: { commits: [SHA(2)] } });
  expect(await row("acme/config")).toMatchObject({ level: 3, clients: ["cursor"], evidence: { files: [{ path: ".cursor/rules/style.mdc", client: "cursor" }] } });
  // 상세가 읽는 것 — 없어진 저장소는 '검사 전', 근거 없음은 '검사함·단계 없음'
  expect(await getRepositoryAiLevel("https://github.com/acme/gone")).toMatchObject({ checked: false, level: null });
  expect(await getRepositoryAiLevel("https://github.com/acme/shared")).toMatchObject({ checked: true, level: null });
  expect(await getRepositoryAiLevel("https://github.com/Acme/Agent/")).toMatchObject({ checked: true, level: 1 });
  expect(await storedAiLevel("Acme/Config")).toBe(3);

  // 다시 볼 때가 아니면 GitHub 에 묻지 않는다
  github.calls.mockClear();
  await refreshAiLevelsJob(context(), github);
  expect(github.calls).not.toHaveBeenCalled();
});

it("묶음이 통째로 실패하면 하나씩 다시 묻고, 그래도 실패한 저장소는 지난 단계를 그대로 둔다", async () => {
  const fixtures: Record<string, Fixture> = {
    "acme/agent": { prs: [{ number: 5, login: "google-labs-jules" }], prFiles: { 5: ["src/app.ts"] } },
    "acme/other": { root: [{ name: ".windsurfrules", type: "blob" }] },
  };
  const agent = await product("https://github.com/acme/agent");
  const other = await product("https://github.com/acme/other");
  await refreshAiLevelsJob(context(), fakeGithub(fixtures));
  expect([await levelOf(agent.id), await levelOf(other.id)]).toEqual([1, 3]);

  await db.execute(sql`update repository_ai_levels set next_check_at = now() - interval '1 minute'`);
  fixtures["acme/agent"].fail = true;
  const github = fakeGithub(fixtures);
  await refreshAiLevelsJob(context(), github);
  // 둘을 묶은 질의 한 번 + 하나씩 두 번
  expect(github.calls).toHaveBeenCalledTimes(3);
  expect(await row("acme/agent")).toMatchObject({ level: 1, lastError: "unknown" });
  expect(await levelOf(agent.id)).toBe(1);
  expect(await row("acme/other")).toMatchObject({ level: 3, lastError: null });
  expect(await getRepositoryAiLevel("https://github.com/acme/agent")).toMatchObject({ checked: true, level: 1 });
});

it("처음 보는 저장소가 실패하면 '검사 전'으로 남기고 한 시간 뒤에 다시 본다", async () => {
  await product("https://github.com/acme/slow");
  await refreshAiLevelsJob(context(), fakeGithub({ "acme/slow": { fail: true } }));
  expect(await row("acme/slow")).toMatchObject({ level: null, lastError: "unknown", headSha: null });
  expect(await getRepositoryAiLevel("https://github.com/acme/slow")).toMatchObject({ checked: false });
  expect((await dueRepositories(10)).keys).toEqual([]);
});

it("지금은 없어진 저장소라도 기존 근거 수집이 찾은 개발 커밋 표기가 있으면 그것으로 단계를 세운다", async () => {
  const gone = await product("https://github.com/acme/vanished");
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(7), repositoryKey: "acme/vanished", commitSha: SHA(998),
    detectorVersion: "2026-09-14.1", scope: "", scopeHash: createHash("sha256").update(JSON.stringify("")).digest("hex"), state: "complete", completedAt: new Date() }).returning();
  await db.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: "k", facts: {
    kind: "commit_attribution", client: "codex", compatibleClients: [], modelDeveloper: null, declaredModelId: null, gateway: null, routing: "unknown",
    role: "coauthor", scope: "", keyPath: null, ruleId: "commit.coauthor.v2", sourcePath: null, commitSha: SHA(5), blobSha: null,
    sourceUrl: `https://github.com/acme/vanished/commit/${SHA(5)}`, commitEvidence: { basis: "coauthor", changedPaths: ["app.py"], changeKind: "development", headSha: SHA(998) } } });
  await refreshAiLevelsJob(context(), fakeGithub({ "acme/vanished": { missing: true } }));
  expect(await row("acme/vanished")).toMatchObject({ level: 2, lastError: "not_found", clients: ["codex"] });
  expect(await levelOf(gone.id)).toBe(2);
  expect(await getRepositoryAiLevel("https://github.com/acme/vanished")).toMatchObject({ checked: true, level: 2 });
});

it("GitHub 한도에 걸리면 아무것도 적지 않고 풀릴 때까지 쉰다", async () => {
  await product("https://github.com/acme/agent");
  const resetAt = new Date(Date.now() + 30 * 60_000);
  const graphql = vi.fn(async () => ({ ok: false as const, error: { kind: "rate_limited" as const, resetAt } })) as unknown as typeof githubGraphql;
  const outcome = await refreshAiLevelsJob(context(), { graphql });
  expect(outcome).toEqual({ done: true, cursor: { retryAfter: resetAt.toISOString(), unseenIdleUntil: expect.any(String) } });
  expect(await db.select().from(repositoryAiLevels)).toEqual([]);
  // 쉬는 동안은 부르지도 않는다
  await refreshAiLevelsJob(context(outcome.cursor!), { graphql });
  expect(graphql).toHaveBeenCalledTimes(1);
});
