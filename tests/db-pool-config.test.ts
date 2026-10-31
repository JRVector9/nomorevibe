import { expect, it } from "vitest";
import { dbPoolConfig } from "@/lib/db/pool";

// 2026-10-31: reviewer 3 → 6(3a-A, 모델 줄 4 + 2) → 11(3a-C 합성 잡 분해, 모델 줄 9 + 2); 그 전 27-connection 예산은 35 가 됐다(lib/jobs/catalog.ts 줄 설명)
it("allocates finite role-specific pools within the 35-connection budget", () => {
  const roles = ["web","crawler","reviewer","publisher","maintenance","scheduler"];
  expect(roles.map(WORKER_ROLE => dbPoolConfig({WORKER_ROLE}).max)).toEqual([8,8,11,3,3,2]);
  expect(roles.reduce((total,WORKER_ROLE) => total+dbPoolConfig({WORKER_ROLE}).max,0)).toBe(35);
  expect(dbPoolConfig({}).role).toBe("web");
  expect(dbPoolConfig({WORKER_ROLE:"maintenance"}).statementMs).toBeGreaterThan(25_000);
});
it("validates overrides before opening a pool and keeps connect/pool wait independent", () => {
  expect(dbPoolConfig({WORKER_ROLE:"crawler",DB_POOL_MAX:"2",DB_POOL_WAIT_MS:"40",DB_CONNECT_TIMEOUT_SECONDS:"3"}))
    .toMatchObject({max:2,waitMs:40,connectSeconds:3});
  for (const env of [{WORKER_ROLE:"typo"},{DB_POOL_MAX:"0"},{DB_POOL_MAX:"Infinity"},{DB_POOL_MAX:"1.5"},
    {DB_POOL_WAIT_MS:"0"},{DB_STATEMENT_TIMEOUT_MS:"0"},{DB_MAX_LIFETIME_SECONDS:"0"},
    {DB_STATEMENT_TIMEOUT_MS:"1000",DB_LOCK_TIMEOUT_MS:"2000"}]) {
    expect(() => dbPoolConfig(env)).toThrow();
  }
});
