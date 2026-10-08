"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, resetSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { overrideCandidate } from "@/lib/crawl/admin-review";
import { resolveTakedown, resolveTakedowns, type TakedownAction } from "@/lib/domain/products/takedown";
import { isDismissReason } from "@/lib/domain/products/takedown-view";
import { banProduct, unbanProduct } from "@/lib/domain/products/manage";
import { markClaimInvited } from "@/lib/domain/products/claim-invite";
import { decideRepoReview } from "@/lib/domain/products/repo-reviews";
import { logger } from "@/lib/observability/logger";
import { recordAdminAction, recordAdminActions, type AdminLogEntry } from "@/lib/operations/admin-log";
import { MAX_BULK_DECISIONS, parseSelection, type BulkReviewState, type ReviewDecisionState } from "./review/contract";

/** version: 저장한 뒤의 폼 판 — 열어 둔 폼이 다음 저장에 이 판을 싣는다 */
export type SaveState = { ok?: true; version?: string; issues?: string[] } | null;

/** 여러 줄 입력을 배열로 (빈 줄과 공백 제거) */
function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(value: FormDataEntryValue | null): number {
  return Number(String(value ?? ""));
}

/**
 * 설정 저장.
 *
 * middleware가 /admin을 막지만 서버 액션은 별도 진입점이므로 자격을 다시 확인한다 —
 * 액션은 URL 없이도 호출될 수 있다.
 */
export async function saveCrawlSettings(_prev: SaveState, form: FormData): Promise<SaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  // 검색 신호는 행 단위로 들어온다
  const queryCount = num(form.get("queryCount"));
  // Allocate only after validating the client-supplied count against the actual request.
  // Each row contains form entries; a tiny request must not allocate an arbitrarily large array.
  if (!Number.isSafeInteger(queryCount) || queryCount < 1 || queryCount > [...form.keys()].length) {
    return { issues: ["검색 신호 행 수를 확인해주세요. 새로고침한 뒤 다시 저장해주세요."] };
  }
  const queries = Array.from({ length: queryCount }, (_, i) => ({
    label: String(form.get(`query.${i}.label`) ?? ""),
    kind: form.get(`query.${i}.kind`) === "repositories" ? "repositories" : "commits",
    query: String(form.get(`query.${i}.query`) ?? ""),
    enabled: form.get(`query.${i}.enabled`) === "on",
    priority: num(form.get(`query.${i}.priority`)),
    builder: String(form.get(`query.${i}.builder`) ?? "").trim() || null,
    requireEvidence: form.get(`query.${i}.requireEvidence`) === "on",
  })).filter((q) => q.label && q.query);

  /*
   * 수집 켜기·끄기(enabled)는 폼에서 읽지 않는다 — 운영센터 머리의 즉시 스위치만 바꾼다(2026-10-08 UX 감사 ADM-18).
   * 키를 빼면 saveSettings 가 저장된 값을 그대로 둔다. 옛 폼이 "enabled" 를 보내도 수집이 켜지거나 꺼지지 않는다.
   */
  const patch = {
    discover: {
      queries,
      windowDays: num(form.get("windowDays")),
      sort: String(form.get("sort") ?? "relevance"),
      pagesPerTick: num(form.get("pagesPerTick")),
      // Show HN 행은 2026-10-08 화면부터 있다 — 그 칸을 보내지 않은 폼은 Show HN 설정을 건드리지 않는다
      ...(form.has("showHn.priority") ? { showHn: {
        enabled: form.get("showHn.enabled") === "on",
        priority: num(form.get("showHn.priority")),
        requireEvidence: form.get("showHn.requireEvidence") === "on",
      } } : {}),
    },
    judge: {
      autoApproveMinStars: num(form.get("autoApproveMinStars")),
      minStars: num(form.get("minStars")),
      maxPushAgeDays: num(form.get("maxPushAgeDays")),
      excludeForks: form.get("excludeForks") === "on",
      excludeOrganizations: form.get("excludeOrganizations") === "on",
      blockedHomepageDomains: lines(form.get("blockedHomepageDomains")),
      thirdPartyHosts: lines(form.get("thirdPartyHosts")),
      stubPageTitles: lines(form.get("stubPageTitles")),
      excludedRepoPatterns: lines(form.get("excludedRepoPatterns")),
      heldRepoPatterns: lines(form.get("heldRepoPatterns")),
      holdAmbiguous: form.get("holdAmbiguous") === "on",
    },
    secondReview: {
      enabled: form.get("secondReviewEnabled") === "on",
      // 모델을 비운 칸은 세우지 않는다 — 표를 지우는 방법이 칸을 비우는 것이어야 한다
      voters: [0, 1, 2].flatMap((index) => {
        const model = String(form.get(`voterModel${index}`) ?? "").trim();
        return model ? [{ provider: String(form.get(`voterProvider${index}`) ?? "claude-cli"), model }] : [];
      }),
      fallbacks: [0, 1].flatMap((index) => {
        const model = String(form.get(`fallbackModel${index}`) ?? "").trim();
        return model ? [{ provider: String(form.get(`fallbackProvider${index}`) ?? "claude-cli"), model }] : [];
      }),
      includeAiHeld: form.get("secondReviewIncludeAiHeld") === "on",
      sampleRate: num(form.get("secondReviewSamplePercent")) / 100,
      agreeAt: num(form.get("secondReviewAgreeAt")),
    },
    /*
     * 모델 칸을 비우면 설정을 지운다(서버의 CRAWL_REVIEW_MODEL 로 돌아간다).
     * 키를 빼 버리면 저장이 기존 값에 덮여 한 번 넣은 심사자를 화면에서 되돌릴 길이 없다 —
     * saveSettings 가 {...지금, ...바꾼 것} 으로 합치기 때문이다. 그래서 undefined 를 명시한다.
     */
    firstReview: (() => {
      const model = String(form.get("firstReviewModel") ?? "").trim();
      return model ? { provider: String(form.get("firstReviewProvider") ?? "abcllm"), model } : undefined;
    })(),
    reviewConcurrency: num(form.get("reviewConcurrency")),
    // 수집을 켜는 것과 그것을 발행 조건으로 삼는 것은 다른 결정이다 — 따로 둔다
    agentEvidence: {
      enabled: form.get("agentEvidenceEnabled") === "on",
      enforceEligibility: form.get("agentEvidenceEnforce") === "on",
    },
    // 공개 목록 칸은 2026-10-08 화면부터 있다 — 그 칸을 보내지 않은 폼은 저장된 기간을 건드리지 않는다
    ...(form.has("risingFreshDays") ? { rising: { freshDays: num(form.get("risingFreshDays")) } } : {}),
  };

  // 폼이 그린 판 — 그 사이 다른 곳에서 바뀌었으면 저장이 거절한다. 판이 없는 제출도 견주게 빈 값으로 넘긴다
  const result = await saveSettings(patch, admin.login, { expectedFormVersion: String(form.get("settingsVersion") ?? "") });
  if (!result.ok) {
    logger.warn("admin.settings_rejected", { login: admin.login, issues: result.issues });
    return { issues: result.issues };
  }

  revalidatePath("/admin");
  return { ok: true, version: settingsFormVersion(result.settings) };
}

export type ReviewState = { error?: string } | null;

/** 관리자가 고를 수 있는 결정 사유 코드 — 승인은 늘 passed, 거부는 고른 사유(REVIEW_REJECT_REASONS) */
type DecisionReasonCode = "passed" | (typeof REVIEW_REJECT_REASONS)[number]["value"];
function decisionReasonCode(decision: "approve" | "reject", reason: string): DecisionReasonCode | null {
  if (decision === "approve") return "passed";
  return REVIEW_REJECT_REASONS.find((row) => row.value === reason)?.value ?? null;
}
/**
 * 메모를 비운 결정에 남길 사유(2026-10-08 UX 감사 ADM-11) — 승인마다 자유 서술을 적게 하던 것을 풀었다.
 * 기록에는 늘 사유가 남아야 하므로(overrideCandidate 가 1자 이상을 요구한다) 고른 사유의 이름을 쓴다.
 */
function defaultDecisionNote(code: DecisionReasonCode): string {
  return code === "passed" ? "관리자 승인" : REVIEW_REJECT_REASONS.find((row) => row.value === code)!.label;
}

/**
 * 심사 결정.
 *
 * 설정 저장과 같은 이유로 여기서도 자격을 다시 확인한다 — 서버 액션은 URL 없이
 * 호출될 수 있으므로 middleware가 막아주지 않는다.
 *
 * 거부 사유는 여기서 막는다 — 화면이 첫 사유를 기본값으로 두어 고르지 않은 거부가 틀린 사유로 기록됐다(ADM-11).
 * 성공하면 알림과 되돌리기(undoCandidateDecisions)가 쓸 결정 기록 id 와 이전 상태를 돌려준다(ADM-12).
 * 전에는 성공이 null 이었다 — 실패만 보던 화면은 그대로 error 만 보면 된다.
 */
export async function decideCrawlCandidate(_prev: ReviewDecisionState | ReviewState, form: FormData): Promise<ReviewDecisionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { error: "알 수 없는 결정입니다" };

  const repo = String(form.get("repo") ?? "");
  const reason = decision === "reject" ? String(form.get("reason") ?? "") : "";
  const reasonCode = decisionReasonCode(decision, reason);
  if (!reasonCode) return { error: "거부 사유를 골라주세요." };
  const note = String(form.get("note") ?? "").trim() || defaultDecisionNote(reasonCode);
  const result = await overrideCandidate({
    repo, actor: admin.login, decision, reasonCode, reason: note,
    inputHash: String(form.get("inputHash") ?? ""),
    sourceRevisionHash: String(form.get("sourceRevisionHash") ?? ""),
    candidateRevisionHash: String(form.get("candidateRevisionHash") ?? ""),
  });
  await recordAdminAction(admin.login, { action: `candidate-${decision}`, target: repo,
    detail: { reason, note, ...(result.ok ? { attemptId: result.attemptId } : {}) },
    ok: result.ok, error: result.ok ? null : result.message });
  if (!result.ok) {
    logger.warn("admin.review_rejected", { login: admin.login, message: result.message });
    return { error: result.message };
  }
  logger.info("crawl.reviewed", { repo, decision, reason: reasonCode, admin: admin.login });

  revalidatePath("/admin/review");
  return { ok: true, repo, decision, attemptId: result.attemptId, previous: result.previous };
}

/**
 * 여러 후보를 같은 사유로 한 번에 결정한다.
 *
 * 갈래가 같으면 사람이 내리는 판단도 같다 — 심사 큐 대부분이 한 갈래라 한 건씩 누르는 것은
 * 같은 판단을 수백 번 반복하는 일이다.
 *
 * 묶어서 보낼 뿐, 검사는 한 건씩 그대로 받는다. 각 후보의 입력·원본·후보 해시를 따로 실어
 * 보내므로 그중 하나라도 그 사이에 바뀌었으면 그 건만 거절되고 나머지는 처리된다.
 * 처리한 건은 decided 로 돌려준다 — 알림의 되돌리기가 그 목록을 그대로 되돌린다.
 */
export async function decideCrawlCandidates(_prev: BulkReviewState, form: FormData): Promise<BulkReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { error: "알 수 없는 결정입니다" };
  const reason = decision === "reject" ? String(form.get("reason") ?? "") : "";
  const reasonCode = decisionReasonCode(decision, reason);
  if (!reasonCode) return { error: "거부 사유를 골라주세요." };
  const note = String(form.get("note") ?? "").trim() || defaultDecisionNote(reasonCode);

  const selected = form.getAll("selected").map(String).filter(Boolean);
  if (!selected.length) return { error: "처리할 후보를 선택해주세요." };
  if (selected.length > MAX_BULK_DECISIONS) {
    return { error: `한 번에 최대 ${MAX_BULK_DECISIONS}건까지 처리합니다. 나눠서 선택해주세요.` };
  }

  const failures: { repo: string; message: string }[] = [];
  const decided: { repo: string; attemptId: number }[] = [];
  const entries: AdminLogEntry[] = [];
  for (const packed of selected) {
    const parsed = parseSelection(packed);
    if (!parsed) {
      failures.push({ repo: packed.split(" ")[0] || "(알 수 없음)", message: "화면이 오래됐습니다. 새로고침해주세요." });
      continue;
    }
    const { repo, inputHash, sourceRevisionHash, candidateRevisionHash } = parsed;
    const result = await overrideCandidate({
      repo, actor: admin.login, decision, reasonCode, reason: note, inputHash, sourceRevisionHash, candidateRevisionHash,
    });
    if (result.ok) decided.push({ repo, attemptId: result.attemptId });
    else failures.push({ repo, message: result.message });
    entries.push({ action: `candidate-${decision}`, target: repo,
      detail: { reason, note, bulk: selected.length, ...(result.ok ? { attemptId: result.attemptId } : {}) },
      ok: result.ok, error: result.ok ? null : result.message });
  }
  await recordAdminActions(admin.login, entries);

  logger.info("admin.review_bulk", { login: admin.login, decision, ok: decided.length, failed: failures.length });
  revalidatePath("/admin/review");
  return { ok: decided.length, failures, decided };
}

/**
 * 내려달라는 요청 처리.
 *
 * 내릴 때 행을 지우지 않고 banned로 둔다 — 지우면 수집기가 다음 바퀴에 같은 URL을 다시
 * 주워 온다. 유스케이스가 그렇게 하고, 여기서는 자격 확인과 파싱만 한다.
 */
export async function resolveTakedownRequest(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const action = String(form.get("action") ?? "");
  if (action !== "remove" && action !== "dismiss") return { error: "알 수 없는 결정입니다" };

  const dismissReason = form.get("dismissReason");
  const slug = String(form.get("slug") ?? "");
  const result = await resolveTakedown(slug, action as TakedownAction, admin.login, {
    dismissReason: isDismissReason(dismissReason) ? dismissReason : null, note: String(form.get("note") ?? "") || null,
  });
  if (!result.ok) {
    // 처리한 것은 처리 트랜잭션이 기록한다. 못 한 것만 여기서 남긴다
    await recordAdminAction(admin.login, { action: `takedown-${action}`, target: slug, ok: false, error: result.error.kind });
    logger.warn("admin.takedown_rejected", { login: admin.login, error: result.error });
    return { error: "요청을 처리하지 못했습니다" };
  }

  revalidateTakedownViews();
  return null;
}

/** 요청 처리 결과가 보이는 곳 — 처리 화면, 심사 큐 띠, 운영센터 조치, 메뉴 배지(레이아웃) */
function revalidateTakedownViews() {
  revalidatePath("/admin/audit");
  revalidatePath("/admin/review");
  revalidatePath("/admin/status");
  revalidatePath("/admin", "layout");
}

export type BulkTakedownState = { error?: string; done?: number; failed?: { slug: string; message: string }[] } | null;
const MAX_BULK_TAKEDOWNS = 100;

/** 여러 건 한 번에 내리거나 둔다 — 처리 화면의 체크박스·묶음 머리에서 */
export async function resolveTakedownRequests(_prev: BulkTakedownState, form: FormData): Promise<BulkTakedownState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };
  const action = String(form.get("action") ?? "");
  if (action !== "remove" && action !== "dismiss") return { error: "알 수 없는 결정입니다" };
  const slugs = form.getAll("selected").map(String).filter(Boolean);
  if (slugs.length === 0) return { error: "고른 요청이 없습니다" };
  if (slugs.length > MAX_BULK_TAKEDOWNS) return { error: `한 번에 ${MAX_BULK_TAKEDOWNS}건까지 처리합니다` };
  const dismissReason = form.get("dismissReason");
  const result = await resolveTakedowns(slugs, action as TakedownAction, admin.login, {
    dismissReason: isDismissReason(dismissReason) ? dismissReason : null, note: String(form.get("note") ?? "") || null,
  });
  await recordAdminActions(admin.login, result.failed.map((item) => ({ action: `takedown-${action}`, target: item.slug,
    detail: { bulk: slugs.length }, ok: false, error: item.message })));
  logger.info("admin.takedown_bulk", { login: admin.login, action, done: result.done.length, failed: result.failed.length });
  revalidateTakedownViews();
  return { done: result.done.length, failed: result.failed };
}

/**
 * 기준을 코드 기본값으로 되돌린다.
 *
 * 판정 규칙을 고쳐도 저장된 설정이 있으면 그 값이 이긴다. 배포 환경이 옛 기준으로 도는 것을
 * 손으로 고치게 두지 않는다. 수집 스위치는 건드리지 않는다.
 */
export async function resetCrawlSettings(): Promise<SaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  const result = await resetSettings(admin.login);
  if (!result.ok) {
    logger.warn("admin.settings_reset_failed", { login: admin.login, issues: result.issues });
    return { issues: result.issues };
  }

  logger.info("admin.settings_reset", { login: admin.login });
  revalidatePath("/admin");
  return { ok: true };
}

/**
 * 제품 차단·해제.
 *
 * 차단은 행을 남기므로 같은 URL의 재등록과 재수집이 함께 막힌다. 해제는 차단 전 상태를
 * 유도해 되돌린다 — 되돌릴 길이 없으면 차단 버튼을 누르는 것 자체가 무서운 일이 된다.
 */
export async function setProductBan(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const slug = String(form.get("slug") ?? "");
  const action = String(form.get("action") ?? "");
  if (action !== "ban" && action !== "unban") return { error: "알 수 없는 결정입니다" };

  const result = action === "ban" ? await banProduct(slug) : await unbanProduct(slug);
  await recordAdminAction(admin.login, { action: `product-${action}`, target: slug, ok: result.ok, error: result.ok ? null : result.error.kind });
  if (!result.ok) return { error: "제품을 찾을 수 없습니다" };

  logger.info("admin.product_ban", { slug, action, login: admin.login });
  revalidatePath("/admin/products");
  return null;
}

/**
 * 저장소가 사라진 웹사이트의 2단계 판정(product_repo_reviews)을 운영자가 정한다 — 유지 또는 내리기.
 *
 * 내리기는 위 차단과 같은 길이다(setStatusWithAudit 'admin.product.ban' — 행은 남고 되돌릴 수 있다). 결정은 같은
 * 트랜잭션에 적는다. 한 번에 한 제품 — AI 판정은 사람이 하나씩 보고 정한다(감사 내리기와 같다).
 */
export async function decideRepoReviewAction(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const slugs = form.getAll("slug");
  const decision = form.get("decision");
  if (slugs.length !== 1 || !slugs[0] || (decision !== "keep" && decision !== "delist")) {
    return { error: "한 번에 한 제품만 처리합니다. 새로고침해주세요." };
  }
  const slug = String(slugs[0]);
  const result = await decideRepoReview({ slug, decision, by: admin.login });
  await recordAdminAction(admin.login, { action: `repo-review-${decision}`, target: slug, ok: result.ok, error: result.ok ? null : result.error });
  if (!result.ok) return { error: result.error };

  logger.info("admin.repo_review_decided", { slug, decision, login: admin.login });
  revalidatePath("/admin/products");
  return null;
}

/**
 * 재검수에서 걸린 것을 한 번에 내린다.
 *
 * 걸린 것을 제품 목록에서 다시 찾아 하나씩 누르게 하면 30페이지를 넘겨야 한다. 실제로
 * 그 옮겨 적기에서 이름을 잘못 적은 적이 있어, 화면이 짚은 것을 화면에서 바로 내린다.
 *
 * 차단이므로 행은 남는다 — 같은 URL의 재수집·재등록까지 함께 막히고, 되돌릴 수 있다.
 */
export type BulkBanState = { error?: string; ok?: number; failures?: string[] } | null;

export async function banProducts(_prev: BulkBanState, form: FormData): Promise<BulkBanState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const slugs = [...new Set(form.getAll("slug").map(String).filter(Boolean))];
  if (slugs.length === 0) return { error: "선택한 제품이 없습니다" };
  if (slugs.length > MAX_BULK_DECISIONS) {
    return { error: `한 번에 ${MAX_BULK_DECISIONS}건까지 내립니다. 나눠서 눌러주세요.` };
  }

  let ok = 0;
  const failures: string[] = [];
  const entries: AdminLogEntry[] = [];
  for (const slug of slugs) {
    const result = await banProduct(slug);
    if (result.ok) ok += 1;
    else failures.push(slug);
    entries.push({ action: "product-ban", target: slug, detail: { from: "recheck", bulk: slugs.length },
      ok: result.ok, error: result.ok ? null : result.error.kind });
  }
  await recordAdminActions(admin.login, entries);

  logger.info("admin.product_ban_bulk", { login: admin.login, ok, failed: failures.length });
  revalidatePath("/admin/products");
  revalidatePath("/admin/products/recheck");
  return { ok, failures };
}

/**
 * 클레임 초대를 보냈다고 표시한다.
 *
 * 보내는 것은 운영자가 GitHub에서 직접 한다(미리 채운 새 이슈 링크). 여기서는 두 번 보내지
 * 않도록 시각만 남긴다.
 */
export async function markClaimInvite(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const slug = String(form.get("slug") ?? "");
  const result = await markClaimInvited(slug);
  await recordAdminAction(admin.login, { action: "claim-invite", target: slug, ok: result.ok, error: result.ok ? null : result.error.kind });
  if (!result.ok) {
    return { error: result.error.kind === "forbidden" ? result.error.message : "제품을 찾을 수 없습니다" };
  }

  logger.info("admin.claim_invited", { slug, login: admin.login });
  revalidatePath("/admin/products");
  return null;
}
