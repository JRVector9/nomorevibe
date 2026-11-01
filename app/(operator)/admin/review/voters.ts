import { modelForPurpose } from "@/lib/llm/model-registry";
import { sameReviewModel } from "@/lib/crawl/review-model-identity";

/**
 * 2차 표 빠른 전환의 선택지 — 심사 큐 머리에서 고른다.
 * 서버 액션과 화면이 같은 목록을 쓴다. abcllm 선택지는 심사 경로의 직접 연결 계약으로 열리는 모델만이다(listReviewEngineModels). 네트워크로 모델 목록을 묻지 않는다.
 */

export type VoterProvider = "grok-cli" | "abcllm" | "claude-cli" | "local-direct";
export type VoterChoice = { value: string; provider: VoterProvider; model: string; label: string; group: string; disabled: string | null };

export const GROK_MODELS = [modelForPurpose("ai2-grok").model] as const;
export const CLAUDE_MODELS = [modelForPurpose("classify-claude").model, modelForPurpose("ai2-cli").model] as const;

export const voterValue = (provider: VoterProvider, model: string) => `${provider}|${model}`;

export function parseVoterValue(value: unknown): { provider: VoterProvider; model: string } | null {
  if (typeof value !== "string") return null;
  const at = value.indexOf("|");
  const provider = value.slice(0, at);
  const model = value.slice(at + 1).trim();
  if (at < 1 || !model || model.length > 160 || !["grok-cli", "abcllm", "claude-cli", "local-direct"].includes(provider)) return null;
  return { provider: provider as VoterProvider, model };
}

/**
 * 고를 수 있는 것: Grok(구독), 심사 경로의 직접 연결 계약으로 열리는 abcllm 모델, Claude(구독). 1차와 같은 모델은 막는다 —
 * 같은 모델의 표는 메아리라 두 모델 관문이 서지 않는다(second-review.ts). 지금 세운 표는 목록에 없어도 보인다.
 */
export function voterChoices(gatewayModels: readonly string[] | null, current: { provider: string; model: string } | null,
  firstModel: string | null): VoterChoice[] {
  const choice = (provider: VoterProvider, model: string, label: string, group: string): VoterChoice => ({
    value: voterValue(provider, model), provider, model, label, group,
    disabled: sameReviewModel(firstModel, model) ? "1차와 같은 모델" : null,
  });
  const choices = [
    ...GROK_MODELS.map((model) => choice("grok-cli", model, `Grok ${model.replace(/^grok-/, "")}`, "Grok CLI — 구독, 주간 한도")),
    ...(gatewayModels ?? []).map((model) => choice("abcllm", model, model, "abcllm · 직접 연결 계약")),
    ...CLAUDE_MODELS.map((model) => choice("claude-cli", model, `Claude ${model}`, "Claude CLI — 구독 한도")),
  ];
  if (current && !choices.some((item) => item.provider === current.provider && item.model === current.model)) {
    const provider = (["grok-cli", "abcllm", "claude-cli", "local-direct"].includes(current.provider) ? current.provider : "abcllm") as VoterProvider;
    choices.unshift(choice(provider, current.model, `${current.model} (지금 · 목록에 없음)`, "지금 세운 표"));
  }
  return choices;
}
