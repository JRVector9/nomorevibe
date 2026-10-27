import type { ModelOption } from "../settings/ModelRows";

/** Suggestions are identities, not a claim that a backend or its capacity contract is ready. */
export function reviewModelOptions(gatewayModels: readonly string[] | null, direct: boolean): ModelOption[] {
  return [
    ...(direct ? [{ provider: "local-direct", model: "qwen3.8-flash-next", label: "GPU3090 · Qwen · 직접 연결" }] : []),
    ...[...new Set(["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b", ...(gatewayModels ?? [])])]
      .map(model => ({ provider: "abcllm", model, label: `게이트웨이 · ${model}` })),
    { provider: "claude-cli", model: "sonnet", label: "Claude CLI · sonnet" },
    { provider: "claude-cli", model: "opus", label: "Claude CLI · opus" },
    { provider: "grok-cli", model: "grok-4.7", label: "Grok CLI · grok-4.7" },
  ];
}
