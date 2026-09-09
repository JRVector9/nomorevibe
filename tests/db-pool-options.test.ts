import { describe, expect, it } from "vitest";
import { dbPoolConfig, postgresClientOptions } from "@/lib/db/pool";

describe("PostgreSQL client options", () => {
  it("omits unsupported timeout startup parameters for PgBouncer", () => {
    const config = dbPoolConfig({
      WORKER_ROLE: "web",
      DB_POOLER_MODE: "pgbouncer",
    });

    expect(postgresClientOptions(config)).toMatchObject({
      max: 8,
      connection: { application_name: "nomorevibe:web" },
    });
    expect(postgresClientOptions(config).connection).not.toHaveProperty("statement_timeout");
    expect(postgresClientOptions(config).connection).not.toHaveProperty("lock_timeout");
    expect(postgresClientOptions(config).connection).not.toHaveProperty("idle_in_transaction_session_timeout");
  });

  it("keeps server-side timeout startup parameters for direct PostgreSQL", () => {
    const config = dbPoolConfig({ WORKER_ROLE: "maintenance" });

    expect(postgresClientOptions(config).connection).toMatchObject({
      application_name: "nomorevibe:maintenance",
      statement_timeout: 120_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 120_000,
    });
  });

  it("rejects an unknown pooler mode", () => {
    expect(() => dbPoolConfig({ DB_POOLER_MODE: "unknown" })).toThrow("Invalid DB_POOLER_MODE");
  });

  it("gives the private connect agent its own bounded pool identity", () => {
    expect(dbPoolConfig({ WORKER_ROLE: "connect-agent" })).toMatchObject({
      role: "connect-agent",
      max: 1,
    });
  });
});
