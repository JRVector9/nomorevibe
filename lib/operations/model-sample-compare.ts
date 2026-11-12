/**
 * 표본 비교(2026-11-12 최종 시안 흐름 2 「밀린 단계에 모델 붙이기」, 조각 3a) — 순수 규칙. DB·네트워크를 쓰지 않는다.
 *
 * 모델을 단계에 붙이기 전에, 그 작업의 실제 대기 일감에서 표본 N건을 골라 지금 모델과 후보 모델 둘 다로 돌리고 원문·두 결과·기존 품질 검사 통과 여부를
 * 나란히 본다. 부르는 것은 늘 그 작업의 기존 호출 경로와 용량 장부(배경 잡이 자기 lease 로 부른다)이고, 결과는 운영 데이터에 쓰지 않는다 — 비교 기록
 * (model_sample_comparisons, 0180)에만 남는다. 요청은 관리자 서버 동작이 감사 로그와 함께 남기고, 웹 요청 안에서 부르지 않는다.
 *
 * 지금 실행까지 붙인 작업은 한국어 소개(product-tagline-ko) 하나다. 나머지는 「지원 안 함」과 까닭을 그대로 보인다(지어내지 않는다).
 */

export const SAMPLE_COMPARE_LIMITS = Object.freeze({
  /** 기본 표본 수 */
  defaultSize: 20,
  /** 표본 수 상한 — 한 비교가 장부 칸을 오래 쥐지 않게(한 틱에 한 묶음씩 부른다) */
  maxSize: 40,
  /** 실제 잡이 다음 틱에 집어 갈 맨 앞 일감은 표본에서 뺀다(같은 제품을 같이 부르지 않게) */
  skipHead: 32,
  /** 한 번에 부르는 묶음 — 한국어 소개 원래 경로의 묶음 상한(8건 · 1,200자)과 같다 */
  batchItems: 8,
  batchChars: 1200,
  /** 같은 쪽(지금·후보)을 이만큼 미뤄도(용량·접수) 끝나지 않으면 실패로 닫는다 */
  maxDeferrals: 30,
});

export type SampleCompareTask = Readonly<{ task: string; label: string; supported: boolean; reason: string | null }>;
/** 시안이 말하는 텍스트 작업 넷 — 실행을 붙인 것만 supported */
export const SAMPLE_COMPARE_TASKS: readonly SampleCompareTask[] = Object.freeze([
  { task: "product-tagline-ko", label: "한국어 소개", supported: true, reason: null },
  { task: "product-translate", label: "공개 번역", supported: false,
    reason: "공개 번역은 언어·칸마다 묶음을 다시 만들고 쓰기 증명이 그 묶음에 붙어 있어, 결과를 운영 데이터에 쓰지 않고 돌리는 비교 실행을 아직 붙이지 않았습니다." },
  { task: "reason-translate", label: "사유 번역", supported: false,
    reason: "사유 번역의 호출은 심사 기록 한 건과 묶여 있어, 결과를 운영 데이터에 쓰지 않고 돌리는 비교 실행을 아직 붙이지 않았습니다." },
  { task: "product-search-profile", label: "키워드 짓기", supported: false,
    reason: "키워드 짓기의 호출은 제품 프로필 쓰기와 묶여 있어, 결과를 운영 데이터에 쓰지 않고 돌리는 비교 실행을 아직 붙이지 않았습니다." },
]);
export const sampleCompareTask = (task: string): SampleCompareTask | null => SAMPLE_COMPARE_TASKS.find(row => row.task === task) ?? null;
export const SAMPLE_COMPARE_SUPPORTED: readonly string[] = Object.freeze(SAMPLE_COMPARE_TASKS.filter(row => row.supported).map(row => row.task));

/** 표본 수 — 빈 값이면 기본, 1~상한으로 자른다. 숫자가 아니면 null */
export function sampleSize(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return SAMPLE_COMPARE_LIMITS.defaultSize;
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  return Math.min(SAMPLE_COMPARE_LIMITS.maxSize, Math.max(1, Number(text)));
}

/**
 * 대기 일감에서 표본 고르기 — 맨 앞(실제 잡이 곧 집어 갈 것)을 건너뛰고, 남은 줄 전체에 고르게 퍼지게 같은 간격으로 고른다.
 * 무작위를 쓰지 않아 같은 대기 줄이면 같은 표본이 나온다(기록과 시험이 같은 답). 남은 줄이 모자라면 맨 앞도 쓴다.
 */
export function pickSamples<T extends { productId: number }>(queue: readonly T[], size: number, skipHead: number = SAMPLE_COMPARE_LIMITS.skipHead): T[] {
  const unique = queue.filter((item, index) => queue.findIndex(other => other.productId === item.productId) === index);
  const want = Math.max(0, Math.min(size, unique.length));
  if (!want) return [];
  const rest = unique.length - skipHead >= want ? unique.slice(skipHead) : unique;
  const step = rest.length / want;
  return Array.from({ length: want }, (_, index) => rest[Math.min(rest.length - 1, Math.floor(index * step + step / 2))]);
}

// ── 기록 ───────────────────────────────────────────────────────────────────────────────────────────────

export type SampleSideResult = Readonly<{
  /** done = 불렀고 답을 받음(검사 결과 포함), failed = 불렀지만 결과가 없음(오류 코드), skipped = 부르지 않음(까닭) */
  state: "done" | "failed" | "skipped";
  output?: string | null;
  /** 기존 품질 검사(한국어 소개: checkKoreanTaglineOutput) 통과 */
  pass?: boolean;
  /** 검사 탈락·오류·건너뛴 까닭 코드 */
  reason?: string | null;
}>;
export type SampleItem = Readonly<{ productId: number; name: string; text: string; current: SampleSideResult | null; candidate: SampleSideResult | null }>;
export type SampleModelRef = Readonly<{ connectionId: string; model: string; name: string }>;
export type SampleStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type SampleComparison = Readonly<{
  id: number; task: string; status: SampleStatus; statusCode: string | null;
  candidate: SampleModelRef; current: SampleModelRef | null;
  size: number; items: readonly SampleItem[]; deferrals: number;
  requestedBy: string; requestedAt: string; startedAt: string | null; finishedAt: string | null;
}>;

export type SampleSide = "current" | "candidate";
/**
 * 다음에 부를 묶음 — 지금 모델 쪽부터, 아직 결과가 없는 표본을 앞에서부터 개수·글자 상한까지. 지금 모델이 없으면 후보만.
 * 둘 다 끝났으면 null.
 */
export function nextSampleBatch(record: Pick<SampleComparison, "items" | "current">, limits = SAMPLE_COMPARE_LIMITS): { side: SampleSide; items: SampleItem[] } | null {
  for (const side of ["current", "candidate"] as const) {
    if (side === "current" && !record.current) continue;
    const open = record.items.filter(item => item[side] === null);
    if (!open.length) continue;
    const batch: SampleItem[] = [];
    let chars = 0;
    for (const item of open) {
      if (batch.length && (batch.length >= limits.batchItems || chars + item.text.length > limits.batchChars)) break;
      batch.push(item); chars += item.text.length;
    }
    return { side, items: batch };
  }
  return null;
}

/** 묶음 결과를 기록에 옮긴다(불변). 결과가 없는 제품은 그대로 둔다 */
export function applySampleResults(items: readonly SampleItem[], side: SampleSide, results: ReadonlyMap<number, SampleSideResult>): SampleItem[] {
  return items.map(item => results.has(item.productId) ? { ...item, [side]: results.get(item.productId)! } : item);
}

/** 비교가 끝났는가 — 부를 쪽이 모두 결과(받음·실패·건너뜀)를 가졌다 */
export const sampleComplete = (record: Pick<SampleComparison, "items" | "current">) => nextSampleBatch(record) === null;

export type SampleTally = Readonly<{ total: number; current: { pass: number; done: number } | null; candidate: { pass: number; done: number } }>;
/** 시안 「검사 통과 · LG EXAONE 61/61 · Grok 60/61」 — 받은 결과 중 검사 통과 수 / 받은 수(실패·건너뜀은 분모에서 뺀다) */
export function sampleTally(record: Pick<SampleComparison, "items" | "current">): SampleTally {
  const count = (side: SampleSide) => {
    const done = record.items.filter(item => item[side]?.state === "done");
    return { pass: done.filter(item => item[side]!.pass).length, done: done.length };
  };
  return { total: record.items.length, current: record.current ? count("current") : null, candidate: count("candidate") };
}

/** 검사 탈락·오류 코드 → 쉬운 말(모르는 코드는 그대로) */
const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // 한국어 소개 검사(checkKoreanTaglineOutput)의 탈락 사유
  empty: "빈 답", multiline: "여러 줄", markup: "링크·서식", boilerplate: "모델의 말(머리말·거절)", too_long: "너무 긺", too_short: "너무 짧음",
  not_korean: "한국어 아님", foreign_script: "다른 문자", name_lost: "이름 빠짐", invented_number: "원문에 없는 숫자", invented_term: "원문에 없는 말",
  qualifier_lost: "꾸밈말 빠짐",
  timeout: "시간 초과", invalid_output: "출력 형식", rate_limited: "빈도 한도", network: "닿지 않음", model_unavailable: "서버에 모델 없음",
  already_done: "이미 처리됨(표본에서 빠짐)", input_changed: "원문이 바뀜", no_current_model: "지금 모델 없음", binding_unusable: "부를 수 없음",
});
export function sampleReasonText(code: string | null | undefined): string {
  if (!code) return "";
  const [head, rest] = code.split(":", 2);
  if (head === "rejected") return `검사 탈락: ${REASON_TEXT[rest] ?? rest}`;
  if (head === "unusable") return `부를 수 없음: ${rest}`;
  return REASON_TEXT[code] ?? code;
}

const STATUS_TEXT: Readonly<Record<SampleStatus, string>> = Object.freeze({ queued: "기다리는 중", running: "부르는 중", done: "끝남", failed: "실패", cancelled: "취소" });
export function sampleStatusText(record: Pick<SampleComparison, "status" | "statusCode" | "items" | "current">): string {
  if (record.status === "running" || record.status === "queued") {
    const total = record.items.length * (record.current ? 2 : 1);
    const done = record.items.reduce((sum, item) => sum + (item.current !== null && record.current ? 1 : 0) + (item.candidate !== null ? 1 : 0), 0);
    return `${STATUS_TEXT[record.status]} · ${done}/${total}`;
  }
  return record.statusCode && record.status === "failed" ? `${STATUS_TEXT.failed} · ${sampleReasonText(record.statusCode)}` : STATUS_TEXT[record.status];
}
