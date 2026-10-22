import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, operationsAudit, productAuditCampaigns, productAuditItems, productAuditPolicyRunItems, productAuditPolicyRuns,
  productAuditSecondOpinions, productEvidenceAudit, products, takedownRequests, type ProductAuditPolicyRun } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { lockProductGeneration, type ProductTransaction } from "@/lib/domain/products/generation";
import { setStatusWithAudit, uniqueViolation } from "@/lib/domain/products/repository";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { logger } from "@/lib/observability/logger";
import { AUDIT_REASON_CATEGORIES, classifyAuditReason, type AuditReasonCategory } from "./audit-reason-category";
import { auditReasonCategorySql, secondOpinionFilter, secondOpinionsField, type SecondOpinionView } from "./audit-second-opinions";
import { describePolicyFilter, policyFilterSchema, stratifiedQuotas, type PolicyAction, type PolicyFilter, type PolicyStart } from "./audit-policy-filter";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { AUDIT_HOLD_ACTION, AUDIT_HOLD_PURGE, AUDIT_RELEASE_PURGE, auditItemModel, releaseAuditHold, unownedPublic,
  unreleasedOpenItems } from "./product-audit-hold";
import { auditBanReason, GROUP_REMOVE_MIN_CONFIDENCE, keptContentStatus } from "./product-audit";
import { getSettings, lockedSettings } from "./settings";
import { importHoldEffect } from "./audit-import-gate";
import { autoRunInfo, type AutoRunInfo } from "./audit-auto-close";

/**
 * 감사 정책 처리(0116, 2026-10-22) — 열린 감사 거절을 거르기로 골라 한 번에 닫는다. 미리 보고, 수를 적어 적용하고, 실행 하나를 통째로 되돌린다.
 *
 * 대상(universe)은 감사 화면이 보이는 것과 같다: 마지막 감사의 열린 AI 거절(사람 결정 없음·제품이 공개 상태)과, 지난 감사의 항목으로
 * 보류 중인 것(그 제품에 마지막 감사의 열린 거절이 없을 때 — 같은 제품을 두 줄로 세지 않는다). 거르기는 audit-policy-filter.ts 다.
 *
 * 적용의 뜻은 사람이 한 건씩 누를 때와 같다:
 *  - 내리기: removeOne 과 같은 차단(setStatusWithAudit · 사유 not_product · audit:<갈래>)과 사람 결정 removed. 지금 묶어 내리기의 문턱을
 *    그대로 지킨다 — 확신 0.95 이상, 주인 없음(클레임·검증·메이커 권한 없음), 갈림 아님. 여기에 두 번째 모델이 승인한 것도 뺀다.
 *  - 유지: keepAuditedProduct 와 같은 사람 결정 kept·유지 기한, 보류 중이면 같은 커밋에서 푼다.
 * 항목마다 한 트랜잭션이다: DR writer fence → stage → 제품 세대 → 감사 항목 → 실행 항목. 잠근 뒤 거르기와 문턱을 그 항목에 다시 걸어 맞지
 * 않으면 건너뛰고 까닭을 남긴다. 실행 항목의 상태(pending → applied/skipped)가 같은 커밋에 적혀 몇 번 불러도 한 번만 적용된다.
 *
 * 나눠 돌기: 한 번 부르면 POLICY_CHUNK 건 또는 POLICY_CHUNK_MS 안에서만 돌고 남은 수를 돌려준다 — 화면이 끝날 때까지 다시 부른다.
 * 창을 닫아도 실행은 '적용 중'으로 남아 화면이 남은 수와 '이어서 적용'을 보인다. 적용·되돌리기 중인 실행은 한 번에 하나다.
 * 작업 로그에는 실행마다 한 줄 — 다 적용했을 때 audit-policy-apply(정책·거르기·수·누가), 다 되돌렸을 때 audit-policy-undo.
 *
 * Cloudflare: 차단은 트리거(0057)가 제품마다 지우기 줄을 적는다 — 지난 60초에 적힌 줄이 지우기 잡 한 번 몫(PURGE_BATCH)을 넘으면 기다린다
 * (보류 쓸기 AUDIT_HOLD_SWEEP_BATCH 와 같은 셈). 유지·보류 풀기는 제품마다 적지 않고 묶음마다 목록 줄 하나만 적는다(releaseAllAuditHolds 와 같다).
 */

/** 한 번 부를 때 손대는 항목 수와 시간의 상한 — 요청 하나가 10초 안에 끝나게 */
export const POLICY_CHUNK = 50;
export const POLICY_CHUNK_MS = 8_000;
/** 지난 60초에 적힌 Cloudflare 지우기 줄의 상한 — 지우기 잡 한 번(분당)의 몫(lib/cdn/purge.ts PURGE_BATCH) */
export const POLICY_CDN_ROOM = 45;
/** 표본 수 */
export const POLICY_SAMPLE = 20;
const SKIP_EXAMPLES = 5;
const INSERT_BATCH = 1_000;

// ─────────────────────────── 거르기 → SQL ───────────────────────────

type PolicyContext = { latest: number; autoOpinions: boolean };

const FROM = sql`from ${productAuditItems} i join ${products} p on p.id = i.product_id join ${productAuditCampaigns} c on c.id = i.campaign_id`;
/** 주인 없는 공개 제품(보류 중 포함) — 보류와 같은 정의(product-audit-hold.ts unownedPublic): seeded·클레임 없음·검증 없음·메이커 권한 없음 */
const unownedSql = () => unownedPublic("p", { includeHeld: true });

/**
 * 감사 화면이 보이는 열린 거절 — 마지막 감사의 것과, 지난 감사의 항목으로 보류 중인 것(그 제품에 마지막 감사의 열린 거절이 없을 때).
 * 별칭은 i(product_audit_items)·p(products)다. Qwen-v2 감사 두 번째 의견(audit-second-opinion-auto.ts scope all)도 같은 대상을 묻는다
 */
export function openAuditRejectUniverse(latest: number | SQL): SQL {
  return universeSql(latest);
}

function universeSql(latest: number | SQL): SQL {
  return sql`(i.ai_decision = 'reject' and i.human_decision is null and p.status in ('seeded', 'verified')
    and (i.campaign_id = ${latest} or (p.audit_hold_at is not null and p.audit_hold_item_id = i.id
      and not exists (select 1 from ${productAuditItems} n where n.product_id = i.product_id and n.campaign_id = ${latest}
        and n.ai_decision = 'reject' and n.human_decision is null))))`;
}

function secondSql(filter: PolicyFilter, ctx: PolicyContext): SQL | null {
  const source = filter.secondSource ? sql` and o3.source = ${filter.secondSource}` : sql``;
  const opinion = (decision?: "approve" | "reject") =>
    sql`exists (select 1 from ${productAuditSecondOpinions} o3 where o3.item_id = i.id${source}${decision ? sql` and o3.decision = ${decision}` : sql``})`;
  const options = { primary: { provider: sql`i.ai_provider`, model: auditItemModel("i") }, autoOpinions: ctx.autoOpinions };
  switch (filter.second) {
    case "any": return filter.secondSource ? opinion() : null;
    case "none": return sql`not ${opinion()}`;
    case "reject": return opinion("reject");
    case "approve": return opinion("approve");
    case "agreed": return secondOpinionFilter("agreed", sql`i.id`, sql`i.ai_reason`, options);
    case "split": return secondOpinionFilter("split", sql`i.id`, sql`i.ai_reason`, options);
  }
}

/** 거르기 — 빈 칸은 가리지 않는다 */
export function policyFilterSql(filter: PolicyFilter, ctx: PolicyContext): SQL {
  const parts: SQL[] = [];
  if (filter.reviewers.length) {
    parts.push(sql`(coalesce(i.ai_provider, c.provider) || '|' || coalesce(i.ai_model, c.model)) in (${sql.join(filter.reviewers.map((key) => sql`${key}`), sql`, `)})`);
  }
  if (filter.confidenceMin !== null) parts.push(sql`i.ai_confidence >= ${filter.confidenceMin}`);
  if (filter.confidenceBelow !== null) {
    parts.push(filter.confidenceBelow >= 1 ? sql`i.ai_confidence <= 1` : sql`i.ai_confidence < ${filter.confidenceBelow}`);
  }
  if (filter.held === "held") parts.push(sql`p.audit_hold_at is not null`);
  if (filter.held === "not_held") parts.push(sql`p.audit_hold_at is null`);
  const second = secondSql(filter, ctx);
  if (second) parts.push(second);
  if (filter.branches.length) {
    parts.push(sql`${auditReasonCategorySql(sql`i.ai_reason`)} in (${sql.join(filter.branches.map((key) => sql`${key}`), sql`, `)})`);
  }
  if (filter.owner === "unowned") parts.push(unownedSql());
  if (filter.owner === "owned") parts.push(sql`not ${unownedSql()}`);
  if (filter.waitMinDays !== null) parts.push(sql`i.reviewed_at <= now() - ${filter.waitMinDays} * interval '1 day'`);
  if (filter.waitMaxDays !== null) parts.push(sql`i.reviewed_at > now() - ${filter.waitMaxDays} * interval '1 day'`);
  if (filter.statuses.length) parts.push(sql`p.status in (${sql.join(filter.statuses.map((status) => sql`${status}`), sql`, `)})`);
  return parts.length ? sql`(${sql.join(parts, sql` and `)})` : sql`true`;
}

/**
 * 행동마다 건너뛸 까닭 — 거르기에 들어도 이 행동으로는 손대지 않는 것. 내리기는 지금 묶어 내리기의 문턱(groupableItem)을 그대로 지키고
 * (주인 있음 → 확신 0.95 미만 → 갈림) 두 번째 모델의 승인도 뺀다. 그 제품의 다른 항목도 본다 — 살아 있는 유지가 있거나(사람이 지난 감사의
 * 보류 항목을 유지로 정함) 더 새 감사 답이 있으면(보류 조건 holdableItem 과 같은 뜻) 내리지 않는다. 차례가 곧 보이는 까닭이다
 */
function skipSql(action: PolicyAction, ctx: PolicyContext): SQL {
  if (action === "remove") {
    const split = secondOpinionFilter("split", sql`i.id`, sql`i.ai_reason`,
      { primary: { provider: sql`i.ai_provider`, model: auditItemModel("i") }, autoOpinions: ctx.autoOpinions });
    return sql`(case when not ${unownedSql()} then 'owned'
      when i.ai_confidence is null or i.ai_confidence < ${GROUP_REMOVE_MIN_CONFIDENCE} then 'low_confidence'
      when ${split} then 'split'
      when exists (select 1 from ${productAuditSecondOpinions} o4 where o4.item_id = i.id and o4.decision = 'approve') then 'second_approve'
      when exists (select 1 from ${productAuditItems} k4 where k4.product_id = i.product_id and k4.human_decision = 'kept'
        and k4.keep_until > now()) then 'kept'
      when exists (select 1 from ${productAuditItems} n4 where n4.product_id = i.product_id and n4.id > i.id and n4.ai_decision is not null) then 'superseded'
      else null end)`;
  }
  if (action === "release") return sql`(case when p.audit_hold_at is null then 'not_held' else null end)`;
  return sql`(null::text)`;
}

/** 한 줄 — 미리보기·적용 전 다시 보기·만들기가 같은 SELECT 를 쓴다. extra 는 더 거는 조건(i.id = …) */
function baseSql(filter: PolicyFilter, action: PolicyAction, ctx: PolicyContext, extra?: SQL): SQL {
  return sql`select i.id as item_id, i.product_id, i.campaign_id, p.slug, p.name, p.url, p.status, i.ai_reason as reason,
      i.ai_confidence as confidence, ${auditReasonCategorySql(sql`i.ai_reason`)} as branch, ${skipSql(action, ctx)} as skip,
      (p.audit_hold_at is not null) as held, (not ${unownedSql()}) as owned,
      coalesce(i.ai_provider, c.provider) as provider, coalesce(i.ai_model, c.model) as model,
      floor(extract(epoch from (now() - i.reviewed_at)) / 86400)::int as wait_days
    ${FROM} where ${universeSql(ctx.latest)} and ${policyFilterSql(filter, ctx)}${extra ? sql` and ${extra}` : sql``}`;
}

async function policyContext(latestOverride?: number): Promise<PolicyContext | null> {
  const [settings, [row]] = await Promise.all([getSettings(),
    db.select({ id: sql<number | null>`max(${productAuditCampaigns.id})` }).from(productAuditCampaigns)]);
  // 실행이 굳힌 마지막 감사(정책 처리) — 없으면(올리기·연장) 지금의 마지막 감사
  const latest = latestOverride || row?.id || null;
  return latest ? { latest, autoOpinions: settings.qwenAuto.auditSecondOpinion.enabled } : null;
}

// ─────────────────────────── 미리보기 ───────────────────────────

export type PolicyPreviewRow = {
  itemId: number; productId: number; slug: string; name: string; url: string; status: string; reason: string | null; confidence: number | null;
  branch: AuditReasonCategory; skip: string | null; held: boolean; owned: boolean; provider: string; model: string; waitDays: number | null;
  second: SecondOpinionView[];
};

export type PolicyPreview = {
  latestCampaignId: number | null;
  action: PolicyAction;
  /** 거르기에 든 수 */
  matched: number;
  /** 이 행동으로 손댈 수 — 사람이 적을 수 */
  eligible: number;
  /** 그중 보류 중인 것(유지면 목록에 돌아온다) */
  eligibleHeld: number;
  byBranch: { branch: AuditReasonCategory; label: string; matched: number; eligible: number }[];
  skipped: { reason: string; count: number; examples: PolicyPreviewRow[] }[];
  /** 갈래별로 수에 비례해 고른 표본(손댈 것에서) */
  sample: PolicyPreviewRow[];
  /** 가장 오래 기다린 것의 날 수(손댈 것에서) */
  oldestWaitDays: number | null;
  filterText: string;
  seed: string;
};

type RawRow = { item_id: number; product_id: number; campaign_id: number; slug: string; name: string; url: string; status: string; reason: string | null;
  confidence: number | null; branch: AuditReasonCategory; skip: string | null; held: boolean; owned: boolean; provider: string; model: string;
  wait_days: number | null; second?: SecondOpinionView[] };

const toRow = (row: RawRow): PolicyPreviewRow => ({ itemId: row.item_id, productId: row.product_id, slug: row.slug, name: row.name, url: row.url,
  status: row.status, reason: row.reason, confidence: row.confidence === null ? null : Number(row.confidence), branch: row.branch, skip: row.skip,
  held: row.held, owned: row.owned, provider: row.provider, model: row.model, waitDays: row.wait_days, second: row.second ?? [] });

const branchLabel = (key: AuditReasonCategory) => AUDIT_REASON_CATEGORIES[key]?.label ?? key;

/**
 * 미리보기 — 읽기만 한다. 거르기에 든 수·손댈 수·갈래별 수·건너뛸 것(까닭마다 수와 예 다섯)·층별 표본(갈래마다 수에 비례, 손댈 것에서).
 * 표본은 seed 로 섞는다(md5(항목 id || seed)) — 같은 seed 면 같은 표본이다
 */
export async function previewAuditPolicy(input: { filter: PolicyFilter; action: PolicyAction; seed?: string }): Promise<PolicyPreview> {
  const filter = policyFilterSchema.parse(input.filter);
  const seed = (input.seed ?? Math.random().toString(36).slice(2, 10)).slice(0, 16);
  const ctx = await policyContext();
  const empty: PolicyPreview = { latestCampaignId: null, action: input.action, matched: 0, eligible: 0, eligibleHeld: 0, byBranch: [], skipped: [],
    sample: [], oldestWaitDays: null, filterText: describePolicyFilter(filter, { branch: branchLabel }), seed };
  if (!ctx) return empty;
  const base = baseSql(filter, input.action, ctx);
  const groups = await db.execute<{ branch: AuditReasonCategory; skip: string | null; n: number; held: number; oldest: number | null }>(sql`
    select branch, skip, count(*)::int as n, count(*) filter (where held)::int as held, max(wait_days)::int as oldest
      from (${base}) b group by branch, skip`);
  const byBranch = new Map<AuditReasonCategory, { matched: number; eligible: number }>();
  const skipCounts = new Map<string, number>();
  let matched = 0, eligible = 0, eligibleHeld = 0;
  let oldest: number | null = null;
  for (const group of groups) {
    const entry = byBranch.get(group.branch) ?? { matched: 0, eligible: 0 };
    entry.matched += group.n;
    matched += group.n;
    if (group.skip === null) {
      entry.eligible += group.n;
      eligible += group.n;
      eligibleHeld += group.held;
      if (group.oldest !== null) oldest = Math.max(oldest ?? 0, group.oldest);
    } else skipCounts.set(group.skip, (skipCounts.get(group.skip) ?? 0) + group.n);
    byBranch.set(group.branch, entry);
  }
  const quotas = stratifiedQuotas(Object.fromEntries([...byBranch].map(([key, value]) => [key, value.eligible])), POLICY_SAMPLE);
  const quotaCase = Object.keys(quotas).length
    ? sql`(case b.branch ${sql.join(Object.entries(quotas).map(([key, quota]) => sql`when ${key} then ${quota}`), sql` `)} else 0 end)`
    : sql`0`;
  const [sample, examples] = await Promise.all([
    eligible ? db.execute<RawRow>(sql`
      select b.*, ${secondOpinionsField(sql`b.item_id`)} as second from (
        select b0.*, row_number() over (partition by b0.branch order by md5(b0.item_id::text || ${seed})) as rn
          from (${base}) b0 where b0.skip is null) b
       where b.rn <= ${quotaCase} order by b.branch, b.rn`) : Promise.resolve([] as RawRow[]),
    skipCounts.size ? db.execute<RawRow>(sql`
      select b.*, ${secondOpinionsField(sql`b.item_id`)} as second from (
        select b0.*, row_number() over (partition by b0.skip order by md5(b0.item_id::text || ${seed})) as rn
          from (${base}) b0 where b0.skip is not null) b
       where b.rn <= ${SKIP_EXAMPLES} order by b.skip, b.rn`) : Promise.resolve([] as RawRow[]),
  ]);
  return {
    latestCampaignId: ctx.latest, action: input.action, matched, eligible, eligibleHeld,
    byBranch: [...byBranch].map(([branch, value]) => ({ branch, label: branchLabel(branch), ...value }))
      .sort((a, b) => b.matched - a.matched || a.branch.localeCompare(b.branch)),
    skipped: [...skipCounts].map(([reason, count]) => ({ reason, count, examples: [...examples].filter((row) => row.skip === reason).map(toRow) }))
      .sort((a, b) => b.count - a.count),
    sample: [...sample].map(toRow), oldestWaitDays: oldest, filterText: empty.filterText, seed,
  };
}

/** 거르기 칸의 고를 거리 — 대상에 든 감사 심사자(provider|model)와 두 번째 의견의 출처, 각 수 */
export async function policyFilterOptions(): Promise<{ latestCampaignId: number | null;
  reviewers: { key: string; provider: string; model: string; count: number }[]; sources: { source: string; count: number }[] }> {
  const ctx = await policyContext();
  const sources = await db.execute<{ source: string; count: number }>(sql`
    select source, count(*)::int as count from ${productAuditSecondOpinions} group by source order by count desc, source`);
  if (!ctx) return { latestCampaignId: null, reviewers: [], sources: [...sources] };
  const reviewers = await db.execute<{ provider: string; model: string; count: number }>(sql`
    select coalesce(i.ai_provider, c.provider) as provider, coalesce(i.ai_model, c.model) as model, count(*)::int as count
      ${FROM} where ${universeSql(ctx.latest)} group by 1, 2 order by count desc`);
  return { latestCampaignId: ctx.latest, sources: [...sources],
    reviewers: [...reviewers].map((row) => ({ key: `${row.provider}|${row.model}`, ...row })) };
}

// ─────────────────────────── 실행 ───────────────────────────

export type PolicyRunProgress = {
  runId: number; kind: string; action: string; status: string; planned: number;
  pending: number; applied: number; skipped: number; cancelled: number; undone: number; blocked: number;
  /** 이번에는 손대지 않고 기다린다 — Cloudflare 지우기 줄이 밀림 */
  waiting: { reason: "cdn"; retryMs: number } | null;
  done: boolean;
};

export type PolicyResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export const ACTIVE_RUN = "다른 정책 실행이 적용·되돌리기 중입니다. 그것을 끝내거나 되돌린 뒤에 시작하세요.";

export async function assertWritable(tx: ProductTransaction): Promise<void> {
  if (!(await writerSiteActive(tx))) throw new DrWriterFencedError("site_fenced");
}

/**
 * 실행을 만든다 — 지금 거르기로 손댈 항목을 다시 골라, 그 수가 사람이 적은 수와 같을 때만 만든다(미리본 뒤 바뀌었으면 다시 보게).
 * 고른 항목을 실행 항목(pending)으로 굳힌다 — 적용은 이 목록만 손대고, 그 뒤 새로 든 것은 손대지 않는다.
 */
export async function startAuditPolicyRun(input: PolicyStart & { by: string }): Promise<PolicyResult<{ runId: number; planned: number }>> {
  const filter = policyFilterSchema.parse(input.filter);
  const ctx = await policyContext();
  if (!ctx) return { ok: false, error: "감사가 없습니다." };
  const base = baseSql(filter, input.action, ctx);
  try {
    return await db.transaction(async (tx) => {
      await assertWritable(tx);
      const rows = await tx.execute<{ item_id: number; product_id: number; slug: string }>(sql`
        select item_id, product_id, slug from (${base}) b where b.skip is null order by item_id`);
      if (rows.length !== input.expected) {
        return { ok: false as const, error: `지금 손댈 수는 ${rows.length.toLocaleString("ko-KR")}건입니다(적은 수 ${input.expected.toLocaleString("ko-KR")}건). `
          + "미리본 뒤 바뀌었습니다 — 다시 미리 보세요." };
      }
      const skipped = await tx.execute<{ skip: string; n: number }>(sql`
        select skip, count(*)::int as n from (${base}) b where b.skip is not null group by skip`);
      const [run] = await tx.insert(productAuditPolicyRuns).values({
        kind: "close", action: input.action, status: "applying", filter, planned: rows.length,
        options: { keepDays: input.keepDays, latestCampaignId: ctx.latest, filterText: describePolicyFilter(filter, { branch: branchLabel }) },
        summary: { skipped: Object.fromEntries([...skipped].map((row) => [row.skip, row.n])) },
        note: input.note.trim().slice(0, 500) || null, createdBy: input.by.slice(0, 120),
      }).returning({ id: productAuditPolicyRuns.id });
      for (let index = 0; index < rows.length; index += INSERT_BATCH) {
        await tx.insert(productAuditPolicyRunItems).values(rows.slice(index, index + INSERT_BATCH)
          .map((row) => ({ runId: run.id, itemId: row.item_id, productId: row.product_id, slug: row.slug })));
      }
      return { ok: true as const, runId: run.id, planned: rows.length };
    });
  } catch (error) {
    if (uniqueViolation(error) === "product_audit_policy_runs_one_active_idx") return { ok: false, error: ACTIVE_RUN };
    throw error;
  }
}

type RunRow = { id: number; itemId: number; productId: number; slug: string; payload: Record<string, unknown> | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null };
type ApplyOutcome = { state: "applied"; before: Record<string, unknown>; after?: Record<string, unknown>; relisted?: boolean }
  | { state: "skipped"; reason: string };
type UndoOutcome = { state: "undone"; relisted?: boolean } | { state: "undo_blocked"; reason: string };

/** 실행 종류·행동마다 한 항목을 적용하고 되돌리는 법. 둘 다 잠근 트랜잭션 안에서 부른다(실행 항목의 상태는 부르는 쪽이 적는다) */
type RunHandler = {
  apply: (tx: ProductTransaction, run: ProductAuditPolicyRun, row: RunRow, by: string, ctx: PolicyContext) => Promise<ApplyOutcome>;
  undo: (tx: ProductTransaction, run: ProductAuditPolicyRun, row: RunRow, by: string) => Promise<UndoOutcome>;
  /** 제품마다 Cloudflare 지우기 줄을 적는가(차단·차단 해제 — 트리거) — 그러면 지난 60초의 줄 수로 늦춘다 */
  cdnPerProduct: boolean;
  /** 되돌려 목록이 바뀐 묶음의 목록 지우기 줄의 까닭 — 기본은 보류를 다시 건 것(audit_hold). 자동 숨김을 되돌리면 푼 것(audit_release) */
  undoPurge?: string;
};

const skipped = (reason: string): ApplyOutcome => ({ state: "skipped", reason });
const blocked = (reason: string): UndoOutcome => ({ state: "undo_blocked", reason });
const humanNote = (run: ProductAuditPolicyRun) => `정책 #${run.id}${run.note ? ` · ${run.note}` : ""}`.slice(0, 500);
const keepDaysOf = (run: ProductAuditPolicyRun) => Number((run.options as { keepDays?: number }).keepDays ?? 90);
const latestOf = (run: ProductAuditPolicyRun) => Number((run.options as { latestCampaignId?: number }).latestCampaignId ?? 0);

/** 잠근 뒤 다시 보는 그 항목 — 실행의 거르기·행동·만들 때의 마지막 감사로. 맞지 않으면 없다 */
async function recheck(tx: ProductTransaction, run: ProductAuditPolicyRun, itemId: number, ctx: PolicyContext) {
  const filter = policyFilterSchema.parse(run.filter);
  const [row] = await tx.execute<RawRow & { held_at: string | null; hold_item_id: number | null }>(sql`
    select b.*, to_char(hp.audit_hold_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as held_at, hp.audit_hold_item_id as hold_item_id
      from (${baseSql(filter, run.action as PolicyAction, { ...ctx, latest: latestOf(run) }, sql`i.id = ${itemId}`)}) b
      join ${products} hp on hp.id = b.product_id`);
  return row ?? null;
}

/**
 * 보류를 다시 건다 — 되돌리기가 그 실행이 푼 보류를 원래 시각·원래 항목으로. 제품이 지금도 주인 없는 공개 제품이고 보류가 없고,
 * 그 제품에 살아 있는 유지가 없고 보류 항목에 사람 결정이 없을 때만(못 걸면 그 항목의 되돌리기 전체를 버리고 '되돌리지 못함').
 * 그 실행이 '풀었음'을 적은 항목(releasedIds, 적용 트랜잭션의 시각과 같은 것만)은 지운다. 제품 기록에 보류 줄을 남긴다
 */
async function restoreHold(tx: ProductTransaction, input: { run: ProductAuditPolicyRun; row: RunRow; by: string; heldAt: string; holdItemId: number;
  releasedIds: number[] }): Promise<boolean> {
  // 보류를 걸 수 있는 그대로인가(holdableItem 의 뜻): 주인 없는 공개 제품, 보류 없음, 그 제품에 살아 있는 유지 없음, 보류 항목에 사람 결정 없음
  const [held] = await tx.update(products).set({ auditHoldAt: sql`${input.heldAt}::timestamp`, auditHoldItemId: input.holdItemId })
    .where(and(eq(products.id, input.row.productId), eq(products.slug, input.row.slug), sql`${products.auditHoldAt} is null`,
      unownedPublic("products"),
      sql`not exists (select 1 from ${productAuditItems} k where k.product_id = ${products.id} and k.human_decision = 'kept' and k.keep_until > now())`,
      sql`exists (select 1 from ${productAuditItems} h where h.id = ${input.holdItemId} and h.product_id = ${products.id} and h.human_decision is null)`))
    .returning({ id: products.id });
  if (!held) return false;
  if (input.releasedIds.length) {
    await tx.update(productAuditItems).set({ holdReleasedAt: null }).where(and(inArray(productAuditItems.id, input.releasedIds),
      sql`${productAuditItems.holdReleasedAt} = (select ri.applied_at from ${productAuditPolicyRunItems} ri where ri.id = ${input.row.id})`));
  }
  await tx.insert(productEvidenceAudit).values({ slug: input.row.slug, actor: input.by.slice(0, 120), action: AUDIT_HOLD_ACTION,
    reason: "policy_undo", metadata: { policyRunId: input.run.id, itemId: input.holdItemId } });
  return true;
}

/** 손대기 전 제품 상태 — 되돌리기가 쓴다(보류 시각은 마이크로초까지 글자로) */
const productBefore = (row: { status: string; held_at: string | null; hold_item_id: number | null }) =>
  ({ status: row.status, heldAt: row.held_at, holdItemId: row.hold_item_id });

/** 되돌리기가 읽는 지금의 항목·제품 — 시각 비교는 SQL 에서(자바스크립트 Date 는 마이크로초를 버린다) */
async function undoState(tx: ProductTransaction, row: RunRow, extra: SQL = sql`true`) {
  const [state] = await tx.execute<{ product_ok: boolean; status: string | null; held: boolean; unowned: boolean; human_decision: string | null;
    decided_by_run: boolean; extra: boolean; status_touched: boolean; takedown: boolean }>(sql`
    select (p.id is not null and p.slug = ri.slug) as product_ok, p.status, coalesce(p.audit_hold_at is not null, false) as held,
      coalesce(p.claimed_at is null and p.verified_at is null and not exists (select 1 from ${productMakerMembers} m
        where m.product_id = p.id and m.revoked_at is null), false) as unowned,
      i.human_decision, coalesce(i.human_at = ri.applied_at, false) as decided_by_run, coalesce(${extra}, false) as extra,
      -- 그 실행 뒤 누가 차단·차단 해제를 눌렀다(제품 화면·요청 처리) — 사람이 그 제품을 다시 정했다
      exists (select 1 from ${productEvidenceAudit} a where a.slug = ri.slug and a.action in ('admin.product.ban', 'admin.product.unban')
        and a.created_at > ri.applied_at) as status_touched,
      -- 내려달라는 요청이 기다리고 있거나, 그 실행 뒤 '내림'으로 처리됐다 — 이미 차단된 제품의 요청 처리는 차단 줄을 남기지 않는다
      exists (select 1 from ${takedownRequests} t where t.slug = ri.slug
        and (t.handled_at is null or (t.outcome = 'removed' and t.handled_at > ri.applied_at))) as takedown
      from ${productAuditPolicyRunItems} ri join ${productAuditItems} i on i.id = ri.item_id left join ${products} p on p.id = ri.product_id
     where ri.id = ${row.id}`);
  return state;
}

const closeRemove: RunHandler = {
  cdnPerProduct: true,
  async apply(tx, run, row, by, ctx) {
    const current = await recheck(tx, run, row.itemId, ctx);
    if (!current) return skipped("changed");
    if (current.skip) return skipped(current.skip);
    const category = classifyAuditReason(current.reason);
    const banned = await setStatusWithAudit({ id: row.productId, slug: row.slug, status: "banned", action: "admin.product.ban",
      actor: by.slice(0, 120), reason: auditBanReason(current.reason),
      metadata: { source: "product-audit", campaignId: current.campaign_id, itemId: row.itemId, reasonCategory: category,
        aiConfidence: current.confidence, policyRunId: run.id } }, tx);
    if (!banned) return skipped("changed");
    await tx.update(productAuditItems).set({ humanDecision: "removed", humanBy: by.slice(0, 120), humanAt: sql`now()`, humanNote: humanNote(run) })
      .where(eq(productAuditItems.id, row.itemId));
    return { state: "applied", before: productBefore(current) };
  },
  async undo(tx, run, row, by) {
    const before = row.before as { status: string; heldAt: string | null; holdItemId: number | null };
    // 마지막 차단·차단 해제 줄이 이 실행의 차단인가 — 그 뒤 누가 풀었다 다시 내렸으면 그 사람의 차단이다
    const state = await undoState(tx, row, sql`(select a.metadata->>'policyRunId' from ${productEvidenceAudit} a where a.slug = ri.slug
      and a.action in ('admin.product.ban', 'admin.product.unban') order by a.id desc limit 1) = ${String(run.id)}`);
    if (!state?.product_ok) return blocked("product_changed");
    if (state.human_decision !== "removed" || !state.decided_by_run) return blocked("decision_changed");
    if (state.status !== "banned" || !state.extra) return blocked("status_changed");
    if (state.takedown) return blocked("takedown");
    if (before.heldAt && !state.unowned) return blocked("owned_now");
    const unbanned = await setStatusWithAudit({ id: row.productId, slug: row.slug, status: before.status as "seeded" | "verified",
      action: "admin.product.unban", actor: by.slice(0, 120), reason: "audit_policy_undo",
      metadata: { source: "product-audit", itemId: row.itemId, policyRunId: run.id } }, tx);
    if (!unbanned) return blocked("status_changed");
    await tx.update(productAuditItems).set({ humanDecision: null, humanBy: null, humanAt: null, humanNote: null })
      .where(eq(productAuditItems.id, row.itemId));
    // 차단 해제가 그 제품의 열린 항목에 적은 '풀었음'을 지운다 — 이 트랜잭션(now())이 적은 것만. 실행 전에는 비어 있었다
    await tx.update(productAuditItems).set({ holdReleasedAt: null })
      .where(and(eq(productAuditItems.productId, row.productId), sql`${productAuditItems.holdReleasedAt} = now()`));
    if (before.heldAt && before.holdItemId
      && !(await restoreHold(tx, { run, row, by, heldAt: before.heldAt, holdItemId: before.holdItemId, releasedIds: [] }))) {
      throw new PolicyUndoConflict("hold_changed");
    }
    return { state: "undone", relisted: Boolean(before.heldAt) };
  },
};

const closeKeep: RunHandler = {
  cdnPerProduct: false,
  async apply(tx, run, row, by, ctx) {
    const current = await recheck(tx, run, row.itemId, ctx);
    if (!current) return skipped("changed");
    if (current.skip) return skipped(current.skip);
    const kept = await tx.update(productAuditItems).set({ humanDecision: "kept", humanBy: by.slice(0, 120), humanAt: sql`now()`,
      humanNote: humanNote(run), keepUntil: sql`now() + ${keepDaysOf(run)} * interval '1 day'` })
      .where(and(eq(productAuditItems.id, row.itemId), isNull(productAuditItems.humanDecision)))
      .returning({ keepUntil: sql<string>`to_char(${productAuditItems.keepUntil}, 'YYYY-MM-DD"T"HH24:MI:SS.US')` });
    if (!kept.length) return skipped("changed");
    let releasedIds: number[] = [];
    let relisted = false;
    if (current.held) {
      releasedIds = await unreleasedOpenItems(tx, row.productId);
      relisted = await releaseAuditHold(tx, { productId: row.productId, slug: row.slug, actor: by, reason: "kept", purge: "none",
        metadata: { policyRunId: run.id } });
      if (!relisted) releasedIds = [];
    }
    return { state: "applied", before: { ...productBefore(current), releasedIds }, after: { keepUntil: kept[0].keepUntil }, relisted };
  },
  async undo(tx, run, row, by) {
    const before = row.before as { status: string; heldAt: string | null; holdItemId: number | null; releasedIds?: number[] };
    // 적용이 적은 기한 그대로인가 — 적용 때 글자로 남긴 값과 견준다(세션 시간대의 일광 절약에 흔들리지 않게)
    const keptUntil = (row.after as { keepUntil?: string } | null)?.keepUntil;
    const state = await undoState(tx, row, keptUntil ? sql`i.keep_until = ${keptUntil}::timestamp`
      : sql`i.keep_until = ri.applied_at + ${keepDaysOf(run)} * interval '1 day'`);
    if (!state?.product_ok) return blocked("product_changed");
    if (state.human_decision !== "kept" || !state.decided_by_run) return blocked("decision_changed");
    if (!state.extra) return blocked("keep_changed");
    if (state.status !== before.status || state.status_touched) return blocked("status_changed");
    if (before.heldAt && state.held) return blocked("hold_changed");
    if (before.heldAt && (!state.unowned || state.status !== "seeded")) return blocked("owned_now");
    await tx.update(productAuditItems).set({ humanDecision: null, humanBy: null, humanAt: null, humanNote: null, keepUntil: null })
      .where(eq(productAuditItems.id, row.itemId));
    if (before.heldAt && before.holdItemId) {
      const held = await restoreHold(tx, { run, row, by, heldAt: before.heldAt, holdItemId: before.holdItemId, releasedIds: before.releasedIds ?? [] });
      if (!held) throw new PolicyUndoConflict("hold_changed");
      return { state: "undone", relisted: true };
    }
    return { state: "undone" };
  },
};

/**
 * 보류 풀기(보류 모두 풀기의 고른 판) — 사람 결정은 남기지 않는다. 그 제품의 답이 있는 열린 항목에 '풀었음'을 적어(SETTLES) 쓸기가 다시
 * 걸지 않는다. 감사 거절 목록에는 그대로 남는다(사람이 유지·내리기로 닫을 때까지). 되돌리기는 보류를 원래 시각·항목으로 다시 건다
 */
const closeRelease: RunHandler = {
  cdnPerProduct: false,
  async apply(tx, run, row, by, ctx) {
    const current = await recheck(tx, run, row.itemId, ctx);
    if (!current) return skipped("changed");
    if (current.skip) return skipped(current.skip);
    const releasedIds = await unreleasedOpenItems(tx, row.productId);
    const released = await releaseAuditHold(tx, { productId: row.productId, slug: row.slug, actor: by, reason: "policy_release", purge: "none",
      metadata: { policyRunId: run.id, note: run.note } });
    if (!released) return skipped("changed");
    return { state: "applied", before: { ...productBefore(current), releasedIds }, relisted: true };
  },
  async undo(tx, run, row, by) {
    const before = row.before as { status: string; heldAt: string | null; holdItemId: number | null; releasedIds?: number[] };
    const state = await undoState(tx, row, sql`i.hold_released_at = ri.applied_at`);
    if (!state?.product_ok) return blocked("product_changed");
    if (state.human_decision !== null) return blocked("decision_changed");
    if (state.status !== before.status || state.status_touched) return blocked("status_changed");
    if (state.held || !state.extra) return blocked("hold_changed");
    if (!state.unowned || state.status !== "seeded") return blocked("owned_now");
    if (!before.heldAt || !before.holdItemId) return blocked("hold_changed");
    const held = await restoreHold(tx, { run, row, by, heldAt: before.heldAt, holdItemId: before.holdItemId, releasedIds: before.releasedIds ?? [] });
    if (!held) throw new PolicyUndoConflict("hold_changed");
    return { state: "undone", relisted: true };
  },
};

/** 되돌리기를 시작한 뒤에 맞지 않음을 알았다 — 트랜잭션을 버리고(이미 지운 결정까지) 그 항목을 되돌리지 못함으로 적는다 */
class PolicyUndoConflict extends Error {
  constructor(readonly reason: string) { super(`policy_undo_conflict:${reason}`); }
}

/** 올린 의견 한 줄(실행 항목의 payload) — audit-import-sources.ts ImportOpinion */
type ImportPayload = { model: string; decision: "approve" | "reject" | "needs_review"; confidence: number | null; reason: string | null;
  inputHash: string | null; shot: boolean };
type ImportOptions = { source: string; promptVersion: string | null; supersede?: boolean };
const OPINION_TIME = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US'`);

/**
 * 두 번째 의견 올리기(audit-second-opinion-upload.ts)의 한 줄 — 옮겨 적기(audit-second-opinion-import.ts)와 같은 뜻이다: 열린 거절에만,
 * 같은 (항목, 모델)이면 덮어쓰고, 승인이 지금 그 항목으로 보류된 제품에 오면 덮어쓴 뒤의 의견과 지금 설정으로 둘째 문을 다시 가른다.
 * 맞지 않으면 푼다(second_approve). 사람이 대체를 켰으면 스크린샷까지 본 승인이 글만 본 거절을 대신해 푼다(supersede, audit-import-gate.ts).
 * 되돌리기는 그 줄이 그대로일 때만(출처·적은 시각) 덮어쓰기 전 의견으로 돌리고(없었으면 지우고), 푼 보류를 원래대로 다시 건다.
 * 올린 거절 때문에 그 뒤 감사 잡의 쓸기가 건 보류는 풀지 않는다 — 그 보류는 정책 처리의 보류 풀기로 고른다
 */
const importOpinion: RunHandler = {
  cdnPerProduct: false,
  async apply(tx, run, row) {
    const line = row.payload as ImportPayload;
    const options = run.options as ImportOptions;
    const [item] = await tx.execute<{ open: boolean; reason: string | null; confidence: number | null; model: string | null; status: string;
      held_at: string | null; hold_item_id: number | null }>(sql`
      select (i.ai_decision = 'reject' and i.human_decision is null and p.status in ('seeded', 'verified')) as open,
        i.ai_reason as reason, i.ai_confidence as confidence, ${auditItemModel("i")} as model, p.status,
        to_char(p.audit_hold_at, ${OPINION_TIME}) as held_at, p.audit_hold_item_id as hold_item_id
        from ${productAuditItems} i join ${products} p on p.id = i.product_id
       where i.id = ${row.itemId} and p.id = ${row.productId} and p.slug = ${row.slug}`);
    if (!item) return skipped("product_changed");
    if (!item.open) return skipped("not_open");
    const [existing] = await tx.execute<Record<string, unknown>>(sql`
      select decision, confidence, reason, input_hash, source, prompt_version, product_id, to_char(created_at, ${OPINION_TIME}) as created_at
        from ${productAuditSecondOpinions} where item_id = ${row.itemId} and model = ${line.model}`);
    await tx.insert(productAuditSecondOpinions).values({ itemId: row.itemId, productId: row.productId, model: line.model, decision: line.decision,
      confidence: line.confidence, reason: line.reason, inputHash: line.inputHash, source: options.source, promptVersion: options.promptVersion })
      .onConflictDoUpdate({ target: [productAuditSecondOpinions.itemId, productAuditSecondOpinions.model], set: {
        productId: sql`excluded.product_id`, decision: sql`excluded.decision`, confidence: sql`excluded.confidence`, reason: sql`excluded.reason`,
        inputHash: sql`excluded.input_hash`, source: sql`excluded.source`, promptVersion: sql`excluded.prompt_version`, createdAt: sql`now()` } });
    let released: "gate" | "supersede" | null = null;
    let releasedIds: number[] = [];
    if (line.decision === "approve" && item.held_at && item.hold_item_id === row.itemId) {
      const settings = await lockedSettings(tx);
      const opinions = await tx.select({ model: productAuditSecondOpinions.model, decision: productAuditSecondOpinions.decision,
        source: productAuditSecondOpinions.source, confidence: productAuditSecondOpinions.confidence })
        .from(productAuditSecondOpinions).where(eq(productAuditSecondOpinions.itemId, row.itemId));
      const effect = importHoldEffect({ item: { reason: item.reason, model: item.model, confidence: item.confidence }, opinions,
        line: { decision: line.decision, confidence: line.confidence, shot: line.shot, source: options.source, model: line.model },
        hold: settings.auditHold, options: { autoOpinions: settings.qwenAuto.auditSecondOpinion.enabled }, supersede: Boolean(options.supersede) });
      if (effect.release) {
        releasedIds = await unreleasedOpenItems(tx, row.productId);
        const done = await releaseAuditHold(tx, { productId: row.productId, slug: row.slug, actor: `import:${options.source}`,
          reason: effect.release === "gate" ? "second_approve" : "supersede", purge: "none",
          metadata: { policyRunId: run.id, by: run.createdBy, model: line.model, confidence: line.confidence,
            ...(effect.release === "supersede" ? { superseded: effect.superseded } : {}) } });
        if (done) released = effect.release;
        else releasedIds = [];
      }
    }
    return { state: "applied", before: { opinion: existing ?? null, status: item.status, heldAt: item.held_at, holdItemId: item.hold_item_id,
      releasedIds, released }, relisted: released !== null };
  },
  async undo(tx, run, row, by) {
    const line = row.payload as ImportPayload;
    const options = run.options as ImportOptions;
    const before = row.before as { opinion: Record<string, unknown> | null; status: string; heldAt: string | null; holdItemId: number | null;
      releasedIds: number[]; released: "gate" | "supersede" | null };
    const [mine] = await tx.execute<{ ours: boolean }>(sql`
      select coalesce(o.source = ${options.source} and o.created_at = ri.applied_at, false) as ours
        from ${productAuditPolicyRunItems} ri left join ${productAuditSecondOpinions} o on o.item_id = ri.item_id and o.model = ${line.model}
       where ri.id = ${row.id}`);
    if (!mine?.ours) return blocked("opinion_changed");
    if (before.released) {
      const state = await undoState(tx, row);
      if (!state?.product_ok) return blocked("product_changed");
      if (state.human_decision !== null) return blocked("decision_changed");
      if (state.status !== before.status || state.status_touched) return blocked("status_changed");
      if (state.held) return blocked("hold_changed");
      if (!state.unowned || state.status !== "seeded") return blocked("owned_now");
      if (!before.heldAt || !before.holdItemId
        || !(await restoreHold(tx, { run, row, by, heldAt: before.heldAt, holdItemId: before.holdItemId, releasedIds: before.releasedIds }))) {
        throw new PolicyUndoConflict("hold_changed");
      }
    }
    const previous = before.opinion as { decision: string; confidence: number | null; reason: string | null; input_hash: string | null; source: string;
      prompt_version: string | null; product_id: number; created_at: string } | null;
    if (!previous) {
      await tx.delete(productAuditSecondOpinions).where(and(eq(productAuditSecondOpinions.itemId, row.itemId), eq(productAuditSecondOpinions.model, line.model)));
    } else {
      await tx.update(productAuditSecondOpinions).set({ decision: previous.decision as ImportPayload["decision"], confidence: previous.confidence,
        reason: previous.reason, inputHash: previous.input_hash, source: previous.source, promptVersion: previous.prompt_version,
        productId: previous.product_id, createdAt: sql`${previous.created_at}::timestamp` })
        .where(and(eq(productAuditSecondOpinions.itemId, row.itemId), eq(productAuditSecondOpinions.model, line.model)));
    }
    return { state: "undone", relisted: Boolean(before.released) };
  },
};

/**
 * 유지 연장 — 곧 끝나는 유지의 기한을 늦춘다(keep_until = max(지금 기한, 지금) + 일). 만들 때 본 기한이 그대로인 것만(그 사이 사람이 다시
 * 정했거나 다른 연장이 있었으면 건너뜀). 되돌리기는 연장한 그 기한이 그대로일 때만 원래 기한으로
 */
const extendKeep: RunHandler = {
  cdnPerProduct: false,
  async apply(tx, run, row) {
    const payload = row.payload as { keepUntil: string };
    const days = Number((run.options as { days?: number }).days ?? 90);
    const [updated] = await tx.execute<{ keep_until: string }>(sql`
      update ${productAuditItems} set keep_until = greatest(keep_until, now()) + ${days} * interval '1 day'
       where id = ${row.itemId} and human_decision = 'kept' and keep_until = ${payload.keepUntil}::timestamp
      returning to_char(keep_until, ${OPINION_TIME}) as keep_until`);
    if (!updated) return skipped("changed");
    return { state: "applied", before: { keepUntil: payload.keepUntil }, after: { keepUntil: updated.keep_until } };
  },
  async undo(tx, run, row) {
    const before = row.before as { keepUntil: string };
    const [after] = await tx.select({ after: productAuditPolicyRunItems.after }).from(productAuditPolicyRunItems).where(eq(productAuditPolicyRunItems.id, row.id));
    const extended = (after?.after as { keepUntil?: string } | null)?.keepUntil;
    if (!extended) return blocked("keep_changed");
    const restored = await tx.execute<{ id: number }>(sql`
      update ${productAuditItems} set keep_until = ${before.keepUntil}::timestamp
       where id = ${row.itemId} and human_decision = 'kept' and keep_until = ${extended}::timestamp returning id`);
    return restored.length ? { state: "undone" } : blocked("keep_changed");
  },
};

/**
 * 감사 두 번째 의견의 자동 숨김(audit-auto-close.ts) — 적용은 감사 잡이 의견을 적는 트랜잭션에서 이미 했다(이 실행은 처음부터 '적용함').
 * 되돌리기는 그 숨김이 그대로일 때만(사람이 정하지 않았고, 상태가 그대로고, 그 실행이 건 보류 — 시각·항목 — 가 아직 걸려 있음) 보류를 풀고,
 * 그 제품의 답이 있는 열린 항목에 '풀었음'을 적는다(policy_release — 쓸기·자동 숨김이 다시 걸지 않는다). 운영자가 '숨기지 말라'고 정한 것이다.
 * Qwen 의견은 남는다 — 같은 모델·판으로 다시 묻지 않고 사람이 본다
 */
const autoHold: RunHandler = {
  cdnPerProduct: false,
  undoPurge: AUDIT_RELEASE_PURGE,
  async apply() {
    return skipped("changed");
  },
  async undo(tx, run, row, by) {
    const before = row.before as { status: string };
    const state = await undoState(tx, row, sql`(p.audit_hold_at = ri.applied_at and p.audit_hold_item_id = ri.item_id)`);
    if (!state?.product_ok) return blocked("product_changed");
    if (state.human_decision !== null) return blocked("decision_changed");
    if (state.status !== before.status || state.status_touched) return blocked("status_changed");
    if (!state.held || !state.extra) return blocked("hold_changed");
    const released = await releaseAuditHold(tx, { productId: row.productId, slug: row.slug, actor: by, reason: "policy_release", purge: "none",
      metadata: { policyRunId: run.id, undo: "auto_hold" } });
    if (!released) throw new PolicyUndoConflict("hold_changed");
    return { state: "undone", relisted: true };
  },
};

const HANDLERS: Record<string, RunHandler> = { "close:remove": closeRemove, "close:keep": closeKeep, "close:release": closeRelease,
  "import:import": importOpinion, "extend:extend": extendKeep };

/**
 * 자동 실행(options.auto, audit-auto-close.ts)은 kind·action 이 아니라 options.auto.action 이 뜻이다 — 자동 유지는 사람의 유지와 같은 칸이라
 * 정책 유지의 되돌리기(closeKeep)를 그대로 쓰고, 자동 숨김은 autoHold 다
 */
function handlerOf(run: ProductAuditPolicyRun): RunHandler {
  const auto = autoRunInfo(run);
  if (auto) return auto.action === "keep" ? closeKeep : autoHold;
  const handler = HANDLERS[`${run.kind}:${run.action}`];
  if (!handler) throw new Error(`policy_handler_missing:${run.kind}:${run.action}`);
  return handler;
}

/** 한 번 더 해볼 만한 실패 — 교착·직렬화 */
const retryable = (error: unknown) => {
  for (let current = error as { code?: string; cause?: unknown } | undefined, depth = 0; current && depth < 5; depth++) {
    if (current.code === "40P01" || current.code === "40001") return true;
    current = current.cause as typeof current;
  }
  return false;
};

/** 지난 60초에 적힌 Cloudflare 지우기 줄로 남은 자리 — 지우기 잡 한 번의 몫을 넘기지 않는다 */
async function cdnRoom(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(cdnPurges)
    .where(sql`${cdnPurges.createdAt} > now() - interval '60 seconds'`);
  return Math.max(0, POLICY_CDN_ROOM - (row?.count ?? 0));
}

async function loadRun(runId: number): Promise<ProductAuditPolicyRun | null> {
  const [run] = await db.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.id, runId));
  return run ?? null;
}

export async function policyRunProgress(runId: number, waiting: PolicyRunProgress["waiting"] = null): Promise<PolicyRunProgress | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  const rows = await db.select({ state: productAuditPolicyRunItems.state, count: sql<number>`count(*)::int` }).from(productAuditPolicyRunItems)
    .where(eq(productAuditPolicyRunItems.runId, runId)).groupBy(productAuditPolicyRunItems.state);
  const n = (state: string) => rows.find((row) => row.state === state)?.count ?? 0;
  return { runId, kind: run.kind, action: run.action, status: run.status, planned: run.planned, pending: n("pending"), applied: n("applied"),
    skipped: n("skipped"), cancelled: n("cancelled"), undone: n("undone"), blocked: n("undo_blocked"), waiting,
    done: run.status !== "applying" && run.status !== "undoing" };
}

/** 묶음마다 목록 줄 하나 — 유지·보류 풀기·되돌린 보류는 제품마다 지우기 줄을 적지 않는다 */
async function listPurge(reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertWritable(tx);
    await tx.insert(cdnPurges).values({ slug: "", reason });
  });
}

/** 한 항목의 한 단계(적용·되돌리기)를 한 트랜잭션으로 — 잠금 차례는 손으로 누르는 결정과 같다 */
async function step<T extends ApplyOutcome | UndoOutcome>(row: RunRow, expected: "pending" | "applied",
  work: (tx: ProductTransaction) => Promise<T>, write: (tx: ProductTransaction, outcome: T) => Promise<void>): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await assertWritable(tx);
        await lockPipelineInputStages(tx);
        const generation = await lockProductGeneration(tx, row.productId, row.slug);
        await tx.select({ id: productAuditItems.id }).from(productAuditItems).where(eq(productAuditItems.id, row.itemId)).for("update");
        const [current] = await tx.select({ id: productAuditPolicyRunItems.id }).from(productAuditPolicyRunItems)
          .where(and(eq(productAuditPolicyRunItems.id, row.id), eq(productAuditPolicyRunItems.state, expected))).for("update");
        if (!current) return null;
        const outcome = generation ? await work(tx)
          : (expected === "pending" ? skipped("product_changed") : blocked("product_changed")) as T;
        await write(tx, outcome);
        return outcome;
      });
    } catch (error) {
      if (error instanceof DrWriterFencedError) throw error;
      if (attempt === 0 && retryable(error)) continue;
      if (error instanceof PolicyUndoConflict) {
        const reason = error.reason;
        await db.transaction(async (tx) => {
          await assertWritable(tx);
          await tx.update(productAuditPolicyRunItems).set({ state: "undo_blocked", reason })
            .where(and(eq(productAuditPolicyRunItems.id, row.id), eq(productAuditPolicyRunItems.state, expected)));
        });
        return blocked(reason) as T;
      }
      // 이 항목만의 오류 — 운영 로그에 코드만. 적용이면 까닭을 남기고 다음 항목으로(트랜잭션이 버려져 아무것도 바뀌지 않았고, 항목은 열린 채라
      // 다음 정책이 다시 고른다). 되돌리기면 던진다 — 적용한 채로 남겨 '되돌리기 이어서'가 다시 시도한다(잠깐의 연결 끊김으로 영영 못 되돌리지 않게)
      logger.error("audit_policy.item_failed", { runItem: row.id, item: row.itemId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      if (expected === "applied") throw error;
      await db.transaction(async (tx) => {
        await assertWritable(tx);
        await tx.update(productAuditPolicyRunItems).set(expected === "pending" ? { state: "skipped", reason: "error" } : { state: "undo_blocked", reason: "error" })
          .where(and(eq(productAuditPolicyRunItems.id, row.id), eq(productAuditPolicyRunItems.state, expected)));
      });
      return (expected === "pending" ? skipped("error") : blocked("error")) as T;
    }
  }
}

async function nextRows(runId: number, state: "pending" | "applied", limit: number): Promise<RunRow[]> {
  return db.select({ id: productAuditPolicyRunItems.id, itemId: productAuditPolicyRunItems.itemId, productId: productAuditPolicyRunItems.productId,
    slug: productAuditPolicyRunItems.slug, payload: productAuditPolicyRunItems.payload, before: productAuditPolicyRunItems.before,
    after: productAuditPolicyRunItems.after })
    .from(productAuditPolicyRunItems).where(and(eq(productAuditPolicyRunItems.runId, runId), eq(productAuditPolicyRunItems.state, state)))
    .orderBy(asc(productAuditPolicyRunItems.id)).limit(limit);
}

/**
 * 적용 한 묶음 — 남은 항목(pending)을 id 차례로 POLICY_CHUNK 건·POLICY_CHUNK_MS 안에서. 다 끝났으면 같은 트랜잭션에서 실행을 '적용함'으로 닫고
 * 작업 로그에 한 줄 남긴다. 몇 번 불러도 같다 — 이미 적용·건너뛴 항목은 다시 손대지 않는다.
 */
export async function applyAuditPolicyChunk(input: { runId: number; by: string; limit?: number; budgetMs?: number }): Promise<PolicyRunProgress | null> {
  const run = await loadRun(input.runId);
  if (!run) return null;
  if (run.status !== "applying") return policyRunProgress(run.id);
  const handler = handlerOf(run);
  let limit = Math.min(input.limit ?? POLICY_CHUNK, POLICY_CHUNK);
  if (handler.cdnPerProduct) {
    const room = await cdnRoom();
    if (room <= 0) return policyRunProgress(run.id, { reason: "cdn", retryMs: 20_000 });
    limit = Math.min(limit, room);
  }
  const ctx = await policyContext(latestOf(run));
  if (!ctx) return policyRunProgress(run.id);
  const startedAt = Date.now();
  let relisted = false;
  for (const row of await nextRows(run.id, "pending", limit)) {
    if (Date.now() - startedAt > (input.budgetMs ?? POLICY_CHUNK_MS)) break;
    const outcome = await step(row, "pending", (tx) => handler.apply(tx, run, row, input.by, ctx), async (tx, result) => {
      await tx.update(productAuditPolicyRunItems).set(result.state === "applied"
        ? { state: "applied", before: result.before, after: result.after ?? null, appliedAt: sql`now()`, reason: null }
        : { state: "skipped", reason: result.reason }).where(eq(productAuditPolicyRunItems.id, row.id));
    });
    if (outcome?.state === "applied" && outcome.relisted) relisted = true;
  }
  if (relisted) await listPurge(AUDIT_RELEASE_PURGE);
  await finishIfDone(run.id, "applying", input.by);
  return policyRunProgress(run.id);
}

/**
 * 되돌리기를 시작한다 — 적용함·적용 중인 실행만. 적용 중이었으면 아직 손대지 않은 항목은 '취소'로 닫는다(더 적용하지 않는다).
 * 되돌리기 자체도 나눠 돈다(undoAuditPolicyChunk).
 */
export async function startAuditPolicyUndo(input: { runId: number; by: string }): Promise<PolicyResult<{ progress: PolicyRunProgress }>> {
  try {
    const result = await db.transaction(async (tx) => {
      await assertWritable(tx);
      const [run] = await tx.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.id, input.runId)).for("update");
      if (!run) return { ok: false as const, error: "정책 실행을 찾지 못했습니다." };
      if (run.status === "undoing") return { ok: true as const };
      if (run.status !== "applied" && run.status !== "applying") return { ok: false as const, error: "적용한 실행만 되돌릴 수 있습니다." };
      if (run.status === "applying") {
        await tx.update(productAuditPolicyRunItems).set({ state: "cancelled" })
          .where(and(eq(productAuditPolicyRunItems.runId, run.id), eq(productAuditPolicyRunItems.state, "pending")));
      }
      await tx.update(productAuditPolicyRuns).set({ status: "undoing", undoBy: input.by.slice(0, 120), undoStartedAt: sql`now()` })
        .where(eq(productAuditPolicyRuns.id, run.id));
      return { ok: true as const };
    });
    if (!result.ok) return result;
  } catch (error) {
    if (uniqueViolation(error) === "product_audit_policy_runs_one_active_idx") return { ok: false, error: ACTIVE_RUN };
    throw error;
  }
  return { ok: true, progress: (await policyRunProgress(input.runId))! };
}

/**
 * 되돌리기 한 묶음 — 적용한 항목(applied)을 그 실행 전 상태로. 그 뒤에 바뀐 항목(사람이 다시 정함·차단 해제·보류가 다시 걸림·주인이 생김·
 * 유지 연장 등)은 손대지 않고 '되돌리지 못함'과 까닭을 남긴다 — 화면이 그 목록을 보인다. 다 끝나면 '되돌림'으로 닫고 작업 로그에 한 줄.
 */
export async function undoAuditPolicyChunk(input: { runId: number; by: string; limit?: number; budgetMs?: number }): Promise<PolicyRunProgress | null> {
  const run = await loadRun(input.runId);
  if (!run) return null;
  if (run.status !== "undoing") return policyRunProgress(run.id);
  const handler = handlerOf(run);
  let limit = Math.min(input.limit ?? POLICY_CHUNK, POLICY_CHUNK);
  if (handler.cdnPerProduct) {
    const room = await cdnRoom();
    if (room <= 0) return policyRunProgress(run.id, { reason: "cdn", retryMs: 20_000 });
    limit = Math.min(limit, room);
  }
  const startedAt = Date.now();
  let relisted = false;
  for (const row of await nextRows(run.id, "applied", limit)) {
    if (Date.now() - startedAt > (input.budgetMs ?? POLICY_CHUNK_MS)) break;
    const outcome = await step(row, "applied", (tx) => handler.undo(tx, run, row, input.by), async (tx, result) => {
      await tx.update(productAuditPolicyRunItems).set(result.state === "undone"
        ? { state: "undone", undoneAt: sql`now()` } : { state: "undo_blocked", reason: result.reason })
        .where(eq(productAuditPolicyRunItems.id, row.id));
    });
    if (outcome?.state === "undone" && outcome.relisted) relisted = true;
  }
  if (relisted) await listPurge(handler.undoPurge ?? AUDIT_HOLD_PURGE);
  await finishIfDone(run.id, "undoing", input.by);
  return policyRunProgress(run.id);
}

/**
 * 남은 것이 없으면 실행을 닫는다 — 실행 행을 잠근 한 트랜잭션에서 상태를 바꾸고 작업 로그에 한 줄(정책·거르기·수·누가). 두 번 불려도 한 번만 닫는다
 */
async function finishIfDone(runId: number, phase: "applying" | "undoing", by: string): Promise<void> {
  const waitingState = phase === "applying" ? "pending" : "applied";
  await db.transaction(async (tx) => {
    await assertWritable(tx);
    const [run] = await tx.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.id, runId)).for("update");
    if (!run || run.status !== phase) return;
    const states = await tx.select({ state: productAuditPolicyRunItems.state, reason: productAuditPolicyRunItems.reason, count: sql<number>`count(*)::int` })
      .from(productAuditPolicyRunItems).where(eq(productAuditPolicyRunItems.runId, runId))
      .groupBy(productAuditPolicyRunItems.state, productAuditPolicyRunItems.reason);
    if (states.some((row) => row.state === waitingState && row.count > 0)) return;
    const count = (state: string) => states.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0);
    const reasons = (state: string) => Object.fromEntries(states.filter((row) => row.state === state && row.reason).map((row) => [row.reason, row.count]));
    const common = { runId, kind: run.kind, policy: run.action, filter: run.filter, filterText: (run.options as { filterText?: string }).filterText ?? null,
      options: run.options, planned: run.planned, note: run.note, createdBy: run.createdBy, auto: autoRunInfo(run) };
    if (phase === "applying") {
      await tx.update(productAuditPolicyRuns).set({ status: "applied", appliedAt: sql`now()` }).where(eq(productAuditPolicyRuns.id, runId));
      await tx.insert(operationsAudit).values(await adminAuditRow(by, { action: "audit-policy-apply", target: `policy-run:${runId}`,
        detail: { ...common, applied: count("applied"), skipped: count("skipped"), skipReasons: reasons("skipped"),
          previewSkipped: (run.summary as { skipped?: unknown }).skipped ?? {} } }));
    } else {
      const blockedRows = await tx.select({ slug: productAuditPolicyRunItems.slug, reason: productAuditPolicyRunItems.reason })
        .from(productAuditPolicyRunItems).where(and(eq(productAuditPolicyRunItems.runId, runId), eq(productAuditPolicyRunItems.state, "undo_blocked")))
        .orderBy(asc(productAuditPolicyRunItems.id)).limit(50);
      await tx.update(productAuditPolicyRuns).set({ status: "undone", undoneAt: sql`now()` }).where(eq(productAuditPolicyRuns.id, runId));
      await tx.insert(operationsAudit).values(await adminAuditRow(by, { action: "audit-policy-undo", target: `policy-run:${runId}`,
        detail: { ...common, undone: count("undone"), blocked: count("undo_blocked"), blockReasons: reasons("undo_blocked"),
          cancelled: count("cancelled"), blockedSample: blockedRows } }));
    }
  });
}

// ─────────────────────────── 화면 ───────────────────────────

export type PolicyRunView = {
  id: number; kind: string; action: string; status: string; planned: number; note: string | null; createdBy: string; createdAt: Date;
  appliedAt: Date | null; undoBy: string | null; undoneAt: Date | null; filterText: string; options: Record<string, unknown>;
  counts: Record<string, number>;
  /** 감사 두 번째 의견의 자동 실행(audit-auto-close.ts)이면 그 뜻 — 사람이 만든 실행은 null */
  auto: AutoRunInfo | null;
};

/**
 * 최근 실행 — 상태와 항목 상태별 수. 적용 중·되돌리기 중인 것이 맨 위. 버린 올리기와 올리다 만 올리기(staging — 창을 닫았거나 끊김,
 * 아무것도 적지 않았다)는 빼고, 검사만 한 올리기(staged)는 '검사함 · 적용 전'으로 보인다.
 * 감사 두 번째 의견의 자동 실행(하루·행동마다 하나)은 사람이 만든 실행을 밀어내지 않게 따로 autoLimit 개(기본 이레 치)까지 함께 보인다
 */
export async function listPolicyRuns(limit = 15, autoLimit = 14): Promise<PolicyRunView[]> {
  const isAuto = sql`((${productAuditPolicyRuns.options}->'auto') is not null)`;
  const select = (auto: boolean, count: number) => db.select().from(productAuditPolicyRuns)
    .where(and(sql`${productAuditPolicyRuns.status} not in ('discarded', 'staging')`, auto ? isAuto : sql`not ${isAuto}`))
    .orderBy(sql`(${productAuditPolicyRuns.status} in ('applying', 'undoing')) desc`, desc(productAuditPolicyRuns.id)).limit(count);
  const [manual, automatic] = await Promise.all([select(false, limit), select(true, autoLimit)]);
  const active = (run: ProductAuditPolicyRun) => run.status === "applying" || run.status === "undoing";
  const runs = [...manual, ...automatic].sort((a, b) => Number(active(b)) - Number(active(a)) || b.id - a.id);
  if (!runs.length) return [];
  const counts = await db.select({ runId: productAuditPolicyRunItems.runId, state: productAuditPolicyRunItems.state, count: sql<number>`count(*)::int` })
    .from(productAuditPolicyRunItems).where(inArray(productAuditPolicyRunItems.runId, runs.map((run) => run.id)))
    .groupBy(productAuditPolicyRunItems.runId, productAuditPolicyRunItems.state);
  return runs.map((run) => ({
    id: run.id, kind: run.kind, action: run.action, status: run.status, planned: run.planned, note: run.note, createdBy: run.createdBy,
    createdAt: run.createdAt, appliedAt: run.appliedAt, undoBy: run.undoBy, undoneAt: run.undoneAt, options: run.options,
    filterText: (run.options as { filterText?: string }).filterText ?? "",
    counts: Object.fromEntries(counts.filter((row) => row.runId === run.id).map((row) => [row.state, row.count])), auto: autoRunInfo(run),
  }));
}

/** 그 실행에서 되돌리지 못한 것과 건너뛴 것 — 이름·주소·까닭 */
export async function policyRunExceptions(runId: number, limit = 200) {
  return db.select({ itemId: productAuditPolicyRunItems.itemId, slug: productAuditPolicyRunItems.slug, state: productAuditPolicyRunItems.state,
    reason: productAuditPolicyRunItems.reason, name: products.name, url: products.url })
    .from(productAuditPolicyRunItems).leftJoin(products, eq(products.id, productAuditPolicyRunItems.productId))
    .where(and(eq(productAuditPolicyRunItems.runId, runId), inArray(productAuditPolicyRunItems.state, ["undo_blocked", "skipped"])))
    .orderBy(asc(productAuditPolicyRunItems.state), asc(productAuditPolicyRunItems.id)).limit(limit);
}

// ─────────────────────────── 처리 속도·적체 ───────────────────────────

/**
 * 적체 경보의 문턱 — 가장 오래 기다린 열린 거절이 이만큼 넘으면 메뉴 배지·오늘 할 일에 '오래 기다림'을 세운다.
 *
 * 7일인 까닭: (1) 감사 답·Qwen-v2 두 번째 의견·자동 보류는 하루 안에 끝난다 — 일주일 넘게 열린 것은 사람 말고는 닫을 길이 없다.
 * (2) 하루 300~500건이 들어온다(2026-10-22) — 수로 문턱을 잡으면(예: 1,000건) 늘 켜져 있다. 나이로 잡으면 운영자가 일주일에 한 번
 * 정책으로 닫는 한 꺼진다. (3) 보류된 것은 이미 목록에서 빠졌지만 보류 아닌 거절(0.95 미만·갈림)은 공개 목록에 떠 있다 — 일주일을
 * 공개 목록에 제품 아닌 것을 둬도 되는 상한으로 잡았다. 빨강(긴급)은 쓰지 않는다 — 약속 시간(내려달라는 요청 24시간)이 있는 일만 빨강이다.
 */
export const AUDIT_BACKLOG_OVERDUE_DAYS = 7;

export type OpenBacklogStats = { open: number; held: number; overdue: number; oldestWaitDays: number | null };

/** 열린 거절의 적체 — 정책 처리의 대상과 같은 정의. 수·보류 중·문턱을 넘은 것·가장 오래 기다린 날 */
export async function openBacklogStats(): Promise<OpenBacklogStats> {
  const ctx = await policyContext();
  if (!ctx) return { open: 0, held: 0, overdue: 0, oldestWaitDays: null };
  const [row] = await db.execute<OpenBacklogStats & { oldest: number | null }>(sql`
    select count(*)::int as open, count(*) filter (where p.audit_hold_at is not null)::int as held,
      count(*) filter (where i.reviewed_at <= now() - ${AUDIT_BACKLOG_OVERDUE_DAYS} * interval '1 day')::int as overdue,
      floor(extract(epoch from (now() - min(i.reviewed_at))) / 86400)::int as oldest
      ${FROM} where ${universeSql(ctx.latest)}`);
  return { open: row?.open ?? 0, held: row?.held ?? 0, overdue: row?.overdue ?? 0, oldestWaitDays: row?.oldest ?? null };
}

export type AuditThroughput = OpenBacklogStats & {
  /** 한국 날짜마다 — 닫은 것(사람의 유지·내리기, 정책, m1 자동 유지 포함 — human_decision)과 새로 들어온 AI 거절 */
  days: { day: string; closed: number; incoming: number }[];
  /** 어제까지 7일 하루 평균 */
  closedPerDay: number; incomingPerDay: number;
  /** 지금 속도로 다 닫는 데 걸릴 날 — 줄지 않으면 null */
  daysToClear: number | null;
};

/** 처리 속도 — 지난 14일(한국 날짜) 닫은 수와 들어온 수, 어제까지 7일 평균으로 다 닫는 날 */
export async function auditThroughput(): Promise<AuditThroughput> {
  const kstDay = (column: SQL) => sql`((${column} + interval '9 hours')::date)`;
  const [backlog, closed, incoming, [today]] = await Promise.all([
    openBacklogStats(),
    db.execute<{ day: string; n: number }>(sql`select ${kstDay(sql`human_at`)}::text as day, count(*)::int as n from ${productAuditItems}
      where human_decision is not null and human_at >= now() - interval '15 days' group by 1`),
    db.execute<{ day: string; n: number }>(sql`select ${kstDay(sql`reviewed_at`)}::text as day, count(*)::int as n from ${productAuditItems}
      where ai_decision = 'reject' and reviewed_at >= now() - interval '15 days' group by 1`),
    db.execute<{ day: string }>(sql`select ${kstDay(sql`now()`)}::text as day`),
  ]);
  const closedBy = new Map([...closed].map((row) => [row.day, row.n]));
  const incomingBy = new Map([...incoming].map((row) => [row.day, row.n]));
  const base = Date.parse(`${today.day}T00:00:00Z`);
  const days = Array.from({ length: 14 }, (_, index) => {
    const day = new Date(base - (13 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, closed: closedBy.get(day) ?? 0, incoming: incomingBy.get(day) ?? 0 };
  });
  // 오늘은 아직 끝나지 않았다 — 평균은 어제까지 7일
  const week = days.slice(-8, -1);
  const closedPerDay = week.reduce((sum, day) => sum + day.closed, 0) / 7;
  const incomingPerDay = week.reduce((sum, day) => sum + day.incoming, 0) / 7;
  const net = closedPerDay - incomingPerDay;
  return { ...backlog, days, closedPerDay, incomingPerDay,
    daysToClear: backlog.open === 0 ? 0 : net > 0 ? Math.ceil(backlog.open / net) : null };
}

// ─────────────────────────── 유지 연장 ───────────────────────────

export const KEEP_EXTEND_WITHIN_DAYS = 30;

type KeepCandidate = { item_id: number; product_id: number; slug: string; name: string; url: string; keep_until: string; source_hash: string | null;
  days_left: number };

/** 곧 끝나는 유지의 조건 — 기한이 withinDays 안이고, 제품이 떠 있고, 그 제품의 가장 늦은 유지인 것 */
const expiringKeep = (withinDays: number) => sql`i.human_decision = 'kept' and i.keep_until > now()
  and i.keep_until <= now() + ${withinDays} * interval '1 day' and p.status in ('seeded', 'verified')
  and not exists (select 1 from ${productAuditItems} k where k.product_id = i.product_id and k.human_decision = 'kept' and k.keep_until > i.keep_until)`;

async function keepCandidates(withinDays: number): Promise<KeepCandidate[]> {
  return [...await db.execute<KeepCandidate>(sql`
    select i.id as item_id, i.product_id, p.slug, p.name, p.url, to_char(i.keep_until, ${OPINION_TIME}) as keep_until, i.source_hash,
      ceil(extract(epoch from (i.keep_until - now())) / 86400)::int as days_left
      from ${productAuditItems} i join ${products} p on p.id = i.product_id where ${expiringKeep(withinDays)}
     order by i.keep_until, i.id`)];
}

/** 곧 끝나는 유지의 수 — 화면 머리(무겁지 않게 페이지 해시는 세지 않는다) */
export async function expiringKeepCount(withinDays = KEEP_EXTEND_WITHIN_DAYS): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${productAuditItems} i join ${products} p on p.id = i.product_id
    where ${expiringKeep(withinDays)}`);
  return row?.n ?? 0;
}

export type KeepExtendPreview = { withinDays: number; expiring: number; same: number; changed: number; noSource: number;
  /** 이 설정으로 연장할 수 — 사람이 적을 수 */
  eligible: number; unchangedOnly: boolean;
  sample: { itemId: number; slug: string; name: string; url: string; daysLeft: number; content: "same" | "changed" | "no_source" }[] };

async function keepSelection(withinDays: number, unchangedOnly: boolean) {
  const rows = await keepCandidates(withinDays);
  const status = await keptContentStatus(rows.map((row) => ({ itemId: row.item_id, productId: row.product_id, sourceHash: row.source_hash })));
  const content = (row: KeepCandidate) => status.get(row.item_id) ?? "no_source";
  return { rows, content, picked: rows.filter((row) => !unchangedOnly || content(row) === "same") };
}

/**
 * 유지 연장 미리보기 — 곧 끝나는 유지와 그 페이지가 유지할 때와 같은지(같음·바뀜·원본 없음). 바뀐 것은 기한과 상관없이 다음 감사에 다시 든다
 * (startProductAudit liveKeptProducts) — 그대로인 것만 연장하면(기본) 같은 판단을 되풀이하지 않으면서 바뀐 페이지는 다시 본다
 */
export async function previewKeepExtend(input: { withinDays?: number; unchangedOnly: boolean }): Promise<KeepExtendPreview> {
  const withinDays = input.withinDays ?? KEEP_EXTEND_WITHIN_DAYS;
  const { rows, content, picked } = await keepSelection(withinDays, input.unchangedOnly);
  const count = (kind: "same" | "changed" | "no_source") => rows.filter((row) => content(row) === kind).length;
  return { withinDays, expiring: rows.length, same: count("same"), changed: count("changed"), noSource: count("no_source"), eligible: picked.length,
    unchangedOnly: input.unchangedOnly, sample: rows.slice(0, 20).map((row) => ({ itemId: row.item_id, slug: row.slug, name: row.name, url: row.url,
      daysLeft: row.days_left, content: content(row) })) };
}

/** 유지 연장 실행을 만든다 — 적은 수가 지금 고른 수와 같을 때만. 만들 때의 기한을 항목마다 굳힌다(그 사이 바뀐 것은 적용이 건너뛴다) */
export async function startKeepExtendRun(input: { withinDays?: number; days: number; unchangedOnly: boolean; expected: number; note: string; by: string }):
  Promise<PolicyResult<{ runId: number; planned: number }>> {
  const withinDays = input.withinDays ?? KEEP_EXTEND_WITHIN_DAYS;
  const { picked } = await keepSelection(withinDays, input.unchangedOnly);
  if (picked.length !== input.expected) {
    return { ok: false, error: `지금 연장할 수는 ${picked.length.toLocaleString("ko-KR")}건입니다(적은 수 ${input.expected.toLocaleString("ko-KR")}건). 다시 미리 보세요.` };
  }
  try {
    return await db.transaction(async (tx) => {
      await assertWritable(tx);
      const [run] = await tx.insert(productAuditPolicyRuns).values({ kind: "extend", action: "extend", status: "applying", planned: picked.length,
        filter: { withinDays, unchangedOnly: input.unchangedOnly },
        options: { days: input.days, withinDays, unchangedOnly: input.unchangedOnly,
          filterText: `${withinDays}일 안에 끝나는 유지${input.unchangedOnly ? "(페이지 그대로인 것만)" : ""} → ${input.days}일 연장` },
        note: input.note.trim().slice(0, 500) || null, createdBy: input.by.slice(0, 120) }).returning({ id: productAuditPolicyRuns.id });
      for (let index = 0; index < picked.length; index += INSERT_BATCH) {
        await tx.insert(productAuditPolicyRunItems).values(picked.slice(index, index + INSERT_BATCH).map((row) => ({ runId: run.id, itemId: row.item_id,
          productId: row.product_id, slug: row.slug, payload: { keepUntil: row.keep_until } })));
      }
      return { ok: true as const, runId: run.id, planned: picked.length };
    });
  } catch (error) {
    if (uniqueViolation(error) === "product_audit_policy_runs_one_active_idx") return { ok: false, error: ACTIVE_RUN };
    throw error;
  }
}
