import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CrawlDocument } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { MAX_REVIEW_INPUT_BYTES, reviewInputHash, type ReviewInput, type ReviewSnapshot } from "./agent-review-contract";
import { summarizeAgentEvidence } from "@/lib/domain/evidence/agents/summary";

/**
 * 프로젝트 활동 묶음(2026-11-17 사람 지시 "기간 상관없이 다시 살펴보고 진행중인 프로젝트인지 보게") — 감사 거절의 두 번째 의견 입력에 싣는다.
 *
 * 무엇을 싣나(모두 이미 받아 둔 값이다 — GitHub 를 새로 부르지 않는다):
 *  - archived·lastPushAt: 수집 원본의 저장소 메타(crawl_documents.repo_meta — 수집기가 저장소마다 받는 GitHub REST 답의 archived·pushed_at).
 *    감사 거절은 두 번째 의견 전에 원본을 다시 받으므로(audit-stale-recollect.ts) 묻는 때의 메타다.
 *  - latestRelease: 기존 릴리스 수집(product_updates 의 github_release — 제품 근거 갱신이 이미 받는 것) 가운데 그 원본을 받은 때까지의 마지막 것.
 *  - site: 수집이 연 배포 주소의 응답 코드(crawl_documents.page_status)·리다이렉트 끝 주소(page_meta.finalUrl)와 기존 연결 확인(product_health — uptime)의
 *    마지막 응답 코드·내려감(연속 실패 3번 이상) 여부.
 *
 * 관측 시각(수집 시각·연결 확인 시각)은 싣지 않는다 — 근거를 언제 받았는지가 판정 입력을 바꾸지 않게(오래됨 편향 방지). 날짜는 활동 자체의 날짜
 * (마지막 push·릴리스)만 날(YYYY-MM-DD)로 싣는다.
 */
export type ProjectActivity = {
  /** GitHub 의 보관(archived) 표시. 메타에 없으면 null */
  archived: boolean | null;
  /** 마지막 push 날(YYYY-MM-DD). 모르면 null */
  lastPushAt: string | null;
  /** 원본을 받은 때까지의 마지막 GitHub 릴리스 — 없으면 null */
  latestRelease: { name: string; publishedAt: string | null } | null;
  site: {
    /** 수집이 배포 주소를 연 응답 코드 — 0 은 닿지 않음, null 은 주소가 없거나 아직 안 열어 봄 */
    status: number | null;
    /** 리다이렉트를 따라간 끝 주소 — 연 주소와 같으면 null */
    finalUrl: string | null;
    /** 연결 확인(uptime)의 마지막 응답 코드 — 확인 기록이 없으면 null */
    uptimeStatus: number | null;
    /** 연결 확인이 연속 3번 이상 실패해 내려간 것으로 보는가 — 확인 기록이 없으면 null */
    uptimeDown: boolean | null;
  };
};

type Executor = typeof db | ProductTransaction;

/** 연결 확인이 이만큼 연속 실패하면 내려간 것으로 본다 — 공개 목록의 '닿지 않는 제품 빼기'(product_health_down_slug_idx)와 같은 문턱 */
export const UPTIME_DOWN_FAILURES = 3;

const day = (value: unknown): string | null => {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};
const text = (value: unknown, size: number): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, size) : null;

/** 같은 주소인가 — 끝의 '/'·대소문자 host 만 다른 것은 같다 */
function sameUrl(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  try {
    const left = new URL(a), right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
    return left.protocol === right.protocol && left.host.toLowerCase() === right.host.toLowerCase() && path(left) === path(right) && left.search === right.search;
  } catch { return a === b; }
}

export type ProjectActivityRaw = {
  document: Pick<CrawlDocument, "repoMeta" | "pageStatus" | "pageMeta" | "productUrl">;
  release: { title: string | null; publishedAt: Date | string | null } | null;
  health: { status: number; failures: number } | null;
};

/** 읽은 값 → 묶음(순수 함수, 시험이 직접 부른다). 관측 시각은 받지 않는다 */
export function projectActivityFrom(raw: ProjectActivityRaw): ProjectActivity {
  const meta = raw.document.repoMeta ?? {};
  const finalUrl = text(raw.document.pageMeta?.finalUrl, 300);
  return {
    archived: typeof meta.archived === "boolean" ? meta.archived : null,
    lastPushAt: day(meta.pushed_at),
    latestRelease: raw.release ? { name: text(raw.release.title, 120) ?? "", publishedAt: day(raw.release.publishedAt) } : null,
    site: {
      status: typeof raw.document.pageStatus === "number" ? raw.document.pageStatus : null,
      finalUrl: finalUrl && !sameUrl(finalUrl, raw.document.productUrl) ? finalUrl : null,
      uptimeStatus: raw.health ? raw.health.status : null,
      uptimeDown: raw.health ? raw.health.failures >= UPTIME_DOWN_FAILURES : null,
    },
  };
}

/**
 * 한 제품의 묶음을 읽는다 — 원본(document)은 부르는 쪽이 이미 읽은 그 행이다(같은 입력의 product 칸과 같은 원본).
 * 호출 직전 증명(local-model-domain.ts)은 같은 트랜잭션(tx)으로 다시 읽어 견준다.
 */
export async function loadProjectActivity(slug: string, document: Pick<CrawlDocument, "repoMeta" | "pageStatus" | "pageMeta" | "productUrl" | "fetchedAt">,
  executor: Executor = db): Promise<ProjectActivity> {
  const [release] = await executor.execute<{ title: string | null; published_at: string | null }>(sql`
    select u.title, to_char(coalesce(u.published_at, u.observed_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as published_at
      from product_updates u
     where u.slug = ${slug} and u.source_kind = 'github_release' and u.visible and u.maker_deleted_at is null
       and coalesce(u.published_at, u.observed_at) <= ${document.fetchedAt.toISOString()}::timestamp
     order by coalesce(u.published_at, u.observed_at) desc, u.id desc limit 1`);
  const [health] = await executor.execute<{ status: number; failures: number }>(sql`
    select h.status, h.failures from product_health h where h.slug = ${slug}`);
  return projectActivityFrom({ document, release: release ? { title: release.title, publishedAt: release.published_at } : null,
    health: health ? { status: Number(health.status), failures: Number(health.failures) } : null });
}

/**
 * 입력에 묶음을 싣고 입력 해시를 다시 잰다(createReviewInput 과 같은 셈). 크기 상한을 넘으면 그 함수처럼 뒤 근거부터 덜어 낸다.
 * source·validUntil·sourceRevisionHash 는 그대로다 — 묶음은 원본의 다른 모습일 뿐 새 원본이 아니다
 */
export function attachProjectActivity(input: ReviewInput, activity: ProjectActivity): ReviewInput {
  const snapshot: ReviewSnapshot = { ...structuredClone(input.snapshot), projectActivity: activity };
  let trimmed = false;
  while (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_REVIEW_INPUT_BYTES && snapshot.evidence.length) {
    snapshot.evidence.pop();
    snapshot.evidenceTruncated = true;
    trimmed = true;
  }
  if (trimmed) snapshot.evidenceSummary = summarizeAgentEvidence({ relationship: snapshot.relationship, scanState: snapshot.scanState,
    observations: snapshot.evidence.map(item => item.observation) });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_REVIEW_INPUT_BYTES) throw new Error("review_input_too_large");
  return { ...input, snapshot, inputHash: reviewInputHash(snapshot, input.policyHash) };
}

// ─────────────────────────── 감사 때와 지금의 차이(사람이 읽는 글) ───────────────────────────

/** 날짜를 짧게 — 두 날이 같은 해면 'M/DD', 아니면 'YYYY/M/DD' */
function shortDay(value: string | null, sameYear: boolean): string {
  if (!value) return "모름";
  const [y, m, d] = value.split("-");
  return sameYear ? `${Number(m)}/${d}` : `${y}/${Number(m)}/${d}`;
}

function siteText(site: ProjectActivity["site"]): string {
  if (site.status === null) return "주소 없음";
  return site.status === 0 ? "닿지 않음" : String(site.status);
}

/** 감사 입력의 product 칸 이름 → 사람이 읽는 이름(바뀐 칸 요약) */
export const RECOLLECT_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "이름", description: "소개 글", pageText: "페이지 본문", readme: "README", url: "주소", accessMode: "접근 방식",
  repositoryUrl: "저장소 주소", topics: "토픽", language: "언어", linksOwnGithub: "제작자 GitHub 링크", packageProof: "패키지 근거",
};

/**
 * 감사 때(다시 받기 전 원본)와 지금(다시 받은 원본)의 차이를 사람이 읽는 짧은 글들로 — 감사 화면 항목 한 줄과 기록(change_summary)에 남긴다.
 * 예: "사이트 404 → 200", "마지막 push 9/02 → 11/10", "보관 아님 → 보관됨", "페이지 본문 바뀜". 바뀐 것이 없으면 빈 목록.
 * before 가 없으면(옛 줄) 활동 차이는 쓰지 않고 칸 이름만 쓴다.
 */
export function recollectChangeSummary(before: ProjectActivity | null | undefined, after: ProjectActivity | null | undefined,
  changedFields: readonly string[] = []): string[] {
  const lines: string[] = [];
  if (before && after) {
    if (before.site.status !== after.site.status) lines.push(`사이트 ${siteText(before.site)} → ${siteText(after.site)}`);
    if (!sameUrl(before.site.finalUrl, after.site.finalUrl)) {
      lines.push(after.site.finalUrl ? `리다이렉트 → ${after.site.finalUrl.replace(/^https?:\/\//, "").slice(0, 80)}` : "리다이렉트 없어짐");
    }
    if (before.lastPushAt !== after.lastPushAt) {
      const sameYear = Boolean(before.lastPushAt && after.lastPushAt && before.lastPushAt.slice(0, 4) === after.lastPushAt.slice(0, 4));
      lines.push(`마지막 push ${shortDay(before.lastPushAt, sameYear)} → ${shortDay(after.lastPushAt, sameYear)}`);
    }
    if (before.archived !== after.archived) {
      const label = (value: boolean | null) => value === null ? "모름" : value ? "보관됨(archived)" : "보관 아님";
      lines.push(`${label(before.archived)} → ${label(after.archived)}`);
    }
    const releaseKey = (release: ProjectActivity["latestRelease"]) => release ? `${release.name}@${release.publishedAt ?? ""}` : "";
    if (releaseKey(before.latestRelease) !== releaseKey(after.latestRelease) && after.latestRelease) {
      lines.push(`새 릴리스 ${after.latestRelease.name.slice(0, 40) || "(이름 없음)"}${after.latestRelease.publishedAt
        ? ` (${shortDay(after.latestRelease.publishedAt, false)})` : ""}`);
    }
  }
  const fields = changedFields.map((field) => RECOLLECT_FIELD_LABELS[field] ?? field);
  if (fields.length) lines.push(`${fields.join("·")} 바뀜`);
  return lines;
}
