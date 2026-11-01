import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { pendingProfiles } from "@/lib/domain/products/search-profiles";
import { requestTextProfileModelSlot } from "@/lib/llm/capacity-repository";
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
const ids = async (owner?: { instanceId: string; bootId: string }) => (await pendingProfiles(12, owner)).map(task => task.product.id);
// 2026-10-31: `otherRoutesWaitingOnGroup`(다른 route 의 대기를 보고 양보)은 없앴다 — 하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다
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

it("reselects the final product after its previous boot's reservation expires without another admission expiring it first", async () => {
  const product = await seed();
  await setCapacityMode("open", policy(routes));
  const previous = fixtureOwner("profile-expired"), current = fixtureOwner("profile-successor");
  const held = await holdProfile(previous, product.id);
  expect(held.kind).toBe("granted");
  if (held.kind !== "granted") throw new Error("fixture_reservation_missing");
  expect(await ids(current)).toEqual([]);
  await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 second'
    WHERE request_id=${held.reservation.requestId}::uuid`;
  expect(await ids(current)).toEqual([product.id]);
  // Selection only reads. The canonical admission still owns reservation_expired and the next reservation.
  const [retainedState] = await admin`SELECT state FROM model_capacity_requests WHERE request_id=${held.reservation.requestId}::uuid`;
  expect(retainedState.state).toBe("reserved");
  expect(await holdProfile(current, product.id)).toMatchObject({ kind: "granted" });
  const [expiredState] = await admin`SELECT state FROM model_capacity_requests WHERE request_id=${held.reservation.requestId}::uuid`;
  expect(expiredState.state).toBe("withdrawn");
  expect((await admin`SELECT kind FROM model_capacity_events WHERE request_id=${held.reservation.requestId}::uuid ORDER BY id`)
    .map(row => row.kind)).toEqual(["queued", "reserved", "reservation_expired"]);
});
