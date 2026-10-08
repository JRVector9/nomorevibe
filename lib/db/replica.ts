/**
 * 공개 읽기를 스트리밍 복제본에서 — 주 DB 는 워커(수집·심사)와 다른 DB 19개가 같이 쓴다(2026-10-06 P2).
 *
 * 쓰는 곳은 익명 공개 읽기(lib/domain/products/public-reads.ts, 홈 집계)와 방금 쓴 값이 필요 없는 관리자 집계
 * (운영센터 대시보드 lib/operations/dashboard.ts, 사유 번역 진행 lib/crawl/translations.ts)다. 그 밖의 관리자·워커·쓰기는 주 DB 그대로다.
 * - 연결이 안 되면 같은 읽기를 주 DB 로 다시 하고 30초 동안 복제본을 건너뛴다.
 * - 복제 적용과 부딪혀 취소된 읽기(40001)는 주 DB 로 한 번 더. 복제본에 쓰기를 시도했다면(25006) 주 DB 로 하되 버그로 남긴다.
 * - 10초마다 복제가 밀렸는지 본다 — 스트리밍이 끊겨 10초 넘게 밀렸으면 쓰지 않는다. 내린 제품을 Cloudflare 가
 *   두 번째로 지운 뒤(60초) 옛 값을 다시 채우지 않게 하려는 것이다.
 */

export type ReplicaFailure = "down" | "conflict" | "readonly";

const DOWN_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
  "DB_POOL_WAIT_TIMEOUT", "53300", "57P01", "57P02", "57P03",
]);

/** drizzle 은 드라이버 오류를 cause 로 감싼다 — 사슬을 따라가며 코드를 본다 */
export function replicaFailure(error: unknown): ReplicaFailure | null {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      if (DOWN_CODES.has(code) || code.startsWith("08")) return "down";
      if (code === "40001") return "conflict";
      if (code === "25006") return "readonly";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const REPLICA_COOLDOWN_MS = 30_000;
export const LAG_CHECK_MS = 10_000;
export const MAX_LAG_SECONDS = 10;

export type ReplicaRouter = {
  /** 복제본에서 읽고, 안 되면 주 DB 로 */
  read<T>(load: () => Promise<T>): Promise<T>;
};

export function createReplicaRouter<Db>(deps: {
  /** 복제본 연결 — 설정이 없으면 null(워커·로컬) */
  replica: () => Db | null;
  /** 이 안에서 db 가 복제본을 가리킨다 */
  scope: <T>(db: Db, load: () => Promise<T>) => Promise<T>;
  /** 복제가 몇 초 밀렸나 — 다 따라잡았으면 0 */
  lagSeconds: (db: Db) => Promise<number>;
  warn: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}): ReplicaRouter {
  const now = deps.now ?? Date.now;
  let downUntil = 0;
  let lagCheckedAt = -Infinity;
  let lagOk = true;
  let checking: Promise<void> | null = null;

  async function checkLag(db: Db): Promise<void> {
    try {
      const lag = await deps.lagSeconds(db);
      lagOk = lag <= MAX_LAG_SECONDS;
      if (!lagOk) deps.warn("db.replica_lagging", { lagSeconds: lag });
    } catch (error) {
      lagOk = false;
      if (replicaFailure(error) === "down") downUntil = now() + REPLICA_COOLDOWN_MS;
      deps.warn("db.replica_lag_check_failed", { error });
    } finally {
      lagCheckedAt = now();
    }
  }

  return {
    async read(load) {
      const db = now() < downUntil ? null : deps.replica();
      if (!db) return load();
      if (now() - lagCheckedAt >= LAG_CHECK_MS) {
        checking ??= checkLag(db).finally(() => { checking = null; });
        await checking;
      }
      if (!lagOk || now() < downUntil) return load();
      try {
        return await deps.scope(db, load);
      } catch (error) {
        const kind = replicaFailure(error);
        if (!kind) throw error;
        if (kind === "down") downUntil = now() + REPLICA_COOLDOWN_MS;
        deps.warn(kind === "readonly" ? "db.replica_write_attempt" : "db.replica_fallback", { kind, error });
        return load();
      }
    },
  };
}
