import postgres from "postgres";

const ROLE_POOL_MAX = { web: 8, crawler: 4, reviewer: 3, publisher: 3, maintenance: 3, scheduler: 2 } as const;
export type DbRole = keyof typeof ROLE_POOL_MAX;
export type DbPoolConfig = {
  role: DbRole;
  max: number;
  waitMs: number;
  connectSeconds: number;
  statementMs: number;
  lockMs: number;
  lifetimeSeconds: number;
};

function integerSetting(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const input = env[key];
  if (input === undefined) return fallback;
  const value = /^\d+$/.test(input) ? Number(input) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
  return value;
}

export function dbPoolConfig(env: NodeJS.ProcessEnv = process.env): DbPoolConfig {
  const role = env.WORKER_ROLE ?? "web";
  if (!Object.hasOwn(ROLE_POOL_MAX, role)) throw new Error("Invalid WORKER_ROLE for database pool");
  const selected = role as DbRole;
  const statementDefault = selected === "maintenance" ? 120_000 : selected === "web" ? 15_000 : selected === "scheduler" ? 10_000 : 60_000;
  const statementMs = integerSetting(env, "DB_STATEMENT_TIMEOUT_MS", statementDefault, 100, 600_000);
  const lockMs = integerSetting(env, "DB_LOCK_TIMEOUT_MS", Math.min(5_000, statementMs), 100, 60_000);
  if (lockMs > statementMs) throw new Error("DB_LOCK_TIMEOUT_MS must not exceed DB_STATEMENT_TIMEOUT_MS");
  return {
    role: selected,
    max: integerSetting(env, "DB_POOL_MAX", ROLE_POOL_MAX[selected], 1, 64),
    waitMs: integerSetting(env, "DB_POOL_WAIT_MS", 5_000, 10, 60_000),
    connectSeconds: integerSetting(env, "DB_CONNECT_TIMEOUT_SECONDS", 3, 1, 30),
    statementMs,
    lockMs,
    lifetimeSeconds: integerSetting(env, "DB_MAX_LIFETIME_SECONDS", 1_800, 30, 86_400),
  };
}

export class DbPoolWaitTimeoutError extends Error {
  readonly code = "DB_POOL_WAIT_TIMEOUT";
  constructor() { super("Database connection pool wait exceeded its deadline"); this.name = "DbPoolWaitTimeoutError"; }
}

/**
 * Compatibility surface of postgres 3.4.9 src/query.js and src/index.js cancel(query).
 * Pending query cancellation removes the real queued write; Promise.race alone would leave it queued.
 * Do not use Query.cancel(): that version drops the canceller Promise (including cancellation errors).
 * Revalidate the real saturated-pool and BEGIN integration tests when upgrading postgres.
 */
interface DriverQuery {
  handler: (query: DriverQuery) => unknown;
  resolve: (value: unknown) => unknown;
  reject: (error: unknown) => unknown;
  state: unknown | null;
  canceller: ((query: DriverQuery) => Promise<void>) | null;
}

type WaitingQueries = Map<DriverQuery, (error: Error) => void>;

function waitDeadline<T>(value: T, waitMs: number, waiting: WaitingQueries): T {
  const query = value as T & DriverQuery;
  if (!query || typeof query.handler !== "function" || typeof query.resolve !== "function" || typeof query.reject !== "function") {
    throw new Error("Unsupported postgres query internals; validate the pool adapter before upgrading");
  }
  const originalHandler = query.handler;
  const originalResolve = query.resolve;
  const originalReject = query.reject;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Error | null = null;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; waiting.delete(query); };
  query.resolve = result => { clear(); return originalResolve(result); };
  query.reject = error => { clear(); return originalReject(cancellation ?? error); };
  const cancelWaiting = (reason: Error) => {
    clear();
    if (query.state !== null || !query.canceller) return;
    cancellation = reason;
    const cancel = query.canceller;
    query.canceller = null;
    // cancel removes the queue entry synchronously; catch its returned Promise as well.
    try { void cancel(query).catch(error => query.reject(error)); }
    catch (error) { query.reject(error); }
  };
  query.handler = Object.assign((pending: DriverQuery) => {
    waiting.set(pending, cancelWaiting);
    timer = setTimeout(() => {
      // A connection already owns the query. PostgreSQL statement/lock timeouts bound that work.
      // Only a query that has not been sent is cancelled; no detached in-flight write is reported failed.
      cancelWaiting(new DbPoolWaitTimeoutError());
    }, waitMs);
    timer.unref?.();
    const connection = originalHandler(pending);
    // Initial connect returns its Connection before state is set. connect_timeout bounds it;
    // cancelling that initial query can otherwise strand postgres 3.4.9's connecting slot.
    if (pending.state !== null || (connection && typeof connection === "object" && "execute" in connection)) clear();
    return connection;
  }, originalHandler);
  return value;
}

/** Drizzle executes unsafe queries; postgres.begin also calls this exact object's unsafe for BEGIN. */
export function createDbClient(connectionString: string, config: DbPoolConfig = dbPoolConfig()): ReturnType<typeof postgres> {
  const waiting: WaitingQueries = new Map();
  const options = {
    max: config.max,
    connect_timeout: config.connectSeconds,
    max_lifetime: config.lifetimeSeconds,
    onclose: () => {
      // postgres calls this hook BEFORE moving a queued query onto a reconnecting slot.
      // Reject waiting work now so its queue timer cannot later cancel an initial connect.
      for (const cancel of waiting.values()) cancel(new Error("Database connection closed while waiting for the pool; retry the operation"));
    },
    connection: {
      application_name: `nomorevibe:${config.role}`,
      statement_timeout: config.statementMs,
      lock_timeout: config.lockMs,
      idle_in_transaction_session_timeout: Math.max(config.statementMs, 60_000),
    },
  };
  const client = postgres(connectionString, options);
  client.unsafe = new Proxy(client.unsafe, {
    apply: (unsafe, receiver, args) => waitDeadline(Reflect.apply(unsafe, receiver, args), config.waitMs, waiting),
  });
  // Preserve tagged-query use of the public client without changing SQL fragments or identifiers.
  return new Proxy(client, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      return Array.isArray(args[0]?.raw) ? waitDeadline(result, config.waitMs, waiting) : result;
    },
  });
}
