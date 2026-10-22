import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";

// PR15e: 웹 쓰기 관문 — 캐시 관문(잠그지 않는 fence 읽기, 5초)과 쓰기 TX 의 첫 lock(fence SHARE)을 가짜 DB 로 본다.
// 실제 DB 의 거절·무변경·lock 순서는 tests/integration/dr-web-fence.test.ts 가 본다.
const fake = vi.hoisted(() => ({ siteRows: [] as unknown[], txRows: [] as unknown[], calls: [] as string[],
  receive: vi.fn(), admin: vi.fn(), requestAdminJob: vi.fn(), agentRequest: vi.fn(), recordAdminAction: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/domain/github-webhooks/receive", () => ({ receiveGithubWebhook: fake.receive }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin }));
vi.mock("@/lib/operations/admin", () => ({ requestAdminJob: fake.requestAdminJob }));
vi.mock("@/lib/operations/agent-client", () => ({ agentRequest: fake.agentRequest }));
vi.mock("@/lib/operations/admin-log", () => ({ recordAdminAction: fake.recordAdminAction, adminAuditRow: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: fake.rateLimit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const lineage = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11";
const activeRow = { lineage_id: lineage, writer_epoch: 1, state: "active", reason: null, fenced_db: null, promotion_id: null };
const fencedRow = { lineage_id: lineage, writer_epoch: 1, state: "fenced", reason: "operator_fence", promotion_id: null,
  fenced_db: { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" } };
const sqlText = (query: unknown) => JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query);
/** insert(...).values(...).onConflict…(...) 처럼 이어 부르는 builder. await 하는 순간 한 번 기록한다. */
function chainable(label: string): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const name of ["values", "set", "where", "onConflictDoNothing", "onConflictDoUpdate", "returning"]) self[name] = () => self;
  self.then = (ok: (rows: unknown[]) => unknown, bad?: (error: unknown) => unknown) => { fake.calls.push(label); return Promise.resolve([]).then(ok, bad); };
  return self;
}
const tx = {
  execute: vi.fn(async (query: unknown) => {
    const text = sqlText(query), share = text.includes("dr_writer_fence") && text.includes("FOR SHARE");
    fake.calls.push(share ? "tx:fence-share" : "tx:execute");
    return share ? fake.txRows : [];
  }),
  insert: () => chainable("tx:insert"),
};
const fakeDb = {
  execute: vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    fake.calls.push(/FOR (SHARE|UPDATE)/.test(text) ? "db:locked-read" : text.includes("dr_writer_fence") ? "db:fence-read" : "db:execute");
    return text.includes("dr_writer_fence") ? fake.siteRows : [];
  }),
  transaction: vi.fn(async (load: (value: unknown) => Promise<unknown>, config?: { accessMode?: string }) => {
    fake.calls.push(config?.accessMode === "read only" ? "db:begin-read-only" : "db:begin");
    return load(tx);
  }),
  insert: () => chainable("db:insert"),
};
/** 가짜 tx·db 의 insert(...).values() 를 await 한다(실제 drizzle 형과 겹치지 않아 unknown 으로 받는다). */
const insertRow = (target: unknown) => (target as { insert: () => { values: () => PromiseLike<unknown> } }).insert().values();
// lib/db 는 globalThis.db 가 있으면 그것을 주 DB 로 쓴다(통합 테스트의 bindDb 와 같은 길).
(globalThis as { db?: unknown }).db = fakeDb;
afterAll(() => { delete (globalThis as { db?: unknown }).db; });

const quiet = () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
};
beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.siteRows = [activeRow];
  fake.txRows = [activeRow];
  fake.admin.mockResolvedValue({ login: "operator" });
  fake.receive.mockResolvedValue({ duplicate: false, ignored: false });
  fake.agentRequest.mockResolvedValue({ generation: 1, configVersion: 1 });
  fake.rateLimit.mockResolvedValue(false);
});

it("cache gate: one unlocked fence read per 5 s — the hot path never row-locks the fence", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T00:00:00.000Z") });
  const gate = await import("@/lib/operations/dr/web-gate");
  await gate.assertWebWritable();
  await gate.assertWebWritable();
  expect(await gate.webWritable()).toBe(true);
  expect(fake.calls).toEqual(["db:fence-read"]);
  // TTL 안에서는 이미 읽은 값을 쓴다(이 창은 쓰기 TX 의 첫 lock 이 메운다 — 아래 테스트).
  fake.siteRows = [fencedRow];
  vi.setSystemTime(new Date("2026-10-17T00:00:04.999Z"));
  await gate.assertWebWritable();
  vi.setSystemTime(new Date("2026-10-17T00:00:05.001Z"));
  await expect(gate.assertWebWritable()).rejects.toBeInstanceOf(DrWriterFencedError);
  expect(await gate.webWritable()).toBe(false);
  expect(fake.calls).toEqual(["db:fence-read", "db:fence-read"]);
});

it("cache gate fails closed on a missing or invalid fence row and never caches the failure", async () => {
  const gate = await import("@/lib/operations/dr/web-gate");
  fake.siteRows = [];
  await expect(gate.assertWebWritable()).rejects.toThrow("dr_writer_fence_missing");
  expect(await gate.webWritable()).toBe(false);
  fake.siteRows = [{ ...activeRow, state: "open" }];
  await expect(gate.assertWebWritable()).rejects.toThrow("dr_writer_fence_invalid");
  fake.siteRows = [activeRow];
  await gate.assertWebWritable();
  expect(fake.calls).toEqual(["db:fence-read", "db:fence-read", "db:fence-read", "db:fence-read"]);
});

// R4: 공유 대기(memo pending) 때문에 매달린 fence 읽기 하나가 /go·hot path 와 쓰기 관문을 함께 붙잡았다 — 읽기에 상한을 둔다.
it("a hung fence read is bounded: hot paths skip, writes are refused, and the next request reads again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gate = await import("@/lib/operations/dr/web-gate");
  let hang!: (rows: unknown[]) => void;
  fakeDb.execute.mockImplementationOnce(async () => {
    fake.calls.push("db:fence-read");
    return new Promise<unknown[]>(resolve => { hang = resolve; });
  });
  /** 결과를 상자에 담는다 — 상한이 지난 뒤(타이머 진행 + 실제 setImmediate 한 바퀴) 아직 비어 있으면 매달린 것이다 */
  const observe = <T>(work: Promise<T>) => {
    const box: { state: "pending" | "fulfilled" | "rejected"; value?: T; error?: unknown } = { state: "pending" };
    work.then(value => Object.assign(box, { state: "fulfilled", value }), (error: unknown) => Object.assign(box, { state: "rejected", error }));
    return box;
  };
  try {
    const skipped = observe(gate.webWritable()), refused = observe(gate.assertWebWritable());
    await vi.advanceTimersByTimeAsync(2_000);
    await new Promise(resolve => setImmediate(resolve));
    expect(skipped).toEqual({ state: "fulfilled", value: false });
    expect(refused).toMatchObject({ state: "rejected", error: { message: "dr_writer_fence_read_timeout" } });
    // 매달린 읽기를 다음 요청이 물려받지 않는다 — 새로 읽는다
    expect(await gate.webWritable()).toBe(true);
    expect(fake.calls).toEqual(["db:fence-read", "db:fence-read"]);
  } finally {
    hang?.([activeRow]);
    vi.useRealTimers();
  }
});

it("runWebWrite: a fenced cache refuses before the handler; otherwise every primary write TX inside takes the fence SHARE first", async () => {
  const gate = await import("@/lib/operations/dr/web-gate");
  const { db } = await import("@/lib/db");
  fake.siteRows = [fencedRow];
  const handler = vi.fn(async () => "written");
  await expect(gate.runWebWrite(handler)).rejects.toBeInstanceOf(DrWriterFencedError);
  expect(handler).not.toHaveBeenCalled();
  expect(fake.calls).toEqual(["db:fence-read"]);

  const { clearAllMemos } = await import("@/lib/cache/memo");
  clearAllMemos();
  fake.siteRows = [activeRow];
  fake.calls.length = 0;
  expect(await gate.runWebWrite(async () => {
    await db.transaction(async inner => { await insertRow(inner); });
    await db.transaction(async inner => { await insertRow(inner); });
    // 읽기 전용 TX 는 FOR SHARE 를 걸 수 없고(25006) 걸 필요도 없다
    await db.transaction(async () => {}, { accessMode: "read only" });
    return "written";
  })).toBe("written");
  expect(fake.calls).toEqual(["db:fence-read", "db:begin", "tx:fence-share", "tx:insert", "db:begin", "tx:fence-share", "tx:insert",
    "db:begin-read-only"]);
  // 관문 범위 밖(worker·읽기 요청)의 TX 는 그대로다
  fake.calls.length = 0;
  await db.transaction(async inner => { await insertRow(inner); });
  expect(fake.calls).toEqual(["db:begin", "tx:insert"]);
});

it("inside the cache TTL a fenced DB is still refused at the write TX's first lock: the write never runs", async () => {
  const gate = await import("@/lib/operations/dr/web-gate");
  const { db } = await import("@/lib/db");
  fake.txRows = [fencedRow];
  await expect(gate.runWebWrite(() => db.transaction(async inner => { await insertRow(inner); })))
    .rejects.toBeInstanceOf(DrWriterFencedError);
  expect(fake.calls).toEqual(["db:fence-read", "db:begin", "tx:fence-share"]);
  // 거절을 받은 handler 가 실패 기록을 단일 문장으로 쓰려 해도(action 의 catch → 감사 로그) 같은 요청 안에서는 막힌다
  fake.calls.length = 0;
  let bookkeeping: unknown;
  await gate.runWebWrite(async () => {
    await db.transaction(async () => {}).catch(() => {});
    try { await insertRow(db); } catch (error) { bookkeeping = error; }
    await db.transaction(async () => {}, { accessMode: "read only" });
  });
  expect(bookkeeping).toBeInstanceOf(DrWriterFencedError);
  // 이 프로세스의 캐시도 버려 다음 요청은 DB 를 다시 읽는다(fenced 를 바로 본다)
  expect(fake.calls).toEqual(["db:fence-read", "db:begin", "tx:fence-share", "db:begin-read-only"]);
  fake.siteRows = [fencedRow];
  await expect(gate.assertWebWritable()).rejects.toBeInstanceOf(DrWriterFencedError);
  expect(fake.calls.at(-1)).toBe("db:fence-read");
});

it("withRoute: write methods on a fenced site get 503 + Retry-After before the handler; GET/HEAD/OPTIONS pass", async () => {
  quiet();
  const { withRoute } = await import("@/lib/http/handler");
  fake.siteRows = [fencedRow];
  const handler = vi.fn(async () => NextResponse.json({ ok: true }));
  const route = withRoute("test.fenced", handler);
  const ctx = { params: Promise.resolve({}) };
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await route(new Request("https://nomorevibe.test/api/x", { method }), ctx);
    expect(res.status, method).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = await res.json();
    expect(body).toEqual({ error: "잠시 이용할 수 없습니다. 잠시 후 다시 시도해주세요.", request_id: expect.any(String) });
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
  }
  expect(handler).not.toHaveBeenCalled();
  for (const method of ["GET", "HEAD", "OPTIONS"]) expect((await route(new Request("https://nomorevibe.test/api/x", { method }), ctx)).status).toBe(200);
  expect(handler).toHaveBeenCalledTimes(3);
  // 캐시가 active 인 창에서 TX 첫 lock 이 거절하면(handler 안에서 던짐) 같은 503 이다
  const { clearAllMemos } = await import("@/lib/cache/memo");
  clearAllMemos();
  fake.siteRows = [activeRow];
  const raced = await withRoute("test.raced", async () => { throw new DrWriterFencedError("site_fenced"); })(
    new Request("https://nomorevibe.test/api/x", { method: "POST" }), ctx);
  expect(raced.status).toBe(503);
  expect(raced.headers.get("retry-after")).toBe("60");
});

// GitHub 는 실패한 webhook 을 자동으로 다시 보내지 않는다(docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) —
// 5xx 는 GitHub 에 실패 전달로 남아(3일 안 수동·API 재전송 가능) 수신하지 않은 것이 보이고, 놓친 해지는 15분 reconcile 이 다시 확인한다.
it("public routes: a fenced site answers the existing unavailable code with 503 + Retry-After; webhooks get 5xx and record nothing", async () => {
  const { publicAuthErrorResponse } = await import("@/lib/domain/accounts/request-auth");
  const mapped = publicAuthErrorResponse(new DrWriterFencedError("site_fenced"));
  expect(mapped.status).toBe(503);
  expect(mapped.headers.get("retry-after")).toBe("60");
  expect(mapped.headers.get("cache-control")).toBe("private, no-store");
  expect(await mapped.json()).toEqual({ error: "public_auth_unavailable" });

  const webhook = (app: "feedback" | "star") => import(`@/app/api/github/webhooks/${app}/route`) as Promise<{ POST: (request: Request) => Promise<Response> }>;
  const delivery = () => new Request("https://nomorevibe.test/api/github/webhooks/x", { method: "POST", body: "{}" });
  fake.siteRows = [fencedRow];
  for (const app of ["feedback", "star"] as const) {
    const res = await (await webhook(app)).POST(delivery());
    expect(res.status, app).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  }
  expect(fake.receive).not.toHaveBeenCalled();
  const { clearAllMemos } = await import("@/lib/cache/memo");
  clearAllMemos();
  fake.siteRows = [activeRow];
  expect((await (await webhook("feedback")).POST(delivery())).status).toBe(202);
  expect(fake.receive).toHaveBeenCalledOnce();

  // 피드백 접수는 그 route 의 기존 503 코드를 그대로 쓴다(화면은 기존 문구)
  clearAllMemos();
  fake.siteRows = [fencedRow];
  const { POST } = await import("@/app/api/products/[slug]/feedback/route");
  const res = await POST(new Request("https://nomorevibe.test/api/products/x/feedback", { method: "POST", body: "{}" }), { params: Promise.resolve({ slug: "x" }) });
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("60");
  expect(await res.json()).toEqual({ error: "feedback_unavailable" });
});

it("admin server action: a fenced site refuses before auth and domain writes; the codex status read still answers", async () => {
  const actions = await import("@/app/(operator)/admin/status/actions");
  fake.siteRows = [fencedRow];
  await expect(actions.requestOperation("news-refresh")).rejects.toBeInstanceOf(DrWriterFencedError);
  expect(fake.admin).not.toHaveBeenCalled();
  expect(fake.requestAdminJob).not.toHaveBeenCalled();
  await expect(actions.codexOperation("connect")).rejects.toBeInstanceOf(DrWriterFencedError);
  expect(fake.agentRequest).not.toHaveBeenCalled();
  expect(fake.recordAdminAction).not.toHaveBeenCalled();
  expect(await actions.codexOperation("status")).toEqual({ status: { generation: 1, configVersion: 1 } });
  expect(fake.recordAdminAction).not.toHaveBeenCalled();
});

it("hot paths skip their write on a fenced site and keep serving: click and search records", async () => {
  vi.stubEnv("VISITOR_HASH_SECRET", "pr15e-visitor-secret-0123456789abcdef");
  const { recordClick } = await import("@/lib/domain/products/clicks");
  const { recordSearch } = await import("@/lib/domain/products/search-log");
  const search = { query: "todo app", keywords: null, results: 3, filtered: false, startedAt: new Date() };
  fake.siteRows = [fencedRow];
  await recordClick("pr15e", "0f8fad5b-d9cb-469f-a165-70867728950e");
  await recordSearch(search);
  expect(fake.rateLimit).not.toHaveBeenCalled();
  expect(fake.calls).toEqual(["db:fence-read"]);
  const { clearAllMemos } = await import("@/lib/cache/memo");
  clearAllMemos();
  fake.siteRows = [activeRow];
  fake.calls.length = 0;
  await recordClick("pr15e", "0f8fad5b-d9cb-469f-a165-70867728950e");
  await recordSearch(search);
  expect(fake.rateLimit).toHaveBeenCalledOnce();
  expect(fake.calls).toEqual(["db:fence-read", "db:insert", "db:insert"]);
  vi.unstubAllEnvs();
});

// R4: 관리자 로그아웃은 서명 쿠키만 지운다 — fence·DB 를 거치지 않는다. 관리자 쓰기 경로는 비관리자 ingress 에 404 가 먼저다(proxy 와 같은 판정).
const ADMIN = "https://admin.nomorevibe.test", INGRESS = "pr15e-admin-ingress-secret-0123456789abcdef";
const adminRequest = (pathname: string, method: string, ingress: boolean) => new Request(`${ADMIN}${pathname}`, { method,
  headers: { origin: ADMIN, ...(ingress ? { "x-nmv-admin-ingress-token": INGRESS } : {}) } });

it("admin logout only clears the signed cookie: no fence or DB read, even on a fenced site or without the fence row", async () => {
  quiet();
  vi.stubEnv("ADMIN_ORIGIN", ADMIN);
  vi.stubEnv("ADMIN_INGRESS_SECRET", INGRESS);
  try {
    const { POST } = await import("@/app/api/auth/logout/route");
    for (const rows of [[fencedRow], []]) {
      fake.siteRows = rows;
      fake.calls.length = 0;
      const res = await POST(adminRequest("/api/auth/logout", "POST", true), { params: Promise.resolve({}) });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ADMIN}/admin/login`);
      expect(res.headers.get("set-cookie")).toContain("nmv_admin=;");
      expect(fake.calls).toEqual([]);
    }
  } finally { vi.unstubAllEnvs(); }
});

it("admin write routes answer a non-admin ingress 404 before the fence: a fenced or broken DB is not revealed", async () => {
  quiet();
  vi.stubEnv("ADMIN_ORIGIN", ADMIN);
  vi.stubEnv("ADMIN_INGRESS_SECRET", INGRESS);
  try {
    const password = await import("@/app/api/auth/password/route");
    const ban = await import("@/app/api/admin/products/[slug]/route");
    const logout = await import("@/app/api/auth/logout/route");
    const routes = [["/api/auth/password", "POST", password.POST], ["/api/admin/products/x", "DELETE", ban.DELETE],
      ["/api/auth/logout", "POST", logout.POST]] as const;
    for (const rows of [[fencedRow], []]) {
      fake.siteRows = rows;
      fake.calls.length = 0;
      for (const [pathname, method, route] of routes) {
        const res = await route(adminRequest(pathname, method, false), { params: Promise.resolve({ slug: "x" }) });
        expect(res.status, `${method} ${pathname}`).toBe(404);
        // 관문이 만든 404 는 proxy 와 같은 private, no-store 다(로그아웃은 handler 의 기존 404 그대로)
        if (pathname !== "/api/auth/logout") expect(res.headers.get("cache-control"), `${method} ${pathname}`).toBe("private, no-store");
      }
      expect(fake.calls).toEqual([]);
    }
    // 관리자 ingress 면 기존 관문 그대로다 — fenced 는 handler 전에 503
    const { clearAllMemos } = await import("@/lib/cache/memo");
    clearAllMemos();
    fake.siteRows = [fencedRow];
    for (const [pathname, method, route] of routes.slice(0, 2)) {
      expect((await route(adminRequest(pathname, method, true), { params: Promise.resolve({ slug: "x" }) })).status, `${method} ${pathname}`).toBe(503);
    }
    expect(fake.recordAdminAction).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it("only the admin logout opts out of the write gate (dbWrite: false)", () => {
  const root = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const optedOut = walk(path.join(root, "app")).filter(file => /\.(ts|tsx)$/.test(file) && readFileSync(file, "utf8").includes("dbWrite: false"));
  expect(optedOut.map(file => path.relative(root, file))).toEqual([path.join("app", "api", "auth", "logout", "route.ts")]);
});

/** 새 action·route 가 관문을 빠뜨리지 않게: 쓰기 진입점은 모두 webWriteAction / withRoute / webWriteRoute 를 지난다. */
it("every admin server action and every write route handler goes through the web gate", () => {
  const root = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const files = walk(path.join(root, "app"));
  // actions.ts 와 그 옆의 *-actions.ts(human-review-actions·source-buffer-actions·qwen-auto-actions 등) 모두
  const isActionFile = (file: string) => /(?:^|-)actions\.ts$/.test(path.basename(file));
  const actionFiles = files.filter(file => isActionFile(file) && /^(['"])use server\1/.test(readFileSync(file, "utf8")));
  expect(actionFiles.length).toBeGreaterThanOrEqual(18);
  expect(actionFiles.map(file => path.basename(file))).toEqual(expect.arrayContaining(["human-review-actions.ts", "source-buffer-actions.ts",
    "qwen-auto-actions.ts"]));
  let wrapped = 0;
  for (const file of actionFiles) {
    const source = readFileSync(file, "utf8");
    // codexOperation 은 status 읽기를 섞어 받아 본문 첫 줄에서 쓰기 갈래만 관문을 본다
    expect(source.match(/^export async function (\w+)/gm)?.filter(line => !line.endsWith("codexOperation")) ?? [], file).toEqual([]);
    wrapped += source.match(/^export const \w+ = webWriteAction\(async function \w+/gm)?.length ?? 0;
  }
  // 0110 감사 보류 — 보류 설정 저장·보류 모두 풀기(admin/audit/actions.ts) 두 개가 더해졌다. 0112 남은 감사 모델 바꾸기 하나가 더해졌다.
  // *-actions.ts 도 센다 — 사람 검토 위임·원본 공급 조절·Qwen-v2 자동 단계 스위치 셋.
  // 0116 감사 정책 처리(admin/audit/policy-actions.ts) — 미리보기·실행 만들기·적용 묶음·되돌리기 시작·되돌리기 묶음·예외 목록 여섯,
  // 두 번째 의견 올리기 넷(올려 검사·미리보기·적용 시작·버리기). '보류 모두 풀기'(admin/audit/actions.ts) 하나는 정책의 보류 풀기로 바뀌어 빠졌다
  expect(wrapped).toBe(69);
  const routes = files.filter(file => file.endsWith(`${path.sep}route.ts`));
  for (const file of routes) {
    const source = readFileSync(file, "utf8");
    for (const [, method] of source.matchAll(/^export (?:async function|const) (POST|PUT|PATCH|DELETE)\b/gm)) {
      expect(source, `${file} ${method}`).toMatch(new RegExp(`^export const ${method} = (withRoute|webWriteRoute|verifiedWebWriteRoute)\\(`, "m"));
    }
  }
  // 쓰는 GET(OAuth·설치 콜백)도 같은 관문이다
  for (const file of ["api/auth/user/github/callback", "api/auth/maker/github/callback", "api/github/installations/setup"]) {
    expect(readFileSync(path.join(root, "app", file, "route.ts"), "utf8"), file).toMatch(/^export const GET = webWriteRoute\(/m);
  }
});
