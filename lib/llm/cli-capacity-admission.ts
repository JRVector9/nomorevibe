import { ModelCapacityDeferredError } from "./capacity-deferred";
import { readModelCapacityCallerControl } from "./capacity-repository";

/** 공통 슬롯 밖에서 모델을 부르던 CLI 호출자와 그 호출이 실제로 쓰는 transport */
const CLI_MODEL_ROUTES = {
  "product-intro-check": ["claude-cli"],
  // 감사는 굳힌 provider 가 abcllm 이면 게이트웨이, 그 밖에는 Claude CLI 로 묻는다
  "product-audit": ["claude-cli", "abcllm"],
  "grok-session-check": ["grok-cli"],
} as const;
type CliModelRoute = keyof typeof CLI_MODEL_ROUTES;

/**
 * 거절만 한다. CLI route 에는 아직 serving contract 도 프로세스 종료 증거도 없어 슬롯을 내줄 수 없다.
 * disabled 면 원래 호출을 그대로 두고, open·draining 이면 호출 전에 typed defer 로 끝낸다.
 */
export async function assertCliModelAdmission<R extends CliModelRoute>(input: {
  routeId: R; provider: typeof CLI_MODEL_ROUTES[R][number]; model: string;
}): Promise<void> {
  const { routeId, provider, model } = input;
  if (!Object.hasOwn(CLI_MODEL_ROUTES, routeId) || !(CLI_MODEL_ROUTES[routeId] as readonly string[]).includes(provider))
    throw new Error("invalid_cli_model_route");
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return;
  if (control.mode === "draining") throw new ModelCapacityDeferredError("draining");
  if (control.mode !== "open") throw new Error("model_capacity_control_invalid");
  const mapped = control.policy?.routes.some(route => route.routeId === routeId
    && route.provider === provider && route.model === model);
  throw new ModelCapacityDeferredError(mapped ? "provider_contract_unavailable" : "unmapped");
}
