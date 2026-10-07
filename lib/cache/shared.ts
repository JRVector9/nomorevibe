/**
 * 웹 여러 대가 함께 쓰는 짧은 읽기 캐시 — Valkey(V9-Primary 6380, 계정 nmv 는 nmv:* 키만 다룬다, 2026-10-07).
 *
 * 프로세스 캐시(lib/cache/memo.ts)의 두 번째 층이다. 웹 6대가 같은 목록·상세를 따로 읽던 것을 한 대가 읽으면 나머지가
 * 그대로 쓴다. Valkey 가 없거나(워커·로컬) 느리거나 꽉 차도(서버 정책 noeviction) 읽기는 DB 로 그대로 간다 —
 * 명령은 150ms 안에 끝나지 않으면 버리고, 오류 기록은 1분에 한 번만 남긴다.
 * 값은 v8 직렬화로 넣어 Date 를 그대로 살린다. 열쇠에는 릴리스를 넣는다 — 배포 사이 값의 모양이 바뀌어도 섞이지 않게.
 */
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { createClient, RESP_TYPES } from "redis";
import { logger } from "@/lib/observability/logger";

export type SharedStore = {
  /** 만료 전 값만 준다. 없거나 실패하면 null — 던지지 않는다 */
  get<T>(key: string): Promise<{ value: T; expiresAt: number } | null>;
  /** 기다리지 않는다. 실패는 버린다 */
  set<T>(key: string, value: T, expiresAt: number): void;
};

/** 이 모듈이 쓰는 명령만 — 시험에서 가짜로 바꿔 끼운다 */
export type SharedClient = {
  get(key: string): Promise<Buffer | string | null>;
  set(key: string, value: Buffer, options: { PX: number }): Promise<unknown>;
};

const COMMAND_TIMEOUT_MS = 150;
const LOG_EVERY_MS = 60_000;

export function sharedKey(release: string, key: string): string {
  return `nmv:memo:${release}:${createHash("sha1").update(key).digest("hex")}`;
}

export function createSharedStore(deps: {
  client: () => SharedClient | null;
  release: string;
  now?: () => number;
  warn?: (event: string, fields: Record<string, unknown>) => void;
}): SharedStore {
  const now = deps.now ?? Date.now;
  let loggedAt = -Infinity;
  const warn = (event: string, error: unknown) => {
    if (now() - loggedAt < LOG_EVERY_MS) return;
    loggedAt = now();
    (deps.warn ?? logger.warn)(event, { error });
  };
  return {
    async get<T>(key: string) {
      const client = deps.client();
      if (!client) return null;
      try {
        const raw = await client.get(sharedKey(deps.release, key));
        if (!raw || typeof raw === "string") return null;
        const entry = deserialize(raw) as { v: T; e: number };
        return entry.e > now() ? { value: entry.v, expiresAt: entry.e } : null;
      } catch (error) {
        warn("cache.shared_get_failed", error);
        return null;
      }
    },
    set<T>(key: string, value: T, expiresAt: number) {
      const client = deps.client();
      const ttl = Math.ceil(expiresAt - now());
      if (!client || ttl <= 0) return;
      let payload: Buffer;
      try {
        payload = serialize({ v: value, e: expiresAt });
      } catch (error) {
        warn("cache.shared_serialize_failed", error);
        return;
      }
      client.set(sharedKey(deps.release, key), payload, { PX: ttl }).catch((error) => warn("cache.shared_set_failed", error));
    },
  };
}

const globalForShared = globalThis as unknown as { valkey?: ReturnType<typeof connect> | null };

function connect(url: string) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1_000, reconnectStrategy: (retries: number) => Math.min(500 * (retries + 1), 5_000) },
    commandOptions: { timeout: COMMAND_TIMEOUT_MS, typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } },
  });
  let loggedAt = -Infinity;
  client.on("error", (error: unknown) => {
    if (Date.now() - loggedAt < LOG_EVERY_MS) return;
    loggedAt = Date.now();
    logger.warn("cache.valkey_error", { error });
  });
  client.connect().catch(() => {});
  return client;
}

/** VALKEY_URL 이 있는 웹에서만 — 연결이 서기 전에는 없는 것처럼 군다 */
function valkey(): SharedClient | null {
  if (globalForShared.valkey === undefined) {
    const url = process.env.VALKEY_URL?.trim();
    globalForShared.valkey = url ? connect(url) : null;
  }
  const client = globalForShared.valkey;
  return client?.isReady ? client as unknown as SharedClient : null;
}

export const sharedStore: SharedStore = createSharedStore({
  client: valkey,
  release: (process.env.RELEASE_TAG ?? "dev").slice(0, 12),
});
