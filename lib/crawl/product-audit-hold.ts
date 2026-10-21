import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, productAuditCampaigns, productAuditItems, productEvidenceAudit, products } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { lockProductGeneration, type ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, withJobLeaseWrite } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { classifyAuditReason } from "./audit-reason-category";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { lockedSettings, type AuditHoldSettings } from "./settings";
import { secondOpinionVotesField, type SecondOpinionVoteRow } from "./audit-second-opinions";
import { QWEN_AUTO_MIN_CONFIDENCE, secondOpinionFamily, secondRejectHolds } from "./second-opinion-rules";
import { QWEN_V2_AUTO_SOURCE } from "./qwen-direct-review";

/**
 * 감사 보류(0110, 2026-10-21 운영자 결정) — 발행분 감사가 높은 확신으로 "제품 아님"이라 한 주인 없는 공개 제품은
 * 사람이 정할 때까지 공개 목록에서 뺀다. 내리지도 지우지도 않는다 — 상태(status)는 그대로라 상세 주소는 열리고 색인만 막는다.
 *
 * 감사는 그동안 적기만 했다(product-audit.ts). 그 사이 처리 안 된 거부가 6,558건 쌓였고 그중 6,477건이 목록에 떠 있었다
 * (2026-10-21 프로드). 0.95 이상·주인 없음 2,754건은 묶어 내리기의 문턱과 같은 무리다 — 사람이 이름을 훑을 때까지 목록에서만 뺀다.
 * 확신만으로는 모자라 사유 갈래도 본다: 다시 갈라 본 표본에서 다 맞았던 갈래(빈 화면·회사 소개·남의 플랫폼·쇼핑몰)만 보류하고,
 * 글·문서·기타·로그인은 지금처럼 목록에 둔 채 사람을 기다린다(settings-schema.ts DEFAULT_AUDIT_HOLD). 다른 모델(grok 일괄,
 * product_audit_second_opinions)도 같은 항목을 거절했으면 갈래와 상관없이 보류하고, 그 모델이 승인했으면 갈래로는 걸지 않는다.
 *
 * 거는 곳은 둘이다: 감사 답을 적는 트랜잭션(recordAuditResult)과 감사 잡 틱마다 도는 쓸기(sweepAuditHolds — 밀린 것과 놓친 것).
 * 푸는 곳: 사람의 결정 — 유지(keepAuditedProduct), 상태가 바뀜(setStatusWithAudit — 내리기·차단·차단 해제), 모두 풀기 — 와
 * 두 번째 모델의 승인을 옮겨 적을 때(audit-second-opinion-import.ts, 거절 의견이 하나도 없을 때만). 새 감사의 답이 바뀌어도 풀지 않는다.
 *
 * 걸고 풀 때 product_evidence_audit 에 한 줄씩 남는다(제품 화면의 기록). 팔로한 사람에게는 알리지 않는다 — 내린 것이 아니다
 * (lib/jobs/me/notifications.ts 가 이 줄의 cdn_purges 를 읽지 않는다).
 */
export const AUDIT_HOLD_ACTOR = "system:audit-hold";
export const AUDIT_HOLD_ACTION = "audit.hold";
export const AUDIT_RELEASE_ACTION = "audit.hold.release";
/** cdn_purges.reason — 상태가 바뀐 줄(트리거 0057 의 banned·deleted 등)과 가른다 */
export const AUDIT_HOLD_PURGE = "audit_hold";
export const AUDIT_RELEASE_PURGE = "audit_release";
/**
 * 한 틱에 거는 수. 보류마다 Cloudflare 지우기 줄이 하나라(p-<slug>·lists) 지우기 잡(분당 45줄, 한 줄을 60초 뒤 한 번 더)이
 * 따라잡는 만큼만 건다 — 분당 20건, 허용 갈래 몫(표본으로 2,754건의 3분의 2쯤)이 한 시간 반 남짓에 걸린다.
 * 더 빨리 걸면 차단·내려달라는 요청의 지우기가 그 뒤로 밀린다.
 */
export const AUDIT_HOLD_SWEEP_BATCH = 20;
/** 쓸기가 틱에서 쓰는 시간의 상한 — 나머지는 모델 호출 몫이다(jobs/product-audit.ts 의 TICK_MS) */
const SWEEP_MS = 3_000;
const RELEASE_BATCH = 200;

/**
 * 보류를 푸는 까닭 — 제품 기록의 사유로 남는다. second_approve 는 두 번째 의견을 옮겨 적을 때 그 항목을 다른 모델이 승인한 것
 * (audit-second-opinion-import.ts) — 사람의 유지와 같은 길로 풀되 사람 결정으로 적지는 않는다. owned 는 주인이 생긴 것
 * (도메인 검증·클레임 markVerified, 메이커 확인 recordOwnerMembership) — 보류는 주인 없는 것에만 건다
 */
export type AuditHoldRelease = "kept" | "banned" | "unbanned" | "release_all" | "second_approve" | "owned";
/** 풀면 목록에 돌아오는 까닭 — Cloudflare 지우기 줄을 적는다(차단은 트리거가, 차단 해제는 다음 사본이 맡는다) */
const RELISTS: ReadonlySet<AuditHoldRelease> = new Set(["kept", "second_approve", "owned"]);
/** 사람(또는 두 번째 모델)이 그 제품을 본 까닭 — 그 제품의 열린 항목으로 다시 걸지 않는다 */
const SETTLES: ReadonlySet<AuditHoldRelease> = new Set(["kept", "second_approve", "unbanned"]);

const column = (alias: string) => (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

/**
 * 보류할 수 있는 제품 — 공개(seeded)이고 주인이 없다: 검증 전이고 클레임하지 않았고 메이커 권한(product_maker_members)도 없다.
 * verified 는 주인이 확인된 것이라 들지 않는다. 이미 보류된 것도 뺀다. alias 는 products 를 부르는 이름이다
 */
function unownedPublic(alias: string, options: { includeHeld?: boolean } = {}): SQL {
  const c = column(alias);
  const notHeld = options.includeHeld ? sql`` : sql` and ${c("audit_hold_at")} is null`;
  return sql`(${c("status")} = 'seeded' and ${c("claimed_at")} is null and ${c("verified_at")} is null${notHeld}
    and not exists (select 1 from ${productMakerMembers} m where m.product_id = ${c("id")} and m.revoked_at is null))`;
}

/**
 * 보류의 까닭이 될 수 있는 감사 항목 — AI 거절이고 확신이 문턱 이상이며 사람이 아직 정하지 않았고 보류를 푼 적도 없다.
 * 그 제품의 마지막 항목이어야 한다 — 새 감사가 다시 물었으면 새 답을 기다린다. 다만 답이 없는 새 항목은 그 감사가 돌고 있을 때만
 * 가린다: 중단됐거나 끝난 감사의 답 없는 항목(묻기 전에 멈춤·원본 없음·시도 소진)은 이제 답이 오지 않는다 — 옛 거절이 그대로 까닭이다.
 * 그 제품의 어느 항목이든 살아 있는 유지가 있으면 들지 않는다
 */
function holdableItem(alias: string, minConfidence: number): SQL {
  const c = column(alias);
  return sql`(${c("ai_decision")} = 'reject' and ${c("ai_confidence")} >= ${minConfidence}
    and ${c("human_decision")} is null and ${c("hold_released_at")} is null
    and not exists (select 1 from ${productAuditItems} n join ${productAuditCampaigns} nc on nc.id = n.campaign_id
      where n.product_id = ${c("product_id")} and n.id > ${c("id")} and (n.ai_decision is not null or nc.status = 'running'))
    and not exists (select 1 from ${productAuditItems} k where k.product_id = ${c("product_id")}
      and k.human_decision = 'kept' and k.keep_until > now()))`;
}

/**
 * 그 제품들의 답이 있는 열린 항목에 '풀었음'을 적는다 — 사람이(또는 두 번째 모델의 승인이) 보류를 풀면 그 제품은 지금 감사의 어느
 * 거절로도 다시 걸지 않는다. 보류의 까닭이 된 항목만 적으면 더 새 거절이나 90일 지난 유지 뒤에 쓸기가 다시 건다.
 * 답이 아직 없는 항목은 적지 않는다 — 그 답은 사람이 보기 전의 새 판단이다
 */
async function markOpenItemsReleased(tx: ProductTransaction, productIds: number[]): Promise<void> {
  if (!productIds.length) return;
  await tx.update(productAuditItems).set({ holdReleasedAt: sql`now()` }).where(and(inArray(productAuditItems.productId, productIds),
    isNull(productAuditItems.humanDecision), isNull(productAuditItems.holdReleasedAt), isNotNull(productAuditItems.aiDecision)));
}

/**
 * 보류 후보 — 보류의 까닭이 될 수 있는 감사 항목(holdableItem)이고 그 제품이 주인 없는 공개 제품이다. 이미 보류된 제품도 든다
 * (그 보류의 까닭인 항목). 둘째 문(holdGate)은 보지 않는다 — Qwen-v2 자동 의견(audit-second-opinion-auto.ts)이 물을 것을 고르고,
 * 그 의견이 둘째 문을 바꾼다. itemAlias·productAlias 는 product_audit_items·products 를 부르는 이름이다
 */
export function holdCandidate(itemAlias: string, productAlias: string, minConfidence: number): SQL {
  return sql`(${column(itemAlias)("product_id")} = ${column(productAlias)("id")} and ${holdableItem(itemAlias, minConfidence)}
    and ${unownedPublic(productAlias, { includeHeld: true })})`;
}

/** 그 항목의 두 번째 의견(모델·결정, product_audit_second_opinions) */
const secondVotes = (alias: string) => secondOpinionVotesField(column(alias)("id"));

/**
 * 보류의 둘째 문이 읽는 감사 항목 — 감사 사유, 두 번째 의견들, 이 거절을 낸 감사 모델(coalesce(항목의 ai_model, 그 감사의 model), 0112).
 * model 이 없으면 감사 모델의 규칙은 보지 않는다(옛 호출부·옮겨 적기의 승인)
 */
export type HoldGateItem = { reason: string | null | undefined; opinions: readonly HoldGateOpinion[]; model?: string | null;
  /** 이 감사 거절의 확신(ai_confidence) — Qwen 이 감사한 거절은 QWEN_AUTO_MIN_CONFIDENCE 이상이어야 보류의 까닭이 된다 */
  confidence?: number | null };
/** 두 번째 의견 한 줄 — 출처(source)·확신은 자동 의견(qwen-v2-auto)을 가르는 데 쓴다 */
export type HoldGateOpinion = SecondOpinionVoteRow & { source?: string | null; confidence?: number | null };
/**
 * 보류를 가르는 때의 조건 — autoOpinions: Qwen-v2 자동 의견(qwenAuto.auditSecondOpinion)이 켜져 있다. 꺼져 있으면 자동 의견의 거절은
 * 보류의 까닭이 아니다(grok 같은 옮겨 적은 의견은 그대로 센다). 켜져 있어도 자동 의견은 확신이 0.90 이상일 때만 센다(승인·거절 모두)
 */
export type HoldGateOptions = { autoOpinions?: boolean };

/** 이 의견을 지금 보류에서 세는가 — 자동 의견은 확신이 있고 문턱 이상이며, 거절이면 그 단계가 켜져 있을 때만 */
function countedOpinion(opinion: HoldGateOpinion, options: HoldGateOptions): boolean {
  if (opinion.source !== QWEN_V2_AUTO_SOURCE) return true;
  if (typeof opinion.confidence !== "number" || opinion.confidence < QWEN_AUTO_MIN_CONFIDENCE) return false;
  return opinion.decision !== "reject" || Boolean(options.autoOpinions);
}

/**
 * 두 번째 의견들이 보류에 무엇을 말하나 — 거절(모델별 규칙 secondRejectHolds 를 지난 것만)·승인(모델을 가리지 않는다).
 * 모델별 규칙(second-opinion-rules.ts SECOND_OPINION_REJECT_RULES): grok 의 거절은 늘 센다. Qwen 의 거절은 카탈로그·디렉터리 같은 항목
 * (감사 사유 갈래가 '남의 플랫폼·목록 페이지'이거나 directory·catalog·awesome·curated list·list of)에서 세지 않는다 — 그 항목은 '갈림'에서 사람이 본다
 */
export function secondOpinionStance(item: HoldGateItem): { secondReject: boolean; secondApprove: boolean } {
  return { secondReject: item.opinions.some((opinion) => opinion.decision === "reject" && secondRejectHolds(opinion.model, item.reason)),
    secondApprove: item.opinions.some((opinion) => opinion.decision === "approve") };
}

/**
 * 확신 문턱(holdableItem)을 지난 항목의 둘째 문 — 확신만으로는 가를 수 없었다(settings-schema.ts DEFAULT_AUDIT_HOLD).
 * (a) 사유 갈래가 허용 목록(auditHold.categories)에 들고, 두 번째 모델이 승인하지 않았고, 이 거절을 낸 감사 모델의 거절을 이 항목에서
 *     세는 모델이다 — 갈래는 감사 화면의 칩과 같은 분류(classifyAuditReason)다. 회사 소개 갈래의 정규식은 "marketing copy·promotional
 *     landing" 으로 SaaS 첫 화면도 잡는다 — 다른 모델이 열어 보고 승인했으면 목록에 두고 '갈림'으로 사람에게 넘긴다.
 *     모델별 규칙은 두 번째 의견과 같은 표다(second-opinion-rules.ts secondRejectHolds): Qwen-v2 는 진짜 둘러보기 카탈로그·디렉터리를
 *     가끔 거절하고 확신이 늘 0.95 나 1 이라 문턱으로 가를 수 없다 — Qwen 이 감사한(남은 감사 모델 바꾸기 뒤) 카탈로그·디렉터리 같은
 *     거절(갈래 platform 이거나 사유에 directory·catalog·awesome·curated list·list of)은 갈래로 걸지 않고 목록에 둔 채 사람이 본다. 또는
 * (b) 두 번째 모델도 거절했다(auditHold.secondOpinionReject 가 켜져 있을 때) — 갈래와 상관없이, 모델별 규칙을 지난 거절만(secondOpinionStance —
 *     Qwen 의 두 번째 거절도 카탈로그 같은 항목에서는 세지 않는다). 같은 모델의 두 번째 의견은 묻지 않는다(audit-second-opinion-auto.ts).
 * 판단 보류 의견은 어느 쪽에도 들지 않는다. 갈래 분류가 JS 라 SQL 조건 뒤에 건다. 쓸기·새 답·의견 옮겨 적기가 모두 이 함수로 가른다.
 */
export function holdGates(item: HoldGateItem, hold: Pick<AuditHoldSettings, "categories" | "secondOpinionReject">, options: HoldGateOptions = {}) {
  // Qwen 이 감사한 거절은 확신이 있고 0.90 이상일 때만 사람 없이 보류한다 — 없거나 낮으면 사람의 목록에 둔다
  if (item.model && secondOpinionFamily(item.model) === "qwen" && (typeof item.confidence !== "number" || item.confidence < QWEN_AUTO_MIN_CONFIDENCE)) {
    return { byCategory: false, bySecondOpinion: false };
  }
  const { secondReject, secondApprove } = secondOpinionStance({ ...item, opinions: item.opinions.filter((opinion) => countedOpinion(opinion, options)) });
  const primaryCounts = !item.model || secondRejectHolds(item.model, item.reason);
  return {
    byCategory: hold.categories.includes(classifyAuditReason(item.reason)) && !secondApprove && primaryCounts,
    bySecondOpinion: hold.secondOpinionReject && secondReject,
  };
}

export function holdGate(item: HoldGateItem, hold: Pick<AuditHoldSettings, "categories" | "secondOpinionReject">, options: HoldGateOptions = {}): boolean {
  const gates = holdGates(item, hold, options);
  return gates.byCategory || gates.bySecondOpinion;
}

/** 그 항목의 거절을 낸 감사 모델 — 비어 있으면(0112 전 답) 그 감사가 시작할 때의 모델이다. alias 는 product_audit_items 를 부르는 이름이다 */
export const auditItemModel = (alias: string) => sql<string>`coalesce(${column(alias)("ai_model")},
  (select ac.model from ${productAuditCampaigns} ac where ac.id = ${column(alias)("campaign_id")}))`;

/**
 * 감사 답이 보류로 이어질 수 있는가 — 답을 적는 트랜잭션이 제품 잠금을 잡을지 미리 가른다(켜짐·거절·확신 문턱).
 * 걸지 말지는 잠근 뒤 holdAuditedProduct 가 holdGate 까지 다시 본다
 */
export function verdictMayHold(outcome: { decision: string; confidence?: number | null }, hold: AuditHoldSettings | null): boolean {
  return Boolean(hold?.enabled) && outcome.decision === "reject" && (outcome.confidence ?? 0) >= (hold?.minConfidence ?? Infinity);
}

/**
 * 잠근 트랜잭션 안에서 보류를 건다 — 부르는 쪽이 stage → 제품 세대 → 항목 순서로 잡는다. 스위치는 여기서 다시 읽는다(lockedAuditHold).
 * 새 답(recordAuditResult)과 쓸기(sweepAuditHolds)가 모두 이것을 지난다 — 보류의 조건은 여기 한 곳이다:
 * SQL(holdableItem·unownedPublic)과 둘째 문(holdGate — 두 번째 모델이 승인하지 않은 허용 갈래, 또는 두 번째 모델의 거절).
 * 조건이 그대로일 때만 걸고, 걸었으면 true. Cloudflare 지우기 줄(그 상세의 p-<slug> 와 lists)을 같은 커밋에 적는다 —
 * 상태가 바뀌지 않아 트리거(0057)가 적지 않는다.
 */
export async function holdAuditedProduct(tx: ProductTransaction, input: { itemId: number; productId: number; slug: string }): Promise<boolean> {
  const settings = await lockedSettings(tx);
  const hold = settings.auditHold;
  if (!hold.enabled) return false;
  const [item] = await tx.select({ campaignId: productAuditItems.campaignId, aiReason: productAuditItems.aiReason,
    aiConfidence: productAuditItems.aiConfidence, opinions: secondVotes("product_audit_items"), model: auditItemModel("product_audit_items") })
    .from(productAuditItems).where(eq(productAuditItems.id, input.itemId));
  const gates = item ? holdGates({ reason: item.aiReason, opinions: item.opinions, model: item.model, confidence: item.aiConfidence }, hold,
    { autoOpinions: settings.qwenAuto.auditSecondOpinion.enabled }) : null;
  if (!item || !gates || (!gates.byCategory && !gates.bySecondOpinion)) return false;
  const [held] = await tx.update(products).set({ auditHoldAt: sql`now()`, auditHoldItemId: input.itemId })
    .where(and(eq(products.id, input.productId), eq(products.slug, input.slug), unownedPublic("products"),
      sql`exists (select 1 from ${productAuditItems} i where i.id = ${input.itemId} and i.product_id = ${input.productId}
        and ${holdableItem("i", hold.minConfidence)})`))
    .returning({ id: products.id });
  if (!held) return false;
  await tx.insert(productEvidenceAudit).values({ slug: input.slug, actor: AUDIT_HOLD_ACTOR, action: AUDIT_HOLD_ACTION,
    reason: `ai_reject · audit:${classifyAuditReason(item.aiReason)}`,
    metadata: { itemId: input.itemId, campaignId: item.campaignId, aiConfidence: item.aiConfidence, minConfidence: hold.minConfidence,
      // 어느 문으로 걸렸나 — 두 번째 모델이 승인하지 않은 허용 갈래인지, 두 번째 모델도 거절했는지. 그 거절을 낸 감사 모델(0112)
      category: classifyAuditReason(item.aiReason), auditModel: item.model, ...gates } });
  await tx.insert(cdnPurges).values({ slug: input.slug, reason: AUDIT_HOLD_PURGE });
  return true;
}

/**
 * 한 제품의 보류를 푼다 — 유지·두 번째 모델의 승인·상태 바뀜(내리기·차단·차단 해제)이 그 트랜잭션 안에서 부른다. 풀 보류가 없으면 false.
 * 차단 해제는 사람이 목록에 돌려놓은 것이라, 보류가 없었어도 그 제품의 열린 항목에 '풀었음'을 적어 쓸기가 다시 걸지 않게 한다.
 * 두 번째 모델의 승인으로 풀면 보류의 까닭이 된 항목에 '풀었음'을 적는다(사람 결정이 아니라 human_decision 은 비워 둔다).
 * 유지·승인으로 목록에 돌아오면 Cloudflare 지우기 줄을 적는다. 차단은 트리거가 적고, 차단 해제는 목록이 다음 사본(2분 안)에서 채운다.
 */
export async function releaseAuditHold(tx: ProductTransaction,
  input: { productId: number; slug: string; actor: string; reason: AuditHoldRelease }): Promise<boolean> {
  // 차단 해제는 보류가 없었어도 사람이 목록에 돌려놓은 것이다
  if (input.reason === "unbanned") await markOpenItemsReleased(tx, [input.productId]);
  const [current] = await tx.select({ heldAt: products.auditHoldAt, itemId: products.auditHoldItemId }).from(products)
    .where(and(eq(products.id, input.productId), isNotNull(products.auditHoldAt)));
  if (!current) return false;
  await tx.update(products).set({ auditHoldAt: null, auditHoldItemId: null }).where(eq(products.id, input.productId));
  if (SETTLES.has(input.reason) && input.reason !== "unbanned") await markOpenItemsReleased(tx, [input.productId]);
  await tx.insert(productEvidenceAudit).values({ slug: input.slug, actor: input.actor.slice(0, 120), action: AUDIT_RELEASE_ACTION,
    reason: input.reason, metadata: { itemId: current.itemId } });
  if (RELISTS.has(input.reason)) await tx.insert(cdnPurges).values({ slug: input.slug, reason: AUDIT_RELEASE_PURGE });
  return true;
}

/**
 * 밀린 것과 놓친 것을 건다 — 감사 잡(jobs/product-audit.ts)이 틱마다 먼저 부른다. 감사가 끝났거나 멈춰 있어도 돈다(모델을 부르지 않는다).
 *
 * 제품 하나가 한 트랜잭션이다(스팸 재검사와 같은 길): DR writer fence → stage → 제품 세대 → 항목 → 보류 → 작업 lease.
 * 이미 걸린 것·그 사이 사람이 정한 것은 holdAuditedProduct 의 조건이 걸러 몇 번 돌아도 한 번만 걸린다.
 * 한 틱에 AUDIT_HOLD_SWEEP_BATCH 건(지난 60초에 보류·풀기로 적힌 지우기 줄만큼 뺀다 — 새 답이 바로 건 보류까지 합쳐 지우기 잡이
 * 따라잡는 만큼), SWEEP_MS 안에서만 — 오래된 항목부터. 걸기 전에 먼저 유지가 남았는데 풀리지 않은 보류를 푼다(healKeptHolds).
 */
export async function sweepAuditHolds(ctx: JobContext<null>, hold: AuditHoldSettings, options: HoldGateOptions = {}): Promise<number> {
  const lease = ctx.lease;
  if (!lease) return 0;
  const startedAt = Date.now();
  await healKeptHolds(ctx, lease, startedAt);
  if (!hold.enabled || (!hold.categories.length && !hold.secondOpinionReject)) return 0;
  const [recent] = await db.select({ count: sql<number>`count(*)::int` }).from(cdnPurges).where(and(
    inArray(cdnPurges.reason, [AUDIT_HOLD_PURGE, AUDIT_RELEASE_PURGE]), sql`${cdnPurges.createdAt} > now() - interval '60 seconds'`));
  const room = Math.max(0, AUDIT_HOLD_SWEEP_BATCH - (recent?.count ?? 0));
  if (room === 0) return 0;
  const candidates = await sweepCandidates(hold, startedAt, room, options);
  let held = 0;
  for (const row of candidates) {
    if (!ctx.hasBudget() || ctx.signal?.aborted || Date.now() - startedAt > SWEEP_MS) break;
    const done = await withJobLeaseWrite(lease, async (tx) => {
      await lockPipelineInputStages(tx);
      if (!(await lockProductGeneration(tx, row.product_id, row.slug))) return false;
      // 사람의 결정(유지·내리기)과 같은 항목 잠금으로 줄을 세운다
      await tx.select({ id: productAuditItems.id }).from(productAuditItems).where(eq(productAuditItems.id, row.item_id)).for("update");
      const changed = await holdAuditedProduct(tx, { itemId: row.item_id, productId: row.product_id, slug: row.slug });
      await assertJobLeaseAtWallTime(tx, lease);
      return changed;
    });
    if (done) held += 1;
  }
  if (held) ctx.log("product_audit.held", { held, candidates: candidates.length });
  return held;
}

/** 보류의 까닭이 된 항목이나 그보다 새 항목에 사람의 유지가 있다 — 그 보류는 풀려 있어야 한다 */
const keptSinceHold = sql`exists (select 1 from ${productAuditItems} k where k.product_id = ${products.id}
  and k.human_decision = 'kept' and k.id >= ${products.auditHoldItemId})`;

/**
 * 유지가 남았는데 풀리지 않은 보류를 푼다 — 배포 순서의 틈을 메운다. 공유 배포는 reviewer 를 웹보다 먼저 올려, 옛 웹의 유지는
 * human_decision 만 적고 보류를 풀지 않는다. 스위치와 상관없이 돈다(푸는 일이다). 잠금은 유지와 같다(stage → 제품 세대).
 */
async function healKeptHolds(ctx: JobContext<null>, lease: NonNullable<JobContext<null>["lease"]>, startedAt: number): Promise<number> {
  const rows = await db.select({ id: products.id, slug: products.slug }).from(products)
    .where(and(isNotNull(products.auditHoldAt), keptSinceHold)).orderBy(asc(products.id)).limit(AUDIT_HOLD_SWEEP_BATCH);
  let healed = 0;
  for (const row of rows) {
    if (!ctx.hasBudget() || ctx.signal?.aborted || Date.now() - startedAt > SWEEP_MS) break;
    if (await withJobLeaseWrite(lease, async (tx) => {
      await lockPipelineInputStages(tx);
      if (!(await lockProductGeneration(tx, row.id, row.slug))) return false;
      const [still] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, row.id), isNotNull(products.auditHoldAt), keptSinceHold));
      const changed = still ? await releaseAuditHold(tx, { productId: row.id, slug: row.slug, actor: AUDIT_HOLD_ACTOR, reason: "kept" }) : false;
      await assertJobLeaseAtWallTime(tx, lease);
      return changed;
    })) healed += 1;
  }
  if (healed) ctx.log("product_audit.hold_healed", { healed });
  return healed;
}

/** 쓸기가 한 번에 읽는 쪽 크기 — 사유 문장까지 읽는다 */
const CANDIDATE_PAGE = 500;

/**
 * 걸 것 — SQL 조건을 지난 항목을 id 순서로 쪽마다 읽어 둘째 문(holdGate)으로 거른다. 갈래가 JS 라 SQL 의 limit 으로 자르면
 * 허용 밖 갈래(글·문서·기타)가 앞자리를 영영 차지해 쓸기가 나아가지 않는다. 그 몫은 사람이 정할 때까지 남으므로(2026-10-21 추정 1천여 건)
 * 틱마다 몇 쪽을 다시 읽는다 — id·주소·사유만이다.
 */
async function sweepCandidates(hold: AuditHoldSettings, startedAt: number, room: number, options: HoldGateOptions) {
  const picked: { item_id: number; product_id: number; slug: string }[] = [];
  for (let afterId = 0; picked.length < room && Date.now() - startedAt <= SWEEP_MS;) {
    const page = await db.execute<{ item_id: number; product_id: number; slug: string; ai_reason: string | null;
      opinions: HoldGateOpinion[]; ai_model: string | null; ai_confidence: number | null }>(sql`
      select i.id as item_id, p.id as product_id, p.slug, i.ai_reason, ${secondVotes("i")} as opinions, ${auditItemModel("i")} as ai_model,
             i.ai_confidence
        from ${productAuditItems} i join ${products} p on p.id = i.product_id
       where ${holdableItem("i", hold.minConfidence)} and ${unownedPublic("p")} and i.id > ${afterId}
       order by i.id limit ${CANDIDATE_PAGE}`);
    for (const row of page) {
      if (picked.length < room && holdGate({ reason: row.ai_reason, opinions: row.opinions, model: row.ai_model, confidence: row.ai_confidence },
        hold, options)) picked.push(row);
    }
    if (page.length < CANDIDATE_PAGE) break;
    afterId = page[page.length - 1].item_id;
  }
  return picked;
}

/**
 * 보류를 모두 푼다 — 감사 화면의 '보류 모두 풀기'. 문턱을 잘못 잡았을 때 되돌리는 길이다. 아무것도 내리지 않는다.
 *
 * RELEASE_BATCH 건씩 한 트랜잭션으로 — 제품 행을 id 순서로 잠근다. 그 제품들의 답이 있는 열린 항목에 '풀었음'을 적어 쓸기가 다시 걸지
 * 않는다(새 감사의 새 항목은 걸릴 수 있다).
 * Cloudflare 는 목록만 지운다(빈 slug 의 한 줄, cdn/purge.ts) — 상세는 엣지 사본이 5분 안에 다시 채운다.
 * 제품마다 적으면 수천 줄이 차단·내려달라는 요청의 지우기를 한 시간 넘게 밀어낸다.
 */
export async function releaseAllAuditHolds(input: { by: string; note: string | null }): Promise<number> {
  let released = 0;
  for (;;) {
    const count = await db.transaction(async (tx) => {
      await lockPipelineInputStages(tx);
      const rows = await tx.select({ id: products.id, slug: products.slug, itemId: products.auditHoldItemId }).from(products)
        .where(isNotNull(products.auditHoldAt)).orderBy(asc(products.id)).limit(RELEASE_BATCH).for("update");
      if (!rows.length) return 0;
      await tx.update(products).set({ auditHoldAt: null, auditHoldItemId: null }).where(inArray(products.id, rows.map((row) => row.id)));
      await markOpenItemsReleased(tx, rows.map((row) => row.id));
      await tx.insert(productEvidenceAudit).values(rows.map((row) => ({ slug: row.slug, actor: input.by.slice(0, 120),
        action: AUDIT_RELEASE_ACTION, reason: "release_all" as const, metadata: { itemId: row.itemId, note: input.note } })));
      await tx.insert(cdnPurges).values({ slug: "", reason: AUDIT_RELEASE_PURGE });
      return rows.length;
    });
    released += count;
    if (count < RELEASE_BATCH) return released;
  }
}

/** 지금 보류 중인 공개 제품 수 — 감사 탭·받은편지함·운영센터가 같은 수를 쓴다(products_audit_hold_idx) */
export const heldPublic = sql`(${products.auditHoldAt} is not null and ${products.status} in ('seeded', 'verified'))`;

export async function auditHoldCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(heldPublic);
  return row?.count ?? 0;
}
