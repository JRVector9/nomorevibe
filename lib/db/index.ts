import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { logger } from "@/lib/observability/logger";
import { createDbClient, dbPoolConfig } from "./pool";
import { createReplicaRouter } from "./replica";
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
  const client = globalForDb.pgClient ?? createDbClient(connectionString);
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
    ...dbPoolConfig({ ...process.env, DB_POOL_MAX: process.env.READ_DB_POOL_MAX ?? "4" }),
    poolerMode: "direct" as const,
    applicationName: "nomorevibe:web-replica",
  };
  return (globalForDb.readDb = drizzle(createDbClient(url, config), { schema }));
}

const replicaScope = new AsyncLocalStorage<Db>();

/** db.query.* / db.insert(...) 등을 첫 접근 시점에 초기화해서 넘긴다 — onReplica 안에서는 복제본을 */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(replicaScope.getStore() ?? getDb(), prop, receiver);
  },
});

const router = createReplicaRouter<Db>({
  replica: getReadDb,
  scope: (readDb, load) => replicaScope.run(readDb, load),
  lagSeconds: async (readDb) => {
    // 다 따라잡았으면 0 — 주 DB 가 한가하면 마지막 적용 시각이 오래돼 보여도 밀린 것이 아니다
    const [row] = await readDb.execute<{ lag: number | null }>(sql`
      select case when pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() then 0
                  else extract(epoch from now() - pg_last_xact_replay_timestamp()) end as lag`);
    return Number(row?.lag ?? 0);
  },
  warn: (event, fields) => (event === "db.replica_write_attempt" ? logger.error : logger.warn)(event, fields),
});

/** 익명 공개 읽기만 복제본에서 — 안 되면 주 DB 로(lib/db/replica.ts) */
export function onReplica<T>(load: () => Promise<T>): Promise<T> {
  return router.read(load);
}

/** 복제본 안에서 이 읽기만 주 DB 로 — 복제본이 아직 갖추지 못한 것(확장 등)을 읽을 때 */
export function onPrimary<T>(load: () => Promise<T>): Promise<T> {
  return replicaScope.exit(load);
}
