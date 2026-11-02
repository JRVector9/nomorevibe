import { CLI_PROTOCOL, CLI_DB_CONTRACT_ROUTES, claudeCliTokenBound, cliContractRouteAccepts, cliServingContractSchema, type CliProvider,
  type CliServingContract } from "./cli-serving-contract";

/**
 * 「작업 ↔ 모델」 순위 저장이 CLI 연결에서 만드는 CLI 계약(2026-11-02 소유자 결정, PR C1) — 1차·2차 심사와 Grok 로그인 유지 route 만.
 * 예전에는 운영자가 reviewer env CLI_SERVING_CONTRACTS 에 계약 JSON 을 넣었다. 이제 상한 값은 그 route 가 CLI 를 띄우는 방식(코드의 argv 상수)에서 나오고,
 * 운영자는 CLI 버전(`<도구> --version` 출력 그대로 — 워커 로그 cli_contract.probe 의 observedVersion)만 연결에 적는다.
 * 모델 이름·주소는 없다(모델은 순위의 것이다). 슬롯 한도는 개수 기반이라 C(totalTokenBound)는 활성화 판정에 쓰지 않고 binding·terminal 증거로만 남는다
 * (cli-serving-contract.ts) — 그래서 넉넉한 고정 상한을 둔다.
 *
 * Claude(derived): 심사 argv(agent-review.ts reviewCliArgs)는 --max-turns 2 · --max-budget-usd 0.15 · CLAUDE_CODE_MAX_OUTPUT_TOKENS(경로 한도 review-cli maxTokens).
 *   출력 상한은 관리자 실시간 한도가 바꿀 수 있어 그 상한의 위쪽(32,000)으로 둔다 — 호출이 계약보다 크게 부르면 runner 가 준비하지 않는다(invocationMatches).
 * Grok(declared): 출력 상한 플래그가 없어 공식으로 증명하지 못한다 — 심사는 실측 최대(입력 ~9.5K 토큰)에 여유를 둔 값, 로그인 유지는 짧은 한 줄 호출의 값.
 */
const REVIEW_CLAUDE = Object.freeze({ maxTurns: 2, outputTokensPerTurn: 32_000, overheadTokenBound: 20_000, inputByteCap: 200_000, costBoundUsdMicros: 150_000 });
const REVIEW_GROK = Object.freeze({ inputByteCap: 200_000, totalTokenBound: 200_000 });
const SESSION_GROK = Object.freeze({ inputByteCap: 16_384, totalTokenBound: 32_768 });
const VERSION = /^[^\p{Cc}]{1,80}$/u;

/** 그 route·CLI·모델·버전의 계약(검사에 통과한 것). 받지 않는 조합·틀린 버전 글이면 null. */
export function cliDbContract(routeId: string, provider: CliProvider, model: string, cliVersion: string): CliServingContract | null {
  const version = cliVersion.trim();
  if (!CLI_DB_CONTRACT_ROUTES.has(routeId) || !cliContractRouteAccepts(routeId, provider) || !VERSION.test(version) || version !== cliVersion) return null;
  const base = { version: 1 as const, protocol: CLI_PROTOCOL, routeId, model, cliVersion: version };
  const value = provider === "claude-cli"
    ? { ...base, boundProvenance: "derived" as const, provider, inputByteCap: REVIEW_CLAUDE.inputByteCap, costBoundUsdMicros: REVIEW_CLAUDE.costBoundUsdMicros,
      maxTurns: REVIEW_CLAUDE.maxTurns, outputTokensPerTurn: REVIEW_CLAUDE.outputTokensPerTurn, overheadTokenBound: REVIEW_CLAUDE.overheadTokenBound,
      totalTokenBound: claudeCliTokenBound(REVIEW_CLAUDE) }
    : { ...base, boundProvenance: "declared" as const, provider, costBoundUsdMicros: null,
      ...(routeId === "grok-session-check" ? SESSION_GROK : REVIEW_GROK) };
  const parsed = cliServingContractSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}
