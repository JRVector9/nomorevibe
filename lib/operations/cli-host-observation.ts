import { cliHostObservationAgeMs, observedCliToolVersion } from "@/lib/llm/cli-serving-contract";
import { logger } from "@/lib/observability/logger";
import { readCliHostCatalog } from "./cli-host-client";
import type { CliHostTarget } from "./cli-host-target";

/**
 * 워커의 OpenCode 버전 관측(setCliHostObservedVersion — 60초 동안만 유효)을 예약 전 계약 확인보다 먼저 채운다(2026-11-07).
 *
 * 예약 전 확인(reviewCliServingContract·backgroundCliPath → dbLookup)은 이 프로세스가 60초 안에 호스트 버전을 봤을 때만 OpenCode 계약을 돌려준다.
 * 그런데 워커가 버전을 보는 길(readCliHostCatalog)은 예약 뒤의 원격 prepare 뿐이라, 관측이 없으면 사전 확인이 늘 provider_contract_unavailable 로
 * 미루고 prepare 까지 가지 못했다 — 1차 1순위 OpenCode 호출이 장부에 한 번도 없던 원인이다.
 *
 * - DB 트랜잭션 밖에서만 부른다. 카탈로그 읽기 HTTP 한 번이고 장부·도메인에 아무것도 쓰지 않는다 — dispatch·terminal 근거가 아니다.
 * - 관측이 REFRESH_AFTER_MS 안이면 부르지 않는다. 같은 연결의 동시 요청은 한 번만 나간다(single-flight).
 * - 실패하면 FAILURE_BACKOFF_MS 동안 그 연결을 다시 부르지 않고 false 다(진단 로그 한 줄) — 호출자는 오늘처럼 계약 없음으로 미루거나 다음 순위로 간다.
 * - 예약 뒤의 정확한 대조(prepare 의 catalog.cliVersion === contract.cliVersion·reviewCliContractMatches)는 그대로다.
 */
export const CLI_HOST_OBSERVATION_REFRESH_AFTER_MS = 30_000;
export const CLI_HOST_OBSERVATION_FAILURE_BACKOFF_MS = 30_000;
const inflight = new Map<string, Promise<boolean>>();
const failedAt = new Map<string, number>();

const fresh = (): boolean => {
  const age = cliHostObservationAgeMs();
  return age !== null && age <= CLI_HOST_OBSERVATION_REFRESH_AFTER_MS && observedCliToolVersion("opencode-cli") !== null;
};
/** 고정 코드만 남긴다 — URL·키·응답 본문은 로그에 싣지 않는다. */
const safeCode = (error: unknown): string => error instanceof Error
  ? error.name === "TimeoutError" ? "timeout" : /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "transport_error"
  : "transport_error";

/** 관측이 새로우면(갱신했거나 이미 새로웠으면) true. 던지지 않는다. target 은 실제로 부를 때만 만든다(키를 여는 일도 그때만). */
export function refreshCliHostObservation(connectionId: string, target: () => CliHostTarget | Promise<CliHostTarget>): Promise<boolean> {
  if (fresh()) return Promise.resolve(true);
  const failed = failedAt.get(connectionId);
  if (failed !== undefined && Date.now() - failed < CLI_HOST_OBSERVATION_FAILURE_BACKOFF_MS) return Promise.resolve(false);
  const running = inflight.get(connectionId);
  if (running) return running;
  const attempt = Promise.resolve().then(target).then(readCliHostCatalog).then(() => {
    failedAt.delete(connectionId);
    return observedCliToolVersion("opencode-cli") !== null;
  }, error => {
    failedAt.set(connectionId, Date.now());
    logger.warn("cli_host.observe_unavailable", { connectionId, code: safeCode(error) });
    return false;
  }).finally(() => inflight.delete(connectionId));
  inflight.set(connectionId, attempt);
  return attempt;
}

/** 시험 전용: 실패 대기·진행 중 요청을 비운다. */
export function resetCliHostObservationForTest(): void {
  inflight.clear();
  failedAt.clear();
}
