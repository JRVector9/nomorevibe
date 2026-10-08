import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, operationsAudit } from "@/lib/db/schema";
import { recordAdminAction } from "@/lib/operations/admin-log";
import { activityLog } from "@/app/admin/activity/query";
import { GET } from "@/app/admin/export/route";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";

/**
 * 요청 머리·쿠키를 흉내 낸다 — 로컬 운영자 이름은 쿠키에서, 브라우저는 머리에서 읽는다.
 * 작업 로그는 지울 수 없어 테스트 사이에 남는다 — 대상마다 이번 실행만의 이름을 붙여 가른다.
 */
const request = vi.hoisted(() => ({ operator: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "TestBrowser/1.0" }),
  cookies: async () => ({ get: (name: string) => (name === "nmv_operator" && request.operator ? { name, value: request.operator } : undefined) }),
}));

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

beforeAll(() => ensureSchema());
afterEach(() => { vi.unstubAllEnvs(); request.operator = undefined; });

describe("작업 로그 — 대상으로 찾기", () => {
  const slug = `tgt-${RUN}`;
  const repo = `Owner-${RUN}/Tool`;
  let candidateId = 0;
  beforeAll(async () => {
    const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://${slug}.test`, state: "published", reason: "passed",
      decidedBy: "auto", publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() }).returning({ id: crawlCandidates.id });
    candidateId = candidate.id;
    const row = (action: string, target: string, detail: Record<string, unknown> = {}) => ({ actor: "claude-code", action, target, detail });
    await db.insert(operationsAudit).values([
      row("product-ban", slug),
      row("candidate-approve", repo.toLowerCase()),
      row("ban-spam-campaign", "products", { count: 2, slugs: [slug, `other-${RUN}`] }),
      row("requeue-evidence-gated", "crawl_candidates", { count: 1, ids: [candidateId] }),
      // 이어지지 않아야 하는 줄 — 다른 제품, 다른 후보 id, 같은 숫자를 가진 소식 id
      row("product-ban", `other-${RUN}`),
      row("requeue-evidence-gated", "crawl_candidates", { count: 1, ids: [candidateId + 1_000_000] }),
      row("news-approve", "news:2건", { ids: [candidateId], changed: 2 }),
    ]);
  });
  afterAll(() => db.delete(crawlCandidates).where(eq(crawlCandidates.repo, repo)));

  const matched = async (target: string) => (await activityLog({ target }, 500)).map((row) => row.action).sort();
  const expected = ["ban-spam-campaign", "candidate-approve", "product-ban", "requeue-evidence-gated"];

  it("slug 로 찾으면 그 제품의 줄, 발행한 저장소의 후보 줄, 그것을 담은 일괄 스크립트 줄이 나온다", async () => {
    expect(await matched(slug)).toEqual(expected);
  });

  it("저장소로 찾아도 같다 — 대소문자와 GitHub 주소 꼴을 가리지 않는다", async () => {
    expect(await matched(repo.toUpperCase())).toEqual(expected);
    expect(await matched(`https://github.com/${repo}.git`)).toEqual(expected);
  });

  it("모르는 대상은 아무것도 내지 않는다", async () => {
    expect(await activityLog({ target: `nothing-${RUN}` })).toEqual([]);
  });
});

describe("로컬 운영자 이름", () => {
  it("로컬 로그인에서 이름을 적어 두면 그 이름이 처리자로 남는다 — 방식은 그대로 local", async () => {
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "1");
    request.operator = "지우";
    const target = `operator-${RUN}`;
    await recordAdminAction("local", { action: "product-ban", target });
    const [row] = await db.select().from(operationsAudit).where(eq(operationsAudit.target, target));
    expect(row).toMatchObject({ actor: "지우", actorKind: "local", userAgent: "TestBrowser/1.0" });
  });

  it("이름이 없으면 local, GitHub 로그인이면 쿠키를 보지 않는다", async () => {
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "1");
    await recordAdminAction("local", { action: "product-ban", target: `operator-none-${RUN}` });
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "0");
    request.operator = "사칭";
    await recordAdminAction("jr", { action: "product-ban", target: `operator-gh-${RUN}` });
    const rows = await db.select().from(operationsAudit).where(eq(operationsAudit.action, "product-ban"));
    expect(rows.find((row) => row.target === `operator-none-${RUN}`)).toMatchObject({ actor: "local", actorKind: "local" });
    expect(rows.find((row) => row.target === `operator-gh-${RUN}`)).toMatchObject({ actor: "jr", actorKind: "github" });
  });
});

describe("내보내기", () => {
  it("작업 로그를 화면의 거르기 그대로 내보내고, 내보낸 사실을 운영자 이름으로 남긴다", async () => {
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "1");
    request.operator = "지우";
    const target = `export-${RUN}`;
    await recordAdminAction("local", { action: "product-ban", target, detail: { note: "=SUM(1,2)" } });
    const floor = await auditFloor();
    const response = await GET(new Request(`http://localhost/admin/export?view=activity&format=csv&target=${target}`), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(target);
    // 쉼표가 든 요약은 따옴표로 감싸 한 칸에 둔다
    expect(lines[1]).toContain('"note: =SUM(1,2)"');
    const [logged] = await auditRowsAfter(floor, "export");
    expect(logged).toMatchObject({ actor: "지우", actorKind: "local", target: "export:activity",
      detail: { format: "csv", filters: { target }, rows: 1, truncated: false } });
  });
});
