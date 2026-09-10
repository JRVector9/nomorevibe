import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const safeFetch = vi.fn();
const readBodyCapped = vi.fn();
const fetchPage = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  readBodyCapped: (...a: unknown[]) => readBodyCapped(...a),
}));

/**
 * 기록(DB 쓰기)이 동시에 몇 개 진행됐는지 센다. 실제 함수를 그대로 부르고 세기만 한다.
 * 생존 확인이 쥐는 DB 연결 수를 풀 크기 안에 묶는 근거가 "기록은 한 번에 하나"라서다.
 */
const dbWrites = vi.hoisted(() => ({ calls: 0, active: 0, peak: 0 }));
function counted<A extends unknown[], R>(write: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    dbWrites.calls++;
    dbWrites.peak = Math.max(dbWrites.peak, ++dbWrites.active);
    try {
      return await write(...args);
    } finally {
      dbWrites.active--;
    }
  };
}
vi.mock("@/lib/domain/products/health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/products/health")>();
  return { ...actual, recordPing: counted(actual.recordPing) };
});
vi.mock("@/lib/crawl/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crawl/repository")>();
  return { ...actual, refreshTextSample: counted(actual.refreshTextSample) };
});

const { db } = await import("@/lib/db");
const { productHealth, productHealthDaily, jobs } = await import("@/lib/db/schema");
const repo = await import("@/lib/domain/products/repository");
const { nextToCheck, recordPing, downProducts, healthMetrics, RECHECK_AFTER_MINUTES } = await import(
  "@/lib/domain/products/health"
);
const { pingProducts } = await import("@/lib/jobs/products/uptime");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema, resetTables } = await import("./setup");

async function product(slug: string, url: string, status: "verified" | "seeded" | "unverified" = "seeded") {
  await repo.insert({
    slug,
    url,
    name: slug,
    tagline: "소개",
    description: "설명",
    category: "Other",
    stack: [],
    status,
    source: status === "seeded" ? "crawler" : "skill",
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

const alive = () => safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200 } });
const dead = () => safeFetch.mockResolvedValue(null);

/** 잡이 러너 없이 한 틱을 돌 때 쓰는 문맥 */
const tick = (hasBudget: () => boolean = () => true) => ({
  cursor: null,
  save: async () => {},
  hasBudget,
  log: () => {},
});

/**
 * 동시에 열려 있던 요청 수를 센다 — 전체와 서버(origin)별로.
 * 응답 전에 잠깐 쉬어 다른 확인이 시작될 틈을 준다. 순차로 열면 그 사이에 아무것도 열리지 않는다.
 */
function inFlight() {
  const open = new Map<string, number>();
  const peaks = new Map<string, number>();
  let total = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    peakOf: (origin: string) => peaks.get(origin) ?? 0,
    async during<T>(url: string, respond: () => T): Promise<T> {
      const origin = new URL(url).origin;
      const now = (open.get(origin) ?? 0) + 1;
      open.set(origin, now);
      peaks.set(origin, Math.max(peaks.get(origin) ?? 0, now));
      peak = Math.max(peak, ++total);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open.set(origin, (open.get(origin) ?? 1) - 1);
      total--;
      return respond();
    },
  };
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(productHealth);
  await db.delete(jobs);
  await resetTables();
  safeFetch.mockReset();
  readBodyCapped.mockReset();
  readBodyCapped.mockResolvedValue(Buffer.from(""));
  fetchPage.mockReset();
  dbWrites.calls = 0;
  dbWrites.active = 0;
  dbWrites.peak = 0;
});

describe("생존 확인", () => {
  it("확인한 적 없는 제품을 먼저 본다", async () => {
    await product("a", "https://a.test");
    await product("b", "https://b.test");
    await recordPing("a", 200);
    // a는 재검사 간격이 지난 것으로 둬야 순서 비교가 된다
    await db
      .update(productHealth)
      .set({ checkedAt: new Date(Date.now() - (RECHECK_AFTER_MINUTES + 1) * 60_000) });

    expect((await nextToCheck(5)).map((t) => t.slug)).toEqual(["b", "a"]);
  });

  it("방금 확인한 것은 다시 보지 않는다", async () => {
    // 없으면 제품이 배치보다 적을 때 같은 사이트를 하루 1,440번 두드린다
    await product("a", "https://a.test");
    await recordPing("a", 200);

    expect(await nextToCheck(5)).toEqual([]);

    // 재검사 간격이 지나면 다시 대상이 된다
    await db
      .update(productHealth)
      .set({ checkedAt: new Date(Date.now() - (RECHECK_AFTER_MINUTES + 1) * 60_000) });
    expect((await nextToCheck(5)).map((t) => t.slug)).toEqual(["a"]);
  });

  /**
   * GET이라 본문 스트림이 열린 채로 온다. 읽든 끊든 반드시 닫아야 한다 —
   * 안 닫으면 연결이 풀로 돌아가지 않고 1분마다 15건씩 조용히 쌓인다.
   */
  it("살아 있으면 본문을 읽는다 — 그 자체로 스트림이 닫힌다", async () => {
    await product("a", "https://a.test");
    const cancel = vi.fn().mockResolvedValue(undefined);
    safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200, body: { cancel } } });
    readBodyCapped.mockResolvedValue(Buffer.from("<h1>Nivelato</h1>"));

    await runJob("uptime-ping", pingProducts);

    expect(readBodyCapped).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("죽어 있으면 읽지 않고 끊는다 — 받을 본문이 없다", async () => {
    await product("a", "https://a.test");
    const cancel = vi.fn().mockResolvedValue(undefined);
    safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 500, body: { cancel } } });

    await runJob("uptime-ping", pingProducts);

    expect(readBodyCapped).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  /**
   * 수집 잡과 같은 규칙으로 봐야 한다. 여기만 meta refresh를 안 따라가면 껍데기의
   * "Redirecting…"이 수집이 확보한 목적지 본문을 덮어써 재검수 근거가 사라진다.
   */
  it("meta refresh를 따라가 목적지 본문을 담는다", async () => {
    await product("a", "https://a.test");
    safeFetch.mockResolvedValue({ finalUrl: "https://a.test/", response: { status: 200, body: { cancel: vi.fn() } } });
    readBodyCapped.mockResolvedValue(Buffer.from(`<title>Redirecting…</title><meta http-equiv="refresh" content="0; url=./docs/">`));
    fetchPage.mockResolvedValue({ status: 200, finalUrl: "https://a.test/docs/", html: "<body>npm install -g thing</body>" });

    await runJob("uptime-ping", pingProducts);

    // 백그라운드 잡이라 요청 전체 기한("background")으로 연다
    expect(fetchPage).toHaveBeenCalledWith("https://a.test/docs/", "background");
  });

  it("본문을 못 읽어도 생존 확인은 기록한다 — 본문은 부가물이다", async () => {
    await product("a", "https://a.test");
    safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200, body: { cancel: vi.fn() } } });
    readBodyCapped.mockRejectedValue(new Error("stream broke"));

    await runJob("uptime-ping", pingProducts);

    const [row] = await db.select().from(productHealth);
    expect({ status: row.status, failures: row.failures }).toEqual({ status: 200, failures: 0 });
  });

  it("목록에 없는 상태는 확인하지 않는다", async () => {
    await product("pending", "https://pending.test", "unverified");
    expect(await nextToCheck(5)).toEqual([]);
  });

  it("연속 실패를 센다", async () => {
    await product("a", "https://a.test");
    await recordPing("a", 0);
    await recordPing("a", 500);

    const [{ failures, downSince, status }] = await db.select().from(productHealth);
    expect({ failures, status }).toEqual({ failures: 2, status: 500 });
    expect(downSince).toBeInstanceOf(Date);
  });

  it("죽기 시작한 시각은 처음 실패한 때로 남는다", async () => {
    // 매번 갱신하면 얼마나 죽어 있었는지를 잃는다
    await product("a", "https://a.test");
    await recordPing("a", 0);
    const first = (await db.select().from(productHealth))[0].downSince;

    await recordPing("a", 0);

    expect((await db.select().from(productHealth))[0].downSince?.getTime()).toBe(first?.getTime());
  });

  it("한 번 살아나면 실패 기록이 지워진다", async () => {
    await product("a", "https://a.test");
    await recordPing("a", 0);
    await recordPing("a", 0);

    await recordPing("a", 200);

    const [row] = await db.select().from(productHealth);
    expect(row).toMatchObject({ failures: 0, downSince: null });
  });

  it("3xx는 살아 있는 것으로 본다", async () => {
    await product("a", "https://a.test");
    await recordPing("a", 301);
    expect((await db.select().from(productHealth))[0].failures).toBe(0);
  });

  it("잡이 결과를 기록한다 — 목록은 건드리지 않는다", async () => {
    await product("a", "https://a.test");
    dead();

    await runJob("uptime-ping", pingProducts);

    expect((await db.select().from(productHealth))[0]).toMatchObject({ status: 0, failures: 1 });
    // 죽었다고 자동으로 내리지 않는다
    expect((await repo.findBySlug("a"))?.status).toBe("seeded");
  });

  it("연속 실패가 쌓인 것만 어드민에 올린다", async () => {
    await product("a", "https://a.test");
    await product("b", "https://b.test");
    for (let i = 0; i < 3; i++) await recordPing("a", 0);
    await recordPing("b", 0);

    expect((await downProducts()).map((d) => d.slug)).toEqual(["a"]);
  });

  it("확인할 것이 없으면 사이클을 끝낸다", async () => {
    alive();
    expect(await runJob("uptime-ping", pingProducts)).toMatchObject({ done: true });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("KST 일별 성공률과 성공 응답 지연시간을 원자적으로 집계한다", async () => {
    await product("a", "https://a.test");
    await product("b", "https://b.test");
    const firstDay = new Date("2026-08-19T14:59:00.000Z");
    const secondDay = new Date("2026-08-19T15:01:00.000Z");

    await recordPing("a", 200, 120, firstDay);
    await recordPing("a", 503, null, firstDay);
    await recordPing("a", 204, 80, secondDay);

    expect(await db.select().from(productHealthDaily)).toEqual([
      {
        slug: "a",
        day: "2026-08-19",
        checks: 2,
        successes: 1,
        latencyTotalMs: 120,
        latencySamples: 1,
      },
      {
        slug: "a",
        day: "2026-08-20",
        checks: 1,
        successes: 1,
        latencyTotalMs: 80,
        latencySamples: 1,
      },
    ]);

    const metrics = await healthMetrics(["a", "b"], 30, secondDay);
    expect(metrics.get("a")).toEqual({ latencyMs: 80, uptimePercent: 66.7 });
    expect(metrics.get("b")).toEqual({ latencyMs: null, uptimePercent: null });
  });

  it("잡이 monotonic clock으로 측정한 성공 latency를 기록한다", async () => {
    await product("a", "https://a.test");
    const clock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(157);
    const cancel = vi.fn().mockResolvedValue(undefined);
    safeFetch.mockResolvedValue({ finalUrl: "x", response: { status: 200, body: { cancel } } });
    try {
      await runJob("uptime-ping", pingProducts);
    } finally {
      clock.mockRestore();
    }

    expect((await db.select().from(productHealth))[0].latencyMs).toBe(57);
    expect((await db.select().from(productHealthDaily))[0]).toMatchObject({
      checks: 1,
      successes: 1,
      latencyTotalMs: 57,
      latencySamples: 1,
    });
  });

  it("진행 중이던 확인 결과를 같은 slug의 재등록 제품에 붙이지 않는다", async () => {
    await product("reuse", "https://old.test");
    const oldProduct = await repo.findBySlug("reuse");
    let signalStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    safeFetch.mockImplementation(async () => {
      signalStarted();
      await responseReleased;
      return { finalUrl: "https://old.test", response: { status: 200 } };
    });
    const ping = pingProducts({
      cursor: null,
      save: async () => {},
      hasBudget: () => true,
      log: () => {},
    });
    await started;

    await repo.removeProductAndEvidence(oldProduct!.id, "reuse");
    await product("reuse", "https://replacement.test");
    releaseResponse();

    await expect(ping).rejects.toThrow(/product generation changed/);
    expect(await db.select().from(productHealth)).toHaveLength(0);
    expect(await db.select().from(productHealthDaily)).toHaveLength(0);
  });
});

/**
 * 재확인 간격(6시간)을 따라가려면 한 틱이 순차로 열어서는 안 된다 — 응답 없는 서버 하나가
 * 10초를 먹으면 25초 예산에 두세 건밖에 못 본다. 서로 다른 서버는 동시에, 같은 서버는 하나씩.
 */
describe("생존 확인 — 동시에 연다", () => {
  const reply = (url: string, status = 500) => ({
    finalUrl: url,
    response: { status, body: { cancel: vi.fn().mockResolvedValue(undefined) } },
  });

  it("한 틱 안에서 서로 다른 서버 3곳까지 동시에 연다", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) await product(name, `https://${name}.test`);
    const http = inFlight();
    safeFetch.mockImplementation((url: string) => http.during(url, () => reply(url)));

    await runJob("uptime-ping", pingProducts);

    expect(http.peak).toBe(3);
    expect(safeFetch).toHaveBeenCalledTimes(5);
    expect(await db.select().from(productHealth)).toHaveLength(5);
  });

  it("같은 서버는 한 번에 하나만 연다 — 다른 서버와는 동시에", async () => {
    await product("same-1", "https://same.test/one");
    await product("same-2", "https://same.test/two");
    await product("same-3", "https://same.test/three");
    await product("other", "https://other.test");
    const http = inFlight();
    safeFetch.mockImplementation((url: string) => http.during(url, () => reply(url)));

    await runJob("uptime-ping", pingProducts);

    expect(http.peakOf("https://same.test")).toBe(1);
    expect(http.peak).toBe(2);
    expect(await db.select().from(productHealth)).toHaveLength(4);
  });

  it("동시에 열어도 응답마다 본문을 정확히 한 번 닫는다 — 살았으면 읽고, 죽었으면 끊는다", async () => {
    const responses = new Map<string, ReturnType<typeof reply>["response"]>();
    for (const [i, status] of [200, 500, 204, 503, 301, 404].entries()) {
      const url = `https://p${i}.test`;
      await product(`p${i}`, url);
      responses.set(url, reply(url, status).response);
    }
    const http = inFlight();
    safeFetch.mockImplementation((url: string) => http.during(url, () => ({ finalUrl: url, response: responses.get(url) })));

    await runJob("uptime-ping", pingProducts);

    expect(http.peak).toBe(3);
    for (const response of responses.values()) {
      const read = readBodyCapped.mock.calls.filter(([r]) => r === response).length;
      const cancelled = response.body.cancel.mock.calls.length;
      expect({ status: response.status, read, cancelled }).toEqual({
        status: response.status,
        read: response.status < 400 ? 1 : 0,
        cancelled: response.status < 400 ? 0 : 1,
      });
    }
  });

  /**
   * HTTP만 동시에 연다. 기록은 밀리초라 줄을 세워도 느려지지 않고, 그래야 이 잡이 동시에 쥐는
   * DB 연결이 기록 1개 + 러너 임대 갱신 1개로 묶여 maintenance 풀(3) 안에 든다.
   */
  it("기록은 한 번에 하나씩 한다 — 동시에 여는 것은 HTTP뿐이다", async () => {
    for (const name of ["a", "b", "c", "d", "e", "f"]) await product(name, `https://${name}.test`);
    safeFetch.mockImplementation(async (url: string) => reply(url, 200));
    readBodyCapped.mockResolvedValue(Buffer.from("<body><h1>Nivelato</h1><p>할 일을 정리한다</p></body>"));

    await runJob("uptime-ping", pingProducts);

    expect(await db.select().from(productHealth)).toHaveLength(6);
    // recordPing 6번 + refreshTextSample 6번. 어느 둘이 겹쳐도 연결을 두 개 쥔다
    expect(dbWrites.calls).toBe(12);
    expect(dbWrites.peak).toBe(1);
  });

  it("예산이 끝나면 새 확인을 시작하지 않는다 — 이미 연 것은 마친다", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) await product(name, `https://${name}.test`);
    safeFetch.mockImplementation(async (url: string) => reply(url));
    let allowed = 3;

    const outcome = await pingProducts(tick(() => allowed-- > 0));

    expect(safeFetch).toHaveBeenCalledTimes(3);
    expect(await db.select().from(productHealth)).toHaveLength(3);
    // 남은 것은 가장 오래된 채로 남아 다음 틱이 먼저 가져간다
    expect(outcome).toEqual({ done: false });
  });

  /**
   * 한 건의 실패로 먼저 끝내면 이미 연 확인들이 러너가 임대를 푼 뒤에 뒤늦게 기록된다.
   * 새로 열지는 않되, 연 것은 끝까지 기록하고 닫은 다음에 실패를 알린다.
   */
  it("한 건이 실패해도 이미 연 확인은 기록하고 닫은 뒤에 실패를 알린다", async () => {
    await product("reuse", "https://old.test");
    await product("slow-up", "https://slow-up.test");
    await product("slow-down", "https://slow-down.test");
    const oldProduct = await repo.findBySlug("reuse");
    const downCancel = vi.fn().mockResolvedValue(undefined);
    let started = 0;
    let allStarted!: () => void;
    let releaseReuse!: () => void;
    let releaseSlow!: () => void;
    const ready = new Promise<void>((resolve) => { allStarted = resolve; });
    const reuseGate = new Promise<void>((resolve) => { releaseReuse = resolve; });
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    safeFetch.mockImplementation(async (url: string) => {
      if (++started === 3) allStarted();
      if (url === "https://old.test") {
        await reuseGate;
        return { finalUrl: url, response: { status: 200 } };
      }
      await slowGate;
      return url === "https://slow-down.test"
        ? { finalUrl: url, response: { status: 500, body: { cancel: downCancel } } }
        : reply(url, 200);
    });

    const ping = pingProducts(tick());
    await ready;
    await repo.removeProductAndEvidence(oldProduct!.id, "reuse");
    await product("reuse", "https://replacement.test");
    releaseReuse();
    // 재등록된 쪽의 기록이 먼저 실패한다. 나머지 둘은 그 뒤에야 응답한다
    setTimeout(releaseSlow, 50);

    await expect(ping).rejects.toThrow(/product generation changed/);
    const rows = await db.select().from(productHealth);
    expect(rows.map((row) => row.slug).sort()).toEqual(["slow-down", "slow-up"]);
    expect(downCancel).toHaveBeenCalledTimes(1);
  });
});
