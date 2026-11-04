import { getSettings } from "@/lib/crawl/settings";
import { listAdminReviewEntries, reviewQueueCauses } from "@/lib/crawl/admin-review";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { listAuditFindings, productAuditOverview } from "@/lib/crawl/product-audit";
import { listProducts } from "@/lib/domain/products/repository";
import { formatDetailTime } from "@/lib/format/time";
import { newsSource } from "@/lib/news/sources";
import { PRODUCT_FILTERS, PRODUCT_SORTS, type ProductAdminSort, type ProductFilterName } from "../products/filters";
import { prototypeReviewFilter, prototypeReviewNeeds, prototypeReviewOptions } from "../review/PrototypeReviewQuery";
import { actionLabel, targetLabel } from "../activity/labels";
import { activityFilter, activityLog } from "../activity/query";
import { isScriptRow, summaryLine } from "../activity/summary";
import { listNewsPage, newsFilter } from "../news/list";
import type { CsvValue } from "./csv";

/**
 * 내보낼 수 있는 목록(2026-10-08 UX 감사 ADM-34) — 화면과 같은 거르기 값을 읽어 화면이 쓰는 목록 함수를 그대로 부른다.
 * 그래야 내려받은 표가 화면에 보이던 것과 같다. 쪽 나눔(page·before)만 무시하고 처음부터 limit 건까지 싣는다.
 */
/** 한 번에 내보내는 최대 행 — 감사 거절·응답 없음처럼 천 단위 목록을 통째로 담고도 남는다 */
export const MAX_EXPORT_ROWS = 10_000;

export type ExportRecord = Record<string, CsvValue>;
export type ExportView = { columns: readonly { key: string; label: string }[]; load: (params: URLSearchParams, limit: number) => Promise<ExportRecord[]> };

const text = (params: URLSearchParams, key: string) => params.get(key) ?? "";
const time = (value: Date | string | null | undefined) => (value ? formatDetailTime(value) : null);

// ─────────────────────────── 제품 (/admin/products?filter·q·sort·pending) ───────────────────────────

/** app/admin/products/page.tsx 가 주소를 읽는 식과 같다 — 그 화면은 줄 안에서 읽어 여기 옮겨 두었다 */
function productQuery(params: URLSearchParams) {
  const filter = text(params, "filter");
  const active = (Object.hasOwn(PRODUCT_FILTERS, filter) ? filter : "전체") as ProductFilterName;
  const sort = Object.hasOwn(PRODUCT_SORTS, text(params, "sort")) ? text(params, "sort") as ProductAdminSort : "recent";
  const q = text(params, "q").trim().slice(0, 100);
  const { statuses, ...flags } = PRODUCT_FILTERS[active];
  // ?pending=1 — 저장소 사라짐에 아직 24시간이 지나지 않은 '지금 없음'까지(화면과 같은 식, ADM-33)
  const pending = active === "저장소 사라짐" && text(params, "pending") === "1";
  return { statuses: [...statuses], ...flags, ...(pending ? { repoGone: undefined, repoMissing: true } : {}), adminSearch: q || undefined, sort };
}

const products: ExportView = {
  columns: [
    { key: "slug", label: "slug" }, { key: "name", label: "이름" }, { key: "url", label: "주소" }, { key: "repoUrl", label: "저장소" },
    { key: "category", label: "분류" }, { key: "status", label: "상태" }, { key: "source", label: "들어온 길" }, { key: "stars", label: "별" },
    { key: "claimedAt", label: "클레임" }, { key: "listedAt", label: "등록" },
  ],
  async load(params, limit) {
    const rows = await listProducts({ ...productQuery(params), limit, offset: 0 });
    return rows.map((row) => ({
      slug: row.slug, name: row.name, url: row.url, repoUrl: row.repoUrl, category: row.category, status: row.status, source: row.source,
      stars: row.stars, claimedAt: time(row.claimedAt), listedAt: time(row.verifiedAt ?? row.createdAt),
    }));
  },
};

// ─────────────────────────── 심사 큐 (/admin/review?state·stage·cause·ai·second·q·updated·sort) ───────────────────────────

/** 심사 목록 한 번에 읽는 수 — listAdminReviewEntries 가 50 을 넘겨 주지 않는다. 네 쪽씩 함께 읽는다 */
const REVIEW_BATCH = 50;
const REVIEW_PARALLEL = 4;

/** 화면과 공유하는 필터 조립으로 같은 원본 범위를 내보낸다. 페이지 번호만 제외한다. */
async function reviewQuery(params: URLSearchParams) {
  const values = Object.fromEntries([...new Set(params.keys())].map(key => [key, params.get(key) ?? ""]));
  // Old direct export links retain their pending default; new screens always send an explicit tab.
  if (!params.has("tab") && !params.has("state") && !params.has("stage")) { values.tab = "all"; values.state = "pending"; }
  const filter = prototypeReviewFilter(values), settings = await getSettings();
  const needs = prototypeReviewNeeds(filter);
  const [causes, overview] = await Promise.all([
    needs.causes ? reviewQueueCauses(settings) : null,
    needs.overview ? humanQueueOverview(settings) : null,
  ]);
  return { settings, options: prototypeReviewOptions(filter, causes, overview) };
}

type ReviewEntry = Awaited<ReturnType<typeof listAdminReviewEntries>>["entries"][number];
const review: ExportView = {
  columns: [
    { key: "id", label: "후보 id" }, { key: "repo", label: "저장소" }, { key: "name", label: "이름" }, { key: "state", label: "상태" },
    { key: "reason", label: "규칙 사유" }, { key: "bucket", label: "갈래" }, { key: "productUrl", label: "주소" },
    { key: "aiDecision", label: "AI 판단" }, { key: "aiConfidence", label: "AI 확신" }, { key: "aiReason", label: "AI 사유" },
    { key: "seconds", label: "2차 표" }, { key: "waitingSince", label: "기다린 시작" },
  ],
  async load(params, limit) {
    const { settings, options } = await reviewQuery(params);
    const first = await listAdminReviewEntries(settings, { ...options, offset: 0, limit: REVIEW_BATCH });
    const entries: ReviewEntry[] = [...first.entries];
    const pages = Math.ceil(Math.min(first.total, limit) / REVIEW_BATCH);
    for (let page = 1; page < pages; page += REVIEW_PARALLEL) {
      const batch = await Promise.all(Array.from({ length: Math.min(REVIEW_PARALLEL, pages - page) }, (_, index) =>
        listAdminReviewEntries(settings, { ...options, offset: (page + index) * REVIEW_BATCH, limit: REVIEW_BATCH })));
      for (const result of batch) entries.push(...result.entries);
    }
    return entries.slice(0, limit).map((entry) => ({
      id: entry.candidate.id, repo: entry.candidate.repo, name: entry.name, state: entry.candidate.state, reason: entry.candidate.reason,
      bucket: entry.bucket, productUrl: entry.candidate.productUrl, aiDecision: entry.review?.decision ?? null,
      aiConfidence: entry.review?.confidence ?? null, aiReason: entry.review?.reason ?? null,
      seconds: entry.seconds.map((vote) => `${vote.model ?? "?"}: ${vote.decision ?? vote.status}`).join(" / ") || null,
      waitingSince: time(entry.candidate.judgedAt ?? entry.candidate.updatedAt),
    }));
  },
};

// ─────────────────────────── 감사 거절 (/admin/audit?view → 여기서는 decision) ───────────────────────────

/** 내보내기의 view 는 화면 이름이라, 감사 화면의 갈래(?view=reject|needs_review)는 decision 으로 받는다 */
const audit: ExportView = {
  columns: [
    { key: "campaign", label: "감사" }, { key: "item", label: "항목 id" }, { key: "slug", label: "slug" }, { key: "name", label: "이름" },
    { key: "url", label: "주소" }, { key: "category", label: "지금 분류" }, { key: "decision", label: "AI 판단" },
    { key: "confidence", label: "AI 확신" }, { key: "reason", label: "AI 사유" }, { key: "reviewedAt", label: "본 시각" }, { key: "owned", label: "주인 있음" },
  ],
  async load(params, limit) {
    const { campaign } = await productAuditOverview();
    if (!campaign) return [];
    const decision = text(params, "decision") === "needs_review" ? "needs_review" : "reject";
    const rows = await listAuditFindings(campaign.id, decision, { limit, offset: 0 });
    return rows.map((row) => ({
      campaign: campaign.id, item: row.id, slug: row.slug, name: row.name, url: row.url, category: row.category, decision,
      confidence: row.confidence, reason: row.reason, reviewedAt: time(row.reviewedAt), owned: row.owned,
    }));
  },
};

// ─────────────────────────── 작업 로그 (/admin/activity?group·actor·failed·target) ───────────────────────────

const activity: ExportView = {
  columns: [
    { key: "id", label: "id" }, { key: "createdAt", label: "시각" }, { key: "actor", label: "처리자" }, { key: "actorKind", label: "방식" },
    { key: "script", label: "스크립트" }, { key: "action", label: "작업 코드" }, { key: "actionLabel", label: "작업" },
    { key: "target", label: "대상" }, { key: "targetLabel", label: "대상 이름" }, { key: "ok", label: "성공" }, { key: "error", label: "오류" },
    { key: "summary", label: "요약" }, { key: "ip", label: "접속 주소" }, { key: "userAgent", label: "브라우저" }, { key: "detail", label: "내용(JSON)" },
  ],
  async load(params, limit) {
    // 쪽 넘김(before)은 싣지 않는다 — 처음부터 limit 건까지
    const filter = activityFilter({ group: params.get("group"), actor: params.get("actor"), failed: params.get("failed"), target: params.get("target") });
    const rows = await activityLog(filter, limit);
    return rows.map((row) => ({
      id: row.id, createdAt: time(row.createdAt), actor: row.actor, actorKind: row.actorKind, script: isScriptRow(row),
      action: row.action, actionLabel: actionLabel(row.action), target: row.target, targetLabel: targetLabel(row.target).text,
      ok: row.ok, error: row.error, summary: summaryLine(row), ip: row.ip, userAgent: row.userAgent, detail: JSON.stringify(row.detail),
    }));
  },
};

// ─────────────────────────── AI 소식 (/admin/news?state) ───────────────────────────

const NEWS_STATE: Record<string, string> = { approved: "게시", pending: "대기", hidden: "숨김" };
const news: ExportView = {
  columns: [
    { key: "id", label: "id" }, { key: "source", label: "출처" }, { key: "title", label: "제목" }, { key: "url", label: "주소" },
    { key: "publishedAt", label: "게시" }, { key: "state", label: "상태" }, { key: "decidedBy", label: "정한 사람" }, { key: "decidedAt", label: "정한 시각" },
  ],
  async load(params, limit) {
    const rows = await listNewsPage(newsFilter(params.get("state")), { limit, offset: 0 });
    return rows.map((row) => ({
      id: row.id, source: newsSource(row.sourceKey)?.name ?? row.sourceKey, title: row.title, url: row.url,
      publishedAt: time(row.publishedAt), state: NEWS_STATE[row.state] ?? row.state, decidedBy: row.decidedBy, decidedAt: time(row.decidedAt),
    }));
  },
};

export const EXPORT_VIEWS = { products, review, audit, activity, news } satisfies Record<string, ExportView>;
export type ExportViewName = keyof typeof EXPORT_VIEWS;
