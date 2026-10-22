import { z } from "zod";
import { AUDIT_REASON_KEYS, type AuditReasonCategory } from "./audit-reason-category";

/**
 * 감사 정책 처리의 거르기·행동·까닭 이름(0116) — 화면(브라우저)과 서버(lib/crawl/audit-policy.ts)가 같이 쓴다. DB 를 끌어오지 않는다.
 *
 * 2026-10-22 프로드: 사람 결정 없는 공개 제품의 AI 거절이 7,450건이고 하루 300~500건씩 는다. 감사 화면은 한 쪽에 50줄, 150쪽이다.
 * 사람이 한 건씩 누르는 대신 거르기(모델·확신·보류·두 번째 의견·사유 갈래·주인·기다린 날·지금 상태)를 만들고, 미리 본 뒤 수를 적어 한 번에 닫는다.
 */

/** 정책이 할 수 있는 일 — 내리기(차단, 지금의 묶어 내리기와 같은 뜻)·유지(사람의 유지와 같은 뜻)·보류 풀기(보류 중인 것만) */
export const POLICY_ACTIONS = ["remove", "keep"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_ACTION_LABELS: Record<PolicyAction, string> = {
  remove: "내리기(차단)",
  keep: "유지",
};

/** 유지의 기간 — 사람의 유지는 90일(KEEP_DAYS). 페이지 내용(source_hash)이 바뀌면 기간과 상관없이 다음 감사에 다시 든다 */
export const POLICY_KEEP_DAYS = [90, 180, 365] as const;
export type PolicyKeepDays = (typeof POLICY_KEEP_DAYS)[number];

/** 두 번째 의견으로 거르기 — any: 가리지 않음, none: 없음, reject/approve: 그 결정의 의견이 있음(출처를 고르면 그 출처의 것만), agreed·split: 감사 화면의 갈래 그대로 */
export const POLICY_SECOND = ["any", "none", "reject", "approve", "agreed", "split"] as const;
export type PolicySecond = (typeof POLICY_SECOND)[number];
export const POLICY_SECOND_LABELS: Record<PolicySecond, string> = {
  any: "가리지 않음",
  none: "의견 없음",
  reject: "거절 의견 있음",
  approve: "승인 의견 있음",
  agreed: "두 모델 모두 거절(보류에 세는 거절)",
  split: "갈림(2차 승인·카탈로그 예외)",
};

const confidence = z.number().min(0).max(1).nullable();
const days = z.number().int().min(0).max(3650).nullable();

export const policyFilterSchema = z.object({
  /** 감사 답을 낸 심사자 'provider|model' — 비면 모두 */
  reviewers: z.array(z.string().min(3).max(260)).max(20),
  /** 확신 이상(≥) */
  confidenceMin: confidence,
  /** 확신 미만(<) — 1 이면 1.00 까지 든다 */
  confidenceBelow: confidence,
  held: z.enum(["any", "held", "not_held"]),
  second: z.enum(POLICY_SECOND),
  /** 두 번째 의견의 출처(product_audit_second_opinions.source) — none·reject·approve·any 를 그 출처로 좁힌다 */
  secondSource: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,39}$/).nullable(),
  /** 사유 갈래(audit-reason-category) — 비면 모두 */
  branches: z.array(z.enum(AUDIT_REASON_KEYS as [AuditReasonCategory, ...AuditReasonCategory[]])).max(AUDIT_REASON_KEYS.length),
  owner: z.enum(["any", "unowned", "owned"]),
  /** 감사 답을 받은 지 이만큼 넘음(일) */
  waitMinDays: days,
  /** 감사 답을 받은 지 이만큼 안 됨(일) */
  waitMaxDays: days,
  /** 제품의 지금 상태 — 비면 공개(seeded·verified) 모두 */
  statuses: z.array(z.enum(["seeded", "verified"])).max(2),
}).strict();
export type PolicyFilter = z.infer<typeof policyFilterSchema>;

export const EMPTY_POLICY_FILTER: PolicyFilter = {
  reviewers: [], confidenceMin: null, confidenceBelow: null, held: "any", second: "any", secondSource: null, branches: [],
  owner: "any", waitMinDays: null, waitMaxDays: null, statuses: [],
};

export const policyRequestSchema = z.object({
  filter: policyFilterSchema,
  action: z.enum(POLICY_ACTIONS),
}).strict();

export const policyStartSchema = policyRequestSchema.extend({
  /** 사람이 적은 수 — 지금 고른 수와 같아야 만든다 */
  expected: z.number().int().min(1).max(100_000),
  note: z.string().max(500),
  keepDays: z.union([z.literal(90), z.literal(180), z.literal(365)]),
}).strict();
export type PolicyStart = z.infer<typeof policyStartSchema>;

/** 미리보기·적용이 건너뛰는 까닭 */
export const POLICY_SKIP_LABELS: Record<string, string> = {
  owned: "주인 있음(클레임·검증·메이커) — 묶어서 내리지 않습니다",
  low_confidence: "확신 0.95 미만 — 묶어서 내리지 않습니다",
  split: "갈림(2차 승인·카탈로그 예외) — 사람이 한 건씩 봅니다",
  second_approve: "두 번째 모델이 승인 — 모델이 갈려 내리지 않습니다",
  kept: "그 제품에 살아 있는 유지가 있음(다른 항목을 사람이 유지로 정함)",
  superseded: "그 제품에 더 새 감사 답이 있음 — 옛 거절로 내리지 않습니다",
  not_held: "보류 중이 아님",
  changed: "미리본 뒤 바뀜(사람이 정함·내려감·거르기 밖)",
  product_changed: "제품이 지워졌거나 주소(slug)가 바뀜",
  error: "적용 중 오류",
};

/** 되돌리지 못한 까닭 — 그 실행 뒤에 바뀐 것 */
export const POLICY_UNDO_BLOCK_LABELS: Record<string, string> = {
  decision_changed: "그 뒤 사람 결정이 바뀜",
  status_changed: "그 뒤 제품 상태가 바뀜(차단 해제·다시 차단·삭제 등)",
  hold_changed: "그 뒤 보류가 다시 걸렸거나 풀림",
  owned_now: "그 뒤 주인이 생김 — 보류를 다시 걸 수 없음",
  keep_changed: "그 뒤 유지 기한이 바뀜(연장 등)",
  product_changed: "제품이 지워졌거나 주소(slug)가 바뀜",
  opinion_changed: "그 뒤 두 번째 의견이 다시 적힘",
  takedown: "내려달라는 요청이 기다리거나 그 뒤 '내림'으로 처리됨 — 차단을 풀지 않습니다",
  error: "되돌리다 오류",
};

export const POLICY_RUN_STATUS_LABELS: Record<string, string> = {
  staging: "올리는 중", staged: "검사함 · 적용 전", applying: "적용 중", applied: "적용함", undoing: "되돌리는 중", undone: "되돌림",
  discarded: "버림",
};

/**
 * 층별 표본의 몫 — 갈래마다 수에 비례해 total 건을 나누되, 남은 것이 있는 갈래는 적어도 한 건(갈래가 total 보다 많으면 큰 갈래부터 한 건씩).
 * 몫은 그 갈래의 수를 넘지 않는다. 화면이 갈래마다 몇 줄을 볼지 정하는 순수 함수다
 */
export function stratifiedQuotas(counts: Readonly<Record<string, number>>, total = 20): Record<string, number> {
  const keys = Object.keys(counts).filter((key) => counts[key] > 0).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const quotas: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  const sum = keys.reduce((acc, key) => acc + counts[key], 0);
  if (!sum || total <= 0) return quotas;
  const budget = Math.min(total, sum);
  // 먼저 한 건씩(큰 갈래부터), 그다음 비례로 남은 몫을 큰 나머지부터
  let left = budget;
  for (const key of keys) {
    if (left === 0) break;
    quotas[key] = 1;
    left -= 1;
  }
  if (left > 0) {
    const shares = keys.map((key) => {
      const exact = (counts[key] / sum) * budget;
      return { key, extra: Math.max(0, Math.min(counts[key], Math.floor(exact)) - quotas[key]), rest: exact - Math.floor(exact) };
    });
    for (const share of shares) {
      const add = Math.min(share.extra, left);
      quotas[share.key] += add;
      left -= add;
    }
    for (const share of [...shares].sort((a, b) => b.rest - a.rest)) {
      if (left === 0) break;
      if (quotas[share.key] < counts[share.key]) { quotas[share.key] += 1; left -= 1; }
    }
    // 아직 남으면(작은 갈래가 꽉 참) 남은 것이 있는 갈래에 차례로
    for (let changed = true; left > 0 && changed;) {
      changed = false;
      for (const key of keys) {
        if (left === 0) break;
        if (quotas[key] < counts[key]) { quotas[key] += 1; left -= 1; changed = true; }
      }
    }
  }
  return quotas;
}

/** 거르기 한 줄 요약 — 작업 로그·실행 목록이 같은 글을 쓴다 */
export function describePolicyFilter(filter: PolicyFilter, labels: { branch: (key: AuditReasonCategory) => string } ): string {
  const parts: string[] = [];
  if (filter.reviewers.length) parts.push(`심사자 ${filter.reviewers.map((key) => key.split("|")[1] ?? key).join("·")}`);
  if (filter.confidenceMin !== null || filter.confidenceBelow !== null) {
    parts.push(`확신 ${filter.confidenceMin?.toFixed(2) ?? "0"}${filter.confidenceBelow !== null ? `–${filter.confidenceBelow.toFixed(2)} 미만` : " 이상"}`);
  }
  if (filter.held !== "any") parts.push(filter.held === "held" ? "보류 중" : "보류 아님");
  if (filter.second !== "any" || filter.secondSource) parts.push(`2차 ${POLICY_SECOND_LABELS[filter.second]}${filter.secondSource ? `(${filter.secondSource})` : ""}`);
  if (filter.branches.length) parts.push(`갈래 ${filter.branches.map(labels.branch).join("·")}`);
  if (filter.owner !== "any") parts.push(filter.owner === "unowned" ? "주인 없음" : "주인 있음");
  if (filter.waitMinDays !== null) parts.push(`${filter.waitMinDays}일 넘게 기다림`);
  if (filter.waitMaxDays !== null) parts.push(`${filter.waitMaxDays}일 안`);
  if (filter.statuses.length) parts.push(`상태 ${filter.statuses.join("·")}`);
  return parts.join(" · ") || "열린 거절 전체";
}
