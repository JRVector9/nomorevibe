import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { fetch as undiciFetch } from "undici";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, crawlTaglines, jobs, modelCapacityControl, modelCapacityDevices,
  productKoreanTaglines, products, productSearchProfiles, productTranslations, searchQueries, secondReviews, textTranslations } from "@/lib/db/schema";
import { MAX_REVIEW_INPUT_BYTES } from "@/lib/crawl/agent-review-contract";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { CATEGORY_BATCH_SIZE } from "@/lib/crawl/classify";
import { packBatch, reasonTranslateKnobs } from "@/lib/crawl/jobs/translate-reasons";
import { KOREAN_TRANSLATION_NATIVE_MAX_CHARS } from "@/lib/crawl/korean-translation-config";
import { classificationInputFromRows } from "@/lib/crawl/publish";
import { bindReviewTaskRank, ensureReviewTaskRanks, resolveReviewReserveRanks, resolveReviewTaskRanks } from "@/lib/crawl/review-task-ranks";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { taglineEvidence, taglineHash } from "@/lib/crawl/tagline";
import { textHash } from "@/lib/crawl/translate";
import { UNIQUE_TRANSLATION_SOURCES_SQL } from "@/lib/crawl/translations";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { koreanTaglineSource, type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { legacyQuerySourceLocale, MULTILINGUAL_QUERY_PROMPT_VERSION, usesMultilingualQueryPrompt } from "@/lib/domain/products/search-query-language";
import { multilingualQueryTranslationTarget, normalizeQuery, queryTranslationKey } from "@/lib/domain/products/search-translation";
import { packProductTranslationBatch, productTranslationSourceHash, translationSourceText, type ProductTranslationSource } from "@/lib/domain/products/translation-policy";
import { productTranslationEligible } from "@/lib/domain/products/translations";
import { packTaglineBatch } from "@/lib/jobs/products/korean-tagline";
import { runInTextTaskRank, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { bindApiTaskRank, taskModels, type AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { aiTaskModelsReadState, withReadOnlyAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { readAiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-snapshot";
import { aiTask } from "@/lib/llm/ai-tasks";
import { parseModelCapacityPolicy } from "@/lib/llm/capacity";
import { parseProviderQuotaHeaders } from "@/lib/llm/provider-rate-limit";
import { parseCliEngineRevision } from "@/lib/llm/cli-engine-config";
import { servingContractWireModel } from "@/lib/llm/direct-serving-contract";
import { servingContractsDbEnabled, servingContractSnapshot, setServingContractSnapshotForTest, textRouteAccess,
  type ServingContractSnapshot, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { validateAdminServingContract } from "./admin-serving-contracts";
import { readWriterFence } from "./dr/epoch";
import { headerNameDiff, SHAPE_COMPARE_LIMITS, wireFieldDiff, wireFieldDigest, type CallOutcome, type CompareContractRefusal, type CompareContractView, type CompareRoute,
  type CompareSampleView, type CompareVariant, type PreviewRow, type ShapeCompareArgs, type ShapeCompareDeps, type ShapeCompareLoad } from "./contract-shape-compare";
import { evaluateResponse, preparedWireHash, ROUTE_SAMPLE_KIND, routeTimeoutMs, textPreflight, variantHeaders, variantNeedsTokenizer, variantWire,
  type ParsedContract, type SampleInput } from "./contract-shape-compare-routes";
import { totalBoundContractFromAbcllm } from "./serving-contract-convert";

/**
 * 계약 모양 견줌의 실제 읽기·보내기(scripts/ops/contract-shape-compare.ts 가 부른다 — 운영 text-m3 컨테이너 안에서, 앱과 같은 DATABASE_URL·암호 상자 키로).
 *
 * - 쓰지 않음: load·미리 보기·호출 모두 withReadOnlyAiTaskModels 범위 안에서 돈다 — 순위 스냅숏을 다시 읽을 때 앱이 뒤에서 하는 연결 키 채우기
 *   (ai_connections UPDATE·operations_audit INSERT·엔진 GET /models)가 이 프로세스에서는 일어나지 않는다(범위는 뒤에서 도는 다시 읽기에도 이어진다).
 *   표본·관문 읽기는 READ ONLY 트랜잭션이고, 그 밖의 읽기는 앱의 계약·순위·실행 설정 읽기(SELECT 만) 그대로다.
 * - 계약: 앱과 같은 길로 읽는다(ensureReviewTaskRanks → 계약 스냅숏, 키는 앱처럼 메모리 안에서만 연다 — 출력·기록에 키·주소 전체를 싣지 않고 host:port 만).
 *   그 경로·(고르면) 모델의 켜진 abcllm 계약 중 엔진 직접(transport direct)이고 전환 도구의 변환 함수(totalBoundContractFromAbcllm)가 받는 것만 견준다.
 *   새 모양은 그 함수로 메모리 안에서만 만든다(저장하지 않는다). 지금 순위·묶음 구성원에 묶이지 않은 계약과 외부 API 계약은 --model 로 콕 집을 때만,
 *   꺼진 순위만 가리키는 계약과 장부의 최근 1시간 마지막 정산이 429 거절인 계약은 콕 집어도 부르지 않는다.
 * - 실행 동안 계약 스냅숏을 시작 때 읽은 행으로 고정한다(setServingContractSnapshotForTest — 시험·replay 가 쓰는 고정과 같다). 호출마다 견줄 모양의 행을
 *   그 자리에 끼워 실제 준비 함수(preparedWireHash)와 보낼 키(textRouteAccess — 잡의 contractBearer 와 같은 규칙)를 그 모양으로 받는다. 순위 묶음이
 *   있는 text 경로는 그 순위 범위(runInTextTaskRank) 안에서 한다 — 잡처럼 연결의 키를 보낸다.
 * - 표본: 경로의 잡이 입력을 짓는 함수로(loadReviewInput·profileEvidence·taglineEvidence·packBatch·packProductTranslationBatch·packTaglineBatch·
 *   classificationInputFromRows …) 최근에 그 일이 성공한 입력을 READ ONLY 트랜잭션 안에서 읽는다. 쓰지 않는다.
 * - 보내기: 용량 장부를 거치지 않고 계약 끝점에 바로(운영자 측정). 전송 함수와 같은 헤더·redirect(manual)·기한. 한 번에 하나(부르는 쪽이 순서를 정한다).
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LiveContract = { view: CompareContractView; row: StoredServingContract; abcllm: ParsedContract; converted: ParsedContract;
  binding: TextTaskRankBinding | null };
type LiveSample = { view: CompareSampleView; input: SampleInput };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** host:port 만(경로·인증 정보 없음). 주소가 아니면 null */
export function endpointHost(value: unknown): string | null {
  try { return typeof value === "string" ? new URL(value).host || null : null; } catch { return null; }
}
const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_:.-]{2,120}$/.test(message) ? message : "unexpected";
};

/** 읽기만 하는 트랜잭션 — 첫 문장이 SET TRANSACTION READ ONLY 라 그 안의 어떤 쓰기도 DB 가 거절한다 */
async function readOnly<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return run(tx);
  });
}

/** 경로 → 그 경로를 부르는 잡(검색어 번역은 웹 요청이라 잡이 없다) */
export const ROUTE_JOBS: Readonly<Record<CompareRoute, string | null>> = Object.freeze({ "crawl-agent-review": "crawl-agent-review",
  "second-review": "second-review", "product-search-profile": "product-search-profile", "product-search-verify": "product-search-verify",
  "crawl-tagline": "crawl-tagline", "reason-translate": "reason-translate", "product-translate": "product-translate", "product-tagline-ko": "product-tagline-ko",
  "search-query-translate": null, "crawl-publish-classify": "crawl-publish" });
/** 관리 화면의 작업 멈춤(job-pause)은 not_before 를 먼 미래로 둔다 — lib/jobs/status.ts isPausedJob 과 같은 기준(1년 넘게 뒤) */
const PAUSED_AFTER_DAYS = 365;
export type RouteGates = Readonly<{ contractsDb: boolean; mode: string | null; fenceActive: boolean; jobPaused: boolean;
  ranksReadable: boolean; boundCount: number; disabledCount: number }>;
/**
 * 경로가 꺼져 있으면 그 까닭 — 잡이 부르지 않는 때는 견주지 않는다. 계약 읽기 꺼짐, DR fence(운영 쪽도 fence 된 사이트를 draining 으로 본다),
 * 용량 DRAIN(배포 창), 크롤 설정의 꺼짐(크롤 네 경로·1차 심사 모드·2차), 그 경로 잡의 멈춤(job-pause), 순위를 읽지 못함, 순위가 모두 꺼짐.
 */
export function routeKillSwitch(route: CompareRoute, settings: CrawlSettings, gates: RouteGates): string | null {
  if (!gates.contractsDb) return "serving_contracts_db_off";
  if (!gates.fenceActive) return "dr_fenced";
  if (gates.mode === "draining") return "capacity_draining";
  if (["crawl-agent-review", "second-review", "crawl-tagline", "crawl-publish-classify"].includes(route) && !settings.enabled) return "crawl_disabled";
  if (route === "crawl-agent-review" && settings.reviewMode === "off") return "review_off";
  if (route === "second-review" && !settings.secondReview.enabled) return "second_review_off";
  if (gates.jobPaused) return "job_paused";
  if (!gates.ranksReadable) return "ranks_unreadable";
  if (gates.boundCount === 0 && gates.disabledCount > 0) return "ranks_disabled";
  return null;
}

/**
 * 사설·tailnet 주소인가 — IPv4 사설(10/8·172.16/12·192.168/16)·루프백·링크 로컬·CGNAT(100.64/10, tailnet), IPv6 루프백·ULA·링크 로컬,
 * 점 없는 이름(컨테이너·장비 이름)과 localhost·.ts.net·.internal·.local·.lan·.home.arpa, 공개로 풀리지 않는 예약 이름 .test·.invalid(RFC 6761).
 * 그 밖(공개 이름·공개 IP)은 외부 API 로 본다.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254;
  }
  if (version === 6) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return host === "localhost" || !host.includes(".") || /\.(ts\.net|internal|local|lan|home\.arpa|localhost|test|invalid)$/.test(host);
}
/** 외부 API 계약 — 429 쉼 정책(rateLimitBackoff)을 가졌거나 끝점이 사설·tailnet 주소가 아니다 */
export function externalContract(contract: Readonly<Record<string, unknown>>): string | null {
  if (contract.rateLimitBackoff !== undefined) return "rate_limit_backoff";
  try { return privateHost(new URL(String(contract.endpoint)).hostname) ? null : "public_host"; } catch { return "public_host"; }
}

// ── 표본 ───────────────────────────────────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = { id: products.id, slug: products.slug, name: products.name, url: products.url, category: products.category,
  tagline: products.tagline, description: products.description, searchTopics: products.searchTopics, searchPageText: products.searchPageText,
  searchReadme: products.searchReadme };
/** 검색 키워드 대기열(search-profiles.ts REVIEWER_NOTE)과 같은 감사 메모 — 바깥 표 이름(products)을 그대로 쓴다 */
const REVIEWER_NOTE = sql<string | null>`(select a.ai_reason from product_audit_items a
  where a.product_id = products.id and a.ai_reason is not null order by a.id desc limit 1)`;
const PUBLIC_STATUSES = ["seeded", "verified"] as const;
/** 앞쪽을 먼저(그 일이 지금 입력으로 성공한 것), 모자라면 뒤쪽으로 채운다 */
const preferFirst = <T>(preferred: readonly T[], rest: readonly T[], limit: number): T[] => [...preferred, ...rest].slice(0, limit);

/** 심사 두 경로 — 최근 성공한 시도(1차: crawl_review_attempts automatic·succeeded, 2차: second_reviews 판정 있음)의 후보를 abcllm 먼저, 입력은 loadReviewInput */
async function reviewSamples(tx: Tx, route: CompareRoute, limit: number, settings: CrawlSettings): Promise<LiveSample[]> {
  const ids: number[] = [];
  const pick = async (abcllmOnly: boolean) => {
    const rows = route === "crawl-agent-review"
      ? await tx.select({ candidateId: crawlReviewAttempts.candidateId }).from(crawlReviewAttempts)
        .where(and(eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"),
          abcllmOnly ? eq(crawlReviewAttempts.provider, "abcllm") : undefined)).orderBy(desc(crawlReviewAttempts.id)).limit(limit * 10)
      : await tx.select({ candidateId: secondReviews.candidateId }).from(secondReviews)
        .where(and(isNotNull(secondReviews.secondDecision), abcllmOnly ? eq(secondReviews.provider, "abcllm") : undefined))
        .orderBy(desc(secondReviews.id)).limit(limit * 10);
    for (const row of rows) if (!ids.includes(row.candidateId)) ids.push(row.candidateId);
  };
  await pick(true);
  if (ids.length < limit * 2) await pick(false);
  const wanted = ids.slice(0, limit * 3);
  if (!wanted.length) return [];
  const rows = await tx.select({ candidate: crawlCandidates, document: crawlDocuments }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo)).where(inArray(crawlCandidates.id, wanted));
  const samples: LiveSample[] = [];
  for (const id of wanted) {
    const row = rows.find(entry => entry.candidate.id === id);
    if (!row) continue;
    const input = await loadReviewInput(row.candidate, row.document, settings, tx);
    if (Buffer.byteLength(JSON.stringify(input.snapshot), "utf8") > MAX_REVIEW_INPUT_BYTES) continue;
    samples.push({ view: { id: `candidate:${id}`, label: row.candidate.repo }, input: { kind: "review", input } });
    if (samples.length >= limit) break;
  }
  return samples;
}

/** 검색 키워드 짓기·검수 — 키워드가 오류 없이 지어진(검수는 검수까지 끝난) 공개 제품, 저장된 원본 hash 가 지금 증거와 같은 것 먼저 */
async function profileSamples(tx: Tx, route: "product-search-profile" | "product-search-verify", limit: number): Promise<LiveSample[]> {
  const verify = route === "product-search-verify";
  const rows = await tx.select({ product: PRODUCT_FIELDS, reviewerNote: REVIEWER_NOTE, sourceHash: productSearchProfiles.sourceHash,
    keywordsEn: productSearchProfiles.keywordsEn, keywordsKo: productSearchProfiles.keywordsKo })
    .from(products).innerJoin(productSearchProfiles, eq(productSearchProfiles.productId, products.id))
    .where(and(inArray(products.status, [...PUBLIC_STATUSES]), isNull(productSearchProfiles.errorCode), eq(productSearchProfiles.needsRefresh, false),
      sql`jsonb_array_length(${productSearchProfiles.keywordsEn}) + jsonb_array_length(${productSearchProfiles.keywordsKo}) > 0`,
      verify ? and(isNotNull(productSearchProfiles.verifiedAt), isNull(productSearchProfiles.verifyError)) : undefined))
    .orderBy(desc(verify ? productSearchProfiles.verifiedAt : productSearchProfiles.updatedAt)).limit(limit * 4);
  const built = rows.map(row => {
    const evidence = profileEvidence(row.product, row.reviewerNote);
    const input: SampleInput = verify ? { kind: "verify", item: { evidence, keywords: [...row.keywordsEn, ...row.keywordsKo] } } : { kind: "profile", evidence };
    return { same: profileHash(evidence) === row.sourceHash, sample: { view: { id: `product:${row.product.id}`, label: row.product.slug }, input } };
  });
  return preferFirst(built.filter(entry => entry.same).map(entry => entry.sample), built.filter(entry => !entry.same).map(entry => entry.sample), limit);
}

/** 수집 소개 — 모델이 빈 줄 아닌 소개를 지은(사람이 적지 않은·오류 없는) 후보, 지은 원본 hash 가 지금 증거와 같은 것 먼저 */
async function crawlTaglineSamples(tx: Tx, limit: number): Promise<LiveSample[]> {
  const rows = await tx.select({ candidate: crawlCandidates, document: crawlDocuments, sourceHash: crawlTaglines.sourceHash }).from(crawlTaglines)
    .innerJoin(crawlCandidates, eq(crawlCandidates.repo, crawlTaglines.repo)).innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlTaglines.repo))
    .where(and(isNull(crawlTaglines.writtenBy), isNull(crawlTaglines.errorCode), sql`btrim(${crawlTaglines.tagline}) <> ''`))
    .orderBy(desc(crawlTaglines.updatedAt)).limit(limit * 4);
  const built = rows.map(row => {
    const evidence = taglineEvidence(row.candidate.repo, row.document);
    return { same: taglineHash(evidence) === row.sourceHash,
      sample: { view: { id: `candidate:${row.candidate.id}`, label: row.candidate.repo }, input: { kind: "crawl-tagline" as const, evidence } } };
  });
  return preferFirst(built.filter(entry => entry.same).map(entry => entry.sample), built.filter(entry => !entry.same).map(entry => entry.sample), limit);
}

/** 사유 번역 — 옮기기에 성공한(done) 최근 사유, 원문은 잡과 같은 출처(UNIQUE_TRANSLATION_SOURCES_SQL 의 ref), 묶음은 잡의 packBatch(실시간 손잡이) */
async function reasonSamples(tx: Tx, limit: number): Promise<LiveSample[]> {
  const rows = Array.from(await tx.execute<{ hash: string; body: string | null }>(sql`
    SELECT t.source_hash AS hash, CASE left(u.ref, 1)
        WHEN 'a' THEN (SELECT coalesce(a.reason, a.outcome->>'reason') FROM crawl_review_attempts a WHERE a.id = substr(u.ref, 2)::int)
        ELSE (SELECT s.second_reason FROM second_reviews s WHERE s.id = substr(u.ref, 2)::int) END AS body
      FROM (SELECT tt.source_hash, tt.updated_at FROM ${textTranslations} tt WHERE tt.target_lang = 'ko' AND tt.status = 'done'
        ORDER BY tt.updated_at DESC LIMIT ${limit * 16}) t
      JOIN (${UNIQUE_TRANSLATION_SOURCES_SQL}) u ON u.hash = t.source_hash
     ORDER BY t.updated_at DESC, t.source_hash`));
  let rest = rows.flatMap(row => typeof row.body === "string" && row.body.trim() && textHash(row.body) === row.hash ? [{ hash: row.hash, body: row.body, attempts: 0 }] : []);
  const knobs = reasonTranslateKnobs(), samples: LiveSample[] = [];
  while (rest.length && samples.length < limit) {
    const batch = packBatch(rest, knobs);
    if (!batch.length) break;
    rest = rest.slice(batch.length);
    samples.push({ view: { id: `reasons:${batch.map(item => item.hash.slice(0, 12)).join(",")}`, label: `${batch.length}건` },
      input: { kind: "reasons", texts: batch.map(item => item.body) } });
  }
  return samples;
}

/** 공개 번역 — 기계 번역이 받힌(ready) 최근 항목, 원문 hash 가 지금 제품 글과 같은 것만, 묶음은 언어마다 packProductTranslationBatch(실시간 정책) */
async function productTranslationSamples(tx: Tx, limit: number): Promise<LiveSample[]> {
  const rows = await tx.select({ source: { id: products.id, name: products.name, tagline: products.tagline, description: products.description },
    locale: productTranslations.locale, field: productTranslations.field, sourceHash: productTranslations.sourceHash })
    .from(productTranslations).innerJoin(products, eq(products.id, productTranslations.productId))
    .where(and(eq(productTranslations.status, "ready"), sql`${productTranslations.provenance}->>'kind' = 'machine'`, productTranslationEligible))
    .orderBy(desc(productTranslations.updatedAt)).limit(limit * 12);
  const queues = new Map<string, { source: ProductTranslationSource; locale: (typeof rows)[number]["locale"]; field: (typeof rows)[number]["field"] }[]>();
  for (const row of rows) {
    const source: ProductTranslationSource = { id: row.source.id, name: row.source.name, tagline: row.source.tagline, description: row.source.description };
    if (!translationSourceText(source, row.field).trim() || productTranslationSourceHash(source, row.field) !== row.sourceHash) continue;
    queues.set(row.locale, [...(queues.get(row.locale) ?? []), { source, locale: row.locale, field: row.field }]);
  }
  const samples: LiveSample[] = [];
  // 언어를 번갈아 묶는다(같은 언어끼리만 한 묶음 — ja 묶음도 따로 본다)
  while (samples.length < limit && [...queues.values()].some(queue => queue.length)) {
    for (const [locale, queue] of queues) {
      if (!queue.length || samples.length >= limit) continue;
      const batch = packProductTranslationBatch(queue);
      if (!batch.length) { queues.set(locale, []); continue; }
      queues.set(locale, queue.slice(batch.length));
      samples.push({ view: { id: `products:${batch.map(task => `${task.source.id}:${task.locale}:${task.field}`).join(",")}`, label: locale },
        input: { kind: "product-translate", sources: batch.map(task => task.source),
          items: batch.map(task => ({ name: task.source.name, locale: task.locale, field: task.field, text: translationSourceText(task.source, task.field) })) } });
    }
  }
  return samples;
}

/**
 * 한국어 소개 표본 묶음 — 잡의 packTaglineBatch(native 1,200자)를 되풀이한다. 묶음 함수가 거르는 너무 긴 소개는 처음부터 빼고(남으면 같은 자리에서 맴돈다),
 * 묶은 것만 뺀다(건너뛴 것 — 혼자 보낼 것 — 은 다음 묶음이 받는다). 그래서 한 제품이 두 표본에 들지 않는다.
 */
export function koreanTaglineSampleBatches(tasks: readonly KoreanTaglineTask[], limit: number): KoreanTaglineTask[][] {
  let rest = tasks.filter(task => task.tagline.length <= KOREAN_TRANSLATION_NATIVE_MAX_CHARS);
  const batches: KoreanTaglineTask[][] = [];
  while (rest.length && batches.length < limit) {
    const batch = packTaglineBatch(rest, KOREAN_TRANSLATION_NATIVE_MAX_CHARS);
    if (!batch.length) break;
    rest = rest.filter(task => !batch.includes(task));
    batches.push(batch);
  }
  return batches;
}

/** 한국어 소개 — 지금 소개로 옮기기에 성공한 최근 제품, 묶음은 잡의 packTaglineBatch(native 1,200자), 보내는 글은 잡과 같은 koreanTaglineSource */
async function taglineKoSamples(tx: Tx, limit: number): Promise<LiveSample[]> {
  const rows = await tx.select({ productId: products.id, name: products.name, tagline: products.tagline, repoUrl: products.repoUrl,
    attempts: productKoreanTaglines.attempts, lastError: productKoreanTaglines.errorCode, qualityRejections: productKoreanTaglines.qualityRejections })
    .from(productKoreanTaglines).innerJoin(products, eq(products.id, productKoreanTaglines.productId))
    .where(and(isNotNull(productKoreanTaglines.taglineKo), isNull(productKoreanTaglines.errorCode), sql`${productKoreanTaglines.sourceTagline} = ${products.tagline}`,
      inArray(products.status, [...PUBLIC_STATUSES]), sql`btrim(${products.tagline}) <> ''`))
    .orderBy(desc(productKoreanTaglines.updatedAt)).limit(limit * 16);
  const tasks: KoreanTaglineTask[] = rows.map(row => ({ productId: row.productId, name: row.name, tagline: row.tagline, repoUrl: row.repoUrl,
    attempts: Number(row.attempts), lastError: row.lastError, qualityRejections: Number(row.qualityRejections) }));
  const samples: LiveSample[] = [];
  for (const batch of koreanTaglineSampleBatches(tasks, limit))
    samples.push({ view: { id: `products:${batch.map(task => task.productId).join(",")}`, label: `${batch.length}건` },
      input: { kind: "tagline-ko", items: batch.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) })) } });
  return samples;
}

/**
 * 검색어 번역 — 최근 30일 검색어 중 번역 캐시가 done 인 것(다국어 판 캐시가 있으면 그 입력, 아니면 옛 판). 검색어 원문은 사람이 친 글이라 보이는 id 는 hash 와
 * 언어·길이만 적는다(입력 원문은 보내기에만 쓴다).
 */
async function querySamples(tx: Tx, limit: number): Promise<LiveSample[]> {
  const rows = await tx.select({ query: searchQueries.query }).from(searchQueries)
    .where(sql`${searchQueries.searchedAt} > now() - interval '30 days'`).orderBy(desc(searchQueries.id)).limit(2_000);
  const seen = new Set<string>();
  const candidates: { key: string; multilingual: boolean; input: Extract<SampleInput, { kind: "query" }>["input"] }[] = [];
  for (const { query } of rows) {
    const normalized = normalizeQuery(query);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    // 다국어 판(검색 화면의 multilingual 모드) — 잡(translateOnce)이 그 판 입력을 짓는 규칙 그대로
    const target = multilingualQueryTranslationTarget(query), locale = target?.sourceLocale;
    if (target && locale && locale !== "ko" && usesMultilingualQueryPrompt(target))
      candidates.push({ key: target.cacheKey, multilingual: true, input: { sourceLocale: locale, query, promptVersion: MULTILINGUAL_QUERY_PROMPT_VERSION } });
    const legacy = legacyQuerySourceLocale(query);
    if (legacy) candidates.push({ key: queryTranslationKey(query), multilingual: false, input: { sourceLocale: legacy, query } });
    if (candidates.length >= 400) break;
  }
  if (!candidates.length) return [];
  const done = new Set((await tx.select({ hash: textTranslations.sourceHash }).from(textTranslations)
    .where(and(inArray(textTranslations.sourceHash, candidates.map(candidate => candidate.key)), eq(textTranslations.targetLang, "en"),
      eq(textTranslations.status, "done")))).map(row => row.hash));
  const samples: LiveSample[] = [], used = new Set<string>();
  for (const candidate of [...candidates.filter(entry => entry.multilingual), ...candidates.filter(entry => !entry.multilingual)]) {
    if (!done.has(candidate.key) || used.has(normalizeQuery(candidate.input.query)) || samples.length >= limit) continue;
    used.add(normalizeQuery(candidate.input.query));
    samples.push({ view: { id: `query:${candidate.key.slice(0, 12)}`, label: `${candidate.input.sourceLocale} · ${Array.from(candidate.input.query).length}자` },
      input: { kind: "query", input: candidate.input } });
  }
  return samples;
}

/** 카테고리 분류 — 최근 발행된 후보를 발행 잡과 같은 입력(classificationInputFromRows)으로, 잡의 묶음 크기(10)로 */
async function classifySamples(tx: Tx, limit: number, settings: CrawlSettings): Promise<LiveSample[]> {
  const rows = await tx.select({ candidate: crawlCandidates, document: crawlDocuments, written: crawlTaglines }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo)).leftJoin(crawlTaglines, eq(crawlTaglines.repo, crawlCandidates.repo))
    .where(eq(crawlCandidates.state, "published")).orderBy(desc(crawlCandidates.updatedAt), desc(crawlCandidates.id)).limit(limit * CATEGORY_BATCH_SIZE * 2);
  const inputs = rows.flatMap(row => {
    const input = classificationInputFromRows(row.candidate, row.document, settings, row.written ?? undefined);
    return input ? [{ id: row.candidate.id, input }] : [];
  });
  const samples: LiveSample[] = [];
  for (let offset = 0; offset < inputs.length && samples.length < limit; offset += CATEGORY_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + CATEGORY_BATCH_SIZE);
    samples.push({ view: { id: `candidates:${batch.map(entry => entry.id).join(",")}`, label: `${batch.length}건` },
      input: { kind: "classify", payload: { inputs: batch.map(entry => entry.input), definitions: settings.classify.definitions } } });
  }
  return samples;
}

export async function loadShapeCompareSamples(route: CompareRoute, limit: number, settings: CrawlSettings): Promise<LiveSample[]> {
  return readOnly(async tx => {
    switch (ROUTE_SAMPLE_KIND[route]) {
      case "review": return reviewSamples(tx, route, limit, settings);
      case "profile": return profileSamples(tx, "product-search-profile", limit);
      case "verify": return profileSamples(tx, "product-search-verify", limit);
      case "crawl-tagline": return crawlTaglineSamples(tx, limit);
      case "reasons": return reasonSamples(tx, limit);
      case "product-translate": return productTranslationSamples(tx, limit);
      case "tagline-ko": return taglineKoSamples(tx, limit);
      case "query": return querySamples(tx, limit);
      case "classify": return classifySamples(tx, limit, settings);
    }
  });
}

// ── 계약 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 경로의 순위·묶음 구성원 중 abcllm 계약에 묶이는 것(장부 이름 → 그 묶음)과, 꺼진 순위(순위 꺼짐·연결 꺼짐)만 가리키는 장부 이름 */
export type RouteRanks = Readonly<{ readable: boolean;
  bound: ReadonlyMap<string, Readonly<{ text: TextTaskRankBinding | null; deviceId: string | null }>>; disabled: ReadonlySet<string> }>;
const OFF_CODES: ReadonlySet<string> = new Set(["rank_disabled", "connection_disabled"]);
const turnedOn = (rank: AiTaskRank): AiTaskRank => ({ ...rank, enabled: true, connection: { ...rank.connection, enabled: true } });
/**
 * 지금 잡이 부를 수 있는 순위·구성원(앱의 묶기 함수 그대로): 심사는 칸마다 resolveReviewTaskRanks(순위대로·「동시에」 구성원)와 예비 순위, text 는 「동시에」면
 * 구성원(예비를 켰으면 순위도), 순위대로면 순위, 카테고리 분류는 「동시에」 구성원만(그 잡은 그 모드에서만 돈다). 꺼진 순위는 켠 것으로 다시 묶어 어느 계약을
 * 가리키는지만 본다. 순위 스냅숏을 읽지 못하면 readable false.
 */
export function routeRanks(route: CompareRoute): RouteRanks {
  const bound = new Map<string, { text: TextTaskRankBinding | null; deviceId: string | null }>(), disabled = new Set<string>();
  try {
    if (route === "crawl-agent-review" || route === "second-review") {
      const task = route === "crawl-agent-review" ? "first-review" as const : "second-review" as const;
      for (let slot = 1; slot <= (aiTask(task)?.slots ?? 1); slot++)
        for (const candidate of [...resolveReviewTaskRanks(task, slot).candidates, ...resolveReviewReserveRanks(task, slot)]) {
          if (candidate.binding) {
            if (candidate.binding.routeId === route && candidate.binding.provider === "abcllm")
              bound.set(candidate.binding.identity, { text: null, deviceId: candidate.binding.deviceId });
          } else if (OFF_CODES.has(candidate.unusable ?? "")) {
            const again = bindReviewTaskRank(task, turnedOn(candidate.rank)).binding;
            if (again?.routeId === route && again.provider === "abcllm") disabled.add(again.identity);
          }
        }
    } else {
      const task = route === "crawl-publish-classify" ? "publish-classify" : route;
      const config = readAiTaskExecutionConfig(task, 1);
      const ranks: AiTaskRank[] = config.mode === "workload_pool" ? config.members.map(member => ({ task, slot: 1, rank: 0, model: member.model,
        enabled: true, options: member.options, connection: member.connection })) : [];
      if (route !== "crawl-publish-classify" && (config.mode !== "workload_pool" || config.reserveRanks === true)) ranks.push(...taskModels(task));
      for (const rank of ranks) {
        const candidate = bindApiTaskRank(route, rank);
        if (candidate.binding) {
          if (candidate.binding.provider === "abcllm") bound.set(candidate.binding.identity, { text: candidate.binding, deviceId: candidate.binding.deviceId });
        } else if (OFF_CODES.has(candidate.unusable ?? "")) {
          const again = bindApiTaskRank(route, turnedOn(rank)).binding;
          if (again?.provider === "abcllm") disabled.add(again.identity);
        }
      }
    }
    for (const identity of bound.keys()) disabled.delete(identity);
    return Object.freeze({ readable: aiTaskModelsReadState().loaded, bound, disabled });
  } catch { return Object.freeze({ readable: false, bound, disabled }); }
}
const inScope = <T>(binding: TextTaskRankBinding | null, run: () => Promise<T>): Promise<T> => binding ? runInTextTaskRank(binding, run) : run();

/** 계약 고르기에 쓰는 바깥 사정 — 순위·묶음 구성원, --model 로 콕 집었나, 장부의 최근 429, 장비 칸 수 */
export type ContractContext = Readonly<{ ranks: RouteRanks; explicit: boolean;
  /** 장부 이름 → 최근 1시간 안 마지막 정산이 429 거절이면 그 뒤로 지난 분 */
  recent429: ReadonlyMap<string, number>;
  /** 장부 이름 → 그 계약 장비의 칸 수(모르면 없음) */
  slots: ReadonlyMap<string, number> }>;
/**
 * 스냅숏의 켜진 행 → 견줄 계약과 제외(까닭). 순수하다(스냅숏 행과 바깥 사정만 본다). 제외 까닭: not_abcllm · transport_not_direct · auth_gateway ·
 * contract_invalid · convert_<까닭> · endpoint_invalid · rank_disabled(콕 집어도) · recent_429(콕 집어도) · not_in_ranks(--model 로만) · external_api(--model 로만).
 */
export function shapeCompareContracts(route: CompareRoute, model: string | null, rows: readonly StoredServingContract[],
  context: ContractContext): { contracts: LiveContract[]; refusals: CompareContractRefusal[] } {
  const contracts: LiveContract[] = [], refusals: CompareContractRefusal[] = [];
  for (const row of rows.filter(entry => entry.routeId === route && (model === null || entry.model === model)).sort((a, b) => a.model.localeCompare(b.model))) {
    const raw = record(row.contract), host = endpointHost(raw.endpoint);
    const refuse = (reason: string, detail: string | null = null) => refusals.push(Object.freeze({ model: row.model, host, reason, detail }));
    if (raw.provider !== "abcllm") { refuse("not_abcllm", typeof raw.protocol === "string" ? raw.protocol : null); continue; }
    if (row.transport !== "direct") { refuse("transport_not_direct"); continue; }
    if (row.auth === "gateway") { refuse("auth_gateway"); continue; }
    const checked = validateAdminServingContract(route, row.contract);
    if (!checked.ok) { refuse("contract_invalid", checked.reason); continue; }
    const mapped = totalBoundContractFromAbcllm(route, row.contract);
    if (!mapped.ok) { refuse(`convert_${mapped.reason}`, mapped.detail ?? null); continue; }
    if (!host) { refuse("endpoint_invalid"); continue; }
    const rank = context.ranks.bound.get(row.model) ?? null, external = externalContract(checked.contract);
    if (!rank && context.ranks.disabled.has(row.model)) { refuse("rank_disabled", "순위가 꺼져 있다"); continue; }
    const minutes = context.recent429.get(row.model);
    if (minutes !== undefined) { refuse("recent_429", `${minutes}분 전 장부의 마지막 정산이 429 거절`); continue; }
    if (!rank && !context.explicit) { refuse("not_in_ranks", "지금 순위·묶음 구성원에 없다 — --model 로 콕 집을 때만"); continue; }
    if (external && !context.explicit) { refuse("external_api", `${external} — --model 로 콕 집을 때만`); continue; }
    const abcllm = checked.contract, converted = mapped.contract as ParsedContract, singleSlot = context.slots.get(row.model) === 1;
    contracts.push({ row, abcllm, converted, binding: rank?.text ?? null, view: Object.freeze({ model: row.model,
      wireModel: servingContractWireModel(abcllm as { provider?: unknown; protocol?: unknown; model: string; engineModel?: unknown }), host,
      cliEngine: parseCliEngineRevision(abcllm.deploymentRevision) !== null,
      tokenizer: Object.freeze([...(variantNeedsTokenizer(route, abcllm) ? ["abcllm" as const] : []),
        ...(variantNeedsTokenizer(route, converted) ? ["total-bound" as const] : [])]),
      bound: !!rank, external: !!external, singleSlot, delayMs: singleSlot ? SHAPE_COMPARE_LIMITS.singleSlotDelayMs : SHAPE_COMPARE_LIMITS.delayMs }) });
  }
  return { contracts, refusals };
}

/**
 * 관문·사정 읽기(READ ONLY 트랜잭션 하나): DR fence(잠그지 않는 읽기), 용량 mode·정책, 그 경로 잡의 멈춤, 장비 칸 수, text 경로 장부의 최근 1시간 429 거절.
 * 운영 워커의 429 쉼·잔여량 0 쉼은 그 프로세스 메모리에만 있어 읽을 수 없다 — 장부에 남는 처리 전 거절(0174 gateway_http_rejected)만 본다.
 */
async function readGates(route: CompareRoute, rows: readonly StoredServingContract[], ranks: RouteRanks) {
  return readOnly(async tx => {
    const fence = await readWriterFence(tx);
    const [control] = await tx.select({ mode: modelCapacityControl.mode, policy: modelCapacityControl.policy }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1));
    const job = ROUTE_JOBS[route];
    const [paused] = job ? Array.from(await tx.execute<{ paused: boolean }>(sql`SELECT coalesce(${jobs.notBefore} > now() + make_interval(days => ${PAUSED_AFTER_DAYS}), false) AS paused
      FROM ${jobs} WHERE ${jobs.name} = ${job}`)) : [];
    const devices = await tx.select({ deviceId: modelCapacityDevices.deviceId, limitSlots: modelCapacityDevices.limitSlots,
      physicalLimit: modelCapacityDevices.physicalLimit }).from(modelCapacityDevices).where(eq(modelCapacityDevices.enabled, true));
    const recent429 = new Map<string, number>();
    for (const row of Array.from(await tx.execute<{ model: string; kind: string | null; status: string | null; minutes: number | string }>(sql`
      SELECT DISTINCT ON (model) model, terminal_evidence->>'kind' AS kind, terminal_evidence->>'status' AS status,
        floor(extract(epoch FROM (clock_timestamp() - settled_at)) / 60)::int AS minutes
        FROM model_capacity_requests WHERE state = 'settled' AND settled_at > clock_timestamp() - interval '60 minutes'
          AND route_id = ${route} AND provider = 'abcllm'
       ORDER BY model, settled_at DESC`)))
      if (row.kind === "gateway_http_rejected" && row.status === "429") recent429.set(row.model, Number(row.minutes));
    // 장비 칸 수: 정책 route(경로, abcllm, 모델)의 장비 → 없으면 순위 연결의 장비. 칸 = limit_slots(물리 한도가 더 작으면 그것)
    let policy: ReturnType<typeof parseModelCapacityPolicy> | null = null;
    try { policy = control?.policy ? parseModelCapacityPolicy(control.policy) : null; } catch { policy = null; }
    const slots = new Map<string, number>();
    for (const row of rows.filter(entry => entry.routeId === route)) {
      const group = policy?.routes.find(entry => entry.routeId === route && entry.provider === "abcllm" && entry.model === row.model)?.groupId
        ?? ranks.bound.get(row.model)?.deviceId ?? null;
      const device = group ? devices.find(entry => entry.deviceId === group) : undefined;
      if (device) slots.set(row.model, Math.min(device.limitSlots, device.physicalLimit ?? device.limitSlots));
    }
    return { fenceActive: fence.state === "active", mode: control?.mode ?? null, jobPaused: paused?.paused === true, recent429, slots };
  });
}

// ── deps ──────────────────────────────────────────────────────────────────────────────────────────────

type Fetch = typeof undiciFetch;
/**
 * 계약 스냅숏 고정(setServingContractSnapshotForTest — 시험·replay 가 쓰는 것과 같다). 고정 중에는 DB 를 다시 읽지 않으므로, 이 프로세스에서 다음 load 가
 * 앱과 같은 읽기를 하도록 이 도구가 건 고정은 load 가 먼저 푼다(다른 쪽이 건 고정은 건드리지 않는다).
 */
let pinnedByCompare = false;
function pinSnapshot(base: ServingContractSnapshot, rows: readonly StoredServingContract[]): void {
  setServingContractSnapshotForTest(rows, base.registry, base.devices);
  pinnedByCompare = true;
}
function releaseSnapshot(): void {
  if (!pinnedByCompare) return;
  setServingContractSnapshotForTest(null);
  pinnedByCompare = false;
}
/** 읽은 상태(load 가 만든다) — 시작 때의 계약 스냅숏(키가 열린 행), 견줄 계약, 표본 */
export type LoadedShapeCompare = Readonly<{ route: CompareRoute; base: ServingContractSnapshot; contracts: readonly LiveContract[]; samples: readonly LiveSample[] }>;
export type { LiveContract, LiveSample };

/** 응답이 그 계약을 멈추라고 하는가 — 429, Retry-After(·-ms) 헤더, 검증된 잔여량 0 헤더(provider-rate-limit parseProviderQuotaHeaders) */
export function responseStop(status: number, headers: Readonly<{ get(name: string): string | null }>): string | null {
  if (status === 429) return "rate_limited";
  if (headers.get("retry-after") !== null || headers.get("retry-after-ms") !== null) return "retry_after";
  return parseProviderQuotaHeaders(headers).some(window => window.remaining === 0) ? "quota_exhausted" : null;
}

/**
 * 읽은 상태로 미리 보기·호출을 만든다(load 와 떼어 둔 것은 시험이 DB 없이 이 길을 그대로 돌게 하려는 것뿐이다). 키는 base 의 행 안에만 있고 결과에 들지 않는다.
 * 호출마다 견줄 모양의 행을 끼운 스냅숏으로 고정하고(pin) 실제 준비 함수로 바이트를 확인한 뒤, 같은 스냅숏에서 보낼 키를 받는다.
 * 둘 다 withReadOnlyAiTaskModels 범위 안에서 돈다(순위 스냅숏의 뒤 다시 읽기가 연결 키 채우기를 하지 않게).
 */
export function shapeCompareCallers(state: LoadedShapeCompare, send: Fetch = undiciFetch): Pick<ShapeCompareDeps, "preview" | "call"> {
  const { route, base } = state;
  const contracts = new Map(state.contracts.map(contract => [contract.view.model, contract]));
  const samples = new Map(state.samples.map(sample => [sample.view.id, sample]));
  /** 이 모양의 행을 끼운 계약 스냅숏으로 고정한다(다른 행은 시작 때 읽은 그대로) */
  const pin = (contract: LiveContract, variant: CompareVariant) =>
    pinSnapshot(base, base.rows.map(row => row === contract.row && variant === "total-bound" ? Object.freeze({ ...row, contract: contract.converted }) : row));
  const lookup = (model: string, sample: string) => {
    const contract = contracts.get(model), input = samples.get(sample);
    if (!contract || !input) throw new Error("shape_compare_unknown_target");
    return { contract, input };
  };
  const providerOf = (variant: CompareVariant) => variant === "abcllm" ? "abcllm" as const : "local-direct" as const;
  const contractOf = (contract: LiveContract, variant: CompareVariant) => variant === "abcllm" ? contract.abcllm : contract.converted;
  /** 만든 바이트가 실제 준비 함수의 바이트인지 — 같으면 null, 아니면 까닭 */
  const verify = async (target: ReturnType<typeof lookup>, variant: CompareVariant, wire: string): Promise<string | null> => {
    pin(target.contract, variant);
    const prepared = await preparedWireHash(route, target.contract.row.model, providerOf(variant), target.input.input,
      routeTimeoutMs(route, target.contract.row.model));
    return "refused" in prepared ? `prepare_refused:${prepared.refused}` : prepared.wireHash === sha(wire) ? null : "wire_mismatch";
  };
  return Object.freeze({
    preview: (model: string, sample: string): Promise<PreviewRow> => withReadOnlyAiTaskModels(async () => {
      const target = lookup(model, sample);
      return inScope(target.contract.binding, async () => {
        try {
          const wires = { abcllm: await variantWire(route, target.contract.abcllm, target.input.input),
            "total-bound": await variantWire(route, target.contract.converted, target.input.input) };
          const headerNames = (variant: CompareVariant) => Object.keys(variantHeaders(route, contractOf(target.contract, variant)));
          const headerDiff = headerNameDiff(headerNames("abcllm"), headerNames("total-bound"));
          const wireDiff = wireFieldDiff(wireFieldDigest(wires.abcllm), wireFieldDigest(wires["total-bound"]));
          let check = "ok";
          // tokenizer 를 부르는 준비는 dry-run 에서 하지 않는다(네트워크) — 실행 때 호출마다 확인한다
          if (target.contract.view.tokenizer.length) check = "tokenizer_at_execute";
          else for (const variant of ["abcllm", "total-bound"] as const) {
            const refused = await verify(target, variant, wires[variant]);
            if (refused) { check = `${variant}:${refused}`; break; }
          }
          return Object.freeze({ contract: model, sample, check, wireDiff, headerDiff });
        } catch (error) {
          return Object.freeze({ contract: model, sample, check: `error:${errorCode(error)}`, wireDiff: null, headerDiff: [] });
        }
      });
    }),
    call: (model: string, sample: string, variant: CompareVariant): Promise<CallOutcome> => withReadOnlyAiTaskModels(async () => {
      const target = lookup(model, sample), contract = contractOf(target.contract, variant), headers = variantHeaders(route, contract);
      const timeoutMs = routeTimeoutMs(route, target.contract.row.model);
      const empty = { status: null, transportError: null, latencyMs: null, finishReason: null, usage: null, accepted: false, decision: null,
        items: Object.freeze([]), itemChecks: null, itemPassed: null, stop: null };
      return inScope(target.contract.binding, async (): Promise<CallOutcome> => {
        let wire: string;
        try { wire = await variantWire(route, contract, target.input.input); }
        catch (error) {
          return Object.freeze({ ...empty, refused: `wire_unavailable:${errorCode(error)}`, failure: null, wireHash: null, wireBytes: null, wireFields: null,
            headers: Object.freeze(Object.keys(headers)) });
        }
        const sent = { wireHash: sha(wire), wireBytes: Buffer.byteLength(wire, "utf8"), wireFields: wireFieldDigest(wire), headers: Object.freeze(Object.keys(headers)) };
        const refused = (reason: string): CallOutcome => Object.freeze({ ...empty, ...sent, refused: reason, failure: null });
        try {
          const mismatch = await verify(target, variant, wire);
          if (mismatch) return refused(mismatch);
          // 보낼 키 — 잡의 contractBearer 와 같은 규칙(이 모양의 행이 끼워진 스냅숏, 순위 범위면 연결의 키)
          const access = textRouteAccess(route, target.contract.row.model, providerOf(variant));
          if (access.block) return refused(`bearer:${access.block}`);
          const preflight = await textPreflight(route, contract, wire, timeoutMs);
          if (preflight) return refused(`preflight:${preflight}`);
          const endpoint = contract.endpoint as string, started = performance.now();
          try {
            const response = await send(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), body: wire,
              headers: { "Content-Type": "application/json", ...(access.bearer ? { Authorization: `Bearer ${access.bearer}` } : {}), ...headers } });
            const body = await response.text();
            const latencyMs = Math.round(performance.now() - started);
            const evaluation = await evaluateResponse(route, contract, wire, target.input.input, response.status, body);
            return Object.freeze({ ...sent, refused: null, status: response.status, transportError: null, latencyMs, ...evaluation,
              stop: responseStop(response.status, response.headers) });
          } catch (error) {
            const transportError = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
            return Object.freeze({ ...empty, ...sent, refused: null, transportError, latencyMs: Math.round(performance.now() - started), failure: transportError });
          }
        } catch (error) {
          return refused(`error:${errorCode(error)}`);
        }
      });
    }),
  });
}

/**
 * 실제 deps — load 가 앱과 같은 길로 계약·순위·실행 설정을 읽고(키는 메모리 안에서만), 관문을 READ ONLY 로 읽은 뒤 그 상태로 shapeCompareCallers 를 만든다.
 * load 는 withReadOnlyAiTaskModels 범위 안에서 돈다(연결 키 채우기 없음). options.fetch 는 시험용.
 */
export function createShapeCompareDeps(options: { fetch?: Fetch } = {}): ShapeCompareDeps {
  let callers: Pick<ShapeCompareDeps, "preview" | "call"> | null = null;
  const loaded = () => {
    if (!callers) throw new Error("shape_compare_not_loaded");
    return callers;
  };
  return Object.freeze({
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    load: (args: ShapeCompareArgs): Promise<ShapeCompareLoad> => withReadOnlyAiTaskModels(async () => {
      releaseSnapshot();
      const contractsDb = servingContractsDbEnabled();
      // 계약·순위·실행 설정 스냅숏(앱과 같은 읽기, SELECT 만) — 키는 여기서 메모리 안에서만 열린다
      if (contractsDb) await ensureReviewTaskRanks(0);
      const [settingsRow] = await readOnly(tx => tx.select({ values: crawlSettings.values }).from(crawlSettings).where(eq(crawlSettings.id, 1)));
      const settings = mergeWithDefaults(settingsRow?.values);
      const base = servingContractSnapshot();
      const ranks = routeRanks(args.route);
      const gates = await readGates(args.route, base.rows, ranks);
      const killSwitch = routeKillSwitch(args.route, settings, { contractsDb, mode: gates.mode, fenceActive: gates.fenceActive, jobPaused: gates.jobPaused,
        ranksReadable: ranks.readable, boundCount: ranks.bound.size, disabledCount: ranks.disabled.size });
      const found = shapeCompareContracts(args.route, args.model, base.rows, { ranks, explicit: args.model !== null, recent429: gates.recent429, slots: gates.slots });
      // 잡이 그 계약을 부를 수 없으면(키가 열리지 않음·연결에 키 없음 …) 견주지 않는다 — 계획에 까닭으로 보인다
      const usable: LiveContract[] = [], refusals = [...found.refusals];
      for (const contract of found.contracts) {
        const access = contract.binding ? runInTextTaskRank(contract.binding, () => textRouteAccess(args.route, contract.row.model, "abcllm"))
          : textRouteAccess(args.route, contract.row.model, "abcllm");
        if (access.block) refusals.push(Object.freeze({ model: contract.view.model, host: contract.view.host, reason: `bearer:${access.block}`, detail: null }));
        else usable.push(contract);
      }
      // 이 실행 동안 계약 스냅숏을 시작 때 읽은 행으로 고정한다(중간에 다시 읽혀 견줄 계약이 바뀌지 않게)
      pinSnapshot(base, base.rows);
      const samples = killSwitch || !usable.length ? [] : await loadShapeCompareSamples(args.route, Math.min(args.samples, args.maxPerContract), settings);
      callers = shapeCompareCallers({ route: args.route, base, contracts: usable, samples }, options.fetch);
      const notes = [ROUTE_SAMPLE_KIND[args.route] === "review"
        ? "429 쉼: 운영 워커의 쉼 상태는 그 프로세스 메모리에만 있고 심사 경로는 장부에 429 증거가 남지 않아 확인하지 못했다 — 첫 429·Retry-After 에서 그 계약을 멈춘다."
        : "429 쉼: 운영 워커의 쉼·잔여량 상태는 그 프로세스 메모리에만 있어 읽지 못했다 — 장부의 최근 1시간 마지막 정산이 429 거절인 계약만 뺐다(recent_429)."];
      return Object.freeze({ contracts: usable.map(contract => contract.view), refusals, samples: samples.map(sample => sample.view), killSwitch, notes });
    }),
    preview: (model: string, sample: string) => loaded().preview(model, sample),
    call: (model: string, sample: string, variant: CompareVariant) => loaded().call(model, sample, variant),
  });
}
