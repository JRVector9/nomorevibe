"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, resetSettings } from "@/lib/crawl/settings";
import { decideCandidate, type ReviewDecision } from "@/lib/crawl/review";
import { resolveTakedown, type TakedownAction } from "@/lib/domain/products/takedown";
import { banProduct, unbanProduct } from "@/lib/domain/products/manage";
import { markClaimInvited } from "@/lib/domain/products/claim-invite";
import { logger } from "@/lib/observability/logger";
import { MAX_BULK_DECISIONS, parseSelection, type BulkReviewState } from "./review/contract";

export type SaveState = { ok?: true; issues?: string[] } | null;

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
  const queries = Array.from({ length: Number.isFinite(queryCount) ? queryCount : 0 }, (_, i) => ({
    label: String(form.get(`query.${i}.label`) ?? ""),
    kind: form.get(`query.${i}.kind`) === "repositories" ? "repositories" : "commits",
    query: String(form.get(`query.${i}.query`) ?? ""),
    enabled: form.get(`query.${i}.enabled`) === "on",
    priority: num(form.get(`query.${i}.priority`)),
    builder: String(form.get(`query.${i}.builder`) ?? "").trim() || null,
  })).filter((q) => q.label && q.query);

  const patch = {
    enabled: form.get("enabled") === "on",
    discover: {
      queries,
      windowDays: num(form.get("windowDays")),
      sort: String(form.get("sort") ?? "relevance"),
      pagesPerTick: num(form.get("pagesPerTick")),
    },
    judge: {
      maxStars: num(form.get("maxStars")),
      minStars: num(form.get("minStars")),
      maxPushAgeDays: num(form.get("maxPushAgeDays")),
      excludeForks: form.get("excludeForks") === "on",
      excludeOrganizations: form.get("excludeOrganizations") === "on",
      blockedHomepageDomains: lines(form.get("blockedHomepageDomains")),
      thirdPartyHosts: lines(form.get("thirdPartyHosts")),
      stubPageTitles: lines(form.get("stubPageTitles")),
      excludedRepoPatterns: lines(form.get("excludedRepoPatterns")),
      holdAmbiguous: form.get("holdAmbiguous") === "on",
    },
    secondReview: {
      enabled: form.get("secondReviewEnabled") === "on",
      provider: String(form.get("secondReviewProvider") ?? "claude-cli"),
      model: String(form.get("secondReviewModel") ?? "").trim(),
      sampleRate: num(form.get("secondReviewSamplePercent")) / 100,
      agreeAt: num(form.get("secondReviewAgreeAt")),
    },
    // 수집을 켜는 것과 그것을 발행 조건으로 삼는 것은 다른 결정이다 — 따로 둔다
    agentEvidence: {
      enabled: form.get("agentEvidenceEnabled") === "on",
      enforceEligibility: form.get("agentEvidenceEnforce") === "on",
    },
  };

  const result = await saveSettings(patch, admin.login);
  if (!result.ok) {
    logger.warn("admin.settings_rejected", { login: admin.login, issues: result.issues });
    return { issues: result.issues };
  }

  revalidatePath("/admin");
  return { ok: true };
}

export type ReviewState = { error?: string } | null;

/**
 * 심사 결정.
 *
 * 설정 저장과 같은 이유로 여기서도 자격을 다시 확인한다 — 서버 액션은 URL 없이
 * 호출될 수 있으므로 middleware가 막아주지 않는다.
 */
export async function decideCrawlCandidate(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { error: "알 수 없는 결정입니다" };

  const result = await decideCandidate({
    repo: String(form.get("repo") ?? ""),
    decision: decision as ReviewDecision,
    reason: String(form.get("reason") ?? ""),
    admin: admin.login,
    note: String(form.get("note") ?? ""),
    inputHash: String(form.get("inputHash") ?? ""),
    sourceRevisionHash: String(form.get("sourceRevisionHash") ?? ""),
    candidateRevisionHash: String(form.get("candidateRevisionHash") ?? ""),
  });
  if (!result.ok) {
    logger.warn("admin.review_rejected", { login: admin.login, message: result.message });
    return { error: result.message };
  }

  revalidatePath("/admin/review");
  return null;
}

/**
 * 여러 후보를 같은 사유로 한 번에 결정한다.
 *
 * 갈래가 같으면 사람이 내리는 판단도 같다 — 심사 큐 대부분이 한 갈래라 한 건씩 누르는 것은
 * 같은 판단을 수백 번 반복하는 일이다.
 *
 * 묶어서 보낼 뿐, 검사는 한 건씩 그대로 받는다. 각 후보의 입력·원본·후보 해시를 따로 실어
 * 보내므로 그중 하나라도 그 사이에 바뀌었으면 그 건만 거절되고 나머지는 처리된다.
 */
export async function decideCrawlCandidates(_prev: BulkReviewState, form: FormData): Promise<BulkReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { error: "알 수 없는 결정입니다" };
  const note = String(form.get("note") ?? "").trim();
  if (!note) return { error: "판단 사유를 적어주세요. 기록에 남습니다." };

  const selected = form.getAll("selected").map(String).filter(Boolean);
  if (!selected.length) return { error: "처리할 후보를 선택해주세요." };
  if (selected.length > MAX_BULK_DECISIONS) {
    return { error: `한 번에 최대 ${MAX_BULK_DECISIONS}건까지 처리합니다. 나눠서 선택해주세요.` };
  }

  const failures: { repo: string; message: string }[] = [];
  let ok = 0;
  for (const packed of selected) {
    const parsed = parseSelection(packed);
    if (!parsed) {
      failures.push({ repo: packed.split(" ")[0] || "(알 수 없음)", message: "화면이 오래됐습니다. 새로고침해주세요." });
      continue;
    }
    const { repo, inputHash, sourceRevisionHash, candidateRevisionHash } = parsed;
    const result = await decideCandidate({
      repo, decision: decision as ReviewDecision, reason: String(form.get("reason") ?? ""),
      admin: admin.login, note, inputHash, sourceRevisionHash, candidateRevisionHash,
    });
    if (result.ok) ok++;
    else failures.push({ repo, message: result.message });
  }

  logger.info("admin.review_bulk", { login: admin.login, decision, ok, failed: failures.length });
  revalidatePath("/admin/review");
  return { ok, failures };
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

  const result = await resolveTakedown(String(form.get("slug") ?? ""), action as TakedownAction, admin.login);
  if (!result.ok) {
    logger.warn("admin.takedown_rejected", { login: admin.login, error: result.error });
    return { error: "요청을 처리하지 못했습니다" };
  }

  revalidatePath("/admin/review");
  return null;
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
  if (!result.ok) return { error: "제품을 찾을 수 없습니다" };

  logger.info("admin.product_ban", { slug, action, login: admin.login });
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
  for (const slug of slugs) {
    const result = await banProduct(slug);
    if (result.ok) ok += 1;
    else failures.push(slug);
  }

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
  if (!result.ok) {
    return { error: result.error.kind === "forbidden" ? result.error.message : "제품을 찾을 수 없습니다" };
  }

  logger.info("admin.claim_invited", { slug, login: admin.login });
  revalidatePath("/admin/products");
  return null;
}
