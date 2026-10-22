import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productAuditItems, productAuditPolicyRunItems, productAuditPolicyRuns, products } from "@/lib/db/schema";
import { uniqueViolation } from "@/lib/domain/products/repository";
import { ACTIVE_RUN, assertWritable, type PolicyResult } from "./audit-policy";
import { importHoldEffect, supersedeCandidate, type ImportBlocker } from "./audit-import-gate";
import { IMPORT_SOURCES, parseImportLine, type ImportOpinion, type ImportSource } from "./audit-import-sources";
import { secondOpinionVotesField } from "./audit-second-opinions";
import { auditItemModel, type HoldGateOpinion } from "./product-audit-hold";
import { getSettings } from "./settings";

/**
 * 두 번째 의견 파일 올리기(0116) — 관리자 화면에서 JSONL 을 올려 검사 → 미리보기 → 적용한다. CLI(scripts/ops/import-audit-second-opinions.ts)와
 * 같은 뜻이지만 사람이 수와 영향을 먼저 보고, 실행 하나(product_audit_policy_runs kind=import)로 남아 통째로 되돌릴 수 있다.
 *
 * 1. 올리기(stageImportLines): 화면이 파일을 줄로 나눠 몇백 줄씩 보낸다(서버 액션 본문 1MB 상한). 줄마다 읽어(audit-import-sources.ts)
 *    실패·모양 틀림·같은 파일의 같은 항목(뒤의 것만)·없는 항목·제품 다름(grok 은 productId, 화면 재판정은 지금 제품 slug)·모델 다름을 세고,
 *    남은 줄을 실행 항목(pending, payload)으로 둔다. 아무것도 적지 않는다 — 감사 항목·의견·보류는 그대로다.
 * 2. 미리보기(previewImport, 읽기만): 지금 열린 거절에 적을 수(새로·덮어씀), 보류 중인 항목에 온 승인이 푸는 보류(덮어쓴 뒤 둘째 문으로),
 *    대체(supersede)를 켜면 더 풀릴 항목 전부와 그 항목이 대신할 글만 본 거절, 그래도 남는 보류와 막는 의견.
 * 3. 적용(startImportApply → audit-policy.ts 의 나눠 적용): 적을 수를 그대로 적어야 한다. 대체는 사람이 켰을 때만.
 */

/** 한 번에 받는 줄 수 — 화면은 이보다 적게, 본문 600KB 안으로 나눈다 */
export const IMPORT_STAGE_MAX_LINES = 500;

export type ImportStageSummary = { read: number; stored: number; error: number; invalid: number; duplicate: number; missing: number;
  product_mismatch: number; model_mismatch: number };
const EMPTY_SUMMARY: ImportStageSummary = { read: 0, stored: 0, error: 0, invalid: 0, duplicate: 0, missing: 0, product_mismatch: 0, model_mismatch: 0 };

type ImportRunOptions = { source: ImportSource; model: string | null; promptVersion: string | null; label: string; filterText: string; supersede?: boolean };

/**
 * 줄을 받는다 — runId 가 없으면 새 올리기(staging)를 열고, final 이면 '검사함'(staged)으로 닫는다. 한 번이 한 트랜잭션(DR fence 첫 잠금)이다.
 * 같은 올리기에 다른 출처의 줄을 섞지 않는다
 */
export async function stageImportLines(input: { runId: number | null; source: ImportSource; lines: readonly string[]; final: boolean; by: string }):
  Promise<PolicyResult<{ runId: number; status: string; summary: ImportStageSummary }>> {
  if (input.lines.length > IMPORT_STAGE_MAX_LINES) return { ok: false, error: `한 번에 ${IMPORT_STAGE_MAX_LINES}줄까지 받습니다.` };
  const spec = IMPORT_SOURCES[input.source];
  return db.transaction(async (tx) => {
    await assertWritable(tx);
    let run;
    if (input.runId === null) {
      [run] = await tx.insert(productAuditPolicyRuns).values({ kind: "import", action: "import", status: "staging", summary: { ...EMPTY_SUMMARY },
        options: { source: input.source, model: spec.model, promptVersion: spec.promptVersion, label: spec.label,
          filterText: `${spec.label} 올리기` } satisfies ImportRunOptions, createdBy: input.by.slice(0, 120) }).returning();
    } else {
      [run] = await tx.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.id, input.runId)).for("update");
      if (!run || run.kind !== "import" || run.status !== "staging") return { ok: false as const, error: "이미 끝났거나 버린 올리기입니다. 파일을 다시 올려 주세요." };
      if ((run.options as ImportRunOptions).source !== input.source) return { ok: false as const, error: "한 올리기에 다른 출처의 줄을 섞을 수 없습니다." };
    }
    const options = run.options as ImportRunOptions;
    const summary: ImportStageSummary = { ...EMPTY_SUMMARY, ...(run.summary as Partial<ImportStageSummary>) };
    summary.read += input.lines.length;
    let model = options.model;
    // 같은 파일 안의 같은 항목은 뒤의 것만(이 묶음 안에서 먼저 가린다 — 같은 INSERT 가 한 행을 두 번 고칠 수 없다)
    const latest = new Map<number, ImportOpinion>();
    for (const raw of input.lines) {
      const parsed = parseImportLine(input.source, raw);
      if (typeof parsed === "string") { summary[parsed] += 1; continue; }
      model ??= parsed.model;
      if (parsed.model !== model) { summary.model_mismatch += 1; continue; }
      if (latest.has(parsed.itemId)) summary.duplicate += 1;
      latest.set(parsed.itemId, parsed);
    }
    const ids = [...latest.keys()];
    const items = ids.length ? new Map((await tx.select({ id: productAuditItems.id, productId: productAuditItems.productId, slug: products.slug })
      .from(productAuditItems).leftJoin(products, eq(products.id, productAuditItems.productId))
      .where(inArray(productAuditItems.id, ids))).map((row) => [row.id, row])) : new Map();
    const rows: (typeof productAuditPolicyRunItems.$inferInsert)[] = [];
    for (const line of latest.values()) {
      const item = items.get(line.itemId);
      if (!item || !item.slug) { summary.missing += 1; continue; }
      if ((line.productId !== null && line.productId !== item.productId) || (line.slug !== null && line.slug !== item.slug)) {
        summary.product_mismatch += 1;
        continue;
      }
      rows.push({ runId: run.id, itemId: line.itemId, productId: item.productId, slug: item.slug,
        payload: { model: line.model, decision: line.decision, confidence: line.confidence, reason: line.reason, inputHash: line.inputHash, shot: line.shot } });
    }
    if (rows.length) {
      const written = await tx.insert(productAuditPolicyRunItems).values(rows)
        .onConflictDoUpdate({ target: [productAuditPolicyRunItems.runId, productAuditPolicyRunItems.itemId], set: { payload: sql`excluded.payload` } })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      summary.duplicate += written.filter((row) => !row.inserted).length;
    }
    const [{ stored }] = await tx.select({ stored: sql<number>`count(*)::int` }).from(productAuditPolicyRunItems)
      .where(eq(productAuditPolicyRunItems.runId, run.id));
    summary.stored = stored;
    const status = input.final ? "staged" : "staging";
    await tx.update(productAuditPolicyRuns).set({ summary, options: { ...options, model }, status, planned: stored })
      .where(eq(productAuditPolicyRuns.id, run.id));
    return { ok: true as const, runId: run.id, status, summary };
  });
}

export type ImportPreviewRow = {
  itemId: number; slug: string; name: string | null; url: string | null; decision: string; confidence: number | null;
  /** 올린 줄의 사유 */
  reason: string | null;
  /** 감사(1차)의 사유 */
  auditReason: string | null;
  superseded?: { model: string; source: string | null; confidence: number | null }[];
  blockers?: ImportBlocker[];
};

export type ImportPreview = {
  runId: number; source: ImportSource; label: string; model: string | null; promptVersion: string | null; status: string;
  summary: ImportStageSummary; createdBy: string;
  /** 지금 열린 거절에 적을 수 — 사람이 적을 수 */
  writable: number; inserted: number; updated: number;
  /** 이제 열린 거절이 아닌 항목(사람이 정함·거절이 아님·내려감) — 적용이 건너뛴다 */
  notOpen: number;
  decisions: Record<string, number>;
  /** 지금 그 항목으로 보류된 제품에 온 승인 */
  heldApprovals: number;
  /** 덮어쓴 뒤의 의견으로 둘째 문이 맞지 않아 풀리는 보류 */
  releaseByGate: number;
  /** 대체를 켜면 더 풀리는 보류 — 켜지 않았어도 센다(무엇이 바뀌는지 보이려고) */
  releaseBySupersede: number;
  /** 그래도 남는 보류(이 미리보기의 대체 설정으로) */
  blocked: number;
  /** 보류 아닌 열린 거절에 온 거절 — 감사 잡의 쓸기가 둘째 문을 지나면 다음 틱부터 보류한다 */
  unheldRejects: number;
  supersede: boolean;
  supersedeRows: ImportPreviewRow[];
  blockedRows: ImportPreviewRow[];
  gateRows: ImportPreviewRow[];
};

const PREVIEW_PAGE = 1_000;
const LIST_LIMIT = 300;

/**
 * 미리보기 — 읽기만. 올린 줄을 지금의 항목·제품·의견·보류 설정과 견준다. 대체 대상(supersedeRows)은 켜든 끄든 전부 보인다 —
 * 켜면 바로 그 항목들의 보류가 풀린다. 막힌 것(blockedRows)은 이 미리보기의 대체 설정으로 센다
 */
export async function previewImport(input: { runId: number; supersede: boolean }): Promise<PolicyResult<{ preview: ImportPreview }>> {
  const [run] = await db.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.id, input.runId));
  if (!run || run.kind !== "import") return { ok: false, error: "올리기를 찾지 못했습니다." };
  if (run.status !== "staged") return { ok: false, error: run.status === "staging" ? "아직 올리는 중입니다." : "이미 적용했거나 버린 올리기입니다." };
  const options = run.options as ImportRunOptions;
  const settings = await getSettings();
  const gate = { autoOpinions: settings.qwenAuto.auditSecondOpinion.enabled };
  const preview: ImportPreview = { runId: run.id, source: options.source, label: options.label, model: options.model, promptVersion: options.promptVersion,
    status: run.status, summary: { ...EMPTY_SUMMARY, ...(run.summary as Partial<ImportStageSummary>) }, createdBy: run.createdBy,
    writable: 0, inserted: 0, updated: 0, notOpen: 0, decisions: {}, heldApprovals: 0, releaseByGate: 0, releaseBySupersede: 0, blocked: 0,
    unheldRejects: 0, supersede: input.supersede, supersedeRows: [], blockedRows: [], gateRows: [] };
  for (let afterId = 0; ;) {
    const page = await db.execute<{ id: number; item_id: number; slug: string; payload: ImportOpinion; name: string | null; url: string | null; open: boolean;
      audit_reason: string | null; audit_confidence: number | null; audit_model: string | null; held_by_item: boolean; held: boolean;
      opinions: HoldGateOpinion[] }>(sql`
      select ri.id, ri.item_id, ri.slug, ri.payload, p.name, p.url,
        coalesce(i.ai_decision = 'reject' and i.human_decision is null and p.status in ('seeded', 'verified') and p.slug = ri.slug, false) as open,
        i.ai_reason as audit_reason, i.ai_confidence as audit_confidence, ${auditItemModel("i")} as audit_model,
        coalesce(p.audit_hold_at is not null and p.audit_hold_item_id = i.id, false) as held_by_item, coalesce(p.audit_hold_at is not null, false) as held,
        ${secondOpinionVotesField(sql`i.id`)} as opinions
        from ${productAuditPolicyRunItems} ri join ${productAuditItems} i on i.id = ri.item_id left join ${products} p on p.id = ri.product_id
       where ri.run_id = ${run.id} and ri.state = 'pending' and ri.id > ${afterId} order by ri.id limit ${PREVIEW_PAGE}`);
    for (const row of page) {
      const line = row.payload;
      if (!row.open) { preview.notOpen += 1; continue; }
      preview.writable += 1;
      preview.decisions[line.decision] = (preview.decisions[line.decision] ?? 0) + 1;
      if (row.opinions.some((opinion) => opinion.model === line.model)) preview.updated += 1;
      else preview.inserted += 1;
      const base: ImportPreviewRow = { itemId: row.item_id, slug: row.slug, name: row.name, url: row.url, decision: line.decision,
        confidence: line.confidence, reason: line.reason, auditReason: row.audit_reason };
      if (line.decision === "reject" && !row.held) preview.unheldRejects += 1;
      if (line.decision !== "approve" || !row.held_by_item) continue;
      preview.heldApprovals += 1;
      const opinions = [...row.opinions.filter((opinion) => opinion.model !== line.model),
        { model: line.model, decision: line.decision, source: options.source, confidence: line.confidence }];
      const effect = (supersede: boolean) => importHoldEffect({ item: { reason: row.audit_reason, model: row.audit_model, confidence: row.audit_confidence },
        opinions, line: { ...line, source: options.source }, hold: settings.auditHold, options: gate, supersede });
      const plain = effect(false);
      if (plain.release === "gate") {
        preview.releaseByGate += 1;
        if (preview.gateRows.length < 50) preview.gateRows.push(base);
        continue;
      }
      const withSupersede = supersedeCandidate({ decision: line.decision, shot: line.shot, source: options.source }) ? effect(true) : plain;
      if (withSupersede.release === "supersede") {
        preview.releaseBySupersede += 1;
        preview.supersedeRows.push({ ...base, superseded: withSupersede.superseded });
        if (input.supersede) continue;
      }
      preview.blocked += 1;
      if (preview.blockedRows.length < LIST_LIMIT) preview.blockedRows.push({ ...base, blockers: plain.blockers });
    }
    if (page.length < PREVIEW_PAGE) break;
    afterId = page[page.length - 1].id;
  }
  return { ok: true, preview };
}

/**
 * 적용을 시작한다 — 지금 열린 거절에 적을 수가 사람이 적은 수와 같을 때만. 대체 설정을 실행에 굳힌다. 그 뒤는 audit-policy.ts 의 나눠 적용이다
 */
export async function startImportApply(input: { runId: number; supersede: boolean; expected: number; by: string }):
  Promise<PolicyResult<{ runId: number; planned: number }>> {
  try {
    return await db.transaction(async (tx) => {
      await assertWritable(tx);
      const [run] = await tx.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.id, input.runId)).for("update");
      if (!run || run.kind !== "import" || run.status !== "staged") return { ok: false as const, error: "검사를 마친 올리기가 아닙니다. 새로고침해주세요." };
      const [{ writable, total }] = await tx.execute<{ writable: number; total: number }>(sql`
        select count(*) filter (where i.ai_decision = 'reject' and i.human_decision is null and p.status in ('seeded', 'verified') and p.slug = ri.slug)::int as writable,
          count(*)::int as total
          from ${productAuditPolicyRunItems} ri join ${productAuditItems} i on i.id = ri.item_id left join ${products} p on p.id = ri.product_id
         where ri.run_id = ${run.id} and ri.state = 'pending'`);
      if (writable !== input.expected) {
        return { ok: false as const, error: `지금 적을 수는 ${writable.toLocaleString("ko-KR")}건입니다(적은 수 ${input.expected.toLocaleString("ko-KR")}건). 다시 미리 보세요.` };
      }
      const options = run.options as ImportRunOptions;
      await tx.update(productAuditPolicyRuns).set({ status: "applying", planned: total,
        options: { ...options, supersede: input.supersede, filterText: `${options.label} 올리기${input.supersede ? " · 대체 켬" : ""}` } })
        .where(eq(productAuditPolicyRuns.id, run.id));
      return { ok: true as const, runId: run.id, planned: total };
    });
  } catch (error) {
    if (uniqueViolation(error) === "product_audit_policy_runs_one_active_idx") return { ok: false, error: ACTIVE_RUN };
    throw error;
  }
}

/** 올리기를 버린다 — 적용 전(올리는 중·검사함)만. 아무것도 적지 않았으므로 되돌릴 것이 없다 */
export async function discardImport(input: { runId: number }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await assertWritable(tx);
    const rows = await tx.update(productAuditPolicyRuns).set({ status: "discarded" })
      .where(and(eq(productAuditPolicyRuns.id, input.runId), eq(productAuditPolicyRuns.kind, "import"), inArray(productAuditPolicyRuns.status, ["staging", "staged"])))
      .returning({ id: productAuditPolicyRuns.id });
    return rows.length > 0;
  });
}

/** 마지막으로 검사한(적용 전) 올리기 — 화면을 다시 열어도 이어서 미리보고 적용한다 */
export async function latestStagedImport(): Promise<{ runId: number; label: string; createdBy: string; createdAt: Date; summary: ImportStageSummary } | null> {
  const [run] = await db.select().from(productAuditPolicyRuns)
    .where(and(eq(productAuditPolicyRuns.kind, "import"), eq(productAuditPolicyRuns.status, "staged"))).orderBy(desc(productAuditPolicyRuns.id)).limit(1);
  if (!run) return null;
  return { runId: run.id, label: (run.options as ImportRunOptions).label, createdBy: run.createdBy, createdAt: run.createdAt,
    summary: { ...EMPTY_SUMMARY, ...(run.summary as Partial<ImportStageSummary>) } };
}
