import { and, eq, isNull, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiConnections, operationsAudit, type AiConnectionModel } from "@/lib/db/schema";
import { ensureServingContracts, servingContractSnapshot, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { sealSecret, secretBoxReady } from "@/lib/security/secret-box";
import { AI_CONNECTION_KEY_FILL_AUDIT_ACTION, aiConnectionKeyAad } from "./admin-ai-tasks";
import { readbackServingEndpoint } from "./admin-serving-contracts";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";

/**
 * 같은 주소 계약 키로 「AI 연결」 키 채우기(2026-11-02 — 키 없는 연결 사고 뒤).
 *
 * 11-02 「지금 설정 가져오기」를 상자 키(NMV_SECRET_BOX_KEY)가 없는 프로세스에서 돌려 키가 필요한 엔진의 연결이 키 없이 만들어졌다. 키는 AAD 가 행 정체성이라
 * 암호문을 옮길 수 없고, 상자 키가 있는 프로세스가 계약 행의 키를 열어 연결 행의 AAD 로 다시 잠가야 한다. 이 모듈이 그 일을 한다:
 *
 * - 대상: 켜진 API 연결 중 키 암호문이 없는 것.
 * - 출처: 켜진 모델 계약 행 중 auth stored 이고, 계약 endpoint 의 `origin/v1` 이 연결 주소와 같고, 이 프로세스에서 키가 열리는 것.
 *   출처가 하나 이상이고 열린 키가 모두 같을 때만 채운다. 서로 다르면 채우지 않는다(화면 「모델 목록을 못 읽은 서버」 알림이 까닭을 보인다). 출처가 없으면 하는 일이 없다
 *   (키 없이 도는 서버 — auth none 계약뿐 — 는 그대로).
 * - 쓰기: 상자 키가 있을 때만. 쓰기 울타리(onPrimary + writerSiteActive) 안에서 `id·키 없음·판` 조건부 갱신(판 + 1) — 여러 프로세스가 함께 돌아도 한 번만 써진다.
 *   써진 TX 에만 감사 한 줄(연결 id·이름·주소와 출처 [{routeId, model}]만 — 키·암호문·키 해시는 싣지 않는다). 쓰기 전에 그 키로 GET /models 를 읽어 같은 갱신에
 *   목록을 넣는다(드롭다운에 그 서버 모델이 나오게).
 * - 언제: 프로세스마다 5분에 한 번 이하(maybeFillConnectionKeys). 웹 관리 화면 읽기와, 순위 스냅숏을 다시 읽은 프로세스(워커·웹) 중 키 없는 API 연결이 순위에
 *   있는 것만 부른다(lib/llm/ai-task-models-snapshot.ts). 상자 키가 없는 프로세스(Oracle 등)는 DB 를 읽지도 않는다.
 * 실행 경로(호출 순간)에서 계약 키를 대신 보내지 않는다 — 키는 연결에 한 번 채워 두고, 화면과 실행이 같은 키를 본다.
 */

export const AI_CONNECTION_KEY_FILL_ACTOR = "system:ai-connection-key-fill";
export const AI_CONNECTION_KEY_FILL_INTERVAL_MS = 5 * 60_000;

export type ContractKeySource = Readonly<{ routeId: string; model: string }>;
export type ContractKeyMatch = Readonly<{ status: "none"; sources: readonly ContractKeySource[] }
  | { status: "same"; key: string; sources: readonly ContractKeySource[] }
  | { status: "conflict"; sources: readonly ContractKeySource[] }>;

/** 계약 endpoint → `origin/v1`(연결 주소 꼴). 읽을 수 없으면 null. */
function contractBase(contract: unknown): string | null {
  const endpoint = contract && typeof contract === "object" ? (contract as { endpoint?: unknown }).endpoint : undefined;
  if (typeof endpoint !== "string" || !endpoint) return null;
  try {
    const url = new URL(endpoint);
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}/v1` : null;
  } catch { return null; }
}

/**
 * 연결 주소 하나의 계약 키 출처(순수 — 키는 메모리 안에서만). auth stored 이고 키가 열린 계약 중 endpoint 의 `origin/v1` 이 그 주소인 것.
 * 출처 없음 → none, 열린 키가 모두 같음 → same(그 키), 다름 → conflict(키는 돌려주지 않는다).
 */
export function contractKeyMatch(baseUrl: string | null, rows: readonly Pick<StoredServingContract, "routeId" | "model" | "contract" | "auth" | "apiKey">[]): ContractKeyMatch {
  if (!baseUrl) return Object.freeze({ status: "none", sources: Object.freeze([]) });
  const mine = rows.filter(row => row.auth === "stored" && typeof row.apiKey === "string" && row.apiKey.length > 0 && contractBase(row.contract) === baseUrl);
  const sources = Object.freeze(mine.map(row => Object.freeze({ routeId: row.routeId, model: row.model })));
  if (!mine.length) return Object.freeze({ status: "none", sources });
  const keys = new Set(mine.map(row => row.apiKey!));
  return keys.size === 1 ? Object.freeze({ status: "same", key: mine[0].apiKey!, sources }) : Object.freeze({ status: "conflict", sources });
}

export type ConnectionModelsRead = { ok: true; models: AiConnectionModel[] } | { ok: false; reason: string };
/** GET {주소}/models — 5초, 리다이렉트 없음, 키는 Bearer 로만(readbackServingEndpoint 그대로). 관리 화면의 연결 저장·다시 읽기와 같다. */
export async function readConnectionModels(baseUrl: string, key: string | null, request: typeof fetch = fetch): Promise<ConnectionModelsRead> {
  const result = await readbackServingEndpoint(`${baseUrl}/chat/completions`, key, request).catch(() => ({ ok: false as const, reason: "unreachable" }));
  // root(별칭의 원래 모델)는 알려 줄 때만 담는다 — 운영 콘솔 모델 목록이 같은 모델의 두 이름을 한 줄로 합친다(2026-11-12 3a)
  return result.ok ? { ok: true, models: result.models.slice(0, 512).map(model => ({ id: model.id.slice(0, 200), maxModelLen: model.maxModelLen,
    ...(model.canonicalModel ? { root: model.canonicalModel.slice(0, 200) } : {}) })) }
    : { ok: false, reason: /^[a-z0-9_]{1,40}$/.test(result.reason) ? result.reason : "unreachable" };
}

export type ConnectionKeyFillResult = Readonly<{
  /** 상자 키가 없어 아무것도 하지 않았다 */
  skipped: "secret_box_key_missing" | null;
  filled: readonly Readonly<{ id: string; label: string; sources: number; models: number | null; modelsError: string | null }>[];
  /** 같은 주소의 계약 키가 서로 달라 채우지 않은 연결 */
  conflicts: readonly Readonly<{ id: string; label: string; sources: number }>[];
}>;

type Deps = { request?: typeof fetch; now?: () => number };
let depsForTest: Deps | null = null;
/** 시험 전용 — /models 읽기·시계를 바꾼다. */
export function setConnectionKeyFillDepsForTest(deps: Deps | null): void { depsForTest = deps; }
const now = () => depsForTest?.now?.() ?? Date.now();

/** 한 번 돈다(간격 없이). 쓰기 울타리가 닫혔거나 DB 오류면 던진다 — maybeFillConnectionKeys 가 받아 남긴다. */
export async function fillConnectionKeysFromContracts(): Promise<ConnectionKeyFillResult> {
  if (!secretBoxReady()) return Object.freeze({ skipped: "secret_box_key_missing", filled: Object.freeze([]), conflicts: Object.freeze([]) });
  await ensureServingContracts();
  const contracts = servingContractSnapshot().rows;
  const filled: ConnectionKeyFillResult["filled"][number][] = [], conflicts: ConnectionKeyFillResult["conflicts"][number][] = [];
  // 키를 둔 계약이 하나도 없으면 출처가 없다 — DB 를 읽지 않는다
  if (contracts.some(row => row.auth === "stored" && row.apiKey)) {
    const targets = await onPrimary(() => db.select({ id: aiConnections.id, label: aiConnections.label, baseUrl: aiConnections.baseUrl, version: aiConnections.version })
      .from(aiConnections).where(and(eq(aiConnections.kind, "api"), eq(aiConnections.enabled, true), isNull(aiConnections.apiKeyCiphertext))));
    for (const target of targets) {
      const match = contractKeyMatch(target.baseUrl, contracts);
      if (match.status === "none" || !target.baseUrl) continue;
      if (match.status === "conflict") { conflicts.push(Object.freeze({ id: target.id, label: target.label, sources: match.sources.length })); continue; }
      // 네트워크는 잠금 밖에서 — 같은 갱신에 목록을 넣는다(못 읽으면 그 까닭)
      const read = await readConnectionModels(target.baseUrl, match.key, depsForTest?.request ?? fetch);
      const sealed = sealSecret(match.key, aiConnectionKeyAad(target.id)), at = new Date(now());
      const wrote = await onPrimary(() => db.transaction(async tx => {
        if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
        const [row] = await tx.update(aiConnections).set({ apiKeyCiphertext: sealed,
          ...(read.ok ? { models: read.models, modelsReadAt: at, modelsError: null } : { modelsReadAt: at, modelsError: read.reason }),
          version: sql`${aiConnections.version} + 1`, updatedBy: AI_CONNECTION_KEY_FILL_ACTOR, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(aiConnections.id, target.id), isNull(aiConnections.apiKeyCiphertext), eq(aiConnections.version, Number(target.version)),
            eq(aiConnections.kind, "api"), eq(aiConnections.enabled, true)))
          .returning({ id: aiConnections.id, label: aiConnections.label, baseUrl: aiConnections.baseUrl });
        if (!row) return false;
        await tx.insert(operationsAudit).values({ actor: AI_CONNECTION_KEY_FILL_ACTOR, actorKind: "token", action: AI_CONNECTION_KEY_FILL_AUDIT_ACTION,
          target: row.label.slice(0, 200), ok: true, error: null,
          detail: { id: row.id, label: row.label, baseUrl: row.baseUrl, sources: match.sources.map(source => ({ routeId: source.routeId, model: source.model })) } });
        return true;
      }));
      if (!wrote) continue;
      const entry = Object.freeze({ id: target.id, label: target.label, sources: match.sources.length, models: read.ok ? read.models.length : null,
        modelsError: read.ok ? null : read.reason });
      filled.push(entry);
      logger.info("ai_connections.key_filled", { ...entry });
    }
  }
  if (conflicts.length) logger.warn("ai_connections.key_fill_conflict", { connections: conflicts.map(row => row.label) });
  return Object.freeze({ skipped: null, filled: Object.freeze(filled), conflicts: Object.freeze(conflicts) });
}

type Gate = { lastAt: number; running: Promise<ConnectionKeyFillResult | null> | null };
const holder = globalThis as unknown as { __nmvConnectionKeyFill?: Gate };
const gate = (): Gate => (holder.__nmvConnectionKeyFill ??= { lastAt: 0, running: null });
/** 시험 전용 — 간격을 처음으로 되돌린다. */
export function resetConnectionKeyFillGateForTest(): void { holder.__nmvConnectionKeyFill = { lastAt: 0, running: null }; }

/**
 * 프로세스마다 AI_CONNECTION_KEY_FILL_INTERVAL_MS(5분)에 한 번 이하로 fillConnectionKeysFromContracts. 돌고 있으면 그 결과를 기다린다.
 * 간격 안이거나 상자 키가 없으면 null(아무것도 하지 않는다). 던지지 않는다 — 오류는 코드만 남긴다(drizzle 오류 글에는 값이 든다).
 */
export async function maybeFillConnectionKeys(): Promise<ConnectionKeyFillResult | null> {
  if (!secretBoxReady()) return null;
  const current = gate();
  if (current.running) return current.running;
  const at = now();
  if (current.lastAt > 0 && at - current.lastAt < AI_CONNECTION_KEY_FILL_INTERVAL_MS) return null;
  current.lastAt = at;
  current.running = fillConnectionKeysFromContracts().catch(error => {
    const cause = (error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : error) as { code?: unknown };
    logger.warn("ai_connections.key_fill_failed", { fenced: error instanceof DrWriterFencedError, code: typeof cause?.code === "string" ? cause.code : null });
    return null;
  }).finally(() => { current.running = null; });
  return current.running;
}
