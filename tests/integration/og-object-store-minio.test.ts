import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { AwsV4Signer } from "aws4fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

const { db } = await import("@/lib/db");
const { ogImages } = await import("@/lib/db/schema");
const repo = await import("@/lib/domain/products/repository");
const { createOgObjectStore, ogStoreConfig, setOgObjectStoreForTests } = await import("@/lib/storage/og-store");

/**
 * 진짜 S3 호환 버킷(로컬 MinIO)으로 보는 끝-끝 시험 — OG_STORE_TEST_ENDPOINT 가 있을 때만 돈다(CI 에는 MinIO 가 없다).
 *   docker run -d --name nmv-og-minio-test -p 127.0.0.1:59000:9000 -e MINIO_ROOT_USER=test -e MINIO_ROOT_PASSWORD=testtesttest <minio> server /data
 *   OG_STORE_TEST_ENDPOINT=http://127.0.0.1:59000 OG_STORE_TEST_ACCESS_KEY=test OG_STORE_TEST_SECRET_KEY=testtesttest npm run test:integration -- og-object-store-minio
 */
const endpoint = process.env.OG_STORE_TEST_ENDPOINT;
const env = {
  OG_STORE_ENDPOINT: endpoint ?? "", OG_STORE_BUCKET: "nmv-og-it", OG_STORE_ACCESS_KEY: process.env.OG_STORE_TEST_ACCESS_KEY ?? "",
  OG_STORE_SECRET_KEY: process.env.OG_STORE_TEST_SECRET_KEY ?? "", OG_STORE_REGION: "us-east-1",
};
const SCRIPT = path.resolve(__dirname, "../../scripts/ops/og-images-to-object-store.ts");

async function s3(method: string, url: string) {
  const signed = await new AwsV4Signer({ url, method, accessKeyId: env.OG_STORE_ACCESS_KEY, secretAccessKey: env.OG_STORE_SECRET_KEY,
    service: "s3", region: env.OG_STORE_REGION }).sign();
  return fetch(signed.url, { method, headers: signed.headers });
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    input: TEST_DATABASE_URL, encoding: "utf8", timeout: 60_000, cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, ...env },
  });
  const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, events, stdout: result.stdout, stderr: result.stderr, last: (event: string) => events.findLast((e) => e.event === event) };
}

describe.skipIf(!endpoint)("로컬 MinIO 버킷", () => {
  const store = () => createOgObjectStore(ogStoreConfig(env)!);
  const rows = {
    "alpha": { contentType: "image/png", data: Buffer.from("alpha-bytes") },
    "beta": { contentType: "image/jpeg", data: Buffer.from("beta-bytes-longer") },
    "gamma": { contentType: "image/webp", data: Buffer.alloc(300_000, 7) },
    "newer": { contentType: "image/png", data: Buffer.from("old-db-bytes") },
    "Bad_Slug": { contentType: "image/png", data: Buffer.from("cannot be served") },
  };

  beforeAll(async () => {
    ensureSchema();
    const created = await s3("PUT", `${endpoint}/${env.OG_STORE_BUCKET}`);
    expect([200, 409]).toContain(created.status);
  });
  beforeEach(async () => {
    setOgObjectStoreForTests(undefined);
    await resetTables();
    for (const slug of ["alpha", "beta", "gamma", "newer", "app"]) await store().delete(slug);
  });
  afterAll(() => {
    for (const key of Object.keys(env)) delete process.env[key];
    setOgObjectStoreForTests(undefined);
  });

  it("옮기기: 없으면 쓰고, 같은 것은 건너뛰고, 앱이 새로 쓴 것은 덮지 않는다 — 다시 돌려도 같다", async () => {
    for (const [slug, row] of Object.entries(rows)) await db.insert(ogImages).values({ slug, ...row });
    await store().put("newer", { data: Buffer.from("app-wrote-this"), contentType: "image/png" });

    const dry = run(["--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.last("dry_run")).toMatchObject({ rows: 5, invalidSlug: 1, bytes: Object.values(rows).reduce((n, r) => n + r.data.length, 0) });

    // keyset 은 DB 의 정렬(콜레이션)을 따른다 — 기대 커서도 DB 에서 받는다
    const ordered = (await db.select({ slug: ogImages.slug }).from(ogImages).orderBy(ogImages.slug)).map((row) => row.slug);
    const first = run(["--batch", "2", "--sleep-ms", "0"]);
    expect(first.status).toBe(0);
    expect(first.last("copy_done")).toMatchObject({ rows: 5, copied: 3, same: 0, different: 1, invalid: 1, failed: 0,
      bytes: rows.alpha.data.length + rows.beta.data.length + rows.gamma.data.length });
    expect(first.events.filter((e) => e.event === "batch").map((e) => e.lastSlug)).toEqual([ordered[1], ordered[3], ordered[4]]);
    expect(first.stdout + first.stderr).not.toContain(env.OG_STORE_SECRET_KEY);
    expect(first.stdout + first.stderr).not.toContain(TEST_DATABASE_URL);

    for (const slug of ["alpha", "beta", "gamma"] as const) {
      expect(await store().get(slug)).toEqual(rows[slug]);
    }
    expect((await store().get("newer"))?.data.toString()).toBe("app-wrote-this");

    const again = run([]);
    expect(again.last("copy_done")).toMatchObject({ copied: 0, same: 3, different: 1, invalid: 1 });

    // 이어 가기: 커서 다음부터, 한도까지만
    const resumed = run(["--from-slug", ordered[0], "--limit", "1"]);
    expect(resumed.last("copy_done")).toMatchObject({ rows: 1, lastSlug: ordered[1] });

    const verified = run(["--verify", "--sample", "10"]);
    expect(verified.last("verify")).toMatchObject({ sampled: 5, checked: 4, match: 3, mismatch: 1, missingInStore: 0, invalid: 1, failed: 0 });
    expect(verified.status).toBe(3);
    // DB 는 건드리지 않는다
    expect(await db.$count(ogImages)).toBe(5);
  });

  it("앱 경로: 쓰면 버킷에만 두고, 읽기는 버킷 먼저, 지우기는 둘 다", async () => {
    Object.assign(process.env, env);
    await db.insert(ogImages).values({ slug: "app", contentType: "image/png", data: Buffer.from("legacy") });
    expect(await repo.getOgImage("app")).toEqual({ data: Buffer.from("legacy"), contentType: "image/png" });

    const data = Buffer.from("fresh-jpeg");
    await repo.putOgImage("app", "image/jpeg", data);
    expect(await db.$count(ogImages)).toBe(0);
    const head = await store().head("app");
    expect(head).toMatchObject({ size: data.length, etag: createHash("md5").update(data).digest("hex"), contentType: "image/jpeg" });
    expect(await repo.getOgImage("app")).toEqual({ data, contentType: "image/jpeg" });

    await repo.deleteOgImage("app");
    expect(await store().head("app")).toBeNull();
    expect(await repo.getOgImage("app")).toBeNull();
  });
});
