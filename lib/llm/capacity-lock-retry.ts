import { logger } from "@/lib/observability/logger";
import { isLockNotAvailable, readControlLockHolders } from "./capacity-lock-diagnostics";

/**
 * 정산 TX 의 control 잠금 재시도(2026-11-08). 장부 쓰기는 모두 model_capacity_control(id=1)을 FOR UPDATE 로 잠그고 지나가 사실상 한 줄로 선다.
 * 누가 그 행을 lock_timeout(운영 5초)보다 오래 쥐면 끝난 호출의 정산 TX 가 55P03 으로 접혔고, 호출부는 곧바로 commit_unknown 으로 표시해
 * 사람 검토 줄에 올렸다(11-08 4건, 11-05 6건, 10-31 2건 — 모두 control 행 FOR UPDATE 의 55P03).
 *
 * 55P03 은 그 문장이 실패하고 TX 가 ROLLBACK 된 것이다 — 커밋됐는지 모르는 것이 아니라 커밋되지 않은 것이 확실하다. 정산 함수는 행을
 * FOR UPDATE 로 다시 읽고 상태·근거 hash 로 판정하므로(이미 정산이면 already_settled) 같은 TX 를 다시 여는 것이 안전하다.
 * 다른 오류는 그대로 던진다. 첫 55P03 뒤에 control 을 쥔 세션을 한 번 읽어 남긴다(누가 오래 쥐는지 운영 로그로 찾기 위해).
 * 기본 간격은 0.25·1·2초 — lock_timeout 5초와 합쳐 약 23초까지의 멈춤을 덮는다(11-08 07:53Z 의 DB 지연은 약 13초).
 */
export const SETTLE_LOCK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([250, 1_000, 2_000]);

export type LockRetryOptions = Readonly<{
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  holders?: () => Promise<unknown>;
}>;

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export async function retryOnLockNotAvailable<T>(label: string, run: () => Promise<T>, options: LockRetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? SETTLE_LOCK_RETRY_DELAYS_MS, sleep = options.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await run();
      if (attempt > 0) logger.info("model_capacity.settle_lock_recovered", { settle: label, attempts: attempt + 1 });
      return result;
    } catch (error) {
      if (!isLockNotAvailable(error)) throw error;
      if (attempt >= delays.length) {
        logger.warn("model_capacity.settle_lock_exhausted", { settle: label, attempts: attempt + 1 });
        throw error;
      }
      const holders = attempt === 0 ? await (options.holders ?? readControlLockHolders)().catch(() => []) : undefined;
      logger.warn("model_capacity.settle_lock_retry", { settle: label, attempt: attempt + 1, delayMs: delays[attempt], ...(holders === undefined ? {} : { holders }) });
      await sleep(delays[attempt]);
    }
  }
}
