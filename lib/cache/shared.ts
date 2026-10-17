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
import { fallbackHostEnv, networkRoute, parseFallbackHost, registerRoute, valkeyFallbackUrl } from "@/lib/db/network-route";

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

export function openValkey(url: string) {
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

type RoutedClient = { isReady: boolean; on(event: "error", listener: (error: unknown) => void): unknown };

/**
 * VALKEY_URL 의 주소로 먼저 연다. VALKEY_FALLBACK_HOST 가 있으면, 먼저 연결이 실패했을 때만(그 연결의 error) 같은 계정으로 대신 주소에
 * 둘째 연결을 연다(lib/db/network-route.ts). 명령은 준비된 쪽 하나로만 — 먼저 연결이 다시 서면(node-redis 가 스스로 다시 붙인다)
 * 그쪽으로 돌아간다. 실패한 명령은 다른 쪽으로 다시 보내지 않는다(읽기는 DB 로 간다). 대신 주소가 없으면 지금과 같은 연결 하나.
 */
export function createValkeyRoutes<C extends RoutedClient>(url: string, fallbackHost: string | undefined, open: (url: string) => C) {
  if (fallbackHost === undefined) {
    const only = open(url);
    return { client: () => only.isReady ? only : null };
  }
  const fallbackUrl = valkeyFallbackUrl(url, fallbackHost);
  const routes = { preferred: networkRoute(new URL(url).hostname), fallback: networkRoute(parseFallbackHost("VALKEY_FALLBACK_HOST", fallbackHost).host) };
  const preferred = open(url);
  let fallback: C | null = null;
  preferred.on("error", () => {
    if (fallback) return;
    fallback = open(fallbackUrl);
    logger.warn("cache.valkey_fallback_opened", { route: routes.fallback, preferred: routes.preferred });
  });
  const pick = () => preferred.isReady ? preferred : fallback?.isReady ? fallback : null;
  registerRoute("valkey", () => { const client = pick(); return client === null ? null : client === preferred ? routes.preferred : routes.fallback; });
  return { client: pick };
}

const globalForShared = globalThis as unknown as { valkeyRoutes?: { client(): ReturnType<typeof openValkey> | null } | null };

/** VALKEY_URL 이 있는 웹에서만 — 연결이 서기 전에는 없는 것처럼 군다. 대신 주소 설정이 틀리면 캐시를 끈다(읽기는 DB 로) */
function valkey(): SharedClient | null {
  if (globalForShared.valkeyRoutes === undefined) {
    const url = process.env.VALKEY_URL?.trim();
    const fallbackHost = fallbackHostEnv("VALKEY_FALLBACK_HOST");
    try {
      globalForShared.valkeyRoutes = url ? createValkeyRoutes(url, fallbackHost, openValkey) : null;
    } catch (error) {
      if (fallbackHost === undefined) throw error;
      logger.error("cache.valkey_config_invalid", { error });
      globalForShared.valkeyRoutes = null;
    }
  }
  return (globalForShared.valkeyRoutes?.client() ?? null) as unknown as SharedClient | null;
}

export const sharedStore: SharedStore = createSharedStore({
  client: valkey,
  release: (process.env.RELEASE_TAG ?? "dev").slice(0, 12),
});
