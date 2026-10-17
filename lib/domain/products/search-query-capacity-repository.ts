import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { textHash } from "@/lib/crawl/translate";
import type { PreparedWebsearchQueryGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { lockModelCapacityCallerControl, lockWebsearchQueryModelCapacityDispatch, finishWebsearchQueryModelCapacityDispatch,
  readWebsearchQueryContinuation } from "@/lib/llm/capacity-repository";
import { modelCapacityRequestIdentitySchema, modelCapacityReservationSchema, websearchProcessOwnerSchema, websearchQueryInputSchema,
  websearchQueryMemberSchema, websearchQueryDispatchBindingSchema, websearchQueryLogicalWorkKey, websearchQueryInputHash,
  type ModelCapacityRequestIdentity, type ModelCapacityReservation, type WebsearchProcessOwner, type WebsearchQueryInput,
  type WebsearchQueryModelDispatch } from "@/lib/llm/capacity";

/**
 * 공개 검색어 번역의 주 DB 쪽 — 캐시(text_translations, target_lang='en')를 원 행 그대로 잠가 보고, 슬롯 장부와 같은 짧은 TX 에서만 쓴다.
 * 큐 대기·HTTP 동안에는 TX 도 연결도 잡지 않는다. 기록 수식(시도 수·다시 볼 시각)은 recordTranslations 와 같다.
 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CacheRow = Record<string, unknown>;
export type WebsearchQueryTarget = Readonly<{ query: string; sourceLocale: "ko" | "zh-Hans" | "zh-Hant"; cacheKey: string;
  promptVersion: number; glossaryVersion: number | null }>;
export type WebsearchQueryResult = { ok: true; keywords: string } | { ok: false; error: string };
export type WebsearchQueryWriteExpectation = Readonly<{ kind: "websearch_query_write" }>;
export type WebsearchQueryPreparation = { kind: "disabled" } | { kind: "skipped" } | { kind: "cached"; text: string }
  | { kind: "continued"; result: WebsearchQueryResult; cached: string | null }
  | { kind: "ready"; input: WebsearchQueryInput }
  | { kind: "ready"; dispatch: WebsearchQueryModelDispatch; expectation: WebsearchQueryWriteExpectation };
const queryWrites = new WeakMap<WebsearchQueryWriteExpectation, { cacheKey: string; raw: CacheRow | null; model: string; used: boolean }>();
class WebsearchQueryChanged extends Error { constructor() { super("websearch_query_input_changed"); } }

const targetSchema = z.object({ query: z.string().min(1), sourceLocale: z.enum(["ko", "zh-Hans", "zh-Hant"]),
  cacheKey: z.string().regex(/^[a-f0-9]{64}$/), promptVersion: z.number().int().positive().safe(),
  glossaryVersion: z.number().int().positive().safe().nullable() }).strict();

async function lockQueryCache(tx: Transaction, cacheKey: string): Promise<CacheRow | null> {
  const [row] = await tx.execute<{ raw: CacheRow }>(sql`SELECT to_jsonb(t) AS raw FROM text_translations t
    WHERE t.source_hash=${cacheKey} AND t.target_lang='en' FOR UPDATE`);
  return row?.raw ?? null;
}
const doneText = (raw: CacheRow | null) => raw?.status === "done" && typeof raw.translated === "string" ? raw.translated : null;

/** Absent: INSERT conflict loses. Present: whole raw-row CAS. Formulas equal the original writeTranslations for 'en'. */
async function writeQueryCache(tx: Transaction, cacheKey: string, expected: CacheRow | null, result: WebsearchQueryResult, model: string): Promise<boolean> {
  const done = result.ok, translated = result.ok ? result.keywords : null;
  const error = done ? null : (result.error ?? "invalid_output").slice(0, 60);
  const changed = expected === null
    ? await tx.execute(sql`INSERT INTO text_translations
        (source_hash,target_lang,status,translated,model,attempts,error_code,retry_at,updated_at)
        VALUES (${cacheKey},'en',${done ? "done" : "failed"},${translated},${model},1,${error},
          CASE WHEN ${done} THEN NULL ELSE now()+interval '5 minutes' END,now())
        ON CONFLICT (source_hash,target_lang) DO NOTHING RETURNING source_hash`)
    : await tx.execute(sql`UPDATE text_translations t SET status=${done ? "done" : "failed"},
        translated=CASE WHEN ${done} THEN ${translated} ELSE t.translated END,model=${model},
        attempts=t.attempts+1,error_code=${error},updated_at=now(),
        retry_at=CASE WHEN ${done} THEN NULL ELSE now()+least(interval '24 hours',interval '5 minutes'*power(2,t.attempts)) END
        WHERE t.source_hash=${cacheKey} AND t.target_lang='en' AND (${done} OR t.status <> 'done')
          AND to_jsonb(t)=${JSON.stringify(expected)}::text::jsonb RETURNING source_hash`);
  return changed.length === 1;
}

/** Initial read and reserved reentry share the same primary checks; only the fixed ledger UPDATE prefix differs. */
export async function prepareWebsearchQueryDispatch(value: WebsearchQueryTarget, valueOptions: { owner: WebsearchProcessOwner;
  call: PreparedWebsearchQueryGatewayCall; reserved?: { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; input: WebsearchQueryInput } }):
  Promise<WebsearchQueryPreparation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const target = targetSchema.parse(structuredClone(value)), owner = websearchProcessOwnerSchema.parse(structuredClone(valueOptions.owner));
  const call = valueOptions.call, reserved = valueOptions.reserved && { reservation: modelCapacityReservationSchema.parse(valueOptions.reserved.reservation),
    identity: modelCapacityRequestIdentitySchema.parse(valueOptions.reserved.identity), input: websearchQueryInputSchema.parse(valueOptions.reserved.input) };
  if (call.queryHash !== textHash(target.query) || call.sourceLocale !== target.sourceLocale) throw new Error("websearch_query_call_mismatch");
  let writer: Parameters<typeof queryWrites.set>[1] | undefined;
  try {
    const prepared = await onPrimary(() => db.transaction(async (tx): Promise<Exclude<WebsearchQueryPreparation, { expectation: WebsearchQueryWriteExpectation }>
      | { kind: "ready"; dispatch: WebsearchQueryModelDispatch }> => {
      const lock = reserved ? await lockWebsearchQueryModelCapacityDispatch(tx, reserved) : null;
      if (reserved && !lock) throw new ModelCapacityDeferredError("reservation_lost");
      const control = lock?.control ?? await lockModelCapacityCallerControl(tx);
      if (!reserved && control.mode === "disabled") return { kind: "disabled" };
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "disabled");
      if (!control.policy?.routes.some(route => route.routeId === "search-query-translate" && route.provider === "abcllm" && route.model === call.model))
        throw new ModelCapacityDeferredError("unmapped");
      // 복제본이 늦어 못 본 번역도 여기서 다시 본다 — 이미 옮긴 말이면 부르지 않는다
      const raw = await lockQueryCache(tx, target.cacheKey), cached = doneText(raw);
      if (cached !== null) return { kind: "cached", text: cached };
      const member = websearchQueryMemberSchema.parse({ cacheKey: target.cacheKey, sourceLocale: target.sourceLocale, queryHash: textHash(target.query),
        promptVersion: target.promptVersion, glossaryVersion: target.glossaryVersion,
        cache: raw === null ? { kind: "absent" } : { kind: "present", rowIdentityHash: reviewHash(raw), attempts: Number(raw.attempts) } });
      const input = websearchQueryInputSchema.parse({ member, model: call.model });
      const continuation = await readWebsearchQueryContinuation(tx, input);
      if (continuation.kind === "blocked") throw new ModelCapacityDeferredError("dispatched");
      if (continuation.kind === "settled") {
        // 끝난 호출의 결과가 캐시에 닿기 전에 프로세스가 멈췄다 — 같은 스냅숏에만 그 결과를 적는다. 다시 부르지 않는다
        const result: WebsearchQueryResult = continuation.outcome.ok ? { ok: true, keywords: continuation.outcome.keywords }
          : { ok: false, error: continuation.outcome.error };
        const written = await writeQueryCache(tx, target.cacheKey, raw, result, continuation.model);
        return { kind: "continued", result, cached: written ? null : doneText(await lockQueryCache(tx, target.cacheKey)) };
      }
      if (!reserved) return { kind: "ready", input };
      if (!isDeepStrictEqual(input, reserved.input)) throw new WebsearchQueryChanged();
      const binding = websearchQueryDispatchBindingSchema.parse({ kind: "websearch_query_gateway", version: 1, member, model: call.model,
        logicalWorkKey: websearchQueryLogicalWorkKey(member), inputHash: websearchQueryInputHash(input), provider: "abcllm",
        routeId: "search-query-translate", wireHash: call.wireHash, servingContractHash: call.servingContractHash,
        totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, process: owner });
      const dispatch = await finishWebsearchQueryModelCapacityDispatch(tx, lock!, binding);
      writer = { cacheKey: target.cacheKey, raw, model: call.model, used: false };
      return { kind: "ready", dispatch };
    }));
    if (prepared.kind === "ready" && "dispatch" in prepared) {
      const expectation = Object.freeze({ kind: "websearch_query_write" as const });
      queryWrites.set(expectation, writer!); // issued only after the actual commit acknowledgement
      return { ...prepared, expectation };
    }
    return prepared;
  } catch (error) {
    if (error instanceof WebsearchQueryChanged) return { kind: "skipped" };
    if (error instanceof Error && error.message === "websearch_query_model_reservation_lost") throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
}

/** One-use writer: the exact primary cache snapshot must still hold; a loser rereads the winner and never overwrites it. */
export async function recordWebsearchQueryResult(expectation: WebsearchQueryWriteExpectation, value: WebsearchQueryResult):
  Promise<{ kind: "stored" } | { kind: "lost"; cached: string | null }> {
  const proof = queryWrites.get(expectation), result = structuredClone(value);
  if (!proof || proof.used || !result || typeof result !== "object" || (result.ok ? typeof result.keywords !== "string" || !result.keywords
    : typeof result.error !== "string")) throw new Error("invalid_websearch_query_write_expectation");
  proof.used = true;
  return onPrimary(() => db.transaction(async tx => {
    const raw = await lockQueryCache(tx, proof.cacheKey);
    if (!isDeepStrictEqual(raw, proof.raw) || !await writeQueryCache(tx, proof.cacheKey, proof.raw, result, proof.model))
      return { kind: "lost" as const, cached: doneText(await lockQueryCache(tx, proof.cacheKey)) };
    return { kind: "stored" as const };
  }));
}
