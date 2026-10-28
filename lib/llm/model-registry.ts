import { z } from "zod";

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;
const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const modelProviderSchema = z.enum(["abcllm", "local-direct", "claude-cli", "codex-cli", "grok-cli", "llama-server"]);
export const modelDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/),
  equipment: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), displayName: identity,
  provider: modelProviderSchema,
  baseUrl: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }).nullable(),
  model: identity, family: identity,
  /** Gateway labels are explicit equipment identities, never inferred from a bare name. */
  gatewayLabel: identity.optional(),
  timeoutMs: z.number().int().positive().safe(), maxTokens: z.number().int().positive().max(262_144),
  concurrency: z.number().int().positive().max(64), purposes: z.array(identity).min(1),
}).strict().superRefine((model, context) => {
  if (!model.key.startsWith(`${model.equipment}:`)) context.addIssue({ code: "custom", message: "model_key_equipment_mismatch" });
  if ((model.provider === "abcllm" || model.provider === "local-direct" || model.provider === "llama-server") && !model.baseUrl)
    context.addIssue({ code: "custom", message: "model_base_url_required" });
  if (model.gatewayLabel && model.provider !== "abcllm") context.addIssue({ code: "custom", message: "gateway_label_provider_mismatch" });
});
export type ModelDefinition = Readonly<z.infer<typeof modelDefinitionSchema>>;
const gateway = "https://abcllm-api.brut.bot/v1";
const local = "http://100.77.43.63:8090/v1";

/** All compatibility defaults live here. Selection never grants capacity or verified serving authority. */
export const DEFAULT_MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  { key: "gpu3090:review", equipment: "gpu3090", displayName: "GPU3090 · Qwen · 직접 연결", provider: "local-direct", baseUrl: local,
    model: "qwen3.8-flash-next", family: "qwen3.8-flash-next", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 2,
    purposes: ["direct-review", "ai2-direct", "assist-primary", "korean-translation-direct", "relay"] },
  { key: "m3:review", equipment: "m3", displayName: "M3 · DeepSeek", provider: "local-direct", baseUrl: "http://100.92.77.66:8010/v1",
    model: "deepseek-v4.1-flash-1017", family: "deepseek-v4.1-flash-1017", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1,
    purposes: ["human-review", "assist-audit"] },
  { key: "m1:translation", equipment: "m1", displayName: "M1 · Gemma 4 26B", provider: "abcllm", baseUrl: gateway, gatewayLabel: "m1",
    model: "gemma4-26b", family: "gemma4-26b", timeoutMs: 20_000, maxTokens: 8_000, concurrency: 1, purposes: ["product-translate"] },
  { key: "supa:review", equipment: "supa", displayName: "Supa · Qwen", provider: "abcllm", baseUrl: gateway, gatewayLabel: "supa",
    model: "Qwen3.8-27B-NVFP4", family: "Qwen3.8-27B-NVFP4", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 2,
    purposes: ["ai1-preset", "product-search-verify"] },
  { key: "mlx:text", equipment: "mlx", displayName: "MLX · GPT OSS", provider: "abcllm", baseUrl: gateway, gatewayLabel: "MLX",
    model: "gpt-oss-120b", family: "gpt-oss-120b", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 2,
    purposes: ["product-search-profile", "reason-translate", "product-tagline-ko", "search-query-translate", "assist-legacy-family"] },
  { key: "mlx:tagline", equipment: "mlx", displayName: "MLX · 소개 생성", provider: "abcllm", baseUrl: gateway, gatewayLabel: "MLX",
    model: "qwen3.6-35b-heretic", family: "qwen3.6-35b-heretic", timeoutMs: 60_000, maxTokens: 400, concurrency: 1, purposes: ["crawl-tagline"] },
  { key: "connect:sonnet", equipment: "connect", displayName: "Claude CLI · sonnet", provider: "claude-cli", baseUrl: null,
    model: "sonnet", family: "sonnet", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["product-intro-check", "classify-claude"] },
  { key: "connect:opus", equipment: "connect", displayName: "Claude CLI · opus", provider: "claude-cli", baseUrl: null,
    model: "opus", family: "opus", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["ai2-cli"] },
  { key: "connect:grok", equipment: "connect", displayName: "Grok CLI", provider: "grok-cli", baseUrl: null,
    model: "grok-4.7", family: "grok-4.7", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["ai2-grok"] },
  { key: "connect:spark", equipment: "connect", displayName: "Codex Spark", provider: "codex-cli", baseUrl: null,
    model: "gpt-5.3-codex-spark", family: "gpt-5.3-codex-spark", timeoutMs: 8_000, maxTokens: 8_000, concurrency: 1, purposes: ["classify-primary"] },
  { key: "connect:terra", equipment: "connect", displayName: "Codex Terra", provider: "codex-cli", baseUrl: null,
    model: "gpt-5.6-terra", family: "gpt-5.6-terra", timeoutMs: 12_000, maxTokens: 8_000, concurrency: 1, purposes: ["classify-fallback"] },
];
const registrySchema = z.object({ version: z.literal(1), models: z.array(modelDefinitionSchema).min(1).max(64),
  selections: z.record(z.string(), z.string()).default({}) }).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const model of value.models) {
    if (keys.has(model.key)) context.addIssue({ code: "custom", message: "duplicate_model_key" });
    keys.add(model.key);
  }
  for (const [purpose, key] of Object.entries(value.selections)) {
    if (!value.models.some(model => model.key === key && model.purposes.includes(purpose)))
      context.addIssue({ code: "custom", message: "invalid_model_selection" });
  }
});
export type ModelRegistry = z.infer<typeof registrySchema>;

/** Same versioned JSON environment convention as LOCAL_MODEL_SERVING_CONTRACTS; malformed input fails closed. */
export function readModelRegistry(env: ModelEnvironment = process.env): ModelRegistry {
  try {
    return registrySchema.parse(env.MODEL_REGISTRY_CONFIG?.trim() ? JSON.parse(env.MODEL_REGISTRY_CONFIG)
      : { version: 1, models: DEFAULT_MODEL_DEFINITIONS });
  } catch { throw new Error("invalid_model_registry"); }
}
export function modelForPurpose(purpose: string, env: ModelEnvironment = process.env): ModelDefinition {
  const registry = readModelRegistry(env), key = registry.selections[purpose];
  const matches = registry.models.filter(model => key ? model.key === key : model.purposes.includes(purpose));
  if (matches.length !== 1) throw new Error(`model_purpose_not_unique:${purpose}`);
  return matches[0];
}
export function modelRequestName(model: ModelDefinition): string {
  return model.gatewayLabel ? `[${model.gatewayLabel}] ${model.model}` : model.model;
}

/** Resolve equipment-qualified keys/labels first. A duplicated bare model is an error, never a first match. */
export function resolveRegistryModel(value: string, env: ModelEnvironment = process.env): ModelDefinition | null {
  const models = readModelRegistry(env).models, name = value.trim();
  const exact = models.filter(model => model.key === name || (model.gatewayLabel && modelRequestName(model) === name));
  if (exact.length > 1) throw new Error("ambiguous_model_identity");
  if (exact.length) return exact[0];
  if (name.startsWith("[")) return null;
  const matches = models.filter(model => model.model === name);
  if (matches.length > 1) throw new Error("ambiguous_model_identity");
  return matches[0] ?? null;
}

/** Keep established per-purpose env names; new *_MODEL_KEY selectors take precedence. */
export const MODEL_PURPOSE_ENV = {
  "product-search-profile": "ABCLLM_PROFILE_MODEL", "product-search-verify": "SEARCH_VERIFY_MODEL", "crawl-tagline": "ABCLLM_TAGLINE_MODEL",
  "reason-translate": "ABCLLM_MODEL", "product-tagline-ko": "ABCLLM_MODEL", "search-query-translate": "ABCLLM_MODEL",
  "product-translate": "PRODUCT_TRANSLATION_MODEL", "product-intro-check": "INTRO_CHECK_MODEL",
  "direct-review": "AUDIT_SECOND_OPINION_MODEL", "relay": "LOCAL_MODEL_RELAY_MODEL",
} as const;
export function configuredModel(purpose: keyof typeof MODEL_PURPOSE_ENV, env: ModelEnvironment = process.env): string {
  const variable = MODEL_PURPOSE_ENV[purpose], key = env[`${variable}_KEY`]?.trim();
  if (key) {
    const selected = readModelRegistry(env).models.find(model => model.key === key && model.purposes.includes(purpose));
    if (!selected) throw new Error(`invalid_model_key:${variable}_KEY`);
    return modelRequestName(selected);
  }
  const legacy = env[variable]?.trim();
  if (legacy) {
    const selected = resolveRegistryModel(legacy, env);
    // Unknown gateway model labels and CLI aliases keep their explicit caller identity.
    return selected ? modelRequestName(selected) : legacy;
  }
  return modelRequestName(modelForPurpose(purpose, env));
}
export function modelFamily(purpose: string, env: ModelEnvironment = process.env): string { return modelForPurpose(purpose, env).family; }
export function modelBaseUrl(purpose: string, env: ModelEnvironment = process.env): string {
  const definition = modelForPurpose(purpose, env);
  const legacy = definition.provider === "abcllm" ? env.ABCLLM_BASE_URL?.trim()
    : purpose === "direct-review" ? env.AUDIT_SECOND_OPINION_URL?.trim() : undefined;
  const base = legacy || definition.baseUrl;
  if (!base) throw new Error(`model_base_url_missing:${purpose}`);
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_model_base_url");
  return `${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}
