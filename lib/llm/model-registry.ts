import { z } from "zod";
import { deadlineLadderSchema, deadlineLadderViolation, type DeadlineLadder } from "./deadline-policy";

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;
type EnvironmentResolver = (env: ModelEnvironment, purpose?: string) => ModelEnvironment;
let environmentResolver: EnvironmentResolver | undefined;
/** The server installs one AsyncLocalStorage reader. Client bundles retain the immutable environment defaults. */
export function setModelEnvironmentResolver(resolver: EnvironmentResolver) { environmentResolver = resolver; }
export function modelEnvironment(env: ModelEnvironment = process.env, purpose?: string): ModelEnvironment {
  return environmentResolver?.(env, purpose) ?? env;
}
/** Import-time compatibility constants remain valid outside a DB-selected execution scope. */
export function scopedModel(purpose: string, fallback: string): string {
  const env = modelEnvironment(process.env, purpose);
  if (env === process.env) return fallback;
  return purpose in MODEL_PURPOSE_ENV ? configuredModel(purpose as keyof typeof MODEL_PURPOSE_ENV, env) : modelRequestName(modelForPurpose(purpose, env));
}
export function scopedModelBaseUrl(purpose: string, fallback: string, provider: ModelDefinition["provider"]): string {
  const env = modelEnvironment(process.env, purpose);
  return env === process.env ? fallback : modelBaseUrl(purpose, env, provider);
}
export function scopedModelDefinition(purpose: string): ModelDefinition | null {
  const env = modelEnvironment(process.env, purpose);
  if (env === process.env) return null;
  return purpose in MODEL_PURPOSE_ENV ? configuredModelDefinition(purpose as keyof typeof MODEL_PURPOSE_ENV, env) : modelForPurpose(purpose, env);
}
export function registeredPoolModelNames(keys: readonly string[] | undefined, fallback: string): string[] {
  if (!keys?.length) return [fallback];
  const registry = readModelRegistry();
  return keys.map(key => {
    const model = registry.models.find(row => row.key === key);
    if (!model) throw new Error("stage_model_missing");
    return modelRequestName(model);
  });
}
export function scopedRequestTimeout(purpose: string, fallbackMs: number): number {
  const env = modelEnvironment(process.env, purpose);
  return env === process.env ? fallbackMs : Math.max(1, Math.min(fallbackMs, modelTimeoutMs(purpose, env)));
}
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
  deadlineLadder: deadlineLadderSchema.optional(),
  timeoutMs: z.number().int().positive().max(3_600_000), maxTokens: z.number().int().positive().max(262_144),
  concurrency: z.number().int().positive().max(64), purposes: z.array(identity).min(1),
}).strict().superRefine((model, context) => {
  if (model.deadlineLadder) {
    const violation = deadlineLadderViolation(model.deadlineLadder);
    if (violation) context.addIssue({ code: "custom", message: violation });
    if (model.timeoutMs !== model.deadlineLadder.clientMs)
      context.addIssue({ code: "custom", message: "model_timeout_ladder_mismatch" });
  }
  if (!model.key.startsWith(`${model.equipment}:`)) context.addIssue({ code: "custom", message: "model_key_equipment_mismatch" });
  if ((model.provider === "abcllm" || model.provider === "local-direct" || model.provider === "llama-server") && !model.baseUrl)
    context.addIssue({ code: "custom", message: "model_base_url_required" });
  if (model.gatewayLabel && model.gatewayLabel.toLowerCase() !== model.equipment) context.addIssue({ code: "custom", message: "gateway_label_equipment_mismatch" });
  if (model.gatewayLabel && model.provider !== "abcllm") context.addIssue({ code: "custom", message: "gateway_label_provider_mismatch" });
});
export type ModelDefinition = Readonly<z.infer<typeof modelDefinitionSchema>>;
const m1 = "https://m1-studio.tail02799e.ts.net/v1";
const supa = "http://100.78.219.124:8000/v1";
const m3Mlx = "http://100.92.77.66:8014/v1";
const local = "http://100.77.43.63:8090/v1";

/**
 * All compatibility defaults live here. Selection never grants capacity or verified serving authority.
 * These are direct engine addresses only: the retired abcLLM gateway is not a fallback, and enabled DB
 * overrides or admin engine contracts remain authoritative.
 */
export const DEFAULT_MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  { key: "gpu3090:review", equipment: "gpu3090", displayName: "GPU3090 · Qwen · 직접 연결", provider: "local-direct", baseUrl: local,
    model: "qwen3.8-flash-next", family: "qwen3.8-flash-next", timeoutMs: 60_000, maxTokens: 10_000, concurrency: 2,
    purposes: ["direct-review", "ai2-direct", "assist-primary", "korean-translation-direct"] },
  { key: "m3:review", equipment: "m3", displayName: "M3 · DeepSeek", provider: "local-direct", baseUrl: "http://100.92.77.66:8010/v1",
    model: "deepseek-v4.1-flash-1017", family: "deepseek-v4.1-flash-1017", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1,
    purposes: ["human-review", "assist-audit"] },
  { key: "m1:translation", equipment: "m1", displayName: "M1 · Gemma 4 26B", provider: "abcllm", baseUrl: m1,
    model: "mlx-community--gemma-4-26b-a4b-it-4bit", family: "gemma4-26b", timeoutMs: 300_000, maxTokens: 30_000, concurrency: 1, purposes: ["product-translate", "reason-translate", "relay"] },
  { key: "supa:review", equipment: "supa", displayName: "Supa · Qwen", provider: "abcllm", baseUrl: supa,
    model: "supa", family: "qwen3.8-27b-nvfp4", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 4,
    purposes: ["ai1-preset", "product-search-verify", "crawl-tagline"] },
  { key: "mlx:text", equipment: "mlx", displayName: "MLX · GPT OSS", provider: "abcllm", baseUrl: m3Mlx,
    model: "gpt-oss-120b", family: "gpt-oss-120b", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 2,
    purposes: ["product-search-profile", "product-tagline-ko", "search-query-translate", "assist-legacy-family"] },
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
/** Per-purpose request budgets preserve existing adaptive wire sizing under the model ceiling. */
export const DEFAULT_MODEL_PURPOSE_LIMITS: Readonly<Record<string, { maxTokens: number; concurrency: number; timeoutMs?: number }>> = {
  "gateway-review": { maxTokens: 3_000, concurrency: 2 }, "review-cli": { maxTokens: 2_000, concurrency: 1, timeoutMs: 20_000 },
  "relay": { maxTokens: 10_000, concurrency: 2, timeoutMs: 90_000 },
  "human-review": { maxTokens: 2_000, concurrency: 1 }, "product-intro-check": { maxTokens: 8_000, concurrency: 1 },
  "classify-claude": { maxTokens: 4_000, concurrency: 1 },
  "product-search-profile": { maxTokens: 500, concurrency: 2, timeoutMs: 45_000 }, "product-search-verify": { maxTokens: 3_000, concurrency: 4, timeoutMs: 60_000 },
  "crawl-tagline": { maxTokens: 400, concurrency: 2 }, "reason-translate": { maxTokens: 6_000, concurrency: 2, timeoutMs: 45_000 },
  "product-tagline-ko": { maxTokens: 5_400, concurrency: 1, timeoutMs: 45_000 }, "product-translate": { maxTokens: 30_000, concurrency: 1, timeoutMs: 300_000 },
  "search-query-translate": { maxTokens: 200, concurrency: 1 }, "direct-review": { maxTokens: 3_000, concurrency: 2 },
};
const purposeLimitSchema = z.object({ maxTokens: z.number().int().positive().max(262_144),
  concurrency: z.number().int().positive().max(64), timeoutMs: z.number().int().positive().max(3_600_000).optional() }).strict();
/** Route budgets whose job allowance differs from the model's general client default. */
export const DEFAULT_MODEL_TIMEOUTS: Readonly<Record<string, number>> = {
  "audit-second-opinion": 45_000, "held-review-retry": 15_000, "split-tiebreak": 20_000,
  "split-confirm": 45_000, "product-audit": 45_000, "grok-review": 90_000,
  "grok-session": 60_000, "search-query-translate": 8_000, "crawl-tagline": 45_000,
  "classify-cli": 35_000, "screen-review": 90_000,
};
export const DEFAULT_MODEL_DEADLINES: Readonly<Record<string, DeadlineLadder>> = {
  "review-gateway": { engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 60_000 },
};
/**
 * 용도별 코드 기본 후보. 1차 심사(first-review)의 후보 목록은 없앴다(PR C1) — 1차 심사자는 「작업 ↔ 모델」 순위뿐이고, 화면의 선택지도 연결이 내놓는 모델이다.
 * 등록부 문서의 candidates 칸은 그대로 받는다(덮어쓰기 검사에만 쓴다).
 */
export const DEFAULT_MODEL_CANDIDATES: Readonly<Record<string, readonly string[]>> = {};
const registrySchema = z.object({ version: z.literal(1), models: z.array(modelDefinitionSchema).min(1).max(64),
  selections: z.record(z.string(), z.string()).default({}), limits: z.record(z.string(), purposeLimitSchema).default({}),
  deadlines: z.record(z.string(), deadlineLadderSchema).default({}),
  timeouts: z.record(z.string(), z.number().int().positive().max(3_600_000)).default({}),
  candidates: z.record(z.string(), z.array(z.string()).min(1).max(64)).default({}) }).strict().superRefine((value, context) => {
  for (const [route, ladder] of Object.entries({ ...DEFAULT_MODEL_DEADLINES, ...value.deadlines })) {
    const violation = deadlineLadderViolation(ladder);
    if (violation) context.addIssue({ code: "custom", path: ["deadlines", route], message: violation });
    const timeout = value.timeouts[route] ?? value.limits[route]?.timeoutMs;
    if (timeout !== undefined && timeout !== ladder.clientMs)
      context.addIssue({ code: "custom", path: ["deadlines", route], message: "model_timeout_ladder_mismatch" });
  }
  for (const [purpose, candidates] of Object.entries(value.candidates)) {
    if (new Set(candidates).size !== candidates.length || candidates.some(key => !value.models.some(model => model.key === key)))
      context.addIssue({ code: "custom", path: ["candidates", purpose], message: "invalid_model_candidates" });
  }
  const reviewCandidates = value.candidates["first-review"] ?? DEFAULT_MODEL_CANDIDATES["first-review"] ?? [];
  for (const model of value.models) {
    if (model.provider !== "abcllm" || !(reviewCandidates.includes(model.key) || model.purposes.some(purpose => ["first-review", "second-review", "ai1-preset", "ai2-gateway"].includes(purpose)))) continue;
    const ladder = model.deadlineLadder ?? value.deadlines["review-gateway"] ?? DEFAULT_MODEL_DEADLINES["review-gateway"];
    const effective = { ...ladder, clientMs: Math.min(ladder.clientMs, model.timeoutMs) };
    if (deadlineLadderViolation(effective)) context.addIssue({ code: "custom", path: ["models", model.key], message: "model_role_deadline_order_inverted" });
  }
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

type RegistryOverlay = () => readonly unknown[];
let registryOverlay: RegistryOverlay | undefined;
/** The server installs the admin override reader (model_registry_overrides). Client bundles keep the code defaults. */
export function setModelRegistryOverlay(reader: RegistryOverlay | undefined) { registryOverlay = reader; }
/**
 * Code defaults with admin overrides by key. An override that fails the definition schema removes that key (its routes close);
 * a merged registry that fails the registry schema keeps the code defaults. Saving validates the merge first, so neither
 * should happen outside a later code change.
 */
export function overlaidModelDefinitions(overrides: readonly unknown[], base: readonly ModelDefinition[] = DEFAULT_MODEL_DEFINITIONS): ModelDefinition[] {
  if (!overrides.length) return [...base];
  const replaced = new Map<string, ModelDefinition | null>();
  for (const row of overrides) {
    const key = row && typeof row === "object" ? (row as { key?: unknown }).key : undefined;
    if (typeof key !== "string") continue;
    const parsed = modelDefinitionSchema.safeParse(row);
    replaced.set(key, parsed.success ? parsed.data : null);
  }
  const merged = base.flatMap(model => replaced.has(model.key) ? replaced.get(model.key) ?? [] : [model]);
  for (const [key, model] of replaced) if (model && !base.some(row => row.key === key)) merged.push(model);
  return registrySchema.safeParse({ version: 1, models: merged }).success ? merged : [...base];
}

type RoutePolicyOverlay = () => { limits?: unknown; timeouts?: unknown; deadlines?: unknown } | null;
let routePolicyOverlay: RoutePolicyOverlay | undefined;
/**
 * The server installs the admin route-policy reader (runtime_settings routes: limits/timeouts/deadlines, PR 1a) next to the model overlay.
 * Client bundles keep the code defaults. An explicit MODEL_REGISTRY_CONFIG still bypasses both overlays for that process.
 */
export function setModelRoutePolicyOverlay(reader: RoutePolicyOverlay | undefined) { routePolicyOverlay = reader; }

/** Same versioned JSON environment convention as LOCAL_MODEL_SERVING_CONTRACTS; malformed input fails closed. */
export function readModelRegistry(env: ModelEnvironment = process.env): ModelRegistry {
  env = modelEnvironment(env);
  try {
    // An explicit MODEL_REGISTRY_CONFIG (including a job scope built from the overlaid registry) is used as is.
    if (env.MODEL_REGISTRY_CONFIG?.trim()) return registrySchema.parse(JSON.parse(env.MODEL_REGISTRY_CONFIG));
    const models = overlaidModelDefinitions(registryOverlay?.() ?? []);
    const policy = routePolicyOverlay?.() ?? null;
    if (!policy) return registrySchema.parse({ version: 1, models });
    // A route policy that fails the merged registry schema keeps the code-default routes (saving validates the merge first).
    const merged = registrySchema.safeParse({ version: 1, models, limits: policy.limits ?? {}, timeouts: policy.timeouts ?? {}, deadlines: policy.deadlines ?? {} });
    return merged.success ? merged.data : registrySchema.parse({ version: 1, models });
  } catch (error) {
    // Never include input values (URLs may contain credentials) in configuration errors.
    const detail = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}:${issue.code === "custom" ? issue.message : issue.code}`).join(",") : "invalid_json";
    throw new Error(`invalid_model_registry:${detail}`);
  }
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

/**
 * Keep established per-purpose env names; new *_MODEL_KEY selectors take precedence. null = no process env for that purpose: the
 * registry (code defaults + admin model_registry_overrides) and the admin stage pools select its model. crawl-tagline and
 * product-translate lost their env (2026-10-31, abcLLM gateway removal), and the retired ABCLLM_MODEL / ABCLLM_PROFILE_MODEL
 * names are no longer read for product-search-profile, reason-translate, product-tagline-ko and search-query-translate either
 * (2026-11-04) so a stale gateway alias in an app env cannot pick the model.
 */
export const MODEL_PURPOSE_ENV: Readonly<Record<"product-search-profile" | "product-search-verify" | "crawl-tagline" | "reason-translate"
  | "product-tagline-ko" | "search-query-translate" | "product-translate" | "product-intro-check" | "direct-review" | "relay", string | null>> = {
  "product-search-profile": null, "product-search-verify": "SEARCH_VERIFY_MODEL", "crawl-tagline": null,
  "reason-translate": null, "product-tagline-ko": null, "search-query-translate": null,
  "product-translate": null, "product-intro-check": "INTRO_CHECK_MODEL",
  "direct-review": "AUDIT_SECOND_OPINION_MODEL", "relay": "LOCAL_MODEL_RELAY_MODEL",
};
/**
 * A legacy model env names a route, not a first match. A bare name shared by several equipment entries resolves to the one
 * entry the registry assigns to this purpose (selection, then purposes). A registered equipment label whose model is no longer
 * registered there resolves to the purpose's current model on that same equipment. Anything else stays unresolved.
 */
export function resolvePurposeModel(purpose: string, value: string, env: ModelEnvironment = process.env): ModelDefinition | null {
  const name = value.trim();
  try {
    const exact = resolveRegistryModel(name, env);
    if (exact) return exact;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ambiguous_model_identity" || name.startsWith("[")) throw error;
    const registry = readModelRegistry(env), selected = registry.selections[purpose];
    const named = registry.models.filter(model => model.model === name);
    const routed = selected ? named.filter(model => model.key === selected) : named.filter(model => model.purposes.includes(purpose));
    if (routed.length !== 1) throw error;
    return routed[0];
  }
  const label = /^\[([^\]]+)\] /.exec(name)?.[1]?.toLowerCase();
  if (!label || !readModelRegistry(env).models.some(model => model.gatewayLabel?.toLowerCase() === label)) return null;
  let current: ModelDefinition;
  try { current = modelForPurpose(purpose, env); } catch { return null; }
  return current.gatewayLabel?.toLowerCase() === label ? current : null;
}
type AssignmentDefaultsOverlay = (purpose: string, env: ModelEnvironment) => string | null;
let assignmentDefaultsOverlay: AssignmentDefaultsOverlay | undefined;
/**
 * The server installs the assignment-table default reader (PR 3b-B, lib/llm/stage-assignment-snapshot.ts). With the assignment-table switch on
 * (runtime_settings toggle assignments.tableReads, or MODEL_ASSIGNMENT_TABLE=1 forcing it — PR 3b-E) and a live assignment row for the purpose's
 * stage, that row's registry key is the default ahead of `*_KEY` and the legacy model env. It applies only to
 * the unscoped process environment: an admin stage-pool scope (which itself picks from the table) and explicit caller environments keep their key.
 * Client bundles never install it.
 */
export function setModelAssignmentDefaultsOverlay(reader: AssignmentDefaultsOverlay | undefined) { assignmentDefaultsOverlay = reader; }
function assignedDefinition(purpose: keyof typeof MODEL_PURPOSE_ENV, env: ModelEnvironment): ModelDefinition | null {
  if (!assignmentDefaultsOverlay || env !== process.env) return null;
  const key = assignmentDefaultsOverlay(purpose, env);
  return key ? readModelRegistry(env).models.find(model => model.key === key) ?? null : null;
}
export function configuredModelDefinition(purpose: keyof typeof MODEL_PURPOSE_ENV, env: ModelEnvironment = process.env): ModelDefinition {
  env = modelEnvironment(env, purpose);
  const assigned = assignedDefinition(purpose, env);
  if (assigned) return assigned;
  const variable = MODEL_PURPOSE_ENV[purpose], key = variable ? env[`${variable}_KEY`]?.trim() : undefined;
  if (key) {
    const selected = readModelRegistry(env).models.find(model => model.key === key && model.purposes.includes(purpose));
    if (!selected) throw new Error(`invalid_model_key:${variable}_KEY`);
    return selected;
  }
  const legacy = variable ? env[variable]?.trim() : undefined;
  return (legacy ? resolvePurposeModel(purpose, legacy, env) : null) ?? modelForPurpose(purpose, env);
}
export function configuredModel(purpose: keyof typeof MODEL_PURPOSE_ENV, env: ModelEnvironment = process.env): string {
  env = modelEnvironment(env, purpose);
  const assigned = assignedDefinition(purpose, env);
  if (assigned) return modelRequestName(assigned);
  const variable = MODEL_PURPOSE_ENV[purpose], key = variable ? env[`${variable}_KEY`]?.trim() : undefined;
  if (key) {
    const selected = readModelRegistry(env).models.find(model => model.key === key && model.purposes.includes(purpose));
    if (!selected) throw new Error(`invalid_model_key:${variable}_KEY`);
    return modelRequestName(selected);
  }
  const legacy = variable ? env[variable]?.trim() : undefined;
  if (legacy) {
    const selected = resolvePurposeModel(purpose, legacy, env);
    // Unknown gateway model labels and CLI aliases keep their explicit caller identity.
    return selected ? modelRequestName(selected) : legacy;
  }
  return modelRequestName(modelForPurpose(purpose, env));
}
/** One route descriptor for a purpose: registry entry, equipment, adapter, wire name and address. */
export function configuredModelRoute(purpose: keyof typeof MODEL_PURPOSE_ENV, env: ModelEnvironment = process.env) {
  const definition = configuredModelDefinition(purpose, env);
  return { routeId: purpose, key: definition.key, equipment: definition.equipment, provider: definition.provider,
    requestModel: configuredModel(purpose, env), baseUrl: definition.baseUrl ? modelBaseUrl(purpose, env, definition.provider) : null };
}
/** Models one relay may forward: its equipment's registry entries for the relay purpose, never another device's same-named model. */
export function relayModelDefinitions(equipment: string, env: ModelEnvironment = process.env): ModelDefinition[] {
  return readModelRegistry(env).models.filter(model => model.equipment === equipment && model.purposes.includes("relay")
    && (model.provider === "local-direct" || model.provider === "abcllm"));
}
export function modelFamily(purpose: string, env: ModelEnvironment = process.env): string { return modelForPurpose(purpose, env).family; }
export function configuredModelForProvider(purpose: keyof typeof MODEL_PURPOSE_ENV, provider: ModelDefinition["provider"], env: ModelEnvironment = process.env): string {
  if (configuredModelDefinition(purpose, env).provider !== provider) throw new Error("model_provider_adapter_mismatch");
  const model = configuredModel(purpose, env);
  if (provider.endsWith("-cli") && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) throw new Error("invalid_cli_model");
  return model;
}
export function modelBaseUrl(purpose: string, env: ModelEnvironment = process.env, expectedProvider?: ModelDefinition["provider"]): string {
  env = modelEnvironment(env, purpose);
  const definition = purpose in MODEL_PURPOSE_ENV ? configuredModelDefinition(purpose as keyof typeof MODEL_PURPOSE_ENV, env) : modelForPurpose(purpose, env);
  if (expectedProvider && definition.provider !== expectedProvider) throw new Error("model_provider_adapter_mismatch");
  const legacy = purpose === "direct-review" ? env.AUDIT_SECOND_OPINION_URL?.trim() : undefined;
  const base = legacy || definition.baseUrl;
  if (!base) throw new Error(`model_base_url_missing:${purpose}`);
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_model_base_url");
  return `${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}

export function modelLimits(purpose: string, env: ModelEnvironment = process.env): { maxTokens: number; concurrency: number } {
  const definition = purpose in MODEL_PURPOSE_ENV ? configuredModelDefinition(purpose as keyof typeof MODEL_PURPOSE_ENV, env) : modelForPurpose(purpose, env);
  const budget = readModelRegistry(env).limits[purpose] ?? DEFAULT_MODEL_PURPOSE_LIMITS[purpose] ?? definition;
  return { maxTokens: Math.min(budget.maxTokens, definition.maxTokens), concurrency: Math.min(budget.concurrency, definition.concurrency) };
}

export function modelRequestBudget(purpose: string, env: ModelEnvironment = process.env): { maxTokens: number; concurrency: number } {
  const budget = readModelRegistry(env).limits[purpose] ?? DEFAULT_MODEL_PURPOSE_LIMITS[purpose];
  if (!budget) throw new Error(`model_request_budget_missing:${purpose}`);
  return budget;
}

/** Candidate suggestions never rewrite the DB-selected pool or its assignment policy. */
export function modelCandidates(purpose: string, env: ModelEnvironment = process.env): ModelDefinition[] {
  const registry = readModelRegistry(env);
  return (registry.candidates[purpose] ?? DEFAULT_MODEL_CANDIDATES[purpose] ?? []).flatMap(key => {
    const model = registry.models.find(model => model.key === key);
    return model ? [model] : [];
  });
}

export function modelDeadlineLadder(route: string, env: ModelEnvironment = process.env): DeadlineLadder {
  const ladder = readModelRegistry(env).deadlines[route] ?? DEFAULT_MODEL_DEADLINES[route];
  if (!ladder) throw new Error(`model_deadline_ladder_missing:${route}`);
  return ladder;
}

/** Explicit caller deadlines may shorten this budget. Admin route policy (runtime_settings) and overrides apply on the next read; MODEL_REGISTRY_CONFIG env is restart-only. */
export function modelTimeoutMs(purpose: string, env: ModelEnvironment = process.env): number {
  const registry = readModelRegistry(env);
  if (registry.deadlines[purpose] || DEFAULT_MODEL_DEADLINES[purpose]) return modelDeadlineLadder(purpose, env).clientMs;
  const budget = registry.limits[purpose] ?? DEFAULT_MODEL_PURPOSE_LIMITS[purpose];
  const timeout = registry.timeouts[purpose] ?? budget?.timeoutMs ?? DEFAULT_MODEL_TIMEOUTS[purpose];
  if (purpose in DEFAULT_MODEL_TIMEOUTS) return timeout;
  // Relay upstream timing is separate from the direct-review client and has no proven engine bound by default.
  if (purpose === "relay" || purpose === "review-cli") {
    if (!timeout) throw new Error(`model_timeout_missing:${purpose}`);
    return timeout;
  }
  const model = purpose in MODEL_PURPOSE_ENV ? configuredModelDefinition(purpose as keyof typeof MODEL_PURPOSE_ENV, env) : modelForPurpose(purpose, env);
  return model.deadlineLadder?.clientMs ?? Math.min(model.timeoutMs, timeout ?? model.timeoutMs);
}

/**
 * 경로 한도만으로 정한 한 번 부르는 시간(PR B, 「작업 ↔ 모델」 순위를 읽는 text 경로). 등록부의 모델 정의(환경변수·용도 기본값이 고르는 모델)를
 * 읽지 않는다 — 모델은 순위가 고르고, 시간은 경로(runtime_settings routes·코드 기본 경로 한도)가 정한다. 코드 기본값에서는 modelTimeoutMs 와 같다.
 */
export function modelRouteTimeoutMs(route: string, env: ModelEnvironment = process.env): number {
  const registry = readModelRegistry(env);
  if (registry.deadlines[route] || DEFAULT_MODEL_DEADLINES[route]) return modelDeadlineLadder(route, env).clientMs;
  const budget = registry.limits[route] ?? DEFAULT_MODEL_PURPOSE_LIMITS[route];
  const timeout = registry.timeouts[route] ?? budget?.timeoutMs ?? DEFAULT_MODEL_TIMEOUTS[route];
  if (!timeout) throw new Error(`model_timeout_missing:${route}`);
  return timeout;
}

/** Known equipment models may shorten the role budget or declare their own complete ladder. */
export function modelCallTimeoutMs(route: string, requestModel: string, env: ModelEnvironment = process.env): number {
  const definition = resolveRegistryModel(requestModel, env), routeTimeout = modelTimeoutMs(route, env);
  return definition?.deadlineLadder?.clientMs ?? Math.min(routeTimeout, definition?.timeoutMs ?? routeTimeout);
}

export function modelCallMaxTokens(route: string, requestModel: string, env: ModelEnvironment = process.env): number {
  const definition = resolveRegistryModel(requestModel, env);
  return Math.min(modelRequestBudget(route, env).maxTokens, definition?.maxTokens ?? Number.MAX_SAFE_INTEGER);
}
