import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit, productAuditCampaigns, productAuditItems, productAuditPolicyRunItems, productAuditPolicyRuns, productAuditSecondOpinions,
  products } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { classifyAuditReason } from "./audit-reason-category";
import { POLICY_KEEP_DAYS } from "./audit-policy-filter";
import { holdAuditedProduct, releaseAuditHold, unownedPublic, unreleasedOpenItems } from "./product-audit-hold";
import { QWEN_V2_AUTO_SOURCE } from "./qwen-direct-review";
import { QWEN_AUTO_MIN_CONFIDENCE, THIN_PAGE_TEXT_CHARS } from "./second-opinion-rules";
import { opposingOpinions, pageTextLengthSql, thinPageTextSql } from "./audit-text-gate";
import type { CrawlSettings } from "./settings-schema";

/**
 * Qwen-v2 두 번째 의견으로 감사 거절을 닫는다(2026-10-22 사용자 결정 "승인은 유지, 거절은 숨김"). 최종 내리기는 사람이 정책 처리
 * (/admin/audit?tab=policy, audit-policy.ts)로 한다 — 여기서는 아무것도 내리지 않는다.
 *
 * 감사 잡의 자동 의견(audit-second-opinion-auto.ts)이 의견을 적는 바로 그 트랜잭션에서 부른다(audit-second-opinion-import.ts
 * writeAuditSecondOpinions). 잠금은 보류 쓸기·정책 처리와 같은 차례다: DR writer fence → stage → 제품 세대 → 감사 항목 → 설정 행 →
 * (여기) 자동 실행 행 → 작업 lease. 스위치(qwenAuto.auditSecondOpinion.autoClose·auditHold.enabled)는 잠근 설정 행에서 다시 읽은 값이다.
 *
 *  - 글이 적은 페이지(수집 본문 300자 아래·원본 없음, audit-text-gate.ts)는 승인·거절 모두 닫지 않는다(2026-10-22 사용자 결정 "글이 적은
 *    페이지는 늘 화면을 보고 판정한다") — m1 은 글만 본다. 의견은 남고 그 항목은 '화면 판별 대기'로 화면 판정(audit-screen-review.ts)을 기다린다.
 *    보류의 둘째 문도 그 의견을 세지 않는다(product-audit-hold.ts countedOpinion — 쓸기가 m1 거절로 숨기지도, m1 승인으로 풀지도 않는다).
 *  - 승인 · 확신 0.90 이상 · 다른 모델의 거절 의견 없음 → 유지(사람의 유지와 같은 길: human_decision kept, 누가 qwen-v2-auto, 기한은 정책
 *    처리의 기본 90일). 그 제품이 보류 중이면 같은 커밋에서 푼다(사람의 유지·정책 유지와 같다 — 이 항목이 까닭이 아니어도 쓸기의 healKeptHolds 가
 *    곧 풀므로 여기서 기록과 함께 푼다). 다른 모델이 거절했으면(엇갈림) 열어 둔다.
 *  - 거절 · 확신 0.90 이상 · 주인 없음(클레임·검증·메이커 권한 없음) · 다른 모델의 승인 없음 → 숨김(감사 보류, product-audit-hold.ts
 *    holdAuditedProduct 의 자동 숨김 길). 다른 모델이 승인했으면(엇갈림, 2026-10-22 사용자 결정 "다른 모델이 승인했으면 숨기지 않는다") 승인
 *    쪽과 같이 열어 둔다 — 보류의 둘째 문도 그 m1 거절을 세지 않는다. 첫 감사의 확신·사유 갈래와 상관없이 — 카탈로그 예외(Qwen 거절은
 *    카탈로그·디렉터리 같은 항목에서 세지 않음)도 이 길에는 걸지 않는다(사용자 지시: 갈래와 상관없이, 2026-10-22 결정에서도 바꾸지 않음).
 *    주인 있는 제품, 이미 보류된 것, 사람·정책이 보류를 푼 항목(hold_released_at), 그 제품에 살아 있는 유지가 있는 것, 더 새 감사 답이 있는 것,
 *    감사 보류 스위치가 꺼진 것은 열어 둔다.
 *  - 엇갈려 열어 둔 것은 작업 로그에 audit-auto-split 한 줄을 남긴다 — m1 과 반대 결정을 낸 모델들의 결정·확신·사유를 함께(2차 갈림
 *    판가름이 두 모델의 판단을 작업 로그에 남기는 것과 같은 꼴). 의견은 product_audit_second_opinions 에 남아 감사 줄이 두 사유를 보인다.
 *  - 운영자가 그 항목에 대한 정책 실행(자동 실행 포함)을 되돌렸으면 새 판의 답이 와도 닫지 않는다.
 *  - 그 밖(확신 낮음·판단 보류·오류)은 열어 둔다.
 *
 * 보이기·되돌리기: 자동으로 한 일마다 정책 실행 일지(product_audit_policy_runs·_run_items, 0116)에 한 줄 — UTC 하루·행동마다 시스템 실행
 * 하나(누가 qwen-v2-auto)에 덧붙인다. 실행은 처음부터 '적용함'이라 '적용 중' 하나뿐 규칙(one_active_idx)을 잡지 않고, 운영자는 정책 처리 탭에서
 * 그 실행을 그대로 되돌린다(유지 → 유지를 지우고 풀었던 보류를 다시 건다, 숨김 → 보류를 풀고 그 제품의 열린 항목에 '풀었음'을 적어 쓸기가 다시
 * 걸지 않게). 되돌린 뒤에도 Qwen 의견은 남아 같은 모델·판으로 다시 묻지 않는다 — 사람이 본다.
 * 실행 칸(kind·action)은 0116 의 검사 안에서 적는다(마이그레이션 없이): 유지는 close·keep, 숨김은 close·release 이고 뜻은 options.auto.action 이
 * 정한다 — 이 표를 읽는 곳은 autoRunInfo 로 먼저 가른다(audit-policy.ts handlerOf·listPolicyRuns). 작업 로그에도 한 건마다
 * audit-auto-keep·audit-auto-hold 를 남긴다(사람이 정하지 않은 공개 목록 변화 — audit-hold-auto-release 와 같은 까닭).
 */

export const AUTO_CLOSE_ACTOR = QWEN_V2_AUTO_SOURCE;
/** 자동으로 닫는 확신 하한 — 사람 없이 정하는 Qwen-v2 자동 단계의 하한과 같다(second-opinion-rules.ts) */
export const AUTO_CLOSE_MIN_CONFIDENCE = QWEN_AUTO_MIN_CONFIDENCE;
/** 자동 유지의 기한 — 정책 처리의 기본(사람의 유지 KEEP_DAYS 와 같은 90일) */
export const AUTO_CLOSE_KEEP_DAYS: number = POLICY_KEEP_DAYS[0];
export const AUTO_KEEP_ACTION = "audit-auto-keep";
export const AUTO_HOLD_ACTION = "audit-auto-hold";
/** 엇갈려 열어 둔 것 — 작업 로그에 두 모델의 결정·사유를 남긴다 */
export const AUTO_SPLIT_ACTION = "audit-auto-split";
/** 작업 로그에 싣는 사유의 길이 — 전문은 product_audit_second_opinions 에 있다 */
const SPLIT_REASON_LIMIT = 1_000;

export type AutoRunAction = "keep" | "hold";
/** 자동 실행의 뜻 — product_audit_policy_runs.options.auto */
export type AutoRunInfo = { by: string; action: AutoRunAction; day: string; model: string | null; promptVersion: string | null; minConfidence: number };

/** 0116 의 action 검사 안의 값 — 뜻은 options.auto.action 이다 */
const RUN_ACTION: Record<AutoRunAction, "keep" | "release"> = { keep: "keep", hold: "release" };
const TIME = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US'`);

/** UTC 날짜 — 자동 실행 하나의 하루 */
export const utcDay = (now = new Date()): string => now.toISOString().slice(0, 10);

/** 그 실행이 자동 실행이면 그 뜻 — 아니면 null(사람이 만든 정책 실행) */
export function autoRunInfo(run: { options: unknown }): AutoRunInfo | null {
  const options = run.options !== null && typeof run.options === "object" ? run.options as Record<string, unknown> : null;
  const auto = options?.auto !== null && typeof options?.auto === "object" ? options.auto as Record<string, unknown> : null;
  if (!auto || (auto.action !== "keep" && auto.action !== "hold")) return null;
  return { by: String(auto.by ?? ""), action: auto.action, day: String(auto.day ?? ""), model: typeof auto.model === "string" ? auto.model : null,
    promptVersion: typeof auto.promptVersion === "string" ? auto.promptVersion : null,
    minConfidence: typeof auto.minConfidence === "number" ? auto.minConfidence : AUTO_CLOSE_MIN_CONFIDENCE };
}

/** 화면 이름 — 'm1 자동 유지 · 2026-10-22(UTC)' */
export function autoRunLabel(info: AutoRunInfo): string {
  return `m1 자동 ${info.action === "keep" ? "유지" : "숨김"} · ${info.day}(UTC)`;
}

/** 그 항목이 지금 어떤가 — 잠근 뒤 읽는다 */
export type AutoCloseState = {
  /** 열린 거절 — AI 거절·사람 결정 없음·공개 상태·주소 그대로 */
  open: boolean;
  /** 다른 모델(이름이 다른)의 거절 의견이 있다 */
  otherReject: boolean;
  /** 다른 모델(이름이 다른)의 승인 의견이 있다 — m1 의 거절과 엇갈림 */
  otherApprove: boolean;
  /** 그 제품의 수집 본문이 적다(300자 아래·원본 없음) — 글만 본 m1 의 답으로 닫지 않는다(화면 판별 대기) */
  thinText: boolean;
  /** 주인 없는 공개 제품(seeded·클레임 없음·검증 없음·메이커 권한 없음, 보류 중 포함) */
  unowned: boolean;
  held: boolean;
  /** 사람·정책·두 번째 모델 승인이 이 항목의 보류를 푼 적이 있다(hold_released_at) */
  settled: boolean;
  /** 그 제품의 어느 항목에 살아 있는 유지가 있다 */
  keptElsewhere: boolean;
  /** 그 제품에 더 새 감사 답(또는 돌고 있는 감사의 새 항목)이 있다 */
  superseded: boolean;
  /** 운영자가 이 항목에 대한 정책 실행(자동 실행 포함)을 되돌렸다 — 되돌림은 '사람이 본다'는 뜻이라 새 판의 답으로도 다시 닫지 않는다 */
  reverted: boolean;
};
export type AutoCloseSkip = "off" | "needs_review" | "low_confidence" | "not_open" | "reverted" | "thin_text" | "split" | "hold_off" | "owned"
  | "held_already" | "settled" | "kept" | "superseded";
export type AutoCloseVerdict = { action: AutoRunAction } | { action: null; skip: AutoCloseSkip };

/**
 * 규칙 — 무엇을 할지(순수 함수). autoClose: qwenAuto.auditSecondOpinion.autoClose, holdEnabled: auditHold.enabled(잠근 설정 행의 값)
 */
export function autoCloseVerdict(opinion: { decision: string; confidence: number | null }, state: AutoCloseState,
  switches: { autoClose: boolean; holdEnabled: boolean }): AutoCloseVerdict {
  if (!switches.autoClose) return { action: null, skip: "off" };
  if (opinion.decision !== "approve" && opinion.decision !== "reject") return { action: null, skip: "needs_review" };
  if (typeof opinion.confidence !== "number" || !(opinion.confidence >= AUTO_CLOSE_MIN_CONFIDENCE)) return { action: null, skip: "low_confidence" };
  if (!state.open) return { action: null, skip: "not_open" };
  if (state.reverted) return { action: null, skip: "reverted" };
  // 글이 적은 페이지는 화면을 보고 판정한다 — 엇갈림보다 먼저(그 m1 의견은 보류의 둘째 문에서도 세지 않는다)
  if (state.thinText) return { action: null, skip: "thin_text" };
  if (opinion.decision === "approve") return state.otherReject ? { action: null, skip: "split" } : { action: "keep" };
  // 다른 모델이 승인했으면 숨기지 않는다 — 승인 쪽과 같이 엇갈림으로 열어 둔다(주인·보류 스위치보다 먼저 — 엇갈림은 늘 기록한다)
  if (state.otherApprove) return { action: null, skip: "split" };
  if (!switches.holdEnabled) return { action: null, skip: "hold_off" };
  if (!state.unowned) return { action: null, skip: "owned" };
  if (state.held) return { action: null, skip: "held_already" };
  if (state.settled) return { action: null, skip: "settled" };
  if (state.keptElsewhere) return { action: null, skip: "kept" };
  if (state.superseded) return { action: null, skip: "superseded" };
  return { action: "hold" };
}

/** 앞의 게이트웨이 자리 표시('[gpu3090] ')를 뗀 소문자 모델 이름 — 다른 모델인지 가른다(second-opinion-rules.ts sameOpinionModel 과 같다) */
const bareModel = (model: SQL) => sql`lower(regexp_replace(trim(${model}), '^\\[[^]]*\\]\\s*', ''))`;

/**
 * 닫을 수 있는 의견의 SQL — autoCloseVerdict 와 같은 규칙(스위치 autoClose 는 부르는 쪽이 본다). 별칭 i(감사 항목)·p(제품)·o(그 의견).
 * 열린 거절인지는 부르는 쪽의 범위(감사 두 번째 의견의 auditScope)가 본다. 이미 받은 답으로 닫는 따라잡기(audit-second-opinion-auto.ts)가
 * 닫히지 않을 것을 틱마다 다시 고르지 않게 미리 거른다 — 쓰기는 잠근 뒤 autoCloseOpinion 이 다시 가른다
 */
export function autoClosableSql(holdEnabled: boolean): SQL {
  return sql`(o.confidence >= ${AUTO_CLOSE_MIN_CONFIDENCE} and not ${thinPageTextSql(sql`p.id`)} and (
    (o.decision = 'approve' and not exists (select 1 from ${productAuditSecondOpinions} o5 where o5.item_id = i.id and o5.decision = 'reject'
      and ${bareModel(sql`o5.model`)} <> ${bareModel(sql`o.model`)}))
    or (o.decision = 'reject' and ${holdEnabled} and ${unownedPublic("p")} and i.hold_released_at is null
      and not exists (select 1 from ${productAuditSecondOpinions} o6 where o6.item_id = i.id and o6.decision = 'approve'
        and ${bareModel(sql`o6.model`)} <> ${bareModel(sql`o.model`)})
      and not exists (select 1 from ${productAuditItems} k5 where k5.product_id = i.product_id and k5.human_decision = 'kept' and k5.keep_until > now())
      and not exists (select 1 from ${productAuditItems} n5 join ${productAuditCampaigns} nc5 on nc5.id = n5.campaign_id
        where n5.product_id = i.product_id and n5.id > i.id and (n5.ai_decision is not null or nc5.status = 'running')))))`;
}

export type AutoCloseResult = { action: "kept" | "held"; runId: number; releasedHold: boolean }
  | { action: null; skip: AutoCloseSkip | "journal_conflict" | "changed" };

export type AutoCloseInput = { itemId: number; productId: number; slug: string; model: string; decision: string; confidence: number | null;
  promptVersion: string | null; actor: string;
  /** 잠근 설정 행(lockedSettings)에서 읽은 설정 */
  settings: Pick<CrawlSettings, "auditHold" | "qwenAuto"> };

type StateRow = { ai_decision: string | null; human_decision: string | null; settled: boolean; ai_reason: string | null; ai_confidence: number | null;
  campaign_id: number; status: string; slug_ok: boolean; held_at: string | null; hold_item_id: number | null; unowned: boolean; other_reject: boolean;
  other_approve: boolean; text_length: number | null; kept_elsewhere: boolean; superseded: boolean; reverted: boolean };

async function readState(tx: ProductTransaction, input: AutoCloseInput): Promise<StateRow | null> {
  const [row] = await tx.execute<StateRow>(sql`
    select i.ai_decision, i.human_decision, (i.hold_released_at is not null) as settled, i.ai_reason, i.ai_confidence, i.campaign_id,
      p.status, (p.slug = ${input.slug}) as slug_ok, to_char(p.audit_hold_at, ${TIME}) as held_at, p.audit_hold_item_id as hold_item_id,
      ${unownedPublic("p", { includeHeld: true })} as unowned,
      exists (select 1 from ${productAuditSecondOpinions} o where o.item_id = i.id and o.decision = 'reject'
        and ${bareModel(sql`o.model`)} <> ${bareModel(sql`${input.model}`)}) as other_reject,
      exists (select 1 from ${productAuditSecondOpinions} o where o.item_id = i.id and o.decision = 'approve'
        and ${bareModel(sql`o.model`)} <> ${bareModel(sql`${input.model}`)}) as other_approve,
      ${pageTextLengthSql(sql`p.id`)} as text_length,
      exists (select 1 from ${productAuditItems} k where k.product_id = i.product_id and k.human_decision = 'kept' and k.keep_until > now()) as kept_elsewhere,
      exists (select 1 from ${productAuditItems} n join ${productAuditCampaigns} nc on nc.id = n.campaign_id
        where n.product_id = i.product_id and n.id > i.id and (n.ai_decision is not null or nc.status = 'running')) as superseded,
      exists (select 1 from ${productAuditPolicyRunItems} ri where ri.item_id = i.id and ri.state in ('undone', 'undo_blocked')) as reverted
      from ${productAuditItems} i join ${products} p on p.id = i.product_id
     where i.id = ${input.itemId} and p.id = ${input.productId}`);
  return row ?? null;
}

const stateOf = (row: StateRow): AutoCloseState => ({
  open: row.ai_decision === "reject" && row.human_decision === null && (row.status === "seeded" || row.status === "verified") && row.slug_ok,
  otherReject: row.other_reject, otherApprove: row.other_approve,
  // thinPageTextSql 과 같은 뜻 — 원본이 없으면(null) 글을 확인할 수 없어 적은 것으로 본다
  thinText: row.text_length === null || row.text_length < THIN_PAGE_TEXT_CHARS,
  unowned: row.unowned, held: row.held_at !== null, settled: row.settled, keptElsewhere: row.kept_elsewhere,
  superseded: row.superseded, reverted: row.reverted,
});

/**
 * 엇갈려 열어 둔 것을 작업 로그에 남긴다 — m1 의 결정·확신·사유와 반대 결정을 낸 다른 모델들의 것(같은 트랜잭션에서 막 적은 의견 포함).
 * 사유는 SPLIT_REASON_LIMIT 자까지(전문은 의견 표). 다른 판으로 다시 물어 또 엇갈리면 그때마다 한 줄이다
 */
async function recordSplit(tx: ProductTransaction, input: AutoCloseInput, row: StateRow): Promise<void> {
  const opinions = await tx.select({ model: productAuditSecondOpinions.model, source: productAuditSecondOpinions.source,
    decision: productAuditSecondOpinions.decision, confidence: productAuditSecondOpinions.confidence, reason: productAuditSecondOpinions.reason })
    .from(productAuditSecondOpinions).where(eq(productAuditSecondOpinions.itemId, input.itemId));
  const reason = (text: string | null | undefined) => text ? text.slice(0, SPLIT_REASON_LIMIT) : null;
  const mine = opinions.find((opinion) => opinion.model === input.model);
  await tx.insert(operationsAudit).values({ actor: input.actor.slice(0, 120), actorKind: "model", ok: true, action: AUTO_SPLIT_ACTION,
    target: input.slug.slice(0, 200), detail: {
      itemId: input.itemId, productId: input.productId, aiConfidence: row.ai_confidence, category: classifyAuditReason(row.ai_reason),
      m1: { model: input.model, decision: input.decision, confidence: input.confidence, promptVersion: input.promptVersion, reason: reason(mine?.reason) },
      others: opposingOpinions({ model: input.model, decision: input.decision }, opinions).map((other) => ({ model: other.model, source: other.source,
        decision: other.decision, confidence: other.confidence, reason: reason(other.reason) })),
    } });
}

/**
 * 그날의 자동 실행 — UTC 하루·행동마다 '적용함' 실행 하나를 찾고, 없으면(첫 건·운영자가 되돌리는 중이거나 되돌림) 새로 만든다.
 * 같은 하루·행동의 쓰기는 advisory lock 으로 줄을 세우고, 실행 행을 잠가 운영자의 되돌리기 시작(startAuditPolicyUndo — 실행 행 FOR UPDATE)과
 * 엇갈리지 않는다: 되돌리기가 먼저 커밋되면 이 쓰기는 그 실행을 보지 못해 새 실행에 적는다
 */
async function autoRun(tx: ProductTransaction, input: AutoCloseInput, action: AutoRunAction): Promise<number> {
  const day = utcDay();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`audit-auto-run:${input.actor}:${action}:${day}`}))`);
  const [found] = await tx.select({ id: productAuditPolicyRuns.id }).from(productAuditPolicyRuns)
    .where(and(eq(productAuditPolicyRuns.createdBy, input.actor.slice(0, 120)), eq(productAuditPolicyRuns.status, "applied"),
      sql`${productAuditPolicyRuns.options}->'auto'->>'action' = ${action}`, sql`${productAuditPolicyRuns.options}->'auto'->>'day' = ${day}`))
    .orderBy(desc(productAuditPolicyRuns.id)).limit(1).for("update");
  if (found) return found.id;
  const auto: AutoRunInfo = { by: input.actor, action, day, model: input.model, promptVersion: input.promptVersion, minConfidence: AUTO_CLOSE_MIN_CONFIDENCE };
  const text = `수집 본문 ${THIN_PAGE_TEXT_CHARS}자 이상`;
  const filterText = action === "keep"
    ? `Qwen-v2(${input.model}) 승인 · 확신 ${AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상 · 다른 모델 거절 없음 · ${text} → 유지 ${AUTO_CLOSE_KEEP_DAYS}일`
    : `Qwen-v2(${input.model}) 거절 · 확신 ${AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상 · 주인 없음 · 다른 모델 승인 없음 · ${text} → 숨김(보류)`;
  const [run] = await tx.insert(productAuditPolicyRuns).values({ kind: "close", action: RUN_ACTION[action], status: "applied", appliedAt: sql`now()`,
    planned: 0, filter: { auto: action, decision: action === "keep" ? "approve" : "reject", minConfidence: AUTO_CLOSE_MIN_CONFIDENCE },
    options: { auto, keepDays: AUTO_CLOSE_KEEP_DAYS, filterText }, summary: {},
    note: `감사 두 번째 의견 자동 닫기 · ${day}(UTC)`, createdBy: input.actor.slice(0, 120) }).returning({ id: productAuditPolicyRuns.id });
  return run.id;
}

/** 그 실행에 이 항목이 이미 있다 — 한 실행에 한 항목은 한 줄(0116). 같은 날 같은 항목을 두 번 닫으려 하면(다른 판으로 다시 물음) 열어 둔다 */
async function journaled(tx: ProductTransaction, runId: number, itemId: number): Promise<boolean> {
  const [row] = await tx.select({ id: productAuditPolicyRunItems.id }).from(productAuditPolicyRunItems)
    .where(and(eq(productAuditPolicyRunItems.runId, runId), eq(productAuditPolicyRunItems.itemId, itemId)));
  return Boolean(row);
}

async function journal(tx: ProductTransaction, runId: number, input: AutoCloseInput, value: { before: Record<string, unknown>; after: Record<string, unknown> }) {
  await tx.insert(productAuditPolicyRunItems).values({ runId, itemId: input.itemId, productId: input.productId, slug: input.slug, state: "applied",
    payload: { model: input.model, decision: input.decision, confidence: input.confidence, promptVersion: input.promptVersion },
    before: value.before, after: value.after, appliedAt: sql`now()` });
  await tx.update(productAuditPolicyRuns).set({ planned: sql`${productAuditPolicyRuns.planned} + 1` }).where(eq(productAuditPolicyRuns.id, runId));
}

/**
 * 막 적은 의견으로 그 항목을 닫는다 — 부르는 쪽이 제품 세대와 감사 항목을 잠근 트랜잭션 안에서. 무엇을 했는지(유지·숨김) 또는 왜 열어
 * 두었는지를 돌려준다. 몇 번 불려도 한 번만 닫는다: 유지한 항목은 열린 거절이 아니고, 숨긴 제품은 이미 보류 중이다
 */
export async function autoCloseOpinion(tx: ProductTransaction, input: AutoCloseInput): Promise<AutoCloseResult> {
  const row = await readState(tx, input);
  if (!row) return { action: null, skip: "not_open" };
  const verdict = autoCloseVerdict({ decision: input.decision, confidence: input.confidence }, stateOf(row),
    { autoClose: input.settings.qwenAuto.auditSecondOpinion.autoClose, holdEnabled: input.settings.auditHold.enabled });
  if (verdict.action === null) {
    if (verdict.skip === "split") await recordSplit(tx, input, row);
    return verdict;
  }
  const runId = await autoRun(tx, input, verdict.action);
  if (await journaled(tx, runId, input.itemId)) return { action: null, skip: "journal_conflict" };
  const actor = input.actor.slice(0, 120);
  const detail = { itemId: input.itemId, productId: input.productId, policyRunId: runId, model: input.model, promptVersion: input.promptVersion,
    confidence: input.confidence, aiConfidence: row.ai_confidence, category: classifyAuditReason(row.ai_reason) };
  if (verdict.action === "keep") {
    // 사람의 유지(keepAuditedProduct)·정책 유지(audit-policy.ts closeKeep)와 같은 칸 — 되돌리기는 closeKeep 의 되돌리기를 그대로 쓴다
    const [kept] = await tx.update(productAuditItems).set({ humanDecision: "kept", humanBy: actor, humanAt: sql`now()`,
      humanNote: `m1 자동 유지 · 정책 #${runId}`.slice(0, 500), keepUntil: sql`now() + ${AUTO_CLOSE_KEEP_DAYS} * interval '1 day'` })
      .where(and(eq(productAuditItems.id, input.itemId), sql`${productAuditItems.humanDecision} is null`))
      .returning({ keepUntil: sql<string>`to_char(${productAuditItems.keepUntil}, ${TIME})` });
    if (!kept) return { action: null, skip: "changed" };
    let releasedIds: number[] = [];
    let releasedHold = false;
    if (row.held_at) {
      releasedIds = await unreleasedOpenItems(tx, input.productId);
      releasedHold = await releaseAuditHold(tx, { productId: input.productId, slug: input.slug, actor, reason: "kept",
        metadata: { policyRunId: runId, auto: true, model: input.model, confidence: input.confidence } });
      if (!releasedHold) releasedIds = [];
    }
    await journal(tx, runId, input, { before: { status: row.status, heldAt: row.held_at, holdItemId: row.hold_item_id, releasedIds },
      after: { keepUntil: kept.keepUntil } });
    await tx.insert(operationsAudit).values({ actor, actorKind: "model", ok: true, action: AUTO_KEEP_ACTION, target: input.slug.slice(0, 200),
      detail: { ...detail, releasedHold } });
    return { action: "kept", runId, releasedHold };
  }
  const held = await holdAuditedProduct(tx, { itemId: input.itemId, productId: input.productId, slug: input.slug,
    auto: { actor, metadata: { policyRunId: runId, by: actor, model: input.model, confidence: input.confidence, promptVersion: input.promptVersion } } });
  if (!held) return { action: null, skip: "changed" };
  const [after] = await tx.execute<{ held_at: string }>(sql`select to_char(audit_hold_at, ${TIME}) as held_at from ${products} where id = ${input.productId}`);
  await journal(tx, runId, input, { before: { status: row.status, heldAt: null, holdItemId: null },
    after: { heldAt: after?.held_at ?? null, holdItemId: input.itemId } });
  await tx.insert(operationsAudit).values({ actor, actorKind: "model", ok: true, action: AUTO_HOLD_ACTION, target: input.slug.slice(0, 200), detail });
  return { action: "held", runId, releasedHold: false };
}

export type AutoCloseToday = { day: string; kept: number; held: number; undone: number };

/** 오늘(UTC) 자동으로 닫은 수 — 유지·숨김(되돌린 것 포함)과 그중 되돌린 수. 정책 처리 탭·Qwen 상태 칸이 보인다 */
export async function autoCloseToday(actor = AUTO_CLOSE_ACTOR, day = utcDay()): Promise<AutoCloseToday> {
  const rows = await db.execute<{ action: string; acted: number; undone: number }>(sql`
    select r.options->'auto'->>'action' as action,
      count(ri.id) filter (where ri.state in ('applied', 'undo_blocked', 'undone'))::int as acted,
      count(ri.id) filter (where ri.state = 'undone')::int as undone
      from ${productAuditPolicyRuns} r left join ${productAuditPolicyRunItems} ri on ri.run_id = r.id
     where r.created_by = ${actor.slice(0, 120)} and r.options->'auto'->>'day' = ${day} group by 1`);
  const of = (action: AutoRunAction) => [...rows].find((row) => row.action === action);
  return { day, kept: of("keep")?.acted ?? 0, held: of("hold")?.acted ?? 0, undone: [...rows].reduce((sum, row) => sum + row.undone, 0) };
}
