import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {};
  const instance = {
    insert: vi.fn(),
    query: {},
    select: vi.fn(),
  };

  return {
    client,
    drizzle: vi.fn(() => instance),
    instance,
    postgres: vi.fn(() => client),
  };
});

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));

type DbGlobals = typeof globalThis & {
  db?: unknown;
  pgClient?: unknown;
};

function clearDbGlobals() {
  delete (globalThis as DbGlobals).db;
  delete (globalThis as DbGlobals).pgClient;
}

describe("database client lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clearDbGlobals();
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost:5432/test");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    clearDbGlobals();
    vi.unstubAllEnvs();
  });

  it("reuses one PostgreSQL client across production db property access", async () => {
    const { db } = await import("@/lib/db");

    void db.select;
    void db.insert;
    void db.query;

    expect(mocks.postgres).toHaveBeenCalledTimes(1);
    expect(mocks.drizzle).toHaveBeenCalledTimes(1);
  });
});
