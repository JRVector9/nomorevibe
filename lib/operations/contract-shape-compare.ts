import { createHash } from "node:crypto";
import { GATEWAY_SERVING_CONTRACT_ROUTES, type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";

/**
 * abcllm 이름표 정리 3단계 전의 견줌(docs/plans/2026-11-21-abcllm-label-cleanup.md §7 3단계, 소유자 결정 D-6) — 순수 규칙과 실행 순서.
 *
 * 3단계는 경로마다 켜진 abcllm 계약을 새 모양(openai-chat-total-bound-v1, provider local-direct)으로 다시 저장한다. 새 모양의 wire 는 게이트웨이 전용 칸
 * context_strategy 를 보내지 않으므로(D-6) 엔진에 가는 바이트가 바뀐다 — 1차·2차·검색 키워드 짓기·키워드 검수·수집 소개 다섯 경로. 번역 4경로와 카테고리
 * 분류는 본문 바이트가 같고, 번역 4경로는 엄격 terminal 헤더(X-Abcllm-Strict-Terminal)만 더는 나가지 않는다(그래서 그 여섯은 확인만 하면 된다).
 * 이 도구는 경로·계약(API 주소 + 모델)마다 같은 실제 입력 N건을 지금 abcllm 계약의 wire 와 메모리 안에서만 바꾼 새 모양의 wire 로 한 번씩 보내고,
 * 상태·끝난 까닭·사용량·지연·경로 자신의 검사 통과·판정이나 글을 견준다.
 *
 * - 운영자의 측정이다: 용량 장부를 거치지 않고 엔진에 바로 보낸다. 그래서 호출을 묶는다 — 계약마다 표본 5건(10회, --max-per-contract), 모두 80회,
 *   한 번에 하나, 호출 사이 쉼(칸이 1 인 장비는 더 길게). 계약마다 첫 429·Retry-After·잔여량 0 헤더, 연속 두 번의 시간 초과·전송 오류·5xx(502·503·504)에서
 *   그 계약을 멈추고(까닭을 남긴다) 다음 계약으로 간다.
 * - 외부 API 계약(rateLimitBackoff 가 있거나 사설·tailnet 주소가 아님 — 예: EXAONE)과 지금 순위·묶음 구성원에 묶이지 않은 계약은 기본으로 부르지 않는다
 *   (--model 로 콕 집을 때만). 꺼진 순위·멈춘 잡·DR fence·DRAIN 은 실행하지 않는다.
 * - 쓰지 않는다: DB 에는 읽기만(표본 읽기는 READ ONLY 트랜잭션, 순위 읽기는 연결 키 채우기를 끈 범위), 계약·정책·장부·결과 표 어디에도 쓰지 않는다.
 *   새 모양 계약은 저장하지 않는다.
 * - --execute 없이는 엔진을 부르지 않는다(dry-run: 부를 계약(모델·호스트만)·제외와 까닭·표본 id·호출 수·wire 칸 차이만 보인다).
 * 이 파일은 DB·네트워크를 쓰지 않는다(실행 순서는 주입받은 deps 로만). 실제 읽기·보내기는 contract-shape-compare-run.ts, 경로별 wire·검사는
 * contract-shape-compare-routes.ts 에 있다.
 */
export type CompareRoute = GatewayServingRoute;
/** abcllm = 지금 저장된 계약 그대로 · total-bound = 전환 도구의 변환 함수로 메모리 안에서만 만든 새 모양 */
export type CompareVariant = "abcllm" | "total-bound";
export const COMPARE_VARIANTS: readonly CompareVariant[] = Object.freeze(["abcllm", "total-bound"]);

export const SHAPE_COMPARE_LIMITS = Object.freeze({
  defaultSamples: 5,
  maxSamples: 20,
  /** 한 번 실행에서 엔진에 보내는 채팅 호출의 상한(표본 × 계약 × 2) — 넘으면 실행하지 않는다(--model·--samples 로 줄인다) */
  maxCalls: 80,
  /** 계약마다 표본 수의 기본 상한(→ 계약마다 10회) — --max-per-contract 로 올린다(maxSamples 까지) */
  defaultMaxPerContract: 5,
  /** 호출 사이 쉼(한 번에 하나만 보낸다) · 칸이 1 인 장비(운영 호출과 같은 칸을 순서대로 쓴다)의 쉼 */
  delayMs: 750,
  singleSlotDelayMs: 2_000,
  /** 이만큼 잇달아 시간 초과·전송 오류·5xx(502·503·504)가 나면 그 계약을 멈춘다 */
  consecutiveFailureStop: 2,
  /** 글 경로: 두 쪽이 모두 검사를 통과하고 정규화한 글의 유사도(문자 2-gram Dice)가 이 이상이면 같은 답으로 센다 */
  textAgreeSimilarity: 0.8,
  /** 불일치 예의 글 길이 · 기록에 남기는 글 길이 · 계약마다 보이는 불일치 예 수 */
  exampleChars: 160,
  recordChars: 400,
  examplesPerContract: 3,
});

/** abcllm 계약의 wire 가 context_strategy 를 싣는 경로 — D-6 으로 바이트가 바뀌는 다섯 */
export const CONTEXT_STRATEGY_ROUTES: ReadonlySet<CompareRoute> = new Set(["crawl-agent-review", "second-review", "product-search-profile",
  "crawl-tagline", "product-search-verify"]);
/** abcllm 계약이 엄격 terminal 헤더를 보내는 번역 4경로 — 새 모양은 그 헤더가 없다(본문은 같다) */
export const STRICT_HEADER_ROUTES: ReadonlySet<CompareRoute> = new Set(["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"]);
/** 잡이 항목마다 검사기를 거는 경로(한국어 소개 checkKoreanTaglineOutput · 공개 번역 checkProductTranslation) — 일치는 두 쪽 모든 항목이 검사를 통과해야 한다 */
export const ITEM_CHECK_ROUTES: ReadonlySet<CompareRoute> = new Set(["product-tagline-ko", "product-translate"]);
/**
 * 기록에 싣지 않는 결과 글(검색어 번역 — 사람이 친 검색어의 번역이다). 기록의 items 에는 hash 와 길이만 두고, 견줌(유사도·같음)만 이 값으로 메모리 안에서 한다.
 * symbol 칸이라 JSON(--json·--out)에 나가지 않는다.
 */
export const PRIVATE_ITEMS: unique symbol = Symbol("shape-compare.private-items");
/** 판정을 견주는 경로(승인·거절·보류, 키워드 검수가 뺀 목록, 카테고리). 나머지는 글을 견준다 */
export const DECISION_ROUTES: ReadonlySet<CompareRoute> = new Set(["crawl-agent-review", "second-review", "product-search-verify", "crawl-publish-classify"]);
export const isCompareRoute = (value: string): value is CompareRoute => (GATEWAY_SERVING_CONTRACT_ROUTES as readonly string[]).includes(value);

// ── 인자 ───────────────────────────────────────────────────────────────────────────────────────────────

export type ShapeCompareArgs = Readonly<{ route: CompareRoute; model: string | null; samples: number;
  /** 계약마다 표본 수 상한(기본 5 → 계약마다 10회) */
  maxPerContract: number; execute: boolean; json: boolean; out: string | null }>;
const VALUE_OPTIONS = new Set(["route", "model", "samples", "max-per-contract", "out"]);
const FLAG_OPTIONS = new Set(["--execute", "--json"]);
/** --key=value 와 --execute·--json 만. 모르는·중복·빈 옵션, 모르는 경로, 범위 밖 표본 수는 거절한다(null — 사용법). */
export function parseShapeCompareArgs(argv: readonly string[]): ShapeCompareArgs | null {
  const values = new Map<string, string>(), flags = new Set<string>();
  for (const arg of argv) {
    if (FLAG_OPTIONS.has(arg)) { if (flags.has(arg)) return null; flags.add(arg); continue; }
    const match = /^--([a-z][a-z-]*)=([^\n]*)$/.exec(arg);
    if (!match || !VALUE_OPTIONS.has(match[1]) || values.has(match[1]) || !match[2]) return null;
    values.set(match[1], match[2]);
  }
  const route = values.get("route");
  if (!route || !isCompareRoute(route)) return null;
  const model = values.get("model") ?? null;
  if (model !== null && (model.length > 200 || model !== model.trim())) return null;
  const rawSamples = values.get("samples");
  if (rawSamples !== undefined && !/^\d{1,3}$/.test(rawSamples)) return null;
  const samples = rawSamples === undefined ? SHAPE_COMPARE_LIMITS.defaultSamples : Number(rawSamples);
  if (samples < 1 || samples > SHAPE_COMPARE_LIMITS.maxSamples) return null;
  const rawCap = values.get("max-per-contract");
  if (rawCap !== undefined && !/^\d{1,3}$/.test(rawCap)) return null;
  const maxPerContract = rawCap === undefined ? SHAPE_COMPARE_LIMITS.defaultMaxPerContract : Number(rawCap);
  if (maxPerContract < 1 || maxPerContract > SHAPE_COMPARE_LIMITS.maxSamples) return null;
  return Object.freeze({ route, model, samples, maxPerContract, execute: flags.has("--execute"), json: flags.has("--json"), out: values.get("out") ?? null });
}

// ── 계획 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 견줄 계약 하나의 보이는 모습 — 키·주소 전체는 담지 않는다(모델·엔진 이름·호스트만) */
export type CompareContractView = Readonly<{
  /** 장부 이름(계약 행의 model) — 경로 안에서 계약 하나를 가리킨다 */
  model: string;
  /** 엔진에 보내는 이름(engineModel, 없으면 model) */
  wireModel: string;
  /** 계약 끝점의 host:port(경로·인증 정보 없음) */
  host: string;
  /** OpenCode CLI 엔진 계약(deploymentRevision 이 CLI 엔진 revision) */
  cliEngine: boolean;
  /** 준비가 보내기 전에 엔진 tokenizer 를 부르는 쪽(2차 requestBudget·tokenizer 묶음) */
  tokenizer: readonly CompareVariant[];
  /** 지금 순위·묶음 구성원이 이 계약을 부른다(아니면 --model 로 콕 집었을 때만 들어온다) */
  bound: boolean;
  /** 외부 API(rateLimitBackoff 가 있거나 사설·tailnet 주소가 아님) — --model 로 콕 집었을 때만 들어온다 */
  external: boolean;
  /** 그 장비의 칸이 1(운영 호출과 같은 칸을 차례로 쓴다) — 쉼을 늘린다 */
  singleSlot: boolean;
  /** 이 계약의 호출 사이 쉼 */
  delayMs: number;
}>;
export type CompareContractRefusal = Readonly<{ model: string; host: string | null; reason: string; detail: string | null }>;
export type CompareSampleView = Readonly<{ id: string; label: string }>;
export type ShapeComparePlan = Readonly<{
  route: CompareRoute; model: string | null; samplesRequested: number;
  /** 계약마다 부르는 표본 수(표본 수와 --max-per-contract 중 작은 쪽) */
  perContractSamples: number;
  contracts: readonly CompareContractView[]; refusals: readonly CompareContractRefusal[]; samples: readonly CompareSampleView[];
  /** 엔진에 보내는 채팅 호출 수(많아야 — 계약 × 계약마다 표본 × 2) */
  chatCalls: number;
  /** 준비가 부르는 tokenizer 호출 수(많아야) — 채팅이 아니다 */
  tokenizerCalls: number;
  /** 실행을 막는 것: kill_switch:<까닭> · no_contracts · no_samples · call_cap_exceeded */
  blocked: string | null;
  notes: readonly string[];
}>;

export function planShapeCompare(input: { route: CompareRoute; model: string | null; samplesRequested: number; maxPerContract?: number;
  contracts: readonly CompareContractView[]; refusals: readonly CompareContractRefusal[]; samples: readonly CompareSampleView[]; killSwitch: string | null;
  notes?: readonly string[] }): ShapeComparePlan {
  const { route, contracts, samples } = input;
  const cap = input.maxPerContract ?? SHAPE_COMPARE_LIMITS.defaultMaxPerContract;
  const perContractSamples = Math.min(samples.length, cap);
  const chatCalls = contracts.length * perContractSamples * 2;
  const tokenizerCalls = contracts.reduce((count, contract) => count + contract.tokenizer.length * perContractSamples, 0);
  const blocked = input.killSwitch ? `kill_switch:${input.killSwitch}` : !contracts.length ? "no_contracts" : !samples.length ? "no_samples"
    : chatCalls > SHAPE_COMPARE_LIMITS.maxCalls ? "call_cap_exceeded" : null;
  const notes: string[] = [];
  notes.push(CONTEXT_STRATEGY_ROUTES.has(route)
    ? "D-6: 이 경로의 abcllm wire 는 context_strategy 를 싣는다 — 새 모양은 그 칸 하나만 빼고 보낸다(나머지 바이트는 같다)."
    : "이 경로의 본문 바이트는 두 모양이 같다(context_strategy 없음) — 확인용으로만 보낸다.");
  if (STRICT_HEADER_ROUTES.has(route)) notes.push("번역 경로: abcllm 계약은 X-Abcllm-Strict-Terminal 헤더를 보내고 새 모양은 보내지 않는다(본문은 같다, 계획 0-12).");
  const wanted = Math.min(input.samplesRequested, cap);
  if (input.samplesRequested > cap) notes.push(`계약마다 표본 ${cap}건까지만 부른다(--max-per-contract=${cap}, 계약마다 ${cap * 2}회) — --samples=${input.samplesRequested} 중 앞 ${cap}건.`);
  if (samples.length < wanted) notes.push(`표본이 모자란다: ${wanted}건을 원했고 ${samples.length}건을 찾았다.`);
  if (blocked === "call_cap_exceeded") {
    const most = contracts.length ? Math.floor(SHAPE_COMPARE_LIMITS.maxCalls / (2 * contracts.length)) : 0;
    notes.push(`호출 상한 ${SHAPE_COMPARE_LIMITS.maxCalls}회를 넘는다(${chatCalls}회) — --model=<장부 이름>으로 계약 하나만 고르거나 --max-per-contract=${Math.max(1, most)} 이하로 줄이세요.`);
  }
  const unbound = contracts.filter(contract => !contract.bound), external = contracts.filter(contract => contract.external);
  if (unbound.length) notes.push(`순위·묶음 구성원에 묶이지 않은 계약을 --model 로 콕 집어 부른다: ${unbound.map(contract => contract.model).join(", ")}.`);
  if (external.length) notes.push(`외부 API 계약을 --model 로 콕 집어 부른다(운영 잡과 같은 한도를 쓴다): ${external.map(contract => contract.model).join(", ")}.`);
  const single = contracts.filter(contract => contract.singleSlot);
  if (single.length) notes.push(`칸이 1 인 장비의 계약(${single.map(contract => contract.model).join(", ")}) — 도구의 호출만큼 운영 호출이 기다린다. 호출 사이 ${SHAPE_COMPARE_LIMITS.singleSlotDelayMs / 1000}초 쉰다.`);
  notes.push(...(input.notes ?? []));
  if (contracts.some(contract => contract.cliEngine)) notes.push("CLI 엔진(OpenCode) 계약이 있다 — 그 엔진이 닿는 호스트에서만 의미가 있다(계획 0-2).");
  return Object.freeze({ route, model: input.model, samplesRequested: input.samplesRequested, perContractSamples, contracts: Object.freeze([...contracts]),
    refusals: Object.freeze([...input.refusals]), samples: Object.freeze([...samples]), chatCalls, tokenizerCalls, blocked, notes: Object.freeze(notes) });
}

// ── 호출 기록 ─────────────────────────────────────────────────────────────────────────────────────────

export type CallUsage = Readonly<{ input: number | null; output: number | null; total: number | null; reasoning: number | null }>;
export type CallOutcome = Readonly<{
  /** 보내지 않은 까닭(prepare_refused:<까닭> — 실제 준비 함수가 닫음 · wire_mismatch — 만든 바이트가 실제 준비의 wireHash 와 다름 · bearer:<까닭>) */
  refused: string | null;
  /** HTTP 상태(보내지 못했으면 null) · 전송 오류(timeout · network) · 보낸 뒤 본문까지 걸린 시간 */
  status: number | null; transportError: string | null; latencyMs: number | null;
  finishReason: string | null; usage: CallUsage | null;
  /** 그 경로 자신의 terminal 검사·요청 상한·출력 파서(와 검사기)가 결과를 받았는가 */
  accepted: boolean;
  failure: string | null;
  /** 판정 경로의 판정(심사: approve·reject·needs_review, 키워드 검수: 뺀 목록 JSON, 분류: 카테고리 목록) */
  decision: string | null;
  /** 결과 글(항목마다, 잘라서 — 검색어 번역은 hash 와 길이만, 원문은 PRIVATE_ITEMS) */
  items: readonly string[];
  /** 항목별 검사(한국어 소개 checkKoreanTaglineOutput · 공개 번역 checkProductTranslation) 통과 수와 항목마다의 통과 */
  itemChecks: Readonly<{ passed: number; total: number }> | null;
  itemPassed: readonly boolean[] | null;
  /** 이 응답으로 그 계약을 멈춰야 하는 까닭(rate_limited: 429 · retry_after: Retry-After 헤더 · quota_exhausted: 잔여량 0 헤더) */
  stop: string | null;
  /** 기록에 싣지 않는 견줌용 글(검색어 번역) */
  readonly [PRIVATE_ITEMS]?: readonly string[];
  wireHash: string | null; wireBytes: number | null;
  /** wire 의 맨 위 칸마다 값의 짧은 hash — 두 모양의 칸 차이를 바이트 없이 견준다(wireFieldDigest) */
  wireFields: Readonly<Record<string, string>> | null;
  /** Content-Type·Authorization 밖에 붙인 헤더 이름 */
  headers: readonly string[];
}>;
export type CallRecord = CallOutcome & Readonly<{ contract: string; sample: string; variant: CompareVariant; order: 1 | 2 }>;

export const truncateText = (text: string, chars: number): string => {
  const points = Array.from(text);
  return points.length <= chars ? text : `${points.slice(0, chars).join("")}…`;
};
/** wire 의 맨 위 칸 → 값의 sha256 앞 12자(칸 차이 견주기용 — 프롬프트·근거 바이트를 기록에 싣지 않는다) */
export function wireFieldDigest(wire: string): Readonly<Record<string, string>> | null {
  let body: unknown;
  try { body = JSON.parse(wire); } catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return Object.freeze(Object.fromEntries(Object.entries(body as Record<string, unknown>)
    .map(([key, value]) => [key, createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)])));
}
/** 두 wire 의 맨 위 칸 중 한쪽에만 있거나 값이 다른 칸(이름 순) */
export function wireFieldDiff(a: Readonly<Record<string, string>> | null, b: Readonly<Record<string, string>> | null): string[] | null {
  if (!a || !b) return null;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]).sort();
}
/** 헤더 이름 차이(abcllm → 새 모양): -빠진 헤더 · +더한 헤더 */
export const headerNameDiff = (a: readonly string[], b: readonly string[]): string[] =>
  [...a.filter(name => !b.includes(name)).map(name => `-${name}`), ...b.filter(name => !a.includes(name)).map(name => `+${name}`)].sort();

// ── 견줌 ───────────────────────────────────────────────────────────────────────────────────────────────

export const normalizeOutputText = (text: string): string => text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
/** 정규화한 두 글의 문자 2-gram Dice 계수(0~1). 같으면 1, 한쪽이 두 글자 미만이고 다르면 0 */
export function textSimilarity(left: string, right: string): number {
  const a = Array.from(normalizeOutputText(left)), b = Array.from(normalizeOutputText(right));
  if (a.join("") === b.join("")) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (chars: string[]) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < chars.length - 1; index++) {
      const gram = chars[index] + chars[index + 1];
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const ga = grams(a), gb = grams(b);
  let overlap = 0;
  for (const [gram, count] of ga) overlap += Math.min(count, gb.get(gram) ?? 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}
/** 항목별 유사도의 평균 — 항목 수가 다르면 빠진 항목은 0 으로 센다 */
export function itemsSimilarity(a: readonly string[], b: readonly string[]): number {
  const count = Math.max(a.length, b.length);
  if (!count) return 1;
  let sum = 0;
  for (let index = 0; index < count; index++) sum += index < a.length && index < b.length ? textSimilarity(a[index], b[index]) : 0;
  return sum / count;
}

export type PairComparison = Readonly<{
  contract: string; sample: string; mode: "decision" | "text";
  bothSent: boolean; bothAccepted: boolean; sameAcceptance: boolean;
  /** 항목 검사 경로: 두 쪽 모든 항목이 검사를 통과했는가(그 밖은 null) */
  allItemsPassed: boolean | null;
  /** 판정 경로: 두 쪽이 모두 받혔을 때 판정이 같은가 */
  sameDecision: boolean | null;
  /** 정규화한 글이 항목마다 같은가 · 항목 평균 유사도(두 쪽이 모두 받혔을 때) */
  exactSame: boolean | null; similarity: number | null;
  /** 일치: 판정 경로는 같은 판정, 글 경로는 둘 다 통과 + 유사도 ≥ textAgreeSimilarity(항목 검사 경로는 두 쪽 모든 항목이 검사도 통과) */
  agree: boolean;
  /** 두 wire 의 맨 위 칸 차이 · 헤더 차이(-빠짐 +더함, abcllm → 새 모양) */
  wireDiff: readonly string[] | null; headerDiff: readonly string[];
}>;
/** 견줌에 쓰는 글 — 기록에 싣지 않은 원문(PRIVATE_ITEMS)이 있으면 그것 */
const comparableItems = (record: CallOutcome): readonly string[] => record[PRIVATE_ITEMS] ?? record.items;
export function comparePair(route: CompareRoute, a: CallRecord, b: CallRecord): PairComparison {
  if (a.variant !== "abcllm" || b.variant !== "total-bound" || a.contract !== b.contract || a.sample !== b.sample) throw new Error("shape_compare_pair_mismatch");
  const mode = DECISION_ROUTES.has(route) ? "decision" as const : "text" as const;
  const bothSent = a.refused === null && b.refused === null && a.status !== null && b.status !== null;
  const bothAccepted = a.accepted && b.accepted;
  const left = comparableItems(a), right = comparableItems(b);
  const sameDecision = mode === "decision" && bothAccepted ? a.decision === b.decision : null;
  const exactSame = bothAccepted ? left.length === right.length && left.every((item, index) => normalizeOutputText(item) === normalizeOutputText(right[index])) : null;
  const similarity = bothAccepted ? itemsSimilarity(left, right) : null;
  const passedAll = (record: CallRecord) => !!record.itemPassed && record.itemPassed.length > 0 && record.itemPassed.every(Boolean);
  const allItemsPassed = ITEM_CHECK_ROUTES.has(route) ? bothAccepted && passedAll(a) && passedAll(b) : null;
  const agree = mode === "decision" ? sameDecision === true
    : bothAccepted && allItemsPassed !== false && (similarity ?? 0) >= SHAPE_COMPARE_LIMITS.textAgreeSimilarity;
  return Object.freeze({ contract: a.contract, sample: a.sample, mode, bothSent, bothAccepted, sameAcceptance: a.accepted === b.accepted, allItemsPassed,
    sameDecision, exactSame, similarity, agree, wireDiff: wireFieldDiff(a.wireFields, b.wireFields), headerDiff: Object.freeze(headerNameDiff(a.headers, b.headers)) });
}

/** 기록에서 (계약, 표본) 짝을 만든다 — 두 쪽이 다 있는 것만 */
export function pairRecords(route: CompareRoute, records: readonly CallRecord[]): PairComparison[] {
  const pairs: PairComparison[] = [];
  for (const a of records) {
    if (a.variant !== "abcllm") continue;
    const b = records.find(other => other.variant === "total-bound" && other.contract === a.contract && other.sample === a.sample);
    if (b) pairs.push(comparePair(route, a, b));
  }
  return pairs;
}

// ── 요약 ───────────────────────────────────────────────────────────────────────────────────────────────

export type VariantStats = Readonly<{
  calls: number; sent: number; refused: Readonly<Record<string, number>>; non200: number; transportErrors: number; accepted: number;
  failures: Readonly<Record<string, number>>; finishReasons: Readonly<Record<string, number>>;
  latencyMedianMs: number | null; latencyMeanMs: number | null;
  usageMean: Readonly<{ input: number | null; output: number | null; total: number | null; reasoning: number | null }>;
  itemChecks: Readonly<{ passed: number; total: number }> | null;
}>;
export type DisagreementExample = Readonly<{ sample: string; abcllm: string; totalBound: string; similarity: number | null }>;
export type ContractSummary = Readonly<{
  contract: string; host: string | null; wireModel: string | null;
  pairs: number; bothSent: number; bothAccepted: number; agree: number; agreementRate: number | null;
  exactSame: number; meanSimilarity: number | null;
  variants: Readonly<Record<CompareVariant, VariantStats>>;
  /** 새 모양 − abcllm(중앙 지연, 평균 출력·전체 토큰) — 한쪽이라도 없으면 null */
  deltas: Readonly<{ latencyMedianMs: number | null; outputTokensMean: number | null; totalTokensMean: number | null }>;
  /** wire 칸 차이 → 그 짝 수(예: context_strategy: 5) */
  wireDiffs: Readonly<Record<string, number>>;
  examples: readonly DisagreementExample[];
  /** 이 계약을 도중에 멈췄으면 그 까닭 */
  stopped: StopRecord | null;
}>;
export type ShapeCompareSummary = Readonly<{ contracts: readonly ContractSummary[]; overall: Readonly<{ pairs: number; agree: number; agreementRate: number | null;
  calls: number; sent: number; accepted: Readonly<Record<CompareVariant, number>>; stopped: number }> }>;
/** 계약 하나를 도중에 멈춘 기록 — 까닭(rate_limited · retry_after · quota_exhausted · consecutive_failures), 그때까지 부른 수, 보내지 않은 수 */
export type StopRecord = Readonly<{ contract: string; reason: string; afterCalls: number; skippedCalls: number }>;

const count = (values: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
};
const mean = (values: readonly number[]): number | null => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null;
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
const delta = (next: number | null, base: number | null): number | null => next === null || base === null ? null : Math.round((next - base) * 10) / 10;
const usageValues = (records: readonly CallRecord[], key: keyof CallUsage) =>
  records.flatMap(record => typeof record.usage?.[key] === "number" ? [record.usage[key] as number] : []);

function variantStats(records: readonly CallRecord[]): VariantStats {
  const sent = records.filter(record => record.refused === null && (record.status !== null || record.transportError !== null));
  const checks = records.filter(record => record.itemChecks);
  return Object.freeze({
    calls: records.length, sent: sent.length,
    refused: Object.freeze(count(records.flatMap(record => record.refused ? [record.refused] : []))),
    non200: records.filter(record => record.status !== null && record.status !== 200).length,
    transportErrors: records.filter(record => record.transportError !== null).length,
    accepted: records.filter(record => record.accepted).length,
    failures: Object.freeze(count(records.flatMap(record => !record.accepted && record.refused === null && record.failure ? [record.failure] : []))),
    finishReasons: Object.freeze(count(records.flatMap(record => record.finishReason ? [record.finishReason] : []))),
    latencyMedianMs: median(sent.flatMap(record => record.latencyMs === null ? [] : [record.latencyMs])),
    latencyMeanMs: mean(sent.flatMap(record => record.latencyMs === null ? [] : [record.latencyMs])),
    usageMean: Object.freeze({ input: mean(usageValues(records, "input")), output: mean(usageValues(records, "output")),
      total: mean(usageValues(records, "total")), reasoning: mean(usageValues(records, "reasoning")) }),
    itemChecks: checks.length ? Object.freeze({ passed: checks.reduce((sum, record) => sum + record.itemChecks!.passed, 0),
      total: checks.reduce((sum, record) => sum + record.itemChecks!.total, 0) }) : null,
  });
}
/** 불일치 예에 보일 한 줄 — 판정이 있으면 판정과 첫 글, 아니면 글 목록, 받지 못했으면 그 까닭 */
function exampleText(record: CallRecord): string {
  const text = record.refused ? `보내지 않음(${record.refused})` : !record.accepted ? `실패(${record.failure ?? "unknown"})`
    : record.decision !== null ? `${record.decision}${record.items[0] ? ` · ${record.items[0]}` : ""}` : record.items.join(" / ");
  return truncateText(text, SHAPE_COMPARE_LIMITS.exampleChars);
}

export function summarizeShapeCompare(route: CompareRoute, contracts: readonly CompareContractView[], records: readonly CallRecord[],
  stops: readonly StopRecord[] = []): ShapeCompareSummary {
  const pairs = pairRecords(route, records);
  const names = [...new Set([...contracts.map(contract => contract.model), ...records.map(record => record.contract)])];
  const summaries = names.map((name): ContractSummary => {
    const view = contracts.find(contract => contract.model === name) ?? null;
    const mine = records.filter(record => record.contract === name), matched = pairs.filter(pair => pair.contract === name);
    const variants = Object.freeze({ abcllm: variantStats(mine.filter(record => record.variant === "abcllm")),
      "total-bound": variantStats(mine.filter(record => record.variant === "total-bound")) });
    const similarities = matched.flatMap(pair => pair.similarity === null ? [] : [pair.similarity]);
    const examples = matched.filter(pair => !pair.agree).slice(0, SHAPE_COMPARE_LIMITS.examplesPerContract).map(pair => {
      const a = mine.find(record => record.variant === "abcllm" && record.sample === pair.sample)!;
      const b = mine.find(record => record.variant === "total-bound" && record.sample === pair.sample)!;
      return Object.freeze({ sample: pair.sample, abcllm: exampleText(a), totalBound: exampleText(b),
        similarity: pair.similarity === null ? null : Math.round(pair.similarity * 100) / 100 });
    });
    const agree = matched.filter(pair => pair.agree).length;
    return Object.freeze({ contract: name, host: view?.host ?? null, wireModel: view?.wireModel ?? null,
      pairs: matched.length, bothSent: matched.filter(pair => pair.bothSent).length, bothAccepted: matched.filter(pair => pair.bothAccepted).length,
      agree, agreementRate: matched.length ? Math.round(agree / matched.length * 1000) / 1000 : null,
      exactSame: matched.filter(pair => pair.exactSame === true).length,
      meanSimilarity: similarities.length ? Math.round(similarities.reduce((sum, value) => sum + value, 0) / similarities.length * 1000) / 1000 : null,
      variants,
      deltas: Object.freeze({ latencyMedianMs: delta(variants["total-bound"].latencyMedianMs, variants.abcllm.latencyMedianMs),
        outputTokensMean: delta(variants["total-bound"].usageMean.output, variants.abcllm.usageMean.output),
        totalTokensMean: delta(variants["total-bound"].usageMean.total, variants.abcllm.usageMean.total) }),
      wireDiffs: Object.freeze(count(matched.flatMap(pair => pair.wireDiff === null ? ["(알 수 없음)"]
        : [...(pair.wireDiff.length ? pair.wireDiff : ["(같음)"]), ...pair.headerDiff.map(name => `header:${name}`)]))),
      examples: Object.freeze(examples), stopped: stops.find(stop => stop.contract === name) ?? null });
  });
  const agree = pairs.filter(pair => pair.agree).length;
  return Object.freeze({ contracts: Object.freeze(summaries), overall: Object.freeze({ pairs: pairs.length, agree,
    agreementRate: pairs.length ? Math.round(agree / pairs.length * 1000) / 1000 : null, calls: records.length,
    sent: records.filter(record => record.refused === null && (record.status !== null || record.transportError !== null)).length,
    accepted: Object.freeze({ abcllm: records.filter(record => record.variant === "abcllm" && record.accepted).length,
      "total-bound": records.filter(record => record.variant === "total-bound" && record.accepted).length }), stopped: stops.length }) });
}

// ── 실행 순서 ─────────────────────────────────────────────────────────────────────────────────────────

/** dry-run 미리 보기 한 줄 — 첫 표본으로 두 모양의 wire 를 만들어(네트워크 없이) 실제 준비 함수로 확인한 결과와 칸 차이 */
export type PreviewRow = Readonly<{ contract: string; sample: string;
  /** ok(두 모양 모두 실제 준비의 wireHash 와 같은 바이트) · tokenizer_at_execute(준비가 tokenizer 를 불러 실행 때만 확인) · 그 밖은 거절 까닭 */
  check: string; wireDiff: readonly string[] | null; headerDiff: readonly string[] }>;
export type ShapeCompareLoad = Readonly<{ contracts: readonly CompareContractView[]; refusals: readonly CompareContractRefusal[];
  samples: readonly CompareSampleView[]; killSwitch: string | null;
  /** 읽기가 남긴 알림(예: 운영 워커의 429 쉼 상태를 읽을 수 없음) */
  notes?: readonly string[] }>;
/** 실제 읽기·보내기(contract-shape-compare-run.ts) — 계약·표본은 id(장부 이름·표본 id)로만 가리킨다(키·입력 원문은 deps 안에 있다) */
export type ShapeCompareDeps = Readonly<{
  load(args: ShapeCompareArgs): Promise<ShapeCompareLoad>;
  preview(contract: string, sample: string): Promise<PreviewRow>;
  call(contract: string, sample: string, variant: CompareVariant): Promise<CallOutcome>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}>;
export type ShapeCompareReport = Readonly<{
  version: 1; route: CompareRoute; model: string | null; execute: boolean; startedAt: string; finishedAt: string;
  plan: ShapeComparePlan; previews: readonly PreviewRow[]; records: readonly CallRecord[]; pairs: readonly PairComparison[];
  stops: readonly StopRecord[];
  summary: ShapeCompareSummary | null;
}>;
/** 실행 중 기록을 바로 남기는 갈고리(스크립트의 --out 이 호출마다 JSONL 로 덧붙인다 — 도중에 끊겨도 잰 것이 남는다) */
export type ShapeCompareHooks = Readonly<{
  onPlan?(plan: ShapeComparePlan): Promise<void> | void;
  onRecord?(record: CallRecord): Promise<void> | void;
  onStop?(stop: StopRecord): Promise<void> | void;
}>;
const ENGINE_UNAVAILABLE = new Set([502, 503, 504]);

/**
 * 계획 → (dry-run 이면) 계약마다 첫 표본의 미리 보기만 · (--execute 이고 막힌 것이 없으면) 계약마다 표본 perContractSamples 건 × 두 모양을 한 번씩,
 * 한 번에 하나, 호출 사이 쉼(그 계약의 delayMs).
 * 짝의 순서는 표본마다 번갈아(짝수 표본은 abcllm 먼저, 홀수는 새 모양 먼저) — 엔진 prefix cache 가 늘 둘째 호출만 빠르게 보이지 않게 한다.
 * 멈춤: 응답이 stop 을 주거나(429·Retry-After·잔여량 0) 시간 초과·전송 오류·5xx(502·503·504)가 consecutiveFailureStop 번 이어지면 그 계약의 남은 호출을
 * 보내지 않고 까닭을 남긴 채 다음 계약으로 간다. 호출 수는 계획의 chatCalls(≤ maxCalls)를 넘지 않는다(넘으면 던진다).
 */
export async function runShapeCompare(args: ShapeCompareArgs, deps: ShapeCompareDeps, hooks: ShapeCompareHooks = {}): Promise<ShapeCompareReport> {
  const startedAt = deps.now();
  const loaded = await deps.load(args);
  const plan = planShapeCompare({ route: args.route, model: args.model, samplesRequested: args.samples, maxPerContract: args.maxPerContract,
    contracts: loaded.contracts, refusals: loaded.refusals, samples: loaded.samples, killSwitch: loaded.killSwitch, notes: loaded.notes });
  await hooks.onPlan?.(plan);
  const previews: PreviewRow[] = [], records: CallRecord[] = [], stops: StopRecord[] = [];
  const firstSample = plan.samples[0];
  if (!args.execute || plan.blocked) {
    if (firstSample && (!plan.blocked || plan.blocked === "call_cap_exceeded"))
      for (const contract of plan.contracts) previews.push(await deps.preview(contract.model, firstSample.id));
  } else {
    let sent = 0;
    const samples = plan.samples.slice(0, plan.perContractSamples);
    for (const contract of plan.contracts) {
      let made = 0, failures = 0, stop: string | null = null;
      calls: for (const [index, sample] of samples.entries()) {
        const order: readonly CompareVariant[] = index % 2 === 0 ? ["abcllm", "total-bound"] : ["total-bound", "abcllm"];
        for (const [position, variant] of order.entries()) {
          if (sent >= plan.chatCalls || sent >= SHAPE_COMPARE_LIMITS.maxCalls) throw new Error("shape_compare_call_cap");
          if (sent > 0) await deps.sleep(Math.max(SHAPE_COMPARE_LIMITS.delayMs, contract.delayMs));
          sent++; made++;
          const outcome = await deps.call(contract.model, sample.id, variant);
          const record: CallRecord = Object.freeze({ ...outcome, contract: contract.model, sample: sample.id, variant, order: position === 0 ? 1 as const : 2 as const });
          records.push(record);
          await hooks.onRecord?.(record);
          const failed = outcome.transportError !== null || outcome.status !== null && ENGINE_UNAVAILABLE.has(outcome.status);
          if (failed) failures++; else if (outcome.refused === null) failures = 0;
          stop = outcome.stop ?? (failures >= SHAPE_COMPARE_LIMITS.consecutiveFailureStop ? "consecutive_failures" : null);
          if (stop) break calls;
        }
      }
      if (stop) {
        const record: StopRecord = Object.freeze({ contract: contract.model, reason: stop, afterCalls: made, skippedCalls: samples.length * 2 - made });
        stops.push(record);
        await hooks.onStop?.(record);
      }
    }
  }
  const executed = args.execute && !plan.blocked;
  return Object.freeze({ version: 1 as const, route: args.route, model: args.model, execute: executed, startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(), plan, previews: Object.freeze(previews), records: Object.freeze(records),
    pairs: Object.freeze(pairRecords(args.route, records)), stops: Object.freeze(stops),
    summary: executed ? summarizeShapeCompare(args.route, plan.contracts, records, stops) : null });
}

// ── 한국어 줄 ─────────────────────────────────────────────────────────────────────────────────────────

const BLOCKED_TEXT: Readonly<Record<string, string>> = {
  no_contracts: "견줄 abcllm 계약이 없다(켜진 엔진 직접 abcllm 계약이 없거나 모두 제외 — 순위 밖·외부 API 는 --model 로 콕 집어야 부른다).",
  no_samples: "표본으로 쓸 최근 입력을 찾지 못했다.",
  call_cap_exceeded: `호출 상한(${SHAPE_COMPARE_LIMITS.maxCalls}회)을 넘는다.`,
};
const blockedText = (code: string) => code.startsWith("kill_switch:") ? `경로가 꺼져 있거나 멈춰 있다(${code.slice("kill_switch:".length)}) — 잡이 부르지 않는 때는 견주지 않는다.`
  : BLOCKED_TEXT[code] ?? code;
const percent = (rate: number | null) => rate === null ? "—" : `${Math.round(rate * 100)}%`;
/** 1초 미만은 ms, 그 이상은 초(소수 한 자리) */
const duration = (ms: number) => Math.abs(ms) < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}초`;
const seconds = (ms: number | null) => ms === null ? "—" : duration(ms);
const signed = (value: number | null, unit = "") => value === null ? "—" : `${value > 0 ? "+" : ""}${value}${unit}`;
const signedSeconds = (ms: number | null) => ms === null ? "—" : `${ms > 0 ? "+" : ""}${duration(ms)}`;
const listOf = (counts: Readonly<Record<string, number>>) => Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ") || "없음";

export function shapeComparePlanLines(report: Pick<ShapeCompareReport, "plan" | "previews" | "execute">): string[] {
  const plan = report.plan;
  const lines = [`계약 모양 견줌 · ${plan.route}${plan.model ? ` · ${plan.model}` : ""} · 표본 ${plan.samples.length}건(계약마다 ${plan.perContractSamples}건) · 계약 ${plan.contracts.length}개`
    + ` · 채팅 호출 많아야 ${plan.chatCalls}회${plan.tokenizerCalls ? ` + tokenizer 많아야 ${plan.tokenizerCalls}회` : ""}`
    + ` · ${report.execute ? "실행함" : "dry-run(부르지 않음)"} · 용량 장부를 거치지 않는 운영자 측정`];
  if (plan.blocked) lines.push(`실행 불가: ${blockedText(plan.blocked)}`);
  for (const contract of plan.contracts) lines.push(`계약 ${contract.model}${contract.wireModel !== contract.model ? ` → ${contract.wireModel}` : ""} @ ${contract.host}`
    + `${contract.cliEngine ? " (CLI 엔진)" : ""}${contract.tokenizer.length ? ` (tokenizer: ${contract.tokenizer.join("·")})` : ""}`
    + `${contract.bound ? "" : " (순위 밖 — 콕 집음)"}${contract.external ? " (외부 API — 콕 집음)" : ""}${contract.singleSlot ? ` (칸 1 — 쉼 ${contract.delayMs / 1000}초)` : ""}`);
  for (const refusal of plan.refusals) lines.push(`제외 ${refusal.model}${refusal.host ? ` @ ${refusal.host}` : ""}: ${refusal.reason}${refusal.detail ? ` (${refusal.detail})` : ""}`);
  if (plan.samples.length) lines.push(`표본: ${plan.samples.map(sample => sample.id).join(", ")}`);
  for (const preview of report.previews) lines.push(`미리 보기 ${preview.contract} · ${preview.sample}: ${preview.check}`
    + ` · wire 칸 차이 ${preview.wireDiff === null ? "알 수 없음" : preview.wireDiff.length ? preview.wireDiff.join(",") : "없음"}`
    + `${preview.headerDiff.length ? ` · 헤더 ${preview.headerDiff.join(",")}` : ""}`);
  for (const note of plan.notes) lines.push(`참고 ${note}`);
  return lines;
}
const STOP_TEXT: Readonly<Record<string, string>> = { rate_limited: "429(빈도 한도)", retry_after: "Retry-After 헤더", quota_exhausted: "잔여량 0 헤더",
  consecutive_failures: `시간 초과·전송 오류·5xx ${SHAPE_COMPARE_LIMITS.consecutiveFailureStop}번 연속` };

export function shapeCompareSummaryLines(report: ShapeCompareReport): string[] {
  const lines = shapeComparePlanLines(report);
  const summary = report.summary;
  if (!summary) return lines;
  lines.push(`결과: 짝 ${summary.overall.pairs} · 일치 ${summary.overall.agree}(${percent(summary.overall.agreementRate)}) · 보낸 호출 ${summary.overall.sent}/${summary.overall.calls}`
    + ` · 검사 통과 abcllm ${summary.overall.accepted.abcllm} · 새 모양 ${summary.overall.accepted["total-bound"]}`
    + `${summary.overall.stopped ? ` · 도중에 멈춘 계약 ${summary.overall.stopped}` : ""}`);
  const mode = DECISION_ROUTES.has(report.route) ? "같은 판정" : `둘 다 통과${ITEM_CHECK_ROUTES.has(report.route) ? "(모든 항목 검사 포함)" : ""} + 유사도 ≥ ${SHAPE_COMPARE_LIMITS.textAgreeSimilarity}`;
  for (const contract of summary.contracts) {
    const a = contract.variants.abcllm, b = contract.variants["total-bound"];
    lines.push(`- ${contract.contract}${contract.host ? ` @ ${contract.host}` : ""}: 일치 ${contract.agree}/${contract.pairs}(${percent(contract.agreementRate)}, ${mode})`
      + `${DECISION_ROUTES.has(report.route) ? "" : ` · 글 같음 ${contract.exactSame} · 평균 유사도 ${contract.meanSimilarity ?? "—"}`}`);
    lines.push(`  통과 abcllm ${a.accepted}/${a.calls} · 새 모양 ${b.accepted}/${b.calls} · 실패 abcllm [${listOf(a.failures)}] · 새 모양 [${listOf(b.failures)}]`
      + `${Object.keys(a.refused).length || Object.keys(b.refused).length ? ` · 보내지 않음 abcllm [${listOf(a.refused)}] · 새 모양 [${listOf(b.refused)}]` : ""}`);
    lines.push(`  지연 중앙 abcllm ${seconds(a.latencyMedianMs)} · 새 모양 ${seconds(b.latencyMedianMs)} (${signedSeconds(contract.deltas.latencyMedianMs)})`
      + ` · 출력 토큰 평균 ${a.usageMean.output ?? "—"} → ${b.usageMean.output ?? "—"} (${signed(contract.deltas.outputTokensMean)})`
      + ` · 전체 토큰 평균 ${a.usageMean.total ?? "—"} → ${b.usageMean.total ?? "—"} (${signed(contract.deltas.totalTokensMean)})`
      + ` · 끝난 까닭 abcllm [${listOf(a.finishReasons)}] · 새 모양 [${listOf(b.finishReasons)}]`);
    if (a.itemChecks || b.itemChecks) lines.push(`  항목 검사 통과 abcllm ${a.itemChecks ? `${a.itemChecks.passed}/${a.itemChecks.total}` : "—"}`
      + ` · 새 모양 ${b.itemChecks ? `${b.itemChecks.passed}/${b.itemChecks.total}` : "—"}`);
    lines.push(`  wire 칸 차이: ${listOf(contract.wireDiffs)}`);
    if (contract.stopped) lines.push(`  멈춤: ${STOP_TEXT[contract.stopped.reason] ?? contract.stopped.reason} — ${contract.stopped.afterCalls}회 부른 뒤`
      + ` 남은 ${contract.stopped.skippedCalls}회는 보내지 않았다`);
    for (const example of contract.examples) lines.push(`  불일치 ${example.sample}${example.similarity === null ? "" : ` (유사도 ${example.similarity})`}:`
      + ` abcllm「${example.abcllm}」 새 모양「${example.totalBound}」`);
  }
  return lines;
}
