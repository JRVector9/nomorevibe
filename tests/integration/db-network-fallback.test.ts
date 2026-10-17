import net from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createValkeyRoutes, openValkey } from "@/lib/cache/shared";
import { networkRoutes } from "@/lib/db/network-route";
import { createDbClient, dbPoolConfig } from "@/lib/db/pool";
import { TEST_DATABASE_URL, ensureSchema } from "./setup";

/**
 * 실제 DB 로 경로 고르기를 본다(2026-10-17). 운영의 두 길(LAN·Tailscale)을 같은 테스트 DB 앞의 TCP 중계 둘로 흉내 낸다 —
 * 중계를 닫으면 "그 길이 끊김", 받은 연결 수로 "어느 길로 붙었나"를 센다.
 */
type Endpoint = { host: string; port: number };

function relay(target: Endpoint) {
  let server: net.Server | null = null;
  const open = new Set<net.Socket>();
  const state = { accepted: 0, port: 0 };
  return {
    state,
    async start(port = state.port) {
      server = net.createServer(client => {
        state.accepted++;
        const upstream = net.connect(target);
        const close = () => { client.destroy(); upstream.destroy(); open.delete(client); open.delete(upstream); };
        open.add(client); open.add(upstream);
        client.pipe(upstream).pipe(client);
        for (const socket of [client, upstream]) { socket.on("error", close); socket.on("close", close); }
      });
      await new Promise<void>(resolve => server!.listen(port, "127.0.0.1", resolve));
      state.port = (server.address() as net.AddressInfo).port;
    },
    async stop() {
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
      server = null;
    },
  };
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return; } catch { /* 다시 본다 */ }
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const base = new URL(TEST_DATABASE_URL);
const database: Endpoint = { host: base.hostname === "localhost" ? "127.0.0.1" : base.hostname, port: Number(base.port || 5432) };
const urlAt = (port: number) => { const url = new URL(TEST_DATABASE_URL); url.hostname = "127.0.0.1"; url.port = String(port); return url.toString(); };
const config = () => ({ ...dbPoolConfig({ DB_POOL_MAX: "1" }), waitMs: 3_000 });
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const clients: ReturnType<typeof createDbClient>[] = [];

beforeAll(async () => {
  ensureSchema();
  await admin`create table if not exists dbfb_writes (id serial primary key, note text not null)`;
  await admin`truncate dbfb_writes`;
});
afterAll(async () => {
  await Promise.all(clients.map(client => client.end({ timeout: 1 }).catch(() => {})));
  await admin`drop table if exists dbfb_writes`;
  await admin.end({ timeout: 1 });
});

describe("DB 연결 경로 — 먼저 길, 안 되면 대신 길", () => {
  it("먼저 길이 닫혀 있으면 대신 길로 붙고, 쿼리 오류는 넘기지 않으며, 먼저 길이 돌아오면 새 연결부터 그 길을 쓴다", async () => {
    const preferred = relay(database), fallback = relay(database);
    await preferred.start(); await preferred.stop();
    await fallback.start();
    const sql = createDbClient(urlAt(preferred.state.port), config(), "primary", `127.0.0.1:${fallback.state.port}`);
    clients.push(sql);
    try {
      expect((await sql`select 1 as one`)[0].one).toBe(1);
      expect([preferred.state.accepted, fallback.state.accepted]).toEqual([0, 1]);

      await expect(sql`select 1/0`).rejects.toMatchObject({ code: "22012" });
      expect((await sql`select 2 as two`)[0].two).toBe(2);
      expect([preferred.state.accepted, fallback.state.accepted]).toEqual([0, 1]);

      await preferred.start();
      const [{ pid }] = await sql`select pg_backend_pid() as pid`;
      await admin`select pg_terminate_backend(${pid})`;
      await eventually(async () => (await sql`select 3 as three`)[0].three === 3);
      expect([preferred.state.accepted, fallback.state.accepted]).toEqual([1, 1]);
      await expect(sql`select 1/0`).rejects.toMatchObject({ code: "22012" });
      expect([preferred.state.accepted, fallback.state.accepted]).toEqual([1, 1]);
    } finally { await preferred.stop(); await fallback.stop(); }
  });

  it("연결된 뒤 끊긴 쿼리는 실패로 돌려주고 대신 길로 다시 보내지 않는다 — 쓰기는 많아야 한 번", async () => {
    const preferred = relay(database), fallback = relay(database);
    await preferred.start(); await fallback.start();
    const sql = createDbClient(urlAt(preferred.state.port), config(), "primary", `127.0.0.1:${fallback.state.port}`);
    clients.push(sql);
    try {
      expect((await sql`select 1 as one`)[0].one).toBe(1);
      const write = sql`insert into dbfb_writes (note) select 'cut' from pg_sleep(0.5)`;
      await new Promise(resolve => setTimeout(resolve, 150));
      await preferred.stop();
      await expect(write).rejects.toBeTruthy();
      expect(fallback.state.accepted).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 700));
      const [{ count }] = await admin`select count(*)::int as count from dbfb_writes where note = 'cut'`;
      expect(count).toBeLessThanOrEqual(1);
      // 다음 새 연결은 먼저 길(닫힘)을 거쳐 대신 길로
      expect((await sql`select 4 as four`)[0].four).toBe(4);
      expect(fallback.state.accepted).toBe(1);
      const [{ after }] = await admin`select count(*)::int as after from dbfb_writes where note = 'cut'`;
      expect(after).toBe(count);
    } finally { await preferred.stop(); await fallback.stop(); }
  });

  it("둘 다 안 되면 연결 오류로 빨리 실패하고, 풀 자리를 잃지 않아 길이 돌아오면 다시 쓴다(max 1)", async () => {
    const preferred = relay(database), fallback = relay(database);
    await preferred.start(); await preferred.stop();
    await fallback.start(); await fallback.stop();
    const sql = createDbClient(urlAt(preferred.state.port), config(), "primary", `127.0.0.1:${fallback.state.port}`);
    clients.push(sql);
    try {
      for (let i = 0; i < 2; i++) {
        const startedAt = Date.now();
        await expect(sql`select 1`).rejects.toMatchObject({ code: "ECONNREFUSED" });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      }
      await fallback.start();
      await eventually(async () => (await sql`select 5 as five`)[0].five === 5);
    } finally { await fallback.stop(); }
  });

  it("먼저 길이 응답 없는 주소여도 정해진 시간 안에 대신 길로 붙는다", async () => {
    const fallback = relay(database);
    await fallback.start();
    // TEST-NET-1(RFC 5737) — 어디에도 닿지 않는다(환경에 따라 시간 초과 또는 즉시 도달 불가)
    const url = new URL(TEST_DATABASE_URL); url.hostname = "192.0.2.1"; url.port = "5432";
    const sql = createDbClient(url.toString(), config(), "primary", `127.0.0.1:${fallback.state.port}`);
    clients.push(sql);
    try {
      const startedAt = Date.now();
      expect((await sql`select 6 as six`)[0].six).toBe(6);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(fallback.state.accepted).toBe(1);
    } finally { await fallback.stop(); }
  });

  it("앱 DB(lib/db)는 DATABASE_FALLBACK_HOST 를 읽어 같은 규칙으로 붙고 경로 이름을 관측에 올린다", async () => {
    const preferred = relay(database);
    await preferred.start(); await preferred.stop();
    const globals = globalThis as { pgClient?: ReturnType<typeof postgres>; db?: unknown };
    const before = { url: process.env.DATABASE_URL, fallback: process.env.DATABASE_FALLBACK_HOST, pgClient: globals.pgClient, db: globals.db };
    process.env.DATABASE_URL = urlAt(preferred.state.port);
    process.env.DATABASE_FALLBACK_HOST = `${database.host}:${database.port}`;
    delete globals.pgClient; delete globals.db;
    try {
      const { db } = await import("@/lib/db");
      const { sql } = await import("drizzle-orm");
      expect((await db.execute<{ one: number }>(sql`select 1 as one`))[0].one).toBe(1);
      expect(networkRoutes()).toMatchObject({ primary: "other" });
    } finally {
      const opened = (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient;
      await opened?.end({ timeout: 1 }).catch(() => {});
      Object.assign(globals, { pgClient: before.pgClient, db: before.db });
      process.env.DATABASE_URL = before.url;
      if (before.fallback === undefined) delete process.env.DATABASE_FALLBACK_HOST; else process.env.DATABASE_FALLBACK_HOST = before.fallback;
    }
  });
});

const VALKEY = process.env.TEST_VALKEY_URL;
describe.skipIf(!VALKEY)("Valkey 연결 경로 — 먼저 연결 실패 때만 둘째 연결, 먼저 길이 서면 돌아감", () => {
  it("닫힌 먼저 길 → 대신 길로 읽고 쓰기 → 먼저 길이 돌아오면 그쪽으로", async () => {
    const target = new URL(VALKEY!);
    const preferred = relay({ host: target.hostname, port: Number(target.port) });
    await preferred.start(); await preferred.stop();
    const url = new URL(VALKEY!); url.port = String(preferred.state.port);
    const opened: ReturnType<typeof openValkey>[] = [];
    const routes = createValkeyRoutes(url.toString(), `${target.hostname}:${target.port}`, value => {
      const client = openValkey(value); opened.push(client); return client;
    });
    try {
      await eventually(() => routes.client() !== null);
      expect(opened).toHaveLength(2);
      expect(routes.client()).toBe(opened[1]);
      await opened[1].set("nmv:dbfb:k", "v", { PX: 5_000 });
      expect(String(await opened[1].get("nmv:dbfb:k"))).toBe("v");
      expect(networkRoutes()).toMatchObject({ valkey: "other" });

      await preferred.start();
      await eventually(() => routes.client() === opened[0], 10_000);
      expect(String(await opened[0].get("nmv:dbfb:k"))).toBe("v");
      expect(preferred.state.accepted).toBeGreaterThanOrEqual(1);
      expect(opened).toHaveLength(2);
    } finally {
      for (const client of opened) client.destroy();
      await preferred.stop();
    }
  });
});
