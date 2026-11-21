import { createHash } from "node:crypto";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, products, repositoryAiLevels } from "@/lib/db/schema";
import { maintainerEmailDenials, repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";
import type { githubGraphql, githubRequest } from "@/lib/crawl/github";
import { AI_LEVEL_RULES_VERSION } from "@/lib/domain/evidence/ai-level-labels";
import { getRepositoryAiLevel, storedAiLevel } from "@/lib/domain/evidence/ai-level-store";
import { denyMaintainerEmail, MAINTAINER_EMAIL_DENY_ACTION, maintainerEmailsForRepoUrl } from "@/lib/domain/makers/maintainer-emails-admin";
import { MAINTAINER_EMAIL_LOCK, maintainerEmailDenyHash } from "@/lib/domain/makers/maintainer-emails";
import { update } from "@/lib/domain/products/repository";
import { dueRepositories, refreshAiLevelsJob, type AiLevelCursor } from "@/lib/jobs/products/ai-level-refresh";
import type { JobContext } from "@/lib/jobs/runner";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

// 관리자 전용 읽기 모듈(maintainer-emails-admin.ts)은 server-only 다 — Next 밖에서는 빈 모듈로
vi.mock("server-only", () => ({}));

/** AI 제작 근거 단계 잡(ai-level-refresh) — 차례, 단계마다의 판정, 제품에 옮겨 적기, 실패를 가두기(GitHub 은 가짜) */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  // 공용 resetTables(setup.ts)에 넣지 않는다 — 모든 통합 파일이 부르는 파일이라 CI 증분 tsc 가 통째로 다시 검사한다
  await db.delete(repositoryMaintainerEmails);
  await db.delete(maintainerEmailDenials);
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
  /** REST 로만 읽히는 커밋(기본 브랜치 최근 30개 밖) — 기존 근거 수집이 찾은 커밋 */
  restCommits?: Record<string, { message: string; authorName?: string; authorEmail?: string; authorLogin?: string | null }>;
  missing?: boolean;
  fail?: boolean;
  isFork?: boolean;
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
          isFork: fixture.isFork ?? false,
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
    const fixture = fixtures[key];
    const files = fixture?.commitFiles?.[sha] ?? [];
    const commit = fixture?.commits?.find((item) => item.sha === sha) ?? fixture?.restCommits?.[sha];
    return { ok: true as const, status: 200 as const, etag: null, lastModified: null, link: null, value: {
      files: files.map((filename) => ({ filename })), parents: [{}],
      commit: { message: commit?.message ?? "", author: { name: commit?.authorName ?? "Kim", email: commit?.authorEmail ?? "kim@example.com" } },
      author: commit?.authorLogin === null ? null : { login: commit?.authorLogin ?? "kim" },
    } };
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
/** 기존 근거 수집의 완료 조사 하나와 관찰 — 커밋 표기(commits)·도구 파일(files) */
async function seedScan(key: string, observations: { commits?: { sha: string; client: string }[]; files?: { path: string; client: string }[] }) {
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(++serial), repositoryKey: key, commitSha: SHA(999),
    detectorVersion: "2026-09-14.1", scope: "", scopeHash: createHash("sha256").update(JSON.stringify("")).digest("hex"), state: "complete", completedAt: new Date() }).returning();
  const base = { compatibleClients: [], modelDeveloper: null, declaredModelId: null, gateway: null, routing: "unknown" as const, scope: "", keyPath: null, blobSha: null };
  const facts = [
    ...(observations.commits ?? []).map((commit) => ({ ...base, kind: "commit_attribution" as const, client: commit.client, role: "coauthor", ruleId: "commit.coauthor.v2",
      sourcePath: null, commitSha: commit.sha, sourceUrl: `https://github.com/${key}/commit/${commit.sha}`,
      commitEvidence: { basis: "coauthor" as const, changedPaths: ["src/b.ts"], changeKind: "development" as const, headSha: SHA(999) } })),
    ...(observations.files ?? []).map((file) => ({ ...base, kind: "instruction_file" as const, client: file.client, role: null, ruleId: "x", sourcePath: file.path,
      commitSha: SHA(999), sourceUrl: `https://github.com/${key}/blob/${SHA(999)}/${file.path}` })),
  ];
  for (const [index, fact] of facts.entries()) await db.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: `k${index}`, facts: fact });
}
const levelOf = async (id: number) => (await db.select({ level: products.aiLevel }).from(products).where(eq(products.id, id)))[0].level;
const row = async (key: string) => (await db.select().from(repositoryAiLevels).where(eq(repositoryAiLevels.repositoryKey, key)))[0];

it("차례: 새로 수집한 후보가 먼저, 그다음 아직 보지 않은 공개 제품을 최신부터 — 내려간 제품·거절된 후보는 보지 않는다", async () => {
  await product("https://github.com/acme/old");
  await product("https://github.com/acme/new");
  await product("https://github.com/acme/banned", { status: "banned" });
  // 메이커가 적은 주소 그대로 — http·www·대소문자·끝 / 를 가리지 않는다
  await product("http://www.github.com/Acme/WWW-Case/");
  await db.insert(crawlCandidates).values([{ repo: "Cand/Fresh", state: "new" }, { repo: "cand/rejected", state: "rejected" }]);
  expect(await dueRepositories(10)).toEqual({ keys: ["cand/fresh", "acme/www-case", "acme/new", "acme/old"], unseenExhausted: true });
  // 쉬는 동안은 안 본 공개 제품을 찾지 않는다
  expect(await dueRepositories(10, { skipUnseen: true })).toEqual({ keys: ["cand/fresh"], unseenExhausted: false });
  // 거절된 후보의 행은 다시 볼 때가 돼도 보지 않고 한 달 뒤로 미룬다 — 매 틱 앞에서 걸러 내지 않게
  await db.insert(repositoryAiLevels).values({ repositoryKey: "cand/rejected", level: 2, rulesVersion: AI_LEVEL_RULES_VERSION, checkedAt: new Date(),
    nextCheckAt: new Date(Date.now() - 60_000) });
  expect((await dueRepositories(10, { skipUnseen: true })).keys).not.toContain("cand/rejected");
  const [parked] = await db.execute<{ days: number }>(sql`select extract(day from next_check_at - now())::int as days from repository_ai_levels where repository_key = 'cand/rejected'`);
  expect(parked.days).toBeGreaterThanOrEqual(29);
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
    "acme/scanned": { restCommits: { [SHA(4)]: { message: claude } }, commitFiles: { [SHA(4)]: ["src/b.ts"] } },
    // 기존 수집은 'Claude <사람 주소>'도 도구로 셌다 — 다시 읽으면 사람이다
    "acme/scanned-person": { restCommits: { [SHA(6)]: { message: "fix\n\nCo-authored-by: Claude <claude.martin@gmail.com>" } }, commitFiles: { [SHA(6)]: ["src/c.ts"] } },
    "acme/gone": { missing: true },
  });
  const ids: Record<string, number> = {};
  for (const key of ["acme/agent", "acme/docs-agent", "acme/human-cursor", "acme/signed", "acme/signed-docs", "acme/claude-pr", "acme/config", "acme/shared", "acme/scanned", "acme/scanned-person", "acme/gone"]) {
    ids[key] = (await product(`https://github.com/${key}`)).id;
  }
  const alias = await product("https://github.com/Acme/Signed.git");
  // 기존 근거 수집이 개발 커밋 표기를 찾은 저장소 — 그대로 믿지 않고 REST 로 표기와 바뀐 파일을 다시 읽는다
  await seedScan("acme/scanned", { commits: [{ sha: SHA(4), client: "claude-code" }] });
  await seedScan("acme/scanned-person", { commits: [{ sha: SHA(6), client: "claude-code" }] });

  const outcome = await refreshAiLevelsJob(context(), github);
  expect(outcome).toMatchObject({ done: true, cursor: { unseenIdleUntil: expect.any(String) } });
  const levels = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([key, id]) => [key, await levelOf(id)])));
  expect(levels).toEqual({
    "acme/agent": 1, "acme/docs-agent": null, "acme/human-cursor": null, "acme/signed": 2, "acme/signed-docs": null,
    "acme/claude-pr": 2, "acme/config": 3, "acme/shared": null, "acme/scanned": 2, "acme/scanned-person": null, "acme/gone": null,
  });
  expect(await levelOf(alias.id)).toBe(2);
  // REST 는 표기 커밋을 확인할 때만 — 틱 끝에 저장소마다 한 커밋
  expect(github.restPaths.sort()).toEqual([`/repos/acme/scanned-person/commits/${SHA(6)}`, `/repos/acme/scanned/commits/${SHA(4)}`,
    `/repos/acme/signed-docs/commits/${SHA(2)}`, `/repos/acme/signed/commits/${SHA(1)}`]);
  expect((await row("acme/scanned")).evidence).toMatchObject({ commits: [{ sha: SHA(4), client: "claude-code", basis: "scan" }] });
  expect((await row("acme/scanned-person")).evidence).toMatchObject({ nonDevelopment: { commits: [SHA(6)] } });
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

it("표기 커밋은 틱 끝에 저장소마다 한 커밋씩 확인한다 — 확인하는 동안은 '검사 전', 코드가 아니면 다음 커밋으로", async () => {
  const claude = (n: number) => ({ sha: SHA(n), message: `feat ${n}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` });
  const fixtures: Record<string, Fixture> = {
    "acme/two-step": { commits: [claude(11), claude(12)], commitFiles: { [SHA(11)]: ["README.md"], [SHA(12)]: ["src/app.ts"] } },
    "acme/offline": { commits: [claude(13)], commitFiles: { [SHA(13)]: ["src/b.ts"] } },
  };
  const twoStep = await product("https://github.com/acme/two-step");
  const offline = await product("https://github.com/acme/offline");
  const github = fakeGithub(fixtures);
  // acme/offline 의 REST 는 실패한다 — 대기에 남는다
  const request = vi.fn(async (path: string) => path.includes("acme/offline")
    ? { ok: false as const, error: { kind: "transport" as const } }
    : (github.request as unknown as (p: string) => Promise<unknown>)(path)) as unknown as typeof githubRequest;
  await refreshAiLevelsJob(context(), { graphql: github.graphql, request });
  // 첫 틱: 최신 커밋(README 만)은 코드가 아니고, 다음 커밋은 아직 — '검사 전'
  expect(await row("acme/two-step")).toMatchObject({ level: null, evidence: { pendingCommits: [{ sha: SHA(12) }], nonDevelopment: { commits: [SHA(11)] } } });
  expect(await getRepositoryAiLevel("https://github.com/acme/two-step")).toMatchObject({ checked: false });
  expect(await row("acme/offline")).toMatchObject({ level: null, evidence: { pendingCommits: [{ sha: SHA(13) }] } });

  // 다음 틱: 볼 저장소는 없어도 대기 커밋은 확인한다
  github.calls.mockClear();
  await refreshAiLevelsJob(context({ unseenIdleUntil: new Date(Date.now() + 60_000).toISOString() }), { graphql: github.graphql, request });
  expect(github.calls).not.toHaveBeenCalled();
  expect(await row("acme/two-step")).toMatchObject({ level: 2, clients: ["claude-code"], evidence: { commits: [{ sha: SHA(12), client: "claude-code" }] } });
  expect((await row("acme/two-step")).evidence.pendingCommits).toBeUndefined();
  expect(await levelOf(twoStep.id)).toBe(2);
  expect(await getRepositoryAiLevel("https://github.com/acme/two-step")).toMatchObject({ checked: true, level: 2 });
  // REST 가 계속 실패하면 대기에 남아 '검사 전' 그대로
  expect(await row("acme/offline")).toMatchObject({ level: null, evidence: { pendingCommits: [{ sha: SHA(13) }] } });
  expect(await levelOf(offline.id)).toBeNull();
});

it("지금은 없어진 저장소는 기존 근거 수집이 찾은 도구 파일로만 단계를 세운다 — 커밋 표기는 다시 확인할 수 없어 쓰지 않는다", async () => {
  const withFile = await product("https://github.com/acme/vanished");
  const commitOnly = await product("https://github.com/acme/vanished-commit");
  await seedScan("acme/vanished", { commits: [{ sha: SHA(5), client: "codex" }], files: [{ path: ".cursorrules", client: "cursor" }] });
  await seedScan("acme/vanished-commit", { commits: [{ sha: SHA(7), client: "codex" }] });
  await refreshAiLevelsJob(context(), fakeGithub({ "acme/vanished": { missing: true }, "acme/vanished-commit": { missing: true } }));
  expect(await row("acme/vanished")).toMatchObject({ level: 3, lastError: "not_found", clients: ["cursor"] });
  expect(await levelOf(withFile.id)).toBe(3);
  expect(await getRepositoryAiLevel("https://github.com/acme/vanished")).toMatchObject({ checked: true, level: 3 });
  expect(await levelOf(commitOnly.id)).toBeNull();
  expect(await getRepositoryAiLevel("https://github.com/acme/vanished-commit")).toMatchObject({ checked: false });
});

it("규칙 판이 바뀐 뒤 실패하면 단계는 두고 옛 근거는 비운다 — 옛 근거가 '이미 확인한 것'으로 이어지지 않게", async () => {
  const old = await product("https://github.com/acme/old-rules", { aiLevel: 1 });
  await db.insert(repositoryAiLevels).values({ repositoryKey: "acme/old-rules", level: 1, rulesVersion: "2026-10-10.1", checkedAt: new Date(),
    nextCheckAt: new Date(), evidence: { pullRequests: [{ number: 5, agent: "copilot-swe-agent", mergedAt: "2026-10-01T00:00:00Z", level: 1 }] } });
  await refreshAiLevelsJob(context(), fakeGithub({ "acme/old-rules": { fail: true } }));
  expect(await row("acme/old-rules")).toMatchObject({ level: 1, rulesVersion: AI_LEVEL_RULES_VERSION, lastError: "unknown", evidence: {} });
  expect(await levelOf(old.id)).toBe(1);
});

it("1단계를 이미 확인한 저장소는 다시 볼 때 에이전트 PR 파일을 더 묻지 않는다", async () => {
  const fixtures: Record<string, Fixture> = { "acme/agent": { prs: [{ number: 5, login: "copilot-swe-agent" }], prFiles: { 5: ["src/app.ts"] } } };
  await product("https://github.com/acme/agent");
  await refreshAiLevelsJob(context(), fakeGithub(fixtures));
  await db.execute(sql`update repository_ai_levels set next_check_at = now() - interval '1 minute'`);
  fixtures["acme/agent"].prs = [{ number: 9, login: "devin-ai-integration" }, { number: 5, login: "copilot-swe-agent" }];
  const github = fakeGithub(fixtures);
  await refreshAiLevelsJob(context({ unseenIdleUntil: new Date(Date.now() + 60_000).toISOString() }), github);
  expect(github.calls.mock.calls.map(([query]) => String(query)).some((query) => query.includes("pullRequest(number: 9)"))).toBe(false);
  expect(await row("acme/agent")).toMatchObject({ level: 1, nextCheckAt: expect.any(Date) });
  expect((await row("acme/agent")).evidence.pendingPullRequests).toBeUndefined();
});

it("제품의 저장소 주소를 바꾸면 단계도 새 저장소의 판정으로 바뀐다(없으면 비운다)", async () => {
  const moved = await product("https://github.com/acme/first", { aiLevel: 2 });
  await db.insert(repositoryAiLevels).values({ repositoryKey: "acme/second", level: 3, rulesVersion: AI_LEVEL_RULES_VERSION, checkedAt: new Date(), nextCheckAt: new Date() });
  await update(moved.id, { repoUrl: "https://github.com/Acme/Second" });
  expect(await levelOf(moved.id)).toBe(3);
  await update(moved.id, { repoUrl: "https://gitlab.com/acme/second" });
  expect(await levelOf(moved.id)).toBeNull();
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

// ───────────────────────── 제작자 이메일(관리자 전용, 0194) ─────────────────────────
// 주소는 운영자가 가진 도메인의 시험용 하위 도메인(*.fixture.nomorevibe.com, 받는 곳 없음)이다 — 남의 실제 주소가 아니다.
// 예약 도메인(example.*)은 코드가 버린다 — 위 고정값의 기본 주소(kim@example.com)는 남지 않는다

/** 저장소 키·주소 차례(JS 비교 — DB 정렬 규칙에 기대지 않는다) */
const byKey = <T extends { repositoryKey: string; email: string }>(rows: T[]) => [...rows].sort((a, b) =>
  a.repositoryKey < b.repositoryKey ? -1 : a.repositoryKey > b.repositoryKey ? 1 : a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
const emailRows = async () => byKey(await db.select().from(repositoryMaintainerEmails))
  .map(({ repositoryKey, email, authorName, authorLogin, commitCount }) => ({ repositoryKey, email, authorName, authorLogin, commitCount }));
const emailLog = (ctx: JobContext<AiLevelCursor>) => vi.mocked(ctx.log).mock.calls.find(([event]) => event === "ai_level.maintainer_emails")?.[1];

it("제작자 이메일: 개인 계정 저장소에서 주인 로그인이 쓴 커밋의 사람 주소만 — 다른 기여자·조직 저장소·포크는 모으지 않고 까닭만 센다", async () => {
  const base = { message: "fix: x" };
  const fixtures: Record<string, Fixture> = {
    // 개인 계정 저장소(제품의 owner_type User): 주인 kim 의 주소만. 다른 기여자(lee)·비공개 주소·봇·AI 도구는 뺀다
    "kim/tool": { commits: [
      { sha: SHA(1), ...base, authorName: "Kim", authorEmail: "Kim@Fixture.NoMoreVibe.com", authorLogin: "Kim" },
      { sha: SHA(2), ...base, authorName: "Kim", authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" },
      { sha: SHA(3), ...base, authorName: "Kim", authorEmail: "kim.work@kr.fixture.nomorevibe.com", authorLogin: "kim" },
      { sha: SHA(4), ...base, authorName: "Lee", authorEmail: "lee@fixture.nomorevibe.com", authorLogin: "lee" },
      { sha: SHA(5), ...base, authorName: "Kim", authorEmail: "kim.unlinked@fixture.nomorevibe.com", authorLogin: null },
      { sha: SHA(6), ...base, authorName: "Kim", authorEmail: "1+kim@users.noreply.github.com", authorLogin: "kim" },
      { sha: SHA(7), ...base, authorName: "Cursor Agent", authorEmail: "cursoragent@cursor.com", authorLogin: "cursoragent" },
      { sha: SHA(8), ...base, authorName: "dependabot[bot]", authorEmail: "49699333+dependabot[bot]@users.noreply.github.com", authorLogin: null },
    ] },
    // 후보(수집 원본의 repo_meta.owner.type User) — 저장소 키 대소문자를 가리지 않는다
    "park/app": { commits: [{ sha: SHA(9), ...base, authorName: "Park", authorEmail: "park@stream.fixture.nomorevibe.com", authorLogin: "Park" }] },
    // 조직 저장소: 저장해 둔 주인 종류가 조직이면 커밋을 보지 않는다(로그인이 저장소 주인과 같아 보여도)
    "acme/org-tool": { commits: [{ sha: SHA(10), ...base, authorName: "Acme", authorEmail: "team@fixture.nomorevibe.com", authorLogin: "acme" }] },
    // 주인 종류를 모르는 조직 저장소: 커밋 작성자는 늘 사용자라 조직 로그인과 맞지 않는다
    "acmeorg/unknown": { commits: [{ sha: SHA(11), ...base, authorName: "Lee", authorEmail: "lee@fixture.nomorevibe.com", authorLogin: "lee" }] },
    "kim/forked": { isFork: true, commits: [{ sha: SHA(12), ...base, authorName: "Kim", authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" }] },
  };
  await product("https://github.com/kim/tool", { ownerType: "User" });
  await product("https://github.com/acme/org-tool", { ownerType: "Organization" });
  await product("https://github.com/acmeorg/unknown");
  await product("https://github.com/kim/forked", { ownerType: "User" });
  await db.insert(crawlCandidates).values({ repo: "Park/App", state: "new" });
  await db.insert(crawlDocuments).values({ repo: "Park/App", repoMeta: { owner: { login: "Park", type: "User" } } });
  const ctx = context();
  await refreshAiLevelsJob(ctx, fakeGithub(fixtures));
  expect(await emailRows()).toEqual([
    { repositoryKey: "kim/tool", email: "kim.work@kr.fixture.nomorevibe.com", authorName: "Kim", authorLogin: "kim", commitCount: 1 },
    { repositoryKey: "kim/tool", email: "kim@fixture.nomorevibe.com", authorName: "Kim", authorLogin: "Kim", commitCount: 2 },
    { repositoryKey: "park/app", email: "park@stream.fixture.nomorevibe.com", authorName: "Park", authorLogin: "Park", commitCount: 1 },
  ]);
  // 까닭별 수 — 주소는 로그에 없다
  expect(emailLog(ctx)).toEqual({ repositories: 2, saved: 3, denied: 0, organization: 1, fork: 1, noOwnerCommit: 1, noAddress: 0 });
  expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toMatch(/fixture\.nomorevibe\.com/i);

  // 관리자 화면이 읽는 모양 — 저장소 주소를 어떻게 적어도 같은 키. 지우기 양식에는 주소 대신 해시와 가린 주소
  const view = await maintainerEmailsForRepoUrl("https://github.com/Kim/Tool/");
  expect(view.repositoryKey).toBe("kim/tool");
  expect(view.rows.map(({ email, commits, denyKey, masked }) => ({ email, commits, denyKey, masked }))).toEqual([
    { email: "kim@fixture.nomorevibe.com", commits: 2, denyKey: maintainerEmailDenyHash("kim@fixture.nomorevibe.com"), masked: "k***@fixture.nomorevibe.com" },
    { email: "kim.work@kr.fixture.nomorevibe.com", commits: 1, denyKey: maintainerEmailDenyHash("kim.work@kr.fixture.nomorevibe.com"), masked: "k***@kr.fixture.nomorevibe.com" },
  ]);
  expect(await maintainerEmailsForRepoUrl("https://gitlab.com/kim/tool")).toEqual({ repositoryKey: null, rows: [] });

  // 다시 볼 때: 이번 창에 없는 예전 주소는 남기고(1년 보관 정리가 지운다), 이번에 본 주소는 커밋 수·마지막 확인을 고친다(처음 확인은 그대로)
  const first = (await db.select().from(repositoryMaintainerEmails).where(eq(repositoryMaintainerEmails.email, "kim@fixture.nomorevibe.com")))[0];
  await db.update(repositoryAiLevels).set({ nextCheckAt: new Date(Date.now() - 60_000) });
  fixtures["kim/tool"].commits = [{ sha: SHA(13), ...base, authorName: "", authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" }];
  await refreshAiLevelsJob(context(), fakeGithub(fixtures));
  const after = byKey(await db.select().from(repositoryMaintainerEmails).where(eq(repositoryMaintainerEmails.repositoryKey, "kim/tool")));
  expect(after.map(({ email, authorName, commitCount }) => ({ email, authorName, commitCount }))).toEqual([
    { email: "kim.work@kr.fixture.nomorevibe.com", authorName: "Kim", commitCount: 1 },
    { email: "kim@fixture.nomorevibe.com", authorName: "Kim", commitCount: 1 },
  ]);
  const kim = after.find((item) => item.email === "kim@fixture.nomorevibe.com")!;
  expect(kim.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
  expect(kim.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
  // 판정(repository_ai_levels.evidence)에는 주소가 섞이지 않는다
  const levels = await db.select({ evidence: repositoryAiLevels.evidence }).from(repositoryAiLevels);
  expect(JSON.stringify(levels)).not.toMatch(/fixture\.nomorevibe\.com/i);
});

it("제작자 이메일 지우기: 모든 저장소에서 바로 지우고 거부 목록(해시)에 넣는다 — 다음 수집에서 다시 모으지 않고, 작업 로그에는 주소·해시가 없다", async () => {
  const base = { message: "fix: x" };
  const fixtures: Record<string, Fixture> = {
    "kim/tool": { commits: [{ sha: SHA(1), ...base, authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" }, { sha: SHA(2), ...base, authorEmail: "kim.work@kr.fixture.nomorevibe.com", authorLogin: "kim" }] },
    "kim/other": { commits: [{ sha: SHA(3), ...base, authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" }] },
  };
  const tool = await product("https://github.com/kim/tool", { ownerType: "User" });
  await product("https://github.com/kim/other", { ownerType: "User" });
  await refreshAiLevelsJob(context(), fakeGithub(fixtures));
  expect((await emailRows()).map((row) => `${row.repositoryKey} ${row.email}`)).toEqual(["kim/other kim@fixture.nomorevibe.com", "kim/tool kim.work@kr.fixture.nomorevibe.com", "kim/tool kim@fixture.nomorevibe.com"]);

  const floor = await auditFloor();
  const denyKey = maintainerEmailDenyHash("kim@fixture.nomorevibe.com");
  expect(await denyMaintainerEmail({ slug: tool.slug, repoUrl: tool.repoUrl, denyKey, actor: "operator" })).toEqual({ deletedRows: 2, alreadyDenied: false, found: true });
  expect((await emailRows()).map((row) => `${row.repositoryKey} ${row.email}`)).toEqual(["kim/tool kim.work@kr.fixture.nomorevibe.com"]);
  expect(await db.select({ hash: maintainerEmailDenials.emailHash }).from(maintainerEmailDenials)).toEqual([{ hash: denyKey }]);
  const audit = await auditRowsAfter(floor, MAINTAINER_EMAIL_DENY_ACTION);
  expect(audit.map(({ target, ok, detail }) => ({ target, ok, detail }))).toEqual([{ target: tool.slug, ok: true,
    detail: { repositoryKey: "kim/tool", deletedRows: 2, alreadyDenied: false, found: true, repositories: 2 } }]);
  expect(JSON.stringify(audit)).not.toContain("fixture.nomorevibe.com");
  expect(JSON.stringify(audit)).not.toContain(denyKey);
  // 거부 목록에 있는 주소는 다시 모으지 않는다(다른 저장소에서 보여도) — 수에는 denied 로 남는다
  await db.update(repositoryAiLevels).set({ nextCheckAt: new Date(Date.now() - 60_000) });
  const ctx = context();
  await refreshAiLevelsJob(ctx, fakeGithub(fixtures));
  expect((await emailRows()).map((row) => `${row.repositoryKey} ${row.email}`)).toEqual(["kim/tool kim.work@kr.fixture.nomorevibe.com"]);
  expect(emailLog(ctx)).toMatchObject({ repositories: 1, saved: 1, denied: 2 });
  // 같은 해시를 다시 보내도(두 번 누름) 지울 것이 없고 거부 목록도 하나
  expect(await denyMaintainerEmail({ slug: tool.slug, repoUrl: tool.repoUrl, denyKey, actor: "operator" })).toEqual({ deletedRows: 0, alreadyDenied: true, found: false });
  expect(await db.select().from(maintainerEmailDenials)).toHaveLength(1);
  await expect(denyMaintainerEmail({ slug: tool.slug, repoUrl: tool.repoUrl, denyKey: "kim@fixture.nomorevibe.com", actor: "operator" })).rejects.toThrow("maintainer_email_deny_key_invalid");
});

it("제작자 이메일 지우기는 진행 중인 수집 쓰기를 기다린 뒤 지운다 — 거부 전에 목록을 읽은 쓰기가 주소를 되살리지 못한다", async () => {
  const tool = await product("https://github.com/kim/tool", { ownerType: "User" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const lockedNow = new Promise<void>((resolve) => { locked = resolve; });
  // 수집 쓰기 흉내: 공유 잠금을 잡고(거부 목록은 비어 있다고 읽은 뒤) 조금 있다 주소를 쓴다
  const writer = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext(${MAINTAINER_EMAIL_LOCK}))`);
    locked();
    await held;
    await tx.insert(repositoryMaintainerEmails).values({ repositoryKey: "kim/tool", email: "kim@fixture.nomorevibe.com", commitCount: 1 });
  });
  await lockedNow;
  let denied = false;
  const deny = denyMaintainerEmail({ slug: tool.slug, repoUrl: tool.repoUrl, denyKey: maintainerEmailDenyHash("kim@fixture.nomorevibe.com"), actor: "operator" })
    .then((result) => { denied = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(denied).toBe(false);
  release();
  await writer;
  expect(await deny).toEqual({ deletedRows: 1, alreadyDenied: false, found: true });
  expect(await emailRows()).toEqual([]);
});

it("제작자 이메일 기록이 실패해도(표가 없어도) 단계 판정은 적는다 — 로그에는 주소 없이 개수·코드만", async () => {
  const product1 = await product("https://github.com/kim/no-table", { ownerType: "User" });
  const fixtures: Record<string, Fixture> = { "kim/no-table": { commits: [{ sha: SHA(1), message: "fix", authorName: "Kim", authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" }],
    root: [{ name: ".windsurfrules", type: "blob" }] } };
  await db.execute(sql`ALTER TABLE repository_maintainer_emails RENAME TO repository_maintainer_emails_hidden`);
  const ctx = context();
  try {
    await refreshAiLevelsJob(ctx, fakeGithub(fixtures));
  } finally {
    await db.execute(sql`ALTER TABLE repository_maintainer_emails_hidden RENAME TO repository_maintainer_emails`);
  }
  expect(await levelOf(product1.id)).toBe(3);
  expect(ctx.log).toHaveBeenCalledWith("ai_level.maintainer_emails_failed", { repositories: 1, code: "42P01" });
  // 기록이 실패한 묶음은 saved 에 넣지 않는다(셀 것이 없으면 수집 결과 줄도 남기지 않는다)
  expect(emailLog(ctx)).toBeUndefined();
  expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain("kim@fixture.nomorevibe.com");
  expect(await db.select().from(repositoryMaintainerEmails)).toEqual([]);
});
