import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { logger } from "@/lib/observability/logger";
import { fallbackHostEnv } from "./network-route";
import { createDbClient, dbPoolConfig } from "./pool";
import { createReplicaRouter, REPLICA_LAG_QUERY } from "./replica";
import { currentReplayDb } from "./replay-scope";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Next.js 핫리로드와 프로덕션 요청 모두에서 커넥션 풀 중복 생성을 방지
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres>; db?: Db; readDb?: Db | null };

/**
 * 지연 초기화 — import 시점에 던지면 DATABASE_URL 없이는 어떤 모듈도 로드할 수 없어
 * 단위 테스트가 불가능해진다. 실제 쿼리 시점에만 연결을 요구한다.
 */
function getDb(): Db {
  if (globalForDb.db) return globalForDb.db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL 환경변수가 설정되지 않았습니다");
  }
  const client = globalForDb.pgClient ?? createDbClient(connectionString, undefined, "primary", fallbackHostEnv("DATABASE_FALLBACK_HOST"));
  const instance = drizzle(client, { schema });
  globalForDb.pgClient = client;
  globalForDb.db = instance;
  return instance;
}

/**
 * 공개 읽기용 복제본(lib/db/replica.ts) — READ_DATABASE_URL 이 있는 웹에서만. 워커·로컬은 없어 주 DB 만 쓴다.
 * PgBouncer 없이 바로 붙고(문장 시간 제한을 연결에 건다), 웹 한 대에 READ_DB_POOL_MAX(기본 4)개까지.
 */
function getReadDb(): Db | null {
  if (globalForDb.readDb !== undefined) return globalForDb.readDb;
  const url = process.env.READ_DATABASE_URL;
  if (!url) return (globalForDb.readDb = null);
  const config = {
    ...dbPoolConfig(process.env, "read"),
    poolerMode: "direct" as const,
    applicationName: "nomorevibe:web-replica",
  };
  return (globalForDb.readDb = drizzle(createDbClient(url, config, "read", fallbackHostEnv("READ_DATABASE_FALLBACK_HOST")), { schema }));
}

const replicaScope = new AsyncLocalStorage<Db>();
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TransactionPrelude = (tx: Transaction) => Promise<void>;
type PreludeScope = { prelude: TransactionPrelude; refusal?: { error: unknown } };
const preludeScope = new AsyncLocalStorage<PreludeScope>();
const setupScope = new AsyncLocalStorage<TransactionPrelude>();
const SINGLE_WRITES = new Set<PropertyKey>(["insert", "update", "delete"]);

/** db.query.* / db.insert(...) 등을 첫 접근 시점에 초기화해서 넘긴다 — onReplica 안에서는 복제본을 */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const replayDb = currentReplayDb();
    const scope = !replayDb && !replicaScope.getStore() ? preludeScope.getStore() : undefined;
    if (scope?.refusal && SINGLE_WRITES.has(prop)) throw scope.refusal.error;
    if (scope && prop === "transaction") return preludedTransaction(getDb(), scope);
    return replayDb ? Reflect.get(replayDb, prop, replayDb)
      : Reflect.get(replicaScope.getStore() ?? getDb(), prop, receiver);
  },
});

/**
 * 이 범위에서 연 주 DB top-level 트랜잭션은 prelude 를 첫 문장으로 실행한다(웹 쓰기의 DR fence 첫 lock).
 * 읽기 전용 TX(FOR SHARE 를 걸 수 없다)·복제본·replay 는 그대로다. 단일 문장 쓰기는 prelude 를 타지 않지만,
 * prelude 가 한 번 거절한 범위에서는 뒤이은 insert/update/delete 도 같은 오류로 막는다(거절을 받은 catch 의 실패 기록 등).
 */
export function withTransactionPrelude<T>(prelude: TransactionPrelude, load: () => Promise<T>): Promise<T> {
  return preludeScope.run({ prelude }, load);
}

/**
 * 이 범위에서 연 prelude TX 는 setup 을 prelude 보다 먼저 실행한다 — 호출자의 문장·lock 기한이 prelude 의 첫 lock 대기(웹 fence SHARE)에도
 * 걸리게. prelude 범위 밖(워커·읽기 전용 TX)에서는 아무것도 하지 않는다 — 그때는 호출자가 TX 첫 문장으로 같은 설정을 한다.
 */
export function withTransactionSetup<T>(setup: TransactionPrelude, load: () => Promise<T>): Promise<T> {
  return setupScope.run(setup, load);
}

function preludedTransaction(primary: Db, scope: PreludeScope): Db["transaction"] {
  return ((load: (tx: Transaction) => Promise<unknown>, config?: Parameters<Db["transaction"]>[1]) => config?.accessMode === "read only"
    ? primary.transaction(load, config)
    : primary.transaction(async tx => {
      await setupScope.getStore()?.(tx);
      try { await scope.prelude(tx); } catch (error) { scope.refusal ??= { error }; throw error; }
      return load(tx);
    }, config)) as Db["transaction"];
}

const router = createReplicaRouter<Db>({
  replica: getReadDb,
  scope: (readDb, load) => replicaScope.run(readDb, load),
  lagSeconds: async (readDb) => {
    const [row] = await readDb.execute<{ lag: number | null }>(REPLICA_LAG_QUERY);
    return Number(row?.lag ?? 0);
  },
  warn: (event, fields) => (event === "db.replica_write_attempt" ? logger.error : logger.warn)(event, fields),
});

/** 익명 공개 읽기만 복제본에서 — 안 되면 주 DB 로(lib/db/replica.ts) */
export function onReplica<T>(load: () => Promise<T>): Promise<T> {
  if (currentReplayDb()) return load();
  return router.read(load);
}

/** 복제본 안에서 이 읽기만 주 DB 로 — 복제본이 아직 갖추지 못한 것(확장 등)을 읽을 때 */
export function onPrimary<T>(load: () => Promise<T>): Promise<T> {
  if (currentReplayDb()) return load();
  return replicaScope.exit(load);
}
