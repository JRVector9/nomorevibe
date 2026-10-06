import { describe, expect, it, vi } from "vitest";
import { createReplicaRouter, LAG_CHECK_MS, REPLICA_COOLDOWN_MS, replicaFailure } from "@/lib/db/replica";

/**
 * 공개 읽기를 복제본에서 하되, 복제본이 안 되면 주 DB 로 돌아간다(2026-10-06 P2).
 * 여기서 "주 DB" 는 scope 밖에서 load() 를 부르는 것이고, "복제본" 은 scope 안에서 부르는 것이다.
 */
function setup(options: { lag?: number | Error; scopeError?: unknown } = {}) {
  let now = 1_000_000;
  const where: string[] = [];
  const warn = vi.fn();
  const lagSeconds = vi.fn(async () => {
    if (options.lag instanceof Error) throw options.lag;
    return options.lag ?? 0;
  });
  const scope = vi.fn(async <T,>(_db: string, load: () => Promise<T>) => {
    if (options.scopeError) throw options.scopeError;
    where.push("replica");
    return load();
  });
  const router = createReplicaRouter<string>({
    replica: () => "replica-db", scope: scope as unknown as <T>(db: string, load: () => Promise<T>) => Promise<T>,
    lagSeconds, warn, now: () => now,
  });
  const load = vi.fn(async () => { if (where.at(-1) !== "replica") where.push("primary"); else where.push("ran"); return 1; });
  return { router, load, where, warn, lagSeconds, scope, tick: (ms: number) => { now += ms; } };
}
const err = (code: string, cause?: unknown) => Object.assign(new Error(code), { code, cause });

describe("복제본 읽기", () => {
  it("평소에는 복제본에서 읽고, 지연은 10초마다 한 번만 본다", async () => {
    const s = setup();
    await s.router.read(s.load);
    await s.router.read(s.load);
    expect(s.scope).toHaveBeenCalledTimes(2);
    expect(s.lagSeconds).toHaveBeenCalledTimes(1);
    s.tick(LAG_CHECK_MS);
    await s.router.read(s.load);
    expect(s.lagSeconds).toHaveBeenCalledTimes(2);
  });

  it("10초 넘게 밀렸으면 주 DB 에서 읽는다 — 내린 제품을 다시 채우지 않게", async () => {
    const s = setup({ lag: 11 });
    await s.router.read(s.load);
    expect(s.scope).not.toHaveBeenCalled();
    expect(s.where).toEqual(["primary"]);
    expect(s.warn).toHaveBeenCalledWith("db.replica_lagging", { lagSeconds: 11 });
  });

  it("연결이 안 되면 주 DB 로 다시 읽고 30초 동안 복제본을 건너뛴다", async () => {
    const s = setup({ scopeError: err("wrapped", err("ECONNREFUSED")) });
    expect(await s.router.read(s.load)).toBe(1);
    expect(s.where).toEqual(["primary"]);
    await s.router.read(s.load);
    expect(s.scope).toHaveBeenCalledTimes(1);
    s.tick(REPLICA_COOLDOWN_MS);
    await s.router.read(s.load).catch(() => {});
    expect(s.scope).toHaveBeenCalledTimes(2);
  });

  it("복제 충돌로 취소되면 주 DB 로 한 번 더 읽고 복제본은 계속 쓴다", async () => {
    const s = setup({ scopeError: err("40001") });
    await s.router.read(s.load);
    await s.router.read(s.load);
    expect(s.scope).toHaveBeenCalledTimes(2);
    expect(s.warn).toHaveBeenCalledWith("db.replica_fallback", expect.objectContaining({ kind: "conflict" }));
  });

  it("복제본에 쓰려 했으면 주 DB 로 하되 따로 남긴다", async () => {
    const s = setup({ scopeError: err("25006") });
    await s.router.read(s.load);
    expect(s.where).toEqual(["primary"]);
    expect(s.warn).toHaveBeenCalledWith("db.replica_write_attempt", expect.objectContaining({ kind: "readonly" }));
  });

  it("다른 오류는 그대로 던진다 — 주 DB 로 숨기지 않는다", async () => {
    const s = setup({ scopeError: err("42P01") });
    await expect(s.router.read(s.load)).rejects.toThrow("42P01");
  });

  it("복제본 설정이 없으면(워커·로컬) 주 DB 만 쓴다", async () => {
    const load = vi.fn(async () => 2);
    const scope = vi.fn();
    const router = createReplicaRouter<string>({ replica: () => null, scope, lagSeconds: vi.fn(), warn: vi.fn() });
    expect(await router.read(load)).toBe(2);
    expect(scope).not.toHaveBeenCalled();
  });

  it("오류 코드는 drizzle 이 감싼 원인까지 따라가 가린다", () => {
    expect(replicaFailure(err("wrapped", err("CONNECT_TIMEOUT")))).toBe("down");
    expect(replicaFailure(err("08006"))).toBe("down");
    expect(replicaFailure(err("57P03"))).toBe("down");
    expect(replicaFailure(err("DB_POOL_WAIT_TIMEOUT"))).toBe("down");
    expect(replicaFailure(err("40001"))).toBe("conflict");
    expect(replicaFailure(err("25006"))).toBe("readonly");
    expect(replicaFailure(err("23505"))).toBeNull();
    expect(replicaFailure(new Error("plain"))).toBeNull();
  });
});
