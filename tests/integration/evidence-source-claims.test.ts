import { afterAll, afterEach, beforeAll, expect, it as actualIt, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { evidenceSettings, jobs, productEvidenceSources, products } from "@/lib/db/schema";
import { refreshSiteFingerprint } from "@/lib/domain/evidence/providers/site-fingerprint";
import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { evidenceSourceClaims, evidenceSourceControl } from "@/lib/db/evidence-source-claims-schema";
import { productRefreshRequests, productLinks } from "@/lib/db/schema";
import { claimCanonicalEvidenceSource, renewCanonicalEvidenceSource, recordCanonicalEvidenceSource, abandonCanonicalEvidenceSource,
 executeCanonicalEvidenceSource } from "@/lib/domain/evidence/source-claims";
import { sourceRefreshKey } from "@/lib/domain/evidence/source-contract";
import { refreshProductEvidence } from "@/lib/domain/evidence/refresh";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import { ensureSchema } from "./setup";

const prefix = `pr08-${randomUUID().slice(0, 8)}`;
const owned: string[] = [];
const ownedIds: number[]=[];
const universe = new Map<string, unknown>();
const tables=["products","product_evidence_sources","product_links","product_refresh_requests","evidence_source_claims","evidence_source_control","evidence_settings","jobs","operations_observations","cdn_purges"];
async function rawTable(table:string){return (await db.execute(sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from ${sql.identifier(table)} t`))[0].rows;}
const active = new Set<Promise<unknown>>();
function track<T>(promise: Promise<T>) { active.add(promise); return promise; }
async function drain() { const work = [...active]; await Promise.allSettled(work); work.forEach(p => active.delete(p)); }
function it(name: string, body: () => Promise<void>) { actualIt(name, () => track(body())); }
const snapshots = new Map<string, Record<string, unknown> | undefined>();
const sourceJobs = ["product-evidence-refresh", "product-site-evidence-refresh"];
let cleanup: Promise<void> | undefined;
async function save(table: string, key: string, value: string | number) {
  const [row] = await db.execute(sql`select to_jsonb(t) as row from ${sql.identifier(table)} t where ${sql.identifier(key)}=${value}`);
  snapshots.set(JSON.stringify([table, key, value]), row?.row as Record<string, unknown> | undefined);
}
async function restore(table: string, key: string, value: string | number) {
  const snapshotKey = JSON.stringify([table, key, value]);
  if (!snapshots.has(snapshotKey)) return;
  const original = snapshots.get(snapshotKey), name = sql.identifier(table), id = sql.identifier(key);
  if (!original) { await db.execute(sql`delete from ${name} where ${id}=${value}`); return; }
  const fields = sql.join(Object.keys(original).filter(field => field !== key).map(field => sql`${sql.identifier(field)}=x.${sql.identifier(field)}`), sql`, `);
  await db.execute(sql`update ${name} set ${fields} from jsonb_populate_record(null::${name}, ${JSON.stringify(original)}::jsonb) x where ${name}.${id}=${value}`);
  const [row] = await db.execute(sql`select to_jsonb(t) as row from ${name} t where ${id}=${value}`);
  expect(row.row).toEqual(original);
}
const suspendedProducts:Record<string,unknown>[]=[];
const suspendedRequests:Record<string,unknown>[]=[];
async function restoreSuspended(table:string,key:string,fields:string[],rows:Record<string,unknown>[]) {
 for(const original of rows){
  const [current]=await db.execute(sql`select to_jsonb(t) as row from ${sql.identifier(table)} t where ${sql.identifier(key)}=${original[key] as number}`);
  expect(current?.row).toBeDefined();
  const actual={...(current.row as Record<string,unknown>)};
  if(table==="products") expect(actual.status).toBe("banned");
  else expect(new Date(actual.next_attempt_at as string).toISOString()).toBe("9999-01-01T00:00:00.000Z");
  for(const field of fields) actual[field]=original[field];
  expect(actual).toEqual(original);
  const assignments=sql.join(fields.map(field=>sql`${sql.identifier(field)}=x.${sql.identifier(field)}`),sql`, `);
  await db.execute(sql`update ${sql.identifier(table)} t set ${assignments} from jsonb_populate_record(null::${sql.identifier(table)},${JSON.stringify(original)}::jsonb) x where t.${sql.identifier(key)}=x.${sql.identifier(key)}`);
 }
}
async function restoreFixturePurges() {
 const original=universe.get("cdn_purges") as Record<string,unknown>[]|undefined;
 if(!original)return;
 const current=await rawTable("cdn_purges") as Record<string,unknown>[];
 const originalIds=new Set(original.map(row=>row.id));
 for(const row of original)expect(current.find(value=>value.id===row.id)).toEqual(row);
 const touched=new Set([...owned,...suspendedProducts.map(row=>row.slug as string)]);
 const added=current.filter(row=>!originalIds.has(row.id));
 for(const row of added)expect(touched.has(row.slug as string)).toBe(true);
 for(const row of added){
  const removed=await db.execute(sql`delete from cdn_purges p where p.id=${row.id as number}
   and p.slug=${row.slug as string} and to_jsonb(p)=${JSON.stringify(row)}::jsonb returning p.id`);
  expect(removed).toHaveLength(1);
 }
}
async function allSteps(steps: (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "source fixture cleanup");
}
async function waitForHolderReady(ready: Promise<void>, holder: Promise<unknown>) {
 await Promise.race([ready,holder]);
}
beforeAll(() => track((async () => {
  ensureSchema();
  for(const table of tables) universe.set(table,await rawTable(table));
  // Global existing consumer tests must not visit foreign product/request demand.
  // Only the selector fields are suspended; all original raw fields are checked/restored.
  suspendedProducts.push(...(universe.get("products") as Record<string,unknown>[]).filter(row=>["seeded","verified"].includes(row.status as string)));
  suspendedRequests.push(...(universe.get("product_refresh_requests") as Record<string,unknown>[]).filter(row=>Number(row.requested_version)>Number(row.completed_version)));
  for(const row of suspendedProducts) await db.update(products).set({status:"banned"}).where(eq(products.id,row.id as number));
  for(const row of suspendedRequests) await db.update(productRefreshRequests).set({nextAttemptAt:new Date("9999-01-01T00:00:00Z")}).where(eq(productRefreshRequests.productId,row.product_id as number));
  await save("evidence_source_control", "id", 1);
  await save("evidence_settings", "id", 1);
  for (const name of sourceJobs) {
    await save("jobs", "name", name);
    await save("operations_observations", "key", `job:${name}`);
  }
  await db.insert(evidenceSettings).values({ id: 1, values: {} }).onConflictDoUpdate({ target: evidenceSettings.id, set: { values: {} } });
  await db.update(jobs).set({ lockedAt: null, leaseToken: null, notBefore: null }).where(eq(jobs.name, "product-evidence-refresh"));
})()));
afterEach(async () => { await drain(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.update(evidenceSettings).set({values:{}}).where(eq(evidenceSettings.id,1)); await db.update(evidenceSourceControl).set({ enabled: false, epoch: 1, cursor: 0 }).where(eq(evidenceSourceControl.id, 1)); });
afterAll(() => cleanup ??= (async () => {
  await drain(); await allSteps([
    () => restore("evidence_source_control", "id", 1),
    async () => { if (owned.length) {
      if (ownedIds.length) { await db.delete(evidenceSourceClaims).where(inArray(evidenceSourceClaims.productId, ownedIds));
        await db.delete(productRefreshRequests).where(inArray(productRefreshRequests.productId, ownedIds)); }
      await db.delete(productLinks).where(inArray(productLinks.slug, owned));
      await db.delete(productEvidenceSources).where(inArray(productEvidenceSources.slug, owned));
      await db.delete(products).where(inArray(products.slug, owned));
    } },
    () => restore("evidence_settings", "id", 1),
    ...sourceJobs.map(name => () => restore("jobs", "name", name)),
    ...sourceJobs.map(name => () => restore("operations_observations", "key", `job:${name}`)),
    ()=>restoreSuspended("products","id",["status"],suspendedProducts),
    ()=>restoreSuspended("product_refresh_requests","product_id",["next_attempt_at"],suspendedRequests),
    ()=>restoreFixturePurges(),
    async()=>{for(const [table,original] of universe) expect(await rawTable(table),table).toEqual(original);},
  ]);
})());
async function target() {
  const slug = `${prefix}-${owned.length}`;
  expect(await db.select().from(products).where(eq(products.slug, slug))).toEqual([]);
  expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,slug))).toEqual([]);
  expect(await db.select().from(productLinks).where(eq(productLinks.slug,slug))).toEqual([]); owned.push(slug);
  const [row] = await db.insert(products).values({ slug, url: `https://${slug}.example`, name: slug, tagline: "Evidence", description: "Evidence",
    category: "Other", status: "verified", verifyToken: "test", editTokenHash: "a".repeat(64) }).returning({ productId: products.id, slug: products.slug, url: products.url });
  expect(await db.select().from(evidenceSourceClaims).where(eq(evidenceSourceClaims.productId,row.productId))).toEqual([]);
  expect(await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId,row.productId))).toEqual([]);
  ownedIds.push(row.productId);
  return row;
}
async function withLease<T>(run: (lease: JobLease) => Promise<T>) {
  let value!: T, error: unknown;
  const result = await track(runJob<null>("product-evidence-refresh", async ctx => {
    try { value = await run(ctx.lease!); return { done: true }; } catch (failure) { error = failure; throw failure; }
  }));
  if (error) { await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "product-evidence-refresh")); throw error; }
  expect(result.status).toBe("completed"); return value;
}
const response = (url: string) => ({ ok: true as const, status: 200, finalUrl: url, headers: new Headers(),
  body: Buffer.from('<a href="https://github.com/owner/repo">Source code</a>') });
it("normal canonical evidence commits with a real job and complete body", async () => {
  const row = await target();
  expect(await withLease(lease => refreshSiteFingerprint(row, { lease, fetch: async () => response(row.url) }))).toBe(true);
  expect((await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, row.slug)))[0]).toMatchObject({ state: "ok", normalizedFacts: { repositoryKeys: ["owner/repo"] } });
});
it("a URL edit during the real collector cannot attach an old response to current evidence", async () => {
  const row = await target();
  await withLease(async lease => {
    await expect(refreshSiteFingerprint(row, { lease, fetch: async () => {
      await db.update(products).set({ url: `${row.url}/replacement` }).where(eq(products.id, row.productId)); return response(row.url);
    } })).rejects.toThrow("evidence_source_input_changed");
  });
  expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, row.slug))).toEqual([]);
});
it("an unpublished product cannot acquire an authoritative canonical result after HTTP", async () => {
  const row = await target();
  await withLease(async lease => {
    await expect(refreshSiteFingerprint(row, { lease, fetch: async () => {
      await db.update(products).set({ status: "banned" }).where(eq(products.id, row.productId)); return response(row.url);
    } })).rejects.toThrow("evidence_source_input_changed");
  });
  expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, row.slug))).toEqual([]);
});
it("a settings revision during HTTP rejects the old parser-policy result", async () => {
  const row = await target();
  await db.update(evidenceSettings).set({ values: {} }).where(eq(evidenceSettings.id, 1));
  await withLease(async lease => {
    await expect(refreshSiteFingerprint(row, { lease, fetch: async () => {
      await db.update(evidenceSettings).set({ values: { linkCheckHours: 48 } }).where(eq(evidenceSettings.id, 1)); return response(row.url);
    } })).rejects.toThrow("evidence_source_input_changed");
  });
  expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, row.slug))).toEqual([]);
});

const owner = { instanceId: "m3-source-test", bootId: "boot-1" };
async function enabled() { await db.update(evidenceSourceControl).set({ enabled: true, cursor: 0 }).where(eq(evidenceSourceControl.id, 1)); }
async function claimed(productId: number, job?: JobLease) { const value = await claimCanonicalEvidenceSource({ owner, productId, job }); expect(value).not.toBeNull(); return value!; }
const collected = (url: string) => ({ state: "ok" as const, facts: { type: "site_fingerprint" as const, finalUrl: url,
 bodyDigest: "a".repeat(64), parserVersion: 1 as const, repositoryKeys: ["owner/repo"] }, etag: null, lastModified: null });
async function rawClaim(id: number) { return (await db.execute(sql`select to_jsonb(c) as row from evidence_source_claims c where product_id=${id}`))[0]?.row; }

it("disabled admission has no durable claim or HTTP", async () => {
 const row=await target(), fetch=vi.fn();
 expect(await executeCanonicalEvidenceSource({ owner, productId: row.productId, fetch })).toEqual({state:"idle",factsChanged:0});
 expect(fetch).not.toHaveBeenCalled(); expect(await rawClaim(row.productId)).toBeUndefined();
});
it("actual claim, renewed original receipt and captured source request settle atomically", async () => {
 await enabled(); const row=await target();
 await db.insert(productRefreshRequests).values({productId:row.productId,slug:row.slug,actor:"admin:test",force:true,
 nextAttemptAt:new Date(Date.now()+86400000)});
 await withLease(async job=>{
  const lease=await claimed(row.productId,job);
  expect(lease.binding.requestVersion).toBe(1);
  expect((await renewCanonicalEvidenceSource(lease))?.token).toBe(lease.token);
  expect(await recordCanonicalEvidenceSource(lease,collected(row.url))).toEqual({state:"recorded",factsChanged:1});
  const [request]=await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId,row.productId));
  expect(request).toMatchObject({activeVersion:1,completedVersion:0,progress:{completedKeys:[sourceRefreshKey(lease.binding)]}});
  expect((await rawClaim(row.productId)) as object).toMatchObject({token:null,last_outcome:"ok"});
  expect(await claimCanonicalEvidenceSource({owner,productId:row.productId,job})).toBeNull();
  await expect(recordCanonicalEvidenceSource(lease,collected(row.url))).rejects.toThrow("evidence_source_lease_lost");
 });
});
it("two concurrent owners have one winner and healthy old-control-epoch ownership stays intact", async () => {
 await enabled(); const row=await target();
 const [a,b]=await Promise.all([claimCanonicalEvidenceSource({owner,productId:row.productId}),
  claimCanonicalEvidenceSource({owner:{...owner,bootId:"boot-2"},productId:row.productId})]);
 expect([a,b].filter(Boolean)).toHaveLength(1); const lease=(a??b)!;
 const before=await rawClaim(row.productId);
 await db.update(evidenceSourceControl).set({epoch:2}).where(eq(evidenceSourceControl.id,1));
 expect(await claimCanonicalEvidenceSource({owner,productId:row.productId})).toBeNull();
 expect(await rawClaim(row.productId)).toEqual(before);
 expect(await recordCanonicalEvidenceSource(lease,collected(row.url))).toEqual({state:"input_changed",factsChanged:0});
});
for (const change of ["url","public","settings","source"]) it(`current ${change} changes reject authoritative source storage and release only the original owner`, async()=>{
 await enabled(); const row=await target(), lease=await claimed(row.productId);
 if(change==="url") await db.update(products).set({url:row.url+"/new"}).where(eq(products.id,row.productId));
 if(change==="public") await db.update(products).set({status:"banned"}).where(eq(products.id,row.productId));
 if(change==="settings") await db.update(evidenceSettings).set({values:{linkCheckHours:48}}).where(eq(evidenceSettings.id,1));
 if(change==="source") await db.insert(productEvidenceSources).values({slug:row.slug,kind:"documentation",provider:"product_site",sourceKey:"canonical_site",sourceUrl:row.url,state:"failed"});
 const before=await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug));
 expect(await recordCanonicalEvidenceSource(lease,collected(row.url))).toEqual({state:"input_changed",factsChanged:0});
 expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).toEqual(before);
 expect((await rawClaim(row.productId)) as object).toMatchObject({token:null,last_outcome:"input_changed"});
 if(change==="settings") await db.update(evidenceSettings).set({values:{}}).where(eq(evidenceSettings.id,1));
});
it("expired and forged tokens cannot save or release a replacement owner's lease", async()=>{
 await enabled(); const row=await target(), lease=await claimed(row.productId);
 await expect(recordCanonicalEvidenceSource({...lease,owner:{...owner,bootId:"other"}},collected(row.url))).rejects.toThrow("evidence_source_lease_lost");
 await db.update(evidenceSourceClaims).set({leaseUntil:new Date(0)}).where(eq(evidenceSourceClaims.productId,row.productId));
 await expect(recordCanonicalEvidenceSource(lease,collected(row.url))).rejects.toThrow("evidence_source_lease_lost");
 const replacement=await claimed(row.productId), before=await rawClaim(row.productId);
 expect(replacement.epoch).toBe(lease.epoch+1);
 await expect(abandonCanonicalEvidenceSource(lease)).rejects.toThrow("evidence_source_lease_lost");
 expect(await rawClaim(row.productId)).toEqual(before); await abandonCanonicalEvidenceSource(replacement);
});
it("canonical makes progress despite GitHub request quota while all-required completion stays false",async()=>{
 await enabled(); const row=await target();
 await db.insert(productRefreshRequests).values({productId:row.productId,slug:row.slug,actor:"admin:test",force:true,
 activeVersion:1,activeForce:true,nextAttemptAt:new Date(Date.now()+86400000),
 progress:{completedKeys:[],retryAfterByKey:{github:new Date(Date.now()+86400000).toISOString()}}});
 const result=await executeCanonicalEvidenceSource({owner,productId:row.productId,fetch:async()=>response(row.url)});
 expect(result.state).toBe("recorded");
 const [request]=await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId,row.productId));
 expect(request.completedVersion).toBe(0); expect(request.progress.completedKeys).toHaveLength(1);
 const site=vi.fn();
 const waiting=await refreshProductEvidence(row.slug,{productId:row.productId,force:true,progress:{completedKeys:[],retryAfterByKey:{}},dependencies:{siteFingerprint:site}});
 expect(waiting.complete).toBe(false); expect(site).not.toHaveBeenCalled();
});
it("typed HTTP defer and incomplete body use no source attempt or scheduling turn",async()=>{
 await enabled(); const row=await target();
 const defer=new HttpOriginPermitError("unavailable");
 await expect(executeCanonicalEvidenceSource({owner,productId:row.productId,fetch:async()=>{throw defer;}})).rejects.toBe(defer);
 expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).toEqual([]);
 expect((await db.select().from(evidenceSourceControl))[0].cursor).toBe(0);
 expect(await executeCanonicalEvidenceSource({owner,productId:row.productId,fetch:async()=>({...response(row.url),body:Buffer.alloc(2*1024*1024)})})).toEqual({state:"incomplete",factsChanged:0});
 expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).toEqual([]);
 expect((await db.select().from(evidenceSourceControl))[0].cursor).toBe(0);
});
it("outbox failure rolls back source, progress, cursor and lease release",async()=>{
 await enabled(); const row=await target(), lease=await claimed(row.productId), before=await rawClaim(row.productId);
 const trigger=prefix.replaceAll("-","_")+"_fail";
 expect(await db.execute(sql`select 1 from pg_trigger where tgname=${trigger}`)).toEqual([]);
 let installed=false;const bodyErrors:unknown[]=[];
 await db.execute(sql`create function ${sql.identifier(trigger)}() returns trigger language plpgsql as 'begin raise exception ''source_outbox_fault''; end'`);
 try{
  await db.execute(sql`create trigger ${sql.identifier(trigger)} before insert or update on jobs for each row when(new.name='product-evidence-refresh') execute function ${sql.identifier(trigger)}()`);installed=true;
  await expect(recordCanonicalEvidenceSource(lease,collected(row.url))).rejects.toThrow();
  expect(await rawClaim(row.productId)).toEqual(before);
  expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).toEqual([]);
  expect((await db.select().from(evidenceSourceControl))[0].cursor).toBe(0);
 }catch(error){bodyErrors.push(error);}finally{await allSteps([
  async()=>{if(installed)await db.execute(sql`drop trigger ${sql.identifier(trigger)} on jobs`);},
  ()=>db.execute(sql`drop function ${sql.identifier(trigger)}()`),
 ],bodyErrors);}
 await abandonCanonicalEvidenceSource(lease);
});

it("source-only completion updates repository relationship from existing facts without GitHub refetch", async()=>{
 await enabled(); const row=await target();
 await db.insert(productLinks).values({slug:row.slug,kind:"repository",url:"https://github.com/owner/repo",normalizedKey:"owner/repo",visible:true,declarationSource:"maker"});
 await db.insert(productEvidenceSources).values({slug:row.slug,kind:"repository",provider:"github",sourceKey:"owner/repo",sourceUrl:"https://github.com/owner/repo",state:"ok",
 normalizedFacts:{type:"github_repository",homepage:null,relationshipState:"maker_reported"},nextAttemptAt:new Date(Date.now()+86400000)});
 expect((await executeCanonicalEvidenceSource({owner,productId:row.productId,fetch:async()=>response(row.url)})).state).toBe("recorded");
 expect((await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).find(x=>x.kind==="repository")?.normalizedFacts).toMatchObject({relationshipState:"site_link"});
});
it("a stale product checkpoint cannot erase independently committed canonical request progress",async()=>{
 await enabled(); const row=await target();
 await db.insert(productRefreshRequests).values({productId:row.productId,slug:row.slug,actor:"test",force:true,activeVersion:1,activeForce:true});
 const [snapshot]=await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId,row.productId));
 expect((await executeCanonicalEvidenceSource({owner,productId:row.productId,fetch:async()=>response(row.url)})).state).toBe("recorded");
 const {saveProductRefreshProgress}=await import("@/lib/domain/evidence/refresh-requests");
 await saveProductRefreshProgress(snapshot,{completedKeys:[],retryAfterByKey:{}},{now:new Date()});
 const [current]=await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId,row.productId));
 expect(current.progress.completedKeys).toEqual([sourceRefreshKey({kind:"documentation",sourceKey:"canonical_site",sourceUrl:row.url})]);
 expect(current.completedVersion).toBe(0);
});

function configureSourceOwner() {
 for(const [key,value] of Object.entries({ROLE_LEASE_ROLE:"crawler",ROLE_LEASE_INSTANCE_ID:owner.instanceId,ROLE_LEASE_BOOT_ID:owner.bootId,
 ROLE_LEASE_RELEASE:"test",ROLE_LEASE_EPOCH:"1"})) vi.stubEnv(key,value);
}
it("existing actual job uses a source lane even when the product GitHub request is not due",async()=>{
 await enabled(); configureSourceOwner(); const row=await target();
 await db.update(products).set({createdAt:new Date("1900-01-01")}).where(eq(products.id,row.productId));
 await db.insert(productRefreshRequests).values({productId:row.productId,slug:row.slug,actor:"admin:test",force:true,activeVersion:1,activeForce:true,
 nextAttemptAt:new Date(Date.now()+86400000),progress:{completedKeys:[],retryAfterByKey:{github:new Date(Date.now()+86400000).toISOString()}}});
 const net=await import("@/lib/net/fetch"); vi.spyOn(net,"fetchCapped").mockImplementation(async url=>response(url));
 const {refreshProductEvidenceJob}=await import("@/lib/jobs/products/evidence-refresh");
 const github=vi.fn();
 expect((await runJob<{afterSlug?:string;requestTurn?:boolean}>("product-evidence-refresh",ctx=>refreshProductEvidenceJob(ctx,{github}))).status).toBe("completed");
 expect(github).not.toHaveBeenCalled();
 expect((await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug)))[0]).toMatchObject({state:"ok"});
 const [request]=await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId,row.productId));
 expect(request).toMatchObject({activeVersion:1,completedVersion:0});expect(request.progress.completedKeys).toHaveLength(1);
});
it("actual runner typed defer preserves cursor, consumed version and failure history",async()=>{
 await enabled(); configureSourceOwner(); const row=await target();
 await db.update(products).set({createdAt:new Date("1800-01-01")}).where(eq(products.id,row.productId));
 await db.update(jobs).set({cursor:{afterSlug:"previous"},lastError:"original",notBefore:null}).where(eq(jobs.name,"product-evidence-refresh"));
 const net=await import("@/lib/net/fetch");vi.spyOn(net,"fetchCapped").mockRejectedValue(new HttpOriginPermitError("unavailable"));
 const before=(await db.select().from(jobs).where(eq(jobs.name,"product-evidence-refresh")))[0];
 const {refreshProductEvidenceJob}=await import("@/lib/jobs/products/evidence-refresh");
 expect(await runJob("product-evidence-refresh",refreshProductEvidenceJob)).toMatchObject({status:"deferred",reason:"http_origin_permit"});
 const after=(await db.select().from(jobs).where(eq(jobs.name,"product-evidence-refresh")))[0];
 expect(after).toMatchObject({cursor:before.cursor,processedVersion:before.processedVersion,lastError:before.lastError,lastSuccessAt:before.lastSuccessAt,notBefore:before.notBefore,leaseToken:null});
 expect(after.requestedVersion).toBeGreaterThan(after.processedVersion);
 expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).toEqual([]);
 expect((await db.select().from(evidenceSourceControl))[0].cursor).toBe(0);
});
it("job-row wait crossing source expiry rolls back source, outbox and release",async()=>{
 await enabled(); const row=await target();
 await withLease(async job=>{
  const lease=await claimed(row.productId,job);
  await db.update(evidenceSourceClaims).set({leaseUntil:sql`clock_timestamp()+interval '350 milliseconds'`}).where(eq(evidenceSourceClaims.productId,row.productId));
  const before=await rawClaim(row.productId);
  let open!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{open=r;}),ready=new Promise<void>(r=>{started=r;});
  let pid=0;
  const holder=track(db.transaction(async tx=>{pid=Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
   await tx.select().from(jobs).where(eq(jobs.name,job.name)).for("update");started();await gate;}));
  let error:unknown,writer:Promise<unknown>|undefined;
  const bodyErrors:unknown[]=[];
  try{
   await waitForHolderReady(ready,holder);
   writer=track(recordCanonicalEvidenceSource(lease,collected(row.url)).catch(e=>{error=e;}));
   await vi.waitFor(async()=>{const [wait]=await db.execute(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as blocked`);expect(wait.blocked).toBe(true);});
   await vi.waitFor(async()=>{const [clock]=await db.execute(sql`select lease_until<=clock_timestamp() as expired from evidence_source_claims where product_id=${row.productId}`);expect(clock.expired).toBe(true);});
  }catch(error){bodyErrors.push(error);}finally{open();await allSteps([()=>holder,async()=>{await writer;}],bodyErrors);}
  expect(error).toBeInstanceOf(Error);expect((error as Error).message).toBe("evidence_source_lease_lost");
  expect(await rawClaim(row.productId)).toEqual(before);
  expect(await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug,row.slug))).toEqual([]);
  await abandonCanonicalEvidenceSource(lease);
 });
});

it("available admin/normal/admin/catchup demand receives its fixed turn without starving catchup",async()=>{
 await enabled(); const rows=[];for(let i=0;i<4;i++) rows.push(await target());
 for(let i=0;i<rows.length;i++) await db.update(products).set({createdAt:new Date(`000${i+1}-01-01T00:00:00Z`)}).where(eq(products.id,rows[i].productId));
 for(const index of [0,2]) await db.insert(productRefreshRequests).values({productId:rows[index].productId,slug:rows[index].slug,actor:"admin:test",force:true});
 await db.insert(productEvidenceSources).values({slug:rows[1].slug,kind:"documentation",provider:"product_site",sourceKey:"canonical_site",sourceUrl:rows[1].url,
 state:"ok",nextAttemptAt:new Date(Date.now()-3600000)});
 const ids:number[]=[];
 for(let turn=0;turn<4;turn++){
  const lease=await claimCanonicalEvidenceSource({owner});expect(lease).not.toBeNull();ids.push(lease!.binding.productId);
  expect((await rawClaim(lease!.binding.productId)) as object).toMatchObject({lane:["admin","normal","admin","catchup"][turn]});
  expect((await recordCanonicalEvidenceSource(lease!,collected(lease!.binding.sourceUrl))).state).toBe("recorded");
 }
 expect(ids).toEqual(rows.map(row=>row.productId));expect((await db.select().from(evidenceSourceControl))[0].cursor).toBe(0);
});

it("maker due demand survives a future source checkpoint without bypassing failure cooldown",async()=>{
 await enabled();const row=await target();
 expect((await executeCanonicalEvidenceSource({owner,productId:row.productId,fetch:async()=>response(row.url)})).state).toBe("recorded");
 await db.insert(productRefreshRequests).values({productId:row.productId,slug:row.slug,actor:"admin:test",force:true});
 const forced=await claimed(row.productId);
 expect((await recordCanonicalEvidenceSource(forced,collected(row.url))).state).toBe("recorded");
 await db.update(productEvidenceSources).set({nextAttemptAt:new Date(0)}).where(eq(productEvidenceSources.slug,row.slug));
 const lease=await claimed(row.productId);expect((await recordCanonicalEvidenceSource(lease,{state:"failed",reason:"site_timeout"})).state).toBe("failed");
 expect(await claimCanonicalEvidenceSource({owner,productId:row.productId})).toBeNull();
 await db.update(evidenceSettings).set({values:{batchSize:5}}).where(eq(evidenceSettings.id,1));
 expect(await claimCanonicalEvidenceSource({owner,productId:row.productId})).toBeNull();
 await db.update(products).set({url:row.url+"/replacement"}).where(eq(products.id,row.productId));
 const changed=await claimed(row.productId);expect(changed.binding.sourceUrl).toBe(row.url+"/replacement");
 expect((await recordCanonicalEvidenceSource(changed,collected(changed.binding.sourceUrl))).state).toBe("recorded");
});

it("holder SQL failure reaches the original error and finally before fixture cleanup",async()=>{
 let release!:()=>void,markReady!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{markReady=resolve;});
 let sqlError:unknown,operationError:unknown,finallyReached=false,settled=false;
 const holder=track(db.transaction(async tx=>{
  await tx.execute(sql`select 1/0`);
  markReady();await gate;
 }));
 const observed=holder.catch(error=>{sqlError=error;});
 const operation=track((async()=>{
  try{await waitForHolderReady(ready,holder);}
  finally{finallyReached=true;release();await Promise.allSettled([holder]);}
 })().catch(error=>{operationError=error;}).finally(()=>{settled=true;}));
 try{
  await vi.waitFor(()=>expect(sqlError).toBeInstanceOf(Error));
  expect((sqlError as Error & {cause?:{code?:string}}).cause?.code).toBe("22012");
  await vi.waitFor(()=>expect(settled).toBe(true));
  expect(finallyReached).toBe(true);
  expect(operationError).toBe(sqlError);
 }finally{
  markReady();release();await Promise.allSettled([operation,holder,observed]);
 }
});

it("claim-row lock wait crossing source expiry cannot renew an expired owner",async()=>{
 await enabled();const row=await target(),lease=await claimed(row.productId);
 await db.update(evidenceSourceClaims).set({leaseUntil:sql`clock_timestamp()+interval '750 milliseconds'`}).where(eq(evidenceSourceClaims.productId,row.productId));
 const before=await rawClaim(row.productId);
 let release!:()=>void,markReady!:()=>void,pid=0;
 const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{markReady=resolve;});
 const holder=track(db.transaction(async tx=>{
  pid=Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
  await tx.select().from(evidenceSourceClaims).where(eq(evidenceSourceClaims.productId,row.productId)).for("update");
  markReady();await gate;
 }));
 let renewal:Awaited<ReturnType<typeof renewCanonicalEvidenceSource>>|undefined,renewError:unknown;
 let renewing:Promise<void>|undefined;const errors:unknown[]=[];
 try{
  await waitForHolderReady(ready,holder);
  renewing=track(renewCanonicalEvidenceSource(lease).then(value=>{renewal=value;},error=>{renewError=error;}));
  await vi.waitFor(async()=>{
   const [wait]=await db.execute(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as blocked`);
   expect(wait.blocked).toBe(true);
  });
  const [healthy]=await db.execute(sql`select lease_until>clock_timestamp() as live from evidence_source_claims where product_id=${row.productId}`);
  expect(healthy.live).toBe(true);
  await vi.waitFor(async()=>{
   const [clock]=await db.execute(sql`select lease_until<=clock_timestamp() as expired from evidence_source_claims where product_id=${row.productId}`);
   expect(clock.expired).toBe(true);
  });
  expect(await rawClaim(row.productId)).toEqual(before);
 }catch(error){errors.push(error);}finally{
  release();await allSteps([()=>holder,async()=>{await renewing;}],errors);
 }
 expect(renewError).toBeUndefined();expect(renewal).toBeNull();
 expect(await rawClaim(row.productId)).toEqual(before);
 await abandonCanonicalEvidenceSource(lease);
});
