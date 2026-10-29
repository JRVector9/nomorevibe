import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { pendingProfiles } from "@/lib/domain/products/search-profiles";
import { otherRoutesWaitingOnGroup } from "@/lib/llm/capacity-busy-targets";
import { productTaglineKoInputHash, productTaglineKoLogicalWorkKey, type ProductTaglineKoMember } from "@/lib/llm/capacity";
import { requestProductTaglineKoModelSlot, requestTextProfileModelSlot } from "@/lib/llm/capacity-repository";
import { admin, cleanupCapacityFixture, fixtureOwner, policy, setCapacityMode } from "./postprocess-backlog-fixture";
import { ensureSchema, resetTables } from "./setup";

const MODEL = "postprocess-backlog-profile-model";
let serial = 0;
async function seed() {
  const slug = `pb-profile-${++serial}`;
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline: `Tool ${slug}`,
    description: `Tool ${slug} for teams`, category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt: sql`now() - interval '1 day'` as unknown as Date }).returning({ id: products.id, slug: products.slug });
  return row;
}
const request = (owner: { instanceId: string; bootId: string }, routeId: string, workKey: string) => ({ requestId: randomUUID(), owner,
  workKey, class: "background" as const, pool: "text" as const, routeId, provider: "abcllm", model: MODEL });
async function holdProfile(owner: { instanceId: string; bootId: string }, productId: number) {
  return requestTextProfileModelSlot(request(owner, "product-search-profile", `text:profile:${productId}:${"e".repeat(64)}`), productId);
}
async function waitTagline(owner: { instanceId: string; bootId: string }, productId: number, slug: string) {
  const members: ProductTaglineKoMember[] = [{ productId, slug, sourceIdentityHash: "a".repeat(64), sourceHash: "b".repeat(64), cache: { kind: "absent" } }];
  return requestProductTaglineKoModelSlot(request(owner, "product-tagline-ko",
    `${productTaglineKoLogicalWorkKey(members)}:${productTaglineKoInputHash({ members, model: MODEL })}`), members);
}
const ids = async (owner?: { instanceId: string; bootId: string }) => (await pendingProfiles(12, owner)).map(task => task.product.id);
const routes = [{ routeId: "product-search-profile", model: MODEL }, { routeId: "product-tagline-ko", model: MODEL }];

beforeAll(ensureSchema);
beforeEach(resetTables);
afterEach(cleanupCapacityFixture);
afterAll(() => admin.end({ timeout: 5 }));

it("never selects a product another request already holds, so one product has one request and the head cannot pin the tick", async () => {
  const held = await seed(), free = await seed(), third = await seed();
  await setCapacityMode("open", policy(routes));
  expect(await holdProfile(fixtureOwner("profile-other"), held.id)).toMatchObject({ kind: "granted" });
  const self = fixtureOwner("profile-self");
  const picked = await ids(self);
  expect(picked).not.toContain(held.id);
  expect(picked.sort((a, b) => a - b)).toEqual([free.id, third.id]);
  expect(new Set(picked).size).toBe(picked.length);
  // 묵은 내 요청(입력 해시가 지금과 다름)이 남은 제품도 새로 집지 않는다 — 같은 제품의 두 번째 요청을 만들지 않는다
  expect(await holdProfile(self, free.id)).toMatchObject({ kind: "granted" });
  expect(await ids(self)).toEqual([third.id]);
  await setCapacityMode("disabled");
  expect((await ids(self)).sort((a, b) => a - b)).toEqual([held.id, free.id, third.id]);
});

it("reports another route waiting on the same group only while it is really queued under the current open policy", async () => {
  const a = await seed(), b = await seed();
  await setCapacityMode("open", policy(routes, 1));
  expect(await otherRoutesWaitingOnGroup("product-search-profile", MODEL)).toBe(false);
  // 그룹 자리 하나를 키워드가 쥐고, 소개 짓기는 줄을 선다
  expect(await holdProfile(fixtureOwner("profile-group-a"), a.id)).toMatchObject({ kind: "granted" });
  expect(await waitTagline(fixtureOwner("profile-group-b"), b.id, b.slug)).toMatchObject({ kind: "deferred", reason: "capacity" });
  expect(await otherRoutesWaitingOnGroup("product-search-profile", MODEL)).toBe(true);
  // 자기 route 의 대기는 '남'이 아니다
  expect(await otherRoutesWaitingOnGroup("product-tagline-ko", MODEL)).toBe(false);
  expect(await otherRoutesWaitingOnGroup("product-search-profile", "another-model")).toBe(false);
  await setCapacityMode("draining");
  expect(await otherRoutesWaitingOnGroup("product-search-profile", MODEL)).toBe(false);
});
