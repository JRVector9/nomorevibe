import { createMemo } from "@/lib/cache/memo";
import { db, onPrimary, withTransactionPrelude } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { DrWriterFencedError, readWriterFence, writerSiteActive } from "./epoch";

/**
 * 웹 쓰기 관문(PR15e). fenced DB(옛 primary·승격 전 복원본)에 붙은 웹은 쓰기 요청을 쓰기 전에 거절한다.
 *
 * - 캐시 관문: 이 프로세스가 붙은 DB 의 fence 를 잠그지 않고 읽어 5초 들고 있는다. 요청마다 fence 행에 FOR SHARE 를 걸면
 *   공개 hot path(클릭·방문·rate limit)가 WAL·multixact 를 만든다. 웹 여러 대가 함께 쓰는 Valkey 층은 쓰지 않는다 —
 *   웹마다 붙은 DB 가 다를 수 있다.
 * - TX 첫 lock: runWebWrite 범위에서 연 주 DB 쓰기 TX 는 fence SHARE 를 첫 lock 으로 잡는다(seal·fence-old 의 fence UPDATE 와
 *   직렬화, PR15c 의 fence → … → jobs 순서). 캐시가 아직 active 인 5초 안에 걸린 fence 도 쓰기 TX 는 commit 하지 못하고,
 *   그 거절 뒤 같은 요청의 단일 문장 쓰기(실패 감사 로그 등)도 막힌다. 그 전에 오는 단일 문장 쓰기(rate limit·cron 요청 등)는
 *   캐시 관문만 본다 — fence 뒤 최대 5초 동안 들어갈 수 있다.
 */
export const WEB_FENCE_TTL_MS = 5_000;
/** fenced 거절 응답의 Retry-After(초) — 승격·복구는 분 단위다 */
export const WEB_FENCED_RETRY_AFTER = "60";

/** fence 읽기 상한. 같은 열쇠의 읽기는 공유되므로(memo pending) 매달린 연결 하나가 /go·hot path·쓰기 관문을 함께 붙잡았다(R4) */
export const WEB_FENCE_READ_TIMEOUT_MS = 2_000;

const fence = createMemo<boolean>({ ttlMs: WEB_FENCE_TTL_MS, max: 1 });
/** 행이 없거나 깨졌거나 상한 안에 못 읽으면 던진다(fail-closed). 실패는 담지 않아 다음 요청이 다시 읽는다. */
const siteActive = () => fence.get("active", readFenceWithinBound);

async function readFenceWithinBound(): Promise<boolean> {
  // pool 대기도 같은 기한에 끊는다(상한이 지난 읽기가 줄에 쌓이지 않게). 이미 보낸 문장은 연결의 statement_timeout 이 끝낸다
  const read = withDbDeadline(Date.now() + WEB_FENCE_READ_TIMEOUT_MS, () => onPrimary(async () => (await readWriterFence(db)).state === "active"));
  void read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dr_writer_fence_read_timeout")), WEB_FENCE_READ_TIMEOUT_MS);
  });
  try { return await Promise.race([read, bound]); } finally { clearTimeout(timer); }
}

export async function assertWebWritable(): Promise<void> {
  if (!await siteActive()) throw new DrWriterFencedError("site_fenced");
}

/** hot path 용: 거절 대신 쓰기를 건너뛴다. 읽지 못해도 건너뛴다(fail-closed). */
export async function webWritable(): Promise<boolean> {
  return siteActive().catch(() => false);
}

async function lockFenceFirst(tx: ProductTransaction): Promise<void> {
  if (await writerSiteActive(tx)) return;
  // 캐시가 늦었다 — 버려서 이 프로세스의 다음 요청은 DB 를 다시 읽는다(TTL 을 기다리지 않는다)
  fence.clear();
  throw new DrWriterFencedError("site_fenced");
}

export async function runWebWrite<T>(load: () => Promise<T>): Promise<T> {
  await assertWebWritable();
  return withTransactionPrelude(lockFenceFirst, load);
}

/** 관리자 server action. 거절은 던진다 — action 의 다른 예기치 않은 실패와 같은 오류 경계로 간다. */
export function webWriteAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => runWebWrite(() => action(...args));
}

/** withRoute 를 쓰지 않는 쓰기 route handler. 거절은 그 route 의 기존 오류 형식(refused)으로 답한다. */
export function webWriteRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response>,
  refused: (error: DrWriterFencedError) => Response): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await runWebWrite(() => handler(...args));
    } catch (error) {
      if (error instanceof DrWriterFencedError) return refused(error);
      throw error;
    }
  };
}

/**
 * 서명으로 받는 기계 쓰기 route(X 수집기 보고, 운영센터 v8 PR9). DB 를 보지 않는 검사(설정·크기·시각·서명·형식)를 관문보다 먼저 한다 —
 * 꺼진 주소와 서명이 틀린 요청은 fence 도 읽지 않는다. 검사를 지난 것만 webWriteRoute 와 같은 관문(캐시 fence → 쓰기 TX 첫 lock)을 지난다.
 */
export function verifiedWebWriteRoute<A extends unknown[], V>(
  verify: (...args: A) => Promise<{ ok: true; value: V } | { ok: false; response: Response }>,
  handler: (value: V) => Promise<Response>,
  refused: (error: DrWriterFencedError) => Response,
): (...args: A) => Promise<Response> {
  const write = webWriteRoute(handler, refused);
  return async (...args) => {
    const checked = await verify(...args);
    return checked.ok ? write(checked.value) : checked.response;
  };
}
