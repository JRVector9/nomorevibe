import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, productAuditCampaigns, productAuditItems, products } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { SCREEN_REVIEW_SOURCES } from "./audit-import-sources";
import { openAuditRejectUniverse } from "./audit-policy";
import type { AuditReasonCategory } from "./audit-reason-category";
import { auditReasonCategorySql, secondOpinionsField, type SecondOpinionView } from "./audit-second-opinions";
import { writeAuditSecondOpinions, type SecondOpinionImport, type SecondOpinionRow } from "./audit-second-opinion-import";
import { m1SplitSql, pageTextLengthSql, screenWaitSql } from "./audit-text-gate";
import { auditItemModel, unownedPublic } from "./product-audit-hold";
import { QWEN_DIRECT_DEFAULT_MODEL, qwenDirectConfig } from "./qwen-direct-review";
import { sameOpinionModel } from "./second-opinion-rules";

/**
 * 화면 판별 대기(2026-10-22 사용자 결정 "글이 적은 페이지는 늘 화면을 보고 판정한다") — 화면 판정(브라우저로 그려 스크린샷까지 보는 판정)이
 * 가져가 판정하고 적는 큐다. 새 표·칸은 없다(이전 없음): 대기는 지금 있는 행에서 그때그때 고른다.
 *
 * 대기에 드는 것: 감사 화면·정책 처리의 대상(openAuditRejectUniverse — 마지막 감사의 열린 AI 거절과 지난 감사 항목으로 보류 중인 것) 가운데
 *  - 그 제품의 수집 본문이 THIN_PAGE_TEXT_CHARS(300자) 아래이거나 수집 원본이 없고(audit-text-gate.ts thinPageTextSql),
 *  - 화면 판정 출처(SCREEN_REVIEW_SOURCES — qwen-vision-m1·qwen-vision-auto)의 의견이 아직 없는 것.
 * 글만 본 m1(qwen-v2-auto)은 이 항목들을 닫지 않는다(audit-auto-close.ts thin_text — 의견은 남는다). 사람이 유지·내리기로 닫거나 제품이
 * 내려가면 대상에서 빠진다.
 *
 * 화면 판정 잡이 쓰는 법(따로 만드는 중):
 *  1. screenReviewQueue({ limit, skip }) 로 가져온다 — 공개 중(보류 아님) 먼저, 첫 감사의 확신 높은 순, 그다음 보류 중인 것(m1 의 묻는 차례와 같다).
 *     줄마다 열 주소(url — 공개 목록의 그 주소), 수집 본문(pageText, 300자 아래)과 글자 수, 첫 감사의 결정·사유, 이미 있는 두 번째 의견(출처·사유)을 준다.
 *     읽기만 한다 — 잠그거나 '가져감'을 적지 않는다. 같은 프로세스가 한 번에 한 줄씩 판정하고, 실패한 것은 skip 으로 넘긴다(Qwen-v2 단계의 failures 처럼).
 *  2. markScreenJudged(rows, { source, actor, lease }) 로 적는다 — 두 번째 의견 한 줄(product_audit_second_opinions, (항목, 모델)마다 한 줄 덮어쓰기)이고,
 *     그 출처의 의견이 생기면 대기에서 빠진다(결정과 상관없이 — 판단 보류도. 그리다 실패해 판정을 못 했으면 적지 말고 skip 하거나, 사람에게 넘기려면
 *     needs_review 와 까닭을 적는다). source 는 SCREEN_REVIEW_SOURCES 에 있어야 한다(없으면 audit-import-sources.ts SCREEN_JUDGE_SOURCES 에 더한다).
 *     model 은 글만 본 m1 과 다른 이름이어야 한다(qwen-vision-m1 처럼 '+vision' 을 붙인다) — 같으면 (항목, 모델) 한 줄 규칙으로 m1 의 의견을
 *     덮어쓰고 m1 이 다시 물어 거꾸로 덮어쓴다.
 *     쓰기는 옮겨 적기와 같은 길(audit-second-opinion-import.ts writeAuditSecondOpinions — DR writer fence → stage → 제품 세대 → 의견 → 보류 풀기 →
 *     작업 lease)이다: 열린 거절에만 적고, 승인이 지금 그 항목으로 보류된 제품에 오면 보류의 둘째 문을 다시 가른다(맞지 않으면 푼다 — 화면 판정 출처는
 *     확신 0.90 이상만 센다, 글이 적은 항목의 m1 거절은 세지 않는다). 푼 보류는 작업 로그 audit-hold-auto-release(누가 actor)에 남는다.
 *     유지·숨김(자동 닫기)은 하지 않는다 — 화면 판정으로 닫을지는 그 잡이 정한다. 거절은 보류의 둘째 문에서 두 번째 모델 거절로 센다(확신 0.90 이상).
 *  3. screenReviewCounts() — 감사 거절 탭의 Qwen 상태 칸·정책 처리 탭이 보이는 수(대기·그중 공개 중·엇갈림).
 */

const latestCampaign = sql`(select max(${productAuditCampaigns.id}) from ${productAuditCampaigns})`;
const TIME = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US'`);

/** 화면 판별 대기의 조건 — 별칭 i(감사 항목)·p(제품) */
const screenWaiting = sql`(i.product_id = p.id and ${openAuditRejectUniverse(latestCampaign)} and ${screenWaitSql(sql`i.id`, sql`p.id`)})`;

export type ScreenReviewItem = {
  itemId: number; productId: number; slug: string; name: string;
  /** 판정할 주소 — 공개 목록이 여는 그 주소(products.url) */
  url: string;
  /** 보류 중(공개 목록에서 빠짐)이면 그 시각(마이크로초까지 글자) */
  held: boolean; heldAt: string | null;
  /** 주인 있음(클레임·검증·메이커 권한) — 보류·자동 숨김은 주인 없는 것에만 건다 */
  owned: boolean;
  /** 수집 본문(정적 HTML 의 보이는 글, 앞뒤 공백 없이)과 글자 수 — 원본이 없으면 null */
  pageText: string | null; textLength: number | null;
  /** 첫 감사의 답 — 늘 거절이다(열린 거절). model 은 coalesce(항목의 ai_model, 그 감사의 model) */
  audit: { confidence: number | null; reason: string | null; category: AuditReasonCategory; model: string | null; reviewedAt: string | null };
  /** 이미 있는 두 번째 의견 — 출처·사유까지(글만 본 m1 의 의견이 있으면 여기 든다) */
  opinions: SecondOpinionView[];
};

type QueueRow = { item_id: number; product_id: number; slug: string; name: string; url: string; held_at: string | null; owned: boolean;
  page_text: string | null; text_length: number | null; ai_confidence: number | null; ai_reason: string | null; category: AuditReasonCategory;
  audit_model: string | null; reviewed_at: string | null; opinions: SecondOpinionView[] };

/** 그 제품의 수집 본문 — pageTextLengthSql 과 같은 문서(가장 긴 것) */
const pageTextSql = sql<string | null>`(select btrim(coalesce(td.page_meta->>'textSample', ''))
    from ${products} tp join ${crawlCandidates} tc on tc.published_slug = tp.slug join ${crawlDocuments} td on td.repo = tc.repo
   where tp.id = p.id order by char_length(btrim(coalesce(td.page_meta->>'textSample', ''))) desc, td.id limit 1)`;

/**
 * 화면 판별 대기에서 가져온다 — 공개 중 먼저, 첫 감사의 확신 높은 순, 그다음 보류 중 → 항목 id. skip 은 이번에 넘길 항목 id(판정 실패 등).
 * limit 은 1~200(기본 20)
 */
export async function screenReviewQueue(options: { limit?: number; skip?: readonly number[] } = {}): Promise<ScreenReviewItem[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20)));
  const skip = (options.skip ?? []).filter(Number.isSafeInteger);
  const rows = await db.execute<QueueRow>(sql`
    select i.id as item_id, p.id as product_id, p.slug, p.name, p.url, to_char(p.audit_hold_at, ${TIME}) as held_at,
      (not ${unownedPublic("p", { includeHeld: true })}) as owned, ${pageTextSql} as page_text, ${pageTextLengthSql(sql`p.id`)} as text_length,
      i.ai_confidence, i.ai_reason, ${auditReasonCategorySql(sql`i.ai_reason`)} as category, ${auditItemModel("i")} as audit_model,
      to_char(i.reviewed_at, ${TIME}) as reviewed_at, ${secondOpinionsField(sql`i.id`, { reasons: true })} as opinions
      from ${productAuditItems} i, ${products} p
     where ${screenWaiting}${skip.length ? sql` and i.id not in (${sql.join(skip.map((id) => sql`${id}`), sql`, `)})` : sql``}
     order by (p.audit_hold_at is not null), i.ai_confidence desc nulls last, i.id limit ${limit}`);
  return rows.map((row) => ({ itemId: row.item_id, productId: row.product_id, slug: row.slug, name: row.name, url: row.url,
    held: row.held_at !== null, heldAt: row.held_at, owned: row.owned, pageText: row.text_length === null ? null : row.page_text,
    textLength: row.text_length, opinions: row.opinions,
    audit: { confidence: row.ai_confidence === null ? null : Number(row.ai_confidence), reason: row.ai_reason, category: row.category,
      model: row.audit_model, reviewedAt: row.reviewed_at } }));
}

export type ScreenReviewCounts = {
  /** 화면 판별 대기 — 글이 적고 화면 판정이 아직 없는 열린 거절 */
  screenWait: number;
  /** 그중 공개 목록에 떠 있는 것(보류 아님) */
  screenWaitPublic: number;
  /** 엇갈림 — 확신 0.90 이상인 m1 과 다른 모델이 반대로 정한 열린 거절(글이 적은 것 포함) */
  split: number;
};

/** 화면 판별 대기·엇갈림의 수 — 감사 거절 탭의 Qwen 상태 칸·정책 처리 탭 */
export async function screenReviewCounts(): Promise<ScreenReviewCounts> {
  const [row] = await db.execute<{ screen_wait: number; screen_wait_public: number; split: number }>(sql`
    select count(*) filter (where w.wait)::int as screen_wait, count(*) filter (where w.wait and not w.held)::int as screen_wait_public,
      count(*) filter (where w.split)::int as split
      from (select ${screenWaitSql(sql`i.id`, sql`p.id`)} as wait, (p.audit_hold_at is not null) as held, ${m1SplitSql(sql`i.id`)} as split
        from ${productAuditItems} i, ${products} p where i.product_id = p.id and ${openAuditRejectUniverse(latestCampaign)}) w`);
  return { screenWait: row?.screen_wait ?? 0, screenWaitPublic: row?.screen_wait_public ?? 0, split: row?.split ?? 0 };
}

/** 화면 판정 한 줄 — productId 는 그 항목의 제품(다르면 product_mismatch 로 건너뛴다) */
export type ScreenJudgement = { itemId: number; productId: number; model: string; decision: "approve" | "reject" | "needs_review";
  confidence: number | null; reason: string | null; promptVersion: string | null; inputHash?: string | null };

const DECISIONS = new Set(["approve", "reject", "needs_review"]);

/**
 * 화면 판정을 적는다 — 그 항목은 화면 판별 대기에서 빠진다. source 는 SCREEN_REVIEW_SOURCES, actor 는 작업 로그의 누가(기본 source).
 * 같은 (항목, 모델)이 둘이면 뒤의 것만. 모양이 틀린 줄이 있으면 아무것도 적지 않고 던진다(screen_judgement_invalid·screen_source_unknown·
 * screen_model_same_as_text_m1). dryRun 이면 읽기 전용으로 셈만 한다. 결과는 옮겨 적기와 같은 셈(적은 수·푼 보류·건너뛴 까닭)
 */
export async function markScreenJudged(rows: readonly ScreenJudgement[], options: { source: string; actor?: string; lease?: JobLease; dryRun?: boolean }):
  Promise<SecondOpinionImport> {
  if (!SCREEN_REVIEW_SOURCES.has(options.source)) throw new Error("screen_source_unknown");
  const textModel = qwenDirectConfig()?.model ?? QWEN_DIRECT_DEFAULT_MODEL;
  const unique = new Map<string, SecondOpinionRow>();
  for (const row of rows) {
    const model = row.model?.trim() ?? "";
    if (!Number.isSafeInteger(row.itemId) || row.itemId <= 0 || !Number.isSafeInteger(row.productId) || row.productId <= 0 || !model
      || model.length > 160 || !DECISIONS.has(row.decision)
      || (row.confidence !== null && !(Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1))) {
      throw new Error("screen_judgement_invalid");
    }
    if (sameOpinionModel(model, textModel)) throw new Error("screen_model_same_as_text_m1");
    unique.set(`${row.itemId}:${model}`, { itemId: row.itemId, productId: row.productId, model, decision: row.decision, confidence: row.confidence,
      reason: row.reason?.trim().slice(0, 2_000) || null, inputHash: row.inputHash?.trim().slice(0, 128) || null,
      promptVersion: row.promptVersion?.trim().slice(0, 40) || null });
  }
  return writeAuditSecondOpinions(db, [...unique.values()], { dryRun: Boolean(options.dryRun), source: options.source, lease: options.lease,
    auto: { actor: options.actor ?? options.source, close: false, qwenSwitch: false } });
}
