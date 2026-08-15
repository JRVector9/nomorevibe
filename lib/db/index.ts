import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Next.js dev 핫리로드 시 커넥션 중복 생성을 방지
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres>; db?: Db };

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
  const client = globalForDb.pgClient ?? postgres(connectionString, { max: 10 });
  const instance = drizzle(client, { schema });
  if (process.env.NODE_ENV !== "production") {
    globalForDb.pgClient = client;
    globalForDb.db = instance;
  }
  return instance;
}

/** db.query.* / db.insert(...) 등을 첫 접근 시점에 초기화해서 넘긴다 */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
