import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { products } = await import("@/lib/db/schema");
const { countProducts, countProductsByFilter, listProducts } = await import("@/lib/domain/products/repository");
const { PRODUCT_FILTERS } = await import("@/app/admin/products/filters");
const { scanProductNames } = await import("@/lib/domain/products/name-review");
const { clearAllMemos } = await import("@/lib/cache/memo");
const { main } = await import("@/scripts/normalize-product-names");

/** UX-33 — 관리자 '이름 확인 필요'와 기존 제품 백필(scripts/normalize-product-names.ts) */
async function product(slug: string, name: string, repo: string | null, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, name, url: `https://${slug}.example`, repoUrl: repo ? `https://github.com/${repo}` : null, tagline: "t", description: "d",
    category: "Dev", status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "e", ...values,
  });
}
const names = async () => Object.fromEntries((await db.select({ slug: products.slug, name: products.name }).from(products).orderBy(asc(products.slug)))
  .map((row) => [row.slug, row.name]));

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  clearAllMemos();
  vi.spyOn(console, "log").mockImplementation(() => {});
  await product("shouye", "首页", "someone/shuiyun-notes");
  await product("wireshark", "Wireshark • Go Deep", "wireshark/wireshark");
  await product("erpnext", "Flexible Open-Source ERP & CRM for SMBs", "frappe/erpnext");
  await product("linkedin", "LINKEDIN AGENT", "acme/li-outreach");
  await product("transformer", "🚀 transformer-architecture", "acme/transformer-architecture");
  await product("workspace", "The AI Workspace", "acme/atlas");
  // 걸리지만 내세울 이름이 없다 — 화면에만 보이고 백필은 건드리지 않는다
  await product("homeless", "Home", null);
  // 멀쩡한 이름
  await product("vscode", "Visual Studio Code", "microsoft/vscode");
  // 주인이 있으면 주인이 정한다 — 걸려도 보지 않는다
  await product("owned", "首页", "someone/owned-site", { claimedAt: new Date() });
  await product("registered", "LINKEDIN AGENT", "acme/registered", { source: "skill", status: "verified" });
  await product("banned", "首页", "someone/banned", { status: "banned" });
});

const FLAGGED = ["erpnext", "homeless", "linkedin", "shouye", "transformer", "wireshark", "workspace"];

describe("이름 확인 필요", () => {
  it("주인 없는 공개분 중 걸린 것만 — 관리자 칩의 수와 목록이 같다", async () => {
    expect((await scanProductNames()).map((row) => row.slug).sort()).toEqual(FLAGGED);
    const filter = PRODUCT_FILTERS["이름 확인 필요"];
    expect((await listProducts({ ...filter, limit: 25 })).map((row) => row.slug).sort()).toEqual(FLAGGED);
    expect(await countProducts(filter)).toBe(7);
    expect((await countProductsByFilter(PRODUCT_FILTERS))["이름 확인 필요"]).toBe(7);
    expect((await countProductsByFilter(PRODUCT_FILTERS, "wire"))["이름 확인 필요"]).toBe(1);
  });
});

describe("백필 스크립트", () => {
  it("기본은 보여 주기만 한다", async () => {
    const before = await names();
    expect(await main([])).toEqual({ applied: [], skipped: 0 });
    expect(await names()).toEqual(before);
  });

  it("--apply 는 제안대로 바꾸고 되돌리기 파일과 작업 로그를 남기며, --revert 로 그대로 돌아간다", async () => {
    const floor = await auditFloor();
    const before = await names();
    const dir = mkdtempSync(join(tmpdir(), "names-"));
    const revertFile = join(dir, "revert.json");
    // 계획을 세운 뒤 사람이 고친 이름은 지킨다
    await db.update(products).set({ name: "Atlas Notes" }).where(eq(products.slug, "workspace"));
    clearAllMemos();
    const planFile = join(dir, "plan.json");
    await main(["--out", planFile]);
    await db.update(products).set({ name: "Wireshark (by hand)" }).where(eq(products.slug, "wireshark"));

    const result = await main(["--apply", "--plan", planFile, "--actor", "tester", "--revert-out", revertFile]);
    // 제목 안의 말로 고친 것만 바꾼다 — 저장소 이름으로 대신한 '首页'→'Shuiyun Notes'·'Flexible…'→'Erpnext' 는 사람이 고른다
    expect(result.applied.map((change) => change.slug).sort()).toEqual(["linkedin", "transformer"]);
    expect(result.skipped).toBe(1);
    expect(await names()).toMatchObject({
      shouye: "首页", erpnext: "Flexible Open-Source ERP & CRM for SMBs", linkedin: "Linkedin Agent", transformer: "transformer-architecture",
      wireshark: "Wireshark (by hand)", workspace: "Atlas Notes", homeless: "Home", vscode: "Visual Studio Code", owned: "首页",
      registered: "LINKEDIN AGENT", banned: "首页",
    });
    expect(existsSync(revertFile)).toBe(true);
    expect(JSON.parse(readFileSync(revertFile, "utf8")).changes).toHaveLength(3);
    const [log] = await auditRowsAfter(floor, "normalize-product-names");
    expect(log).toMatchObject({ actor: "tester", target: "products", ok: true });
    expect(log.detail).toMatchObject({ applied: 2, skipped: 1, revertFile, issues: { all_caps: 1, emoji_prefix: 1 } });

    // 다시 계획하면 남은 것은 사람이 볼 것 — 저장소 이름 제안 둘과 제안 없는 'Home'
    clearAllMemos();
    expect((await scanProductNames()).map((row) => row.slug).sort()).toEqual(["erpnext", "homeless", "shouye"]);

    await main(["--revert", revertFile, "--actor", "tester"]);
    expect(await names()).toEqual({ ...before, workspace: "Atlas Notes", wireshark: "Wireshark (by hand)" });
    expect(await auditRowsAfter(floor, "revert-product-names")).toHaveLength(1);
  });

  it("적용·되돌리기에는 누가 했는지가 있어야 한다", async () => {
    await expect(main(["--apply"])).rejects.toThrow("--actor");
  });
});
