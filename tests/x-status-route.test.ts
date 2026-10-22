import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllMemos } from "@/lib/cache/memo";
import { signXStatus, X_STATUS_PREVIOUS_SECRET_ENV, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";

// 운영센터 v8 PR9: X 수집기 하루 보고(서명 push). 가짜 DB 로 검사 순서·관문·한 줄 쓰기를 본다.
// 실제 SQL(조건부 upsert·DB 시계·단조·속도 제한)은 tests/integration/x-status-route.test.ts 가 본다(CI).
const fake = vi.hoisted(() => ({ calls: [] as string[], siteRows: [] as unknown[], txRows: [] as unknown[],
  stored: [] as unknown[], written: [] as unknown[], values: [] as unknown[] }));

const lineage = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11";
const activeRow = { lineage_id: lineage, writer_epoch: 1, state: "active", reason: null, fenced_db: null, promotion_id: null };
const fencedRow = { lineage_id: lineage, writer_epoch: 1, state: "fenced", reason: "operator_fence", promotion_id: null,
  fenced_db: { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" } };
const sqlText = (query: unknown) => JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query);
/** select(...).from().where() · insert().values().onConflictDoUpdate().returning() — await 하는 순간 한 번 기록한다 */
function chain(label: string, rows: () => unknown[]): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const name of ["from", "where", "for", "set", "onConflictDoNothing", "onConflictDoUpdate", "returning"]) self[name] = () => self;
  self.values = (value: unknown) => { fake.values.push(value); return self; };
  self.then = (ok: (value: unknown[]) => unknown, bad?: (error: unknown) => unknown) => { fake.calls.push(label); return Promise.resolve(rows()).then(ok, bad); };
  return self;
}
const tx = {
  execute: vi.fn(async (query: unknown) => {
    const text = sqlText(query), share = text.includes("dr_writer_fence") && text.includes("FOR SHARE");
    fake.calls.push(share ? "tx:fence-share" : "tx:execute");
    return share ? fake.txRows : [];
  }),
  insert: () => chain("tx:upsert", () => fake.written),
  // 끝난 실제 수집의 후보 기록(x-status:runs) — 같은 TX 에서 지난 줄을 잠그고 읽는다
  select: () => chain("tx:runs-read", () => []),
};
const fakeDb = {
  execute: vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    fake.calls.push(text.includes("dr_writer_fence") ? "db:fence-read" : "db:execute");
    return text.includes("dr_writer_fence") ? fake.siteRows : [];
  }),
  select: () => chain("db:read", () => fake.stored),
  insert: () => chain("db:insert", () => []),
  transaction: vi.fn(async (load: (value: unknown) => Promise<unknown>) => { fake.calls.push("db:begin"); return load(tx); }),
};
// lib/db 는 globalThis.db 가 있으면 그것을 주 DB 로 쓴다(dr-web-fence 테스트와 같은 길)
(globalThis as { db?: unknown }).db = fakeDb;
afterAll(() => { delete (globalThis as { db?: unknown }).db; });

const SECRET = "x-status-current-secret-0123456789abcdef", OLD = "x-status-previous-secret-0123456789abcdef";
const NOW = new Date("2026-10-18T00:10:05.000Z"), NOW_S = Math.floor(NOW.getTime() / 1000);
const report = { v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 3,
  lastRunAt: "2026-10-18T00:10:01.000Z", lastSuccessAt: "2026-10-18T00:10:01.000Z", error: null };

type Signed = { secret?: string; timestamp?: number | string; signature?: string; headers?: Record<string, string>; raw?: string | Uint8Array };
function signed(body: unknown = report, options: Signed = {}) {
  const raw = options.raw ?? JSON.stringify(body), timestamp = options.timestamp ?? NOW_S;
  return new Request("https://nomorevibe.test/api/ops/x-status", { method: "POST", body: raw as BodyInit, headers: {
    "content-type": "application/json", "x-nmv-timestamp": String(timestamp),
    "x-nmv-signature": options.signature ?? signXStatus(options.secret ?? SECRET, Number(timestamp), raw), ...options.headers,
  } });
}
async function post(request: Request) {
  const { POST } = await import("@/app/api/ops/x-status/route");
  const response = await POST(request);
  return { status: response.status, body: response.status === 404 ? null : await response.json() as { error?: string; accepted?: boolean }, response };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
  vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, "");
  fake.calls.length = 0; fake.values.length = 0;
  fake.siteRows = [activeRow]; fake.txRows = [activeRow]; fake.stored = []; fake.written = [{ key: "x-status" }];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("꺼진 주소", () => {
  it("비밀이 없거나 짧으면 404 — 본문도 DB 도 보지 않는다(배포만으로는 아무것도 바뀌지 않는다)", async () => {
    for (const [current, previous] of [["", ""], ["short-secret-31-bytes-012345678", ""], ["", OLD]]) {
      vi.stubEnv(X_STATUS_SECRET_ENV, current);
      vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, previous);
      const request = signed();
      const { status, response } = await post(request);
      expect(status, current).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(request.bodyUsed).toBe(false);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("검사 순서 — 크기 → 시각 → 서명 → 형식, 모두 DB 전에", () => {
  it("4KB 를 넘으면 413 — 시각·서명이 틀려도 크기가 먼저다", async () => {
    const big = JSON.stringify({ ...report, pad: "x".repeat(4_096) });
    expect((await post(signed(undefined, { raw: big, timestamp: 1, signature: "v1=00" }))).body).toEqual({ error: "x_status_body_too_large" });
    const declared = signed(undefined, { headers: { "content-length": "5000" } });
    expect(await post(declared)).toMatchObject({ status: 413, body: { error: "x_status_body_too_large" } });
    expect(fake.calls).toEqual([]);
  });

  it("시각이 없거나 ±5분 밖이면 401 — 서명이 틀려도 시각이 먼저다", async () => {
    for (const timestamp of ["", "abc", "1792282", NOW_S - 301, NOW_S + 301]) {
      const { status, body } = await post(signed(undefined, { timestamp, signature: `v1=${"0".repeat(64)}` }));
      expect([status, body], String(timestamp)).toEqual([401, { error: "x_status_timestamp_invalid" }]);
    }
    // 창 끝(±300초)은 시각 검사를 지나 서명 검사로 간다
    for (const timestamp of [NOW_S - 300, NOW_S + 300]) {
      expect((await post(signed(undefined, { timestamp, signature: `v1=${"0".repeat(64)}` }))).body).toEqual({ error: "x_status_signature_invalid" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("서명이 틀리면 401 — 본문 형식이 틀려도 서명이 먼저다", async () => {
    const raw = JSON.stringify(report);
    const cases = [`v1=${"0".repeat(64)}`, signXStatus(SECRET, NOW_S, raw).toUpperCase(), signXStatus(SECRET, NOW_S - 1, raw),
      signXStatus("another-secret-of-enough-length-0123456789", NOW_S, raw), signXStatus(SECRET, NOW_S, raw).replace("v1=", "v2="), ""];
    for (const signature of cases) {
      expect(await post(signed(undefined, { raw, signature })), signature).toMatchObject({ status: 401, body: { error: "x_status_signature_invalid" } });
    }
    // 서명한 바이트를 한 글자라도 바꾸면 틀린다
    const tampered = signed(undefined, { raw: raw.replace('"candidates":3', '"candidates":4'), signature: signXStatus(SECRET, NOW_S, raw) });
    expect((await post(tampered)).status).toBe(401);
    expect((await post(signed("not json", { raw: "not json", signature: `v1=${"a".repeat(64)}` }))).status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("서명이 맞아도 형식이 엄격하지 않으면 400·415 — 자유 글자는 짧은 오류 코드 하나뿐이다", async () => {
    const invalid: unknown[] = [
      { ...report, note: "free text" }, { ...report, v: 2 }, { ...report, v: 3 }, { ...report, v: 4, query: { source: "popular", minLikes: 50 } },
      { ...report, mode: "on" }, Object.fromEntries(Object.entries(report).filter(([key]) => key !== "error")),
      { ...report, reads: { used: 11, limit: 10 } }, { ...report, reads: { used: -1, limit: 10 } }, { ...report, reads: { used: 1.5, limit: 10 } },
      { ...report, reads: { used: 1, limit: 10, extra: 1 } }, { ...report, reads: { used: 1, limit: 1_001 } }, { ...report, candidates: 1_001 },
      { ...report, candidates: "3" }, { ...report, lastRunAt: "2026-10-18 00:10:01" }, { ...report, lastRunAt: "2026-02-30T00:00:00.000Z" },
      { ...report, lastRunAt: "2026-10-18T00:10:07.000Z", lastSuccessAt: null }, { ...report, lastRunAt: "2026-10-17T00:10:01.000Z" },
      { ...report, lastRunAt: null }, { ...report, error: "HTTP 500 from api.x.com" }, { ...report, error: "a".repeat(49) }, { ...report, error: 500 },
      [report], null, "report",
    ];
    for (const body of invalid) {
      expect(await post(signed(body)), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: "x_status_payload_invalid" } });
    }
    for (const raw of ["", "{", new Uint8Array([0x7b, 0xff, 0x7d])]) {
      expect((await post(signed(undefined, { raw }))).body).toEqual({ error: "x_status_payload_invalid" });
    }
    expect(await post(signed(undefined, { headers: { "content-type": "text/plain" } }))).toMatchObject({ status: 415, body: { error: "x_status_json_required" } });
    expect(fake.calls).toEqual([]);
  });
});

describe("받기 — 관문 → 단조 → 속도 → 한 줄 쓰기", () => {
  it("받으면 fence 확인 → 저장된 줄 읽기 → 쓰기 TX 첫 lock(fence SHARE) → x-status 한 줄 upsert", async () => {
    const minimal = { ...report, mode: "dry-run", reads: { used: 0, limit: 10 }, candidates: 0, lastSuccessAt: null, error: "use_case_not_approved" };
    // v3(2026-10-22 수집기)는 그날 검색어 칸이 하나 더 있다
    const v3 = { ...report, v: 3, query: { source: "popular", minLikes: 50 } };
    for (const body of [report, minimal, v3]) {
      // fence 캐시(5초)를 비워 매번 관문 읽기부터 본다
      clearAllMemos(); fake.calls.length = 0; fake.values.length = 0;
      expect(await post(signed(body))).toMatchObject({ status: 200, body: { accepted: true } });
      // 끝난 실제 수집(live·오류 없음·이번 실행이 마지막 성공)이면 같은 TX 에서 후보 기록(x-status:runs)도 고친다 — 시험 실행은 건드리지 않는다
      const completed = body.mode === "live";
      expect(fake.calls).toEqual(["db:fence-read", "db:read", "db:begin", "tx:fence-share", "tx:upsert", ...(completed ? ["tx:runs-read", "tx:upsert"] : [])]);
      expect(fake.values).toEqual([{ key: "x-status", value: { ...body, sentAt: NOW_S, signedWith: "current" }, observedAt: expect.anything() },
        ...(completed ? [{ key: "x-status:runs", value: { zeroRuns: 0, zeroSince: null, lastCompletedRunAt: report.lastRunAt, lastCandidates: 3 }, observedAt: expect.anything() }] : [])]);
    }
  });

  it("비밀 교체: 직전 비밀로 서명한 보고도 받고 어느 쪽인지 적는다 — 지금 비밀과 같은 직전 비밀은 쓰지 않는다", async () => {
    vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, OLD);
    const stored = () => (fake.values as { key: string }[]).filter((row) => row.key === "x-status").at(-1);
    expect((await post(signed(report, { secret: OLD }))).status).toBe(200);
    expect(stored()).toMatchObject({ value: { signedWith: "previous" } });
    expect((await post(signed(report))).status).toBe(200);
    expect(stored()).toMatchObject({ value: { signedWith: "current" } });
    vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, "");
    expect((await post(signed(report, { secret: OLD }))).status).toBe(401);
    vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, SECRET);
    expect((await post(signed(report))).status).toBe(200);
    expect(stored()).toMatchObject({ value: { signedWith: "current" } });
  });

  it("단조: 저장된 보고보다 오래되거나 같으면 409 — 쓰기 TX 를 열지 않는다(되보내기 거절)", async () => {
    for (const sentAt of [NOW_S, NOW_S + 1]) {
      clearAllMemos(); fake.calls.length = 0;
      fake.stored = [{ sentAt, recent: false }];
      expect(await post(signed())).toMatchObject({ status: 409, body: { error: "x_status_not_newer" } });
      expect(fake.calls).toEqual(["db:fence-read", "db:read"]);
    }
  });

  it("속도 제한: 서명·단조를 지난 뒤, 마지막으로 받은 지 60초 안이면 429 — 쓰지 않는다", async () => {
    fake.stored = [{ sentAt: NOW_S - 30, recent: true }];
    const { status, body, response } = await post(signed());
    expect([status, body]).toEqual([429, { error: "x_status_rate_limited" }]);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fake.calls).toEqual(["db:fence-read", "db:read"]);
  });

  it("동시에 온 두 보고: 조건부 upsert 가 0줄이면 409", async () => {
    fake.written = [];
    expect(await post(signed())).toMatchObject({ status: 409, body: { error: "x_status_not_newer" } });
    expect(fake.calls).toEqual(["db:fence-read", "db:read", "db:begin", "tx:fence-share", "tx:upsert"]);
  });

  it("DR: fenced 사이트는 서명 확인 뒤에만 fence 를 읽고 503 — 서명이 틀린 요청은 fence 도 읽지 않는다", async () => {
    fake.siteRows = [fencedRow];
    expect((await post(signed(undefined, { signature: `v1=${"0".repeat(64)}` }))).status).toBe(401);
    expect(fake.calls).toEqual([]);
    const { status, body, response } = await post(signed());
    expect([status, body]).toEqual([503, { error: "x_status_unavailable" }]);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fake.calls).toEqual(["db:fence-read"]);
  });

  it("DR: 캐시가 active 인 창에서 쓰기 TX 첫 lock 이 fenced 면 503 — upsert 하지 않는다", async () => {
    fake.txRows = [fencedRow];
    expect(await post(signed())).toMatchObject({ status: 503, body: { error: "x_status_unavailable" } });
    expect(fake.calls).toEqual(["db:fence-read", "db:read", "db:begin", "tx:fence-share"]);
  });
});
