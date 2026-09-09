import postgres from "postgres";

const ROLE_POOL_MAX = { web: 8, crawler: 4, reviewer: 3, publisher: 3, maintenance: 3, scheduler: 2, "connect-agent": 1 } as const;
export type DbRole = keyof typeof ROLE_POOL_MAX;
export type DbPoolConfig = {
  role: DbRole;
  poolerMode: "direct" | "pgbouncer";
  max: number;
  waitMs: number;
  connectSeconds: number;
  statementMs: number;
  lockMs: number;
  lifetimeSeconds: number;
};

type PoolEnvironment = Readonly<Record<string, string | undefined>>;

function integerSetting(env: PoolEnvironment, key: string, fallback: number, min: number, max: number): number {
  const input = env[key];
  if (input === undefined) return fallback;
  const value = /^\d+$/.test(input) ? Number(input) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
  return value;
}

export function dbPoolConfig(env: PoolEnvironment = process.env): DbPoolConfig {
  const role = env.WORKER_ROLE ?? "web";
  if (!Object.hasOwn(ROLE_POOL_MAX, role)) throw new Error("Invalid WORKER_ROLE for database pool");
  const selected = role as DbRole;
  const poolerMode = env.DB_POOLER_MODE ?? "direct";
  if (poolerMode !== "direct" && poolerMode !== "pgbouncer") {
    throw new Error("Invalid DB_POOLER_MODE: expected direct or pgbouncer");
  }
  const statementDefault = selected === "maintenance" ? 120_000 : selected === "web" ? 15_000 : selected === "scheduler" ? 10_000 : 60_000;
  const statementMs = integerSetting(env, "DB_STATEMENT_TIMEOUT_MS", statementDefault, 100, 600_000);
  const lockMs = integerSetting(env, "DB_LOCK_TIMEOUT_MS", Math.min(5_000, statementMs), 100, 60_000);
  if (lockMs > statementMs) throw new Error("DB_LOCK_TIMEOUT_MS must not exceed DB_STATEMENT_TIMEOUT_MS");
  return {
    role: selected,
    poolerMode,
    max: integerSetting(env, "DB_POOL_MAX", ROLE_POOL_MAX[selected], 1, 64),
    waitMs: integerSetting(env, "DB_POOL_WAIT_MS", 5_000, 10, 60_000),
    connectSeconds: integerSetting(env, "DB_CONNECT_TIMEOUT_SECONDS", 3, 1, 30),
    statementMs,
    lockMs,
    lifetimeSeconds: integerSetting(env, "DB_MAX_LIFETIME_SECONDS", 1_800, 30, 86_400),
  };
}

export function postgresClientOptions(config: DbPoolConfig) {
  const connection = config.poolerMode === "pgbouncer"
    ? { application_name: `nomorevibe:${config.role}` }
    : {
        application_name: `nomorevibe:${config.role}`,
        statement_timeout: config.statementMs,
        lock_timeout: config.lockMs,
        idle_in_transaction_session_timeout: Math.max(config.statementMs, 60_000),
      };
  return {
    max: config.max,
    connect_timeout: config.connectSeconds,
    max_lifetime: config.lifetimeSeconds,
    connection,
  };
}

export class DbPoolWaitTimeoutError extends Error {
  readonly code = "DB_POOL_WAIT_TIMEOUT";
  constructor() { super("Database connection pool wait exceeded its deadline"); this.name = "DbPoolWaitTimeoutError"; }
}

/**
 * Compatibility surface of postgres 3.4.9 Query cancellation/onexecute and Connection.connect.
 * Pending query cancellation removes the real queued write; Promise.race alone would leave it queued.
 * Do not use Query.cancel(): that version drops the canceller Promise (including cancellation errors).
 * Revalidate the real saturation, BEGIN and connection replacement tests when upgrading postgres.
 */
interface DriverQuery {
  handler: (query: DriverQuery) => unknown;
  resolve: (value: unknown) => unknown;
  reject: (error: unknown) => unknown;
  state: unknown | null;
  canceller: ((query: DriverQuery) => Promise<void>) | null;
  options: { onexecute?: (connection: DriverConnection) => unknown };
}

interface DriverConnection {
  connect: (query: DriverQuery) => unknown;
  execute: (query: DriverQuery) => unknown;
}
type WaitingQueries = Map<DriverQuery, { assigned: () => void }>;

function waitDeadline<T>(value: T, waitMs: number, waiting: WaitingQueries,
  trackConnection: (connection: DriverConnection) => void): T {
  const query = value as T & DriverQuery;
  if (!query || typeof query.handler !== "function" || typeof query.resolve !== "function" || typeof query.reject !== "function" || !query.options) {
    throw new Error("Unsupported postgres query internals; validate the pool adapter before upgrading");
  }
  const originalHandler = query.handler;
  const originalResolve = query.resolve;
  const originalReject = query.reject;
  const originalOnExecute = query.options.onexecute;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Error | null = null;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; waiting.delete(query); };
  query.resolve = result => { clear(); return originalResolve(result); };
  query.reject = error => { clear(); return originalReject(cancellation ?? error); };
  query.options.onexecute = connection => {
    trackConnection(connection);
    clear();
    // Preserve BEGIN's reservation callback. Setting max_pipeline=0/1 instead can
    // short-circuit this callback and leave postgres.begin without its connection.
    originalOnExecute?.(connection);
    // Keep standalone backlog in the cancellable pool queue, not the driver's
    // already-sent pipeline, where statement_timeout does not bound queue wait.
    return false;
  };
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
    waiting.set(pending, { assigned: clear });
    timer = setTimeout(() => {
      // A connection already owns the query. PostgreSQL statement/lock timeouts bound that work.
      // Only a query that has not been sent is cancelled; no detached in-flight write is reported failed.
      cancelWaiting(new DbPoolWaitTimeoutError());
    }, waitMs);
    timer.unref?.();
    const connection = originalHandler(pending);
    // Initial connect returns its Connection before state is set. connect_timeout bounds it;
    // cancelling that initial query can otherwise strand postgres 3.4.9's connecting slot.
    if (connection && typeof connection === "object" && "execute" in connection && "connect" in connection) {
      trackConnection(connection as DriverConnection);
      clear();
    } else if (pending.state !== null) clear();
    return connection;
  }, originalHandler);
  return value;
}

/** Drizzle executes unsafe queries; postgres.begin also calls this exact object's unsafe for BEGIN. */
export function createDbClient(connectionString: string, config: DbPoolConfig = dbPoolConfig()): ReturnType<typeof postgres> {
  const waiting: WaitingQueries = new Map();
  const tracked = new WeakSet<DriverConnection>();
  const trackConnection = (connection: DriverConnection) => {
    if (tracked.has(connection)) return;
    tracked.add(connection);
    const connect = connection.connect;
    connection.connect = function(query) {
      // A normal lifetime rotation assigns one queued query to its replacement.
      // That exact query now uses connect_timeout; other waiters retain their
      // deadlines. Cancelling an initial handshake can strand this driver slot.
      waiting.get(query)?.assigned();
      return connect.call(this, query);
    };
  };
  const client = postgres(connectionString, postgresClientOptions(config));
  client.unsafe = new Proxy(client.unsafe, {
    apply: (unsafe, receiver, args) => waitDeadline(Reflect.apply(unsafe, receiver, args), config.waitMs, waiting, trackConnection),
  });
  // Preserve tagged-query use of the public client without changing SQL fragments or identifiers.
  return new Proxy(client, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      return Array.isArray(args[0]?.raw) ? waitDeadline(result, config.waitMs, waiting, trackConnection) : result;
    },
  });
}
