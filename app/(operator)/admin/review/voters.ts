import { sameReviewModel } from "@/lib/crawl/review-model-identity";

/**
 * 2차 표 빠른 전환의 선택지 — 심사 큐 머리에서 고른다(2026-10-06, Grok 주간 한도가 바닥나 사내 게이트웨이로 바꿔야 했다).
 * 서버 액션과 화면이 같은 목록을 쓴다. 게이트웨이 모델은 그때그때 /v1/models 에서 읽는다.
 */

export type VoterProvider = "grok-cli" | "abcllm" | "claude-cli";
export type VoterChoice = { value: string; provider: VoterProvider; model: string; label: string; group: string; disabled: string | null };

export const GROK_MODELS = ["grok-4.7"] as const;
export const CLAUDE_MODELS = ["sonnet", "opus"] as const;

export const voterValue = (provider: VoterProvider, model: string) => `${provider}|${model}`;

export function parseVoterValue(value: unknown): { provider: VoterProvider; model: string } | null {
  if (typeof value !== "string") return null;
  const at = value.indexOf("|");
  const provider = value.slice(0, at);
  const model = value.slice(at + 1).trim();
  if (at < 1 || !model || model.length > 160 || !["grok-cli", "abcllm", "claude-cli"].includes(provider)) return null;
  return { provider: provider as VoterProvider, model };
}

/**
 * 고를 수 있는 것: Grok(구독), 게이트웨이에 지금 있는 모델(한도 없음), Claude(구독). 1차와 같은 모델은 막는다 —
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
    ...(gatewayModels ?? []).map((model) => choice("abcllm", model, model, "사내 게이트웨이 — 한도 없음")),
    ...CLAUDE_MODELS.map((model) => choice("claude-cli", model, `Claude ${model}`, "Claude CLI — 구독 한도")),
  ];
  if (current && !choices.some((item) => item.provider === current.provider && item.model === current.model)) {
    const provider = (["grok-cli", "abcllm", "claude-cli"].includes(current.provider) ? current.provider : "abcllm") as VoterProvider;
    choices.unshift(choice(provider, current.model, `${current.model} (지금 · 목록에 없음)`, "지금 세운 표"));
  }
  return choices;
}
