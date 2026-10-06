import { createMemo, memoKey } from "@/lib/cache/memo";
import { onReplica } from "@/lib/db";

/**
 * 공개 화면(홈·상세)의 읽기를 30초 들고 있는다 — lib/cache/memo.ts.
 *
 * 30초는 Cloudflare 의 두 번째 지우기(60초 뒤, cdn-purge)보다 짧다. 내린 제품을 원 서버가 그 뒤까지 내놓지 않는다.
 * 관리자·워커는 이것을 쓰지 않는다 — 바로 고친 값을 봐야 한다. 읽기는 복제본에서 한다(lib/db/replica.ts).
 */
const PUBLIC_TTL_MS = 30_000;
const memos = {
  /** 개수·시즌 — 열쇠가 적다 */
  count: createMemo<unknown>({ ttlMs: PUBLIC_TTL_MS, max: 300 }),
  /** 목록 — 한 항목이 클 수 있어(최대 198장) 수를 적게 */
  list: createMemo<unknown>({ ttlMs: PUBLIC_TTL_MS, max: 200 }),
  /** 상세 — 제품마다 하나 */
  detail: createMemo<unknown>({ ttlMs: PUBLIC_TTL_MS, max: 2_000 }),
};

export function publicRead<T>(kind: keyof typeof memos, key: unknown[], load: () => Promise<T>): Promise<T> {
  return memos[kind].get(memoKey(...key), () => onReplica(load)) as Promise<T>;
}
