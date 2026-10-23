import { z } from "zod";
import { assistWorkTaskSchema } from "./work";
import { resolveLocalModelServingContract, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";

const drainSchema = z.object({ backendId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  tasks: z.array(assistWorkTaskSchema).min(1).max(8), maxClaims: z.number().int().min(1).max(4) }).strict();
export type AssistBackendDrain = z.infer<typeof drainSchema> & { contract: LocalModelServingContract };

/** 장비 이름으로 기본 주소·모델·용량을 추측하지 않는다. 새 작업은 검증된 native 경로에서만 열린다. */
export function assistBackendDrains(env: Readonly<Record<string, string | undefined>> = process.env): AssistBackendDrain[] {
  if (!env.LLM_ASSIST_BACKENDS) return [];
  const drains = z.array(drainSchema).max(4).parse(JSON.parse(env.LLM_ASSIST_BACKENDS));
  if (new Set(drains.map(drain => drain.backendId)).size !== drains.length) throw new Error("duplicate_assist_backend");
  return drains.map(drain => {
    const contract = resolveLocalModelServingContract(drain.backendId, env);
    if (!contract || contract.modelFamily !== "qwen3.8-flash-next") throw new Error("assist_qwen_backend_required");
    return { ...drain, contract };
  });
}

export function assistBackendKey(backendId: string, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (!env.LLM_ASSIST_API_KEYS) return null;
  const keys = z.record(z.string(), z.string().min(1).max(4096)).parse(JSON.parse(env.LLM_ASSIST_API_KEYS));
  return keys[backendId] ?? null;
}
