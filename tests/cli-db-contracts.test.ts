import { expect, it } from "vitest";
import { cliDbContract } from "@/lib/llm/cli-db-contracts";
import { CLI_DB_CONTRACT_ROUTES, claudeCliTokenBound, cliContractFromRow, cliContractRouteId, cliServingContractSchema,
  type CliProvider } from "@/lib/llm/cli-serving-contract";

/**
 * 「작업 ↔ 모델」 순위 저장이 CLI 연결에서 만드는 CLI 계약(PR C1, lib/llm/cli-db-contracts.ts) — 1차·2차 심사와 Grok 로그인 유지 route 만.
 * 상한은 그 route 가 CLI 를 띄우는 방식에서 나오고 운영자는 버전만 적는다. 만든 계약은 계약 검사(cliServingContractSchema)를 통과해야 하고,
 * 저장된 행(route_id cli:<provider>:<route>, 계약 JSON 의 routeId 도 그 값)을 읽으면 같은 계약으로 돌아와야 한다.
 */
const VERSION = "2.1.0 (Claude Code)";

it.each([
  ["crawl-agent-review", "claude-cli", "sonnet"], ["second-review", "claude-cli", "opus"],
  ["crawl-agent-review", "opencode-cli", "opencode/deepseek-v4.1-flash"], ["second-review", "opencode-cli", "opencode-go/deepseek-v4.1-flash"],
  ["crawl-agent-review", "grok-cli", "grok-4.7"], ["second-review", "grok-cli", "grok-4.7"], ["grok-session-check", "grok-cli", "grok-4.7"],
] as const)("%s · %s 는 검사에 통과한 계약을 만든다", (routeId, provider, model) => {
  const contract = cliDbContract(routeId, provider, model, VERSION);
  if (!contract) throw new Error("cli_db_contract_missing");
  expect(cliServingContractSchema.parse(contract)).toEqual(contract);
  expect(Object.isFrozen(contract)).toBe(true);
  expect(contract).toMatchObject({ version: 1, protocol: "cli-process-v1", routeId, provider, model, cliVersion: VERSION });
  // Claude 는 심사 argv(--max-turns 2 · --max-budget-usd 0.15)에서 나온 공식 상한이고, Grok 은 선언한 상한이다
  expect(contract.boundProvenance).toBe(provider === "claude-cli" ? "derived" : "declared");
  if (contract.boundProvenance === "derived") {
    expect(contract).toMatchObject({ maxTurns: 2, costBoundUsdMicros: 150_000 });
    expect(contract.totalTokenBound).toBe(claudeCliTokenBound(contract));
  } else expect(contract.costBoundUsdMicros).toBeNull();
  // 저장된 행 → 같은 계약(route_id 와 계약 JSON 의 routeId 는 접두가 붙은 값이다)
  const stored = cliContractRouteId(provider, routeId);
  expect(stored).toBe(`cli:${provider}:${routeId}`);
  expect(cliContractFromRow({ routeId: stored, model, contract: { ...contract, routeId: stored } })).toEqual(contract);
});

it("Grok 로그인 유지는 짧은 호출의 상한, 심사는 심사 입력의 상한이다", () => {
  const session = cliDbContract("grok-session-check", "grok-cli", "grok-4.7", VERSION)!;
  const review = cliDbContract("second-review", "grok-cli", "grok-4.7", VERSION)!;
  expect(session.totalTokenBound).toBeLessThan(review.totalTokenBound);
  expect(session.inputByteCap).toBeLessThan(review.inputByteCap);
});

it.each([
  // route 가 받지 않는 CLI
  ["grok-session-check", "claude-cli"], ["crawl-agent-review", "codex-cli"], ["second-review", "codex-cli"], ["grok-session-check", "codex-cli"],
  // DB 계약 route 가 아닌 route(감사·소개 검수·분류는 env 계약 그대로)
  ["product-audit", "claude-cli"], ["product-intro-check", "claude-cli"], ["crawl-publish-classify", "claude-cli"], ["crawl-publish-classify", "codex-cli"],
  ["grok-session-check", "opencode-cli"], ["product-audit", "opencode-cli"], ["product-intro-check", "opencode-cli"], ["crawl-publish-classify", "opencode-cli"],
  ["unknown-route", "claude-cli"],
] as const)("%s · %s 는 받지 않는다(null)", (routeId, provider) => {
  expect(cliDbContract(routeId, provider as CliProvider, "model", VERSION)).toBeNull();
});

it("버전 글이 계약 칸에 맞지 않으면(앞뒤 공백·빈 값·제어 문자·80자 초과) null 이다", () => {
  for (const version of ["", " 2.1.0", "2.1.0 ", "2.1.0\nextra", "a".repeat(81)])
    expect(cliDbContract("crawl-agent-review", "claude-cli", "sonnet", version), JSON.stringify(version)).toBeNull();
  expect(cliDbContract("crawl-agent-review", "claude-cli", "sonnet", "a".repeat(80))).not.toBeNull();
  // 모델 이름이 계약 칸에 맞지 않아도 null 이다
  expect(cliDbContract("crawl-agent-review", "claude-cli", " sonnet", VERSION)).toBeNull();
});

it("DB 계약 route 는 1차·2차 심사와 Grok 로그인 유지뿐이다", () => {
  expect([...CLI_DB_CONTRACT_ROUTES].sort()).toEqual(["crawl-agent-review", "grok-session-check", "second-review"]);
});
