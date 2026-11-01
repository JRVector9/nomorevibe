import { z } from "zod";

/**
 * 「연결 확인」 결과의 관측(operations_observations) 계약 — 2026-10-31 한 화면 개편.
 *
 * 전에는 연결 확인 버튼의 결과가 브라우저 상태에만 있어 새로고침(30초 자동)마다 사라졌다. 이제 서버 액션(probeAdminModel)과
 * 렌더 때의 자동 확인(사람 위임·카테고리·검색 서버, 2026-11-01 부터 엔진 직접 연결 계약도 — admin-models-direct-probe.ts, 1분에 한 번)이
 * 같은 키에 upsert 하고, 표의 「연결 확인」 열이 읽어 「N초 전 · 수동/자동 · 결과」로 보인다.
 *
 * 키: `probe:<provider>:<model>` — 경로(routeId)는 넣지 않는다. 같은 장비·같은 모델 슬롯은 어느 단계가 확인했든 하나의 결과를 공유한다.
 * 값: 결과·출처·소요 ms·확인한 경로만. 주소·키·토큰은 절대 넣지 않는다(결과 문구는 서버 액션이 만든 한국어 메시지다).
 * operations_observations.key 는 varchar(80) — 넘치거나 ASCII 가 아니면 provider+model 의 FNV-1a 해시 32자로 줄인다(읽기도 같은 함수로 키를 만든다).
 * 이 모듈은 클라이언트 표에서도 쓰므로 node:crypto 를 들이지 않는다.
 */
export const PROBE_OBSERVATION_PREFIX = "probe:";
export const PROBE_KEY_MAX = 80;
export const PROBE_SOURCES = ["manual", "auto"] as const;
export type ProbeSource = (typeof PROBE_SOURCES)[number];

/** 32비트 FNV-1a 를 씨앗 네 개로 돌려 32자 16진수 — 암호 용도가 아니라 긴 키를 고정 길이로 줄이는 용도다. */
function shortHash(text: string): string {
  const parts: string[] = [];
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x7f4a7c15]) {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
    parts.push(hash.toString(16).padStart(8, "0"));
  }
  return parts.join("");
}
export function probeObservationKey(identity: { provider: string; model: string }): string {
  const plain = `${PROBE_OBSERVATION_PREFIX}${identity.provider}:${identity.model}`;
  if (plain.length <= PROBE_KEY_MAX && /^[\x21-\x7e]+$/.test(plain)) return plain;
  return `${PROBE_OBSERVATION_PREFIX}#${shortHash(`${identity.provider}\0${identity.model}`)}`;
}

const text = (max: number) => z.string().max(max).nullable();
export const probeObservationValueSchema = z.object({
  kind: z.literal("model-probe"), provider: z.string().min(1).max(60), model: z.string().min(1).max(200), routeId: text(120),
  source: z.enum(PROBE_SOURCES),
  /** true = 모델 목록에 있음, false = 목록에 없음, null = 목록을 읽지 못함(또는 이 제공자는 조회 실행기 없음) */
  listed: z.boolean().nullable(), listMs: z.number().int().nonnegative().nullable(), callMs: z.number().int().nonnegative().nullable(),
  callBlocked: text(300), error: text(300),
  /** 자동 확인이 남기는 짧은 설명(예: "사람 위임 슬롯 · /models") */
  detail: text(200),
}).strict();
export type ProbeObservationValue = z.infer<typeof probeObservationValueSchema>;
export type ProbeObservation = ProbeObservationValue & { key: string; observedAt: string };
export type ProbeResultLike = { listed?: boolean | null; listMs?: number | null; callMs?: number | null; callBlocked?: string | null; error?: string | null };

export function probeObservationValue(identity: { routeId?: string | null; provider: string; model: string }, result: ProbeResultLike,
  source: ProbeSource, detail: string | null = null): ProbeObservationValue {
  return probeObservationValueSchema.parse({ kind: "model-probe", provider: identity.provider, model: identity.model, routeId: identity.routeId ?? null,
    source, listed: result.listed ?? null, listMs: result.listMs == null ? null : Math.round(result.listMs), callMs: result.callMs == null ? null : Math.round(result.callMs),
    callBlocked: result.callBlocked?.slice(0, 300) ?? null, error: result.error?.slice(0, 300) ?? null, detail: detail?.slice(0, 200) ?? null });
}

/** 저장된 관측 한 줄 → 화면 값. 모양이 다르면(다른 종류의 관측·옛 판) null — 없는 것으로 본다. */
export function parseProbeObservation(row: { key: string; value: unknown; observedAt: string | Date }): ProbeObservation | null {
  if (!row.key.startsWith(PROBE_OBSERVATION_PREFIX)) return null;
  const parsed = probeObservationValueSchema.safeParse(row.value);
  if (!parsed.success) return null;
  const observedAt = typeof row.observedAt === "string" ? row.observedAt : row.observedAt.toISOString();
  return Number.isFinite(Date.parse(observedAt)) ? { ...parsed.data, key: row.key, observedAt } : null;
}

/** 모델 목록(GET /models)을 읽지 못했을 때의 결과 문구 — 수동 버튼(probeAdminModel)과 엔진 직접 연결의 자동 확인이 같은 글을 쓴다. */
export const PROBE_LIST_FAILED_MESSAGE = "모델 목록을 읽지 못했습니다. 연결 설정·인증을 확인해주세요.";

export const probeSourceLabel = (source: ProbeSource): string => source === "manual" ? "수동(버튼)" : "자동(렌더)";
const ms = (value: number | null) => value === null ? null : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}초`;

/** 결과 한 줄(색 없이 글자만). 목록 유무 → 시험 호출 → 오류 순서로 적는다. */
export function probeResultLabel(value: Pick<ProbeObservationValue, "listed" | "listMs" | "callMs" | "callBlocked" | "error">): { text: string; tone: "ok" | "bad" | "na" } {
  if (value.error && value.listed !== true) return { text: value.error, tone: "bad" };
  if (value.listed === false) return { text: `목록에 없음${value.listMs === null ? "" : ` ${ms(value.listMs)}`}`, tone: "bad" };
  if (value.listed === true) {
    const call = value.callMs !== null ? `시험 호출 ${ms(value.callMs)}` : value.callBlocked ? "시험 호출 차단" : null;
    return { text: `목록 있음${value.listMs === null ? "" : ` ${ms(value.listMs)}`}${call ? ` · ${call}` : ""}`, tone: "ok" };
  }
  return { text: value.error ?? "목록 미확인", tone: "na" };
}
