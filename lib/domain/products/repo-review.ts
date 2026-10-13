import type { RepoReviewDecision } from "@/lib/db/schema";
import { MAX_LINKS as MAX_GITHUB_LINKS } from "@/lib/crawl/github-links";

/**
 * 저장소가 사라진 공개 제품을 다시 본다 — 저장소가 정말 없으면 내린다(product-repo-review).
 *
 * 2026-10-13 운영자 결정: GitHub 저장소가 사라졌으면(삭제·비공개 — 둘 다 공개 소스가 남지 않는다) 사이트가 살아 있어도 내린다.
 * 그 전 기준(사이트가 죽었거나 다른 제품일 때만 내릴 후보, 게이트웨이 Qwen3.8 네 질문)은 버렸다. 같은 날 Codex 재검수로
 * 1,486건을 내렸는데, 하루 확인(GraphQL)이 없다고 본 지 하루가 지난 1,516건 중 10건은 저장소가 다시 살아 있었고
 * 22건은 같은 프로젝트가 다른 저장소로 옮겨 가 있었다. 그래서 내리기 전에 github.com 을 지금 다시 열고, 페이지가 가리키는
 * 저장소 중 같은 프로젝트로 보이는 것을 연다. 옮겨 간 흔적이 있으면 사람이 정한다.
 */

/** github.com 저장소 페이지를 지금 열어 본 결과. unknown 은 막힘·오류라 이번에는 정하지 않는다 */
export type RepoCheck = { state: "alive" } | { state: "gone" } | { state: "moved"; to: string } | { state: "unknown" };
/**
 * 새로 연 제품 페이지. status 0 은 연결 자체가 안 됐다. githubLinks 는 extractGithubLinks 의 owner/repo(소문자).
 * complete 는 본문을 끝까지 읽었는지 — 끊겼거나 상한에서 잘렸거나 meta refresh 로 넘어간 곳을 못 열었으면 false.
 * 그때는 링크가 비어 있어도 "링크 없음"이 아니다
 */
export type RepoReviewPage = { status: number; finalUrl: string | null; title: string; text: string; githubLinks: string[]; complete: boolean };
export type RepoReviewReason = "repo_alive" | "repo_moved" | "repo_link_alive" | "repo_links_unchecked" | "repo_gone";

/** 같은 프로젝트로 보고 열어 볼 페이지 링크 수 — 한 건에 github.com 을 이보다 많이 열지 않는다. 남은 것이 있으면 내리지 않는다 */
export const MAX_RELATED_LINKS = 3;
/** 사이트가 이만큼 이어서 죽어 있으면 페이지를 못 열어도 내린다(생존 확인 product_health.down_since 기준) */
export const SITE_DOWN_DAYS = 3;

/** 봇 확인·검사 화면 — 200 으로 와도 진짜 페이지가 아니다(옛 사이트 확인의 거르기와 같은 글) */
const CHECKPOINT = /Vercel Security Checkpoint|verifying your browser|Just a moment\.\.\.|Attention Required! \| Cloudflare|checking your browser/i;
const SHORT_PAGE_CHARS = 600;

/**
 * 페이지의 링크를 믿을 수 있나 — 2xx·3xx 를 끝까지 읽었거나 사이트가 없다고 답했다(404·410).
 * 연결 실패·막힘(401·403·429)·서버 오류·봇 확인 화면, 링크가 모으기 상한(20개)에 닿은 페이지는 옮겨 간 저장소 링크를
 * 가렸을 수 있다 — 사이트가 사흘 넘게 죽어 있지 않으면 내리지 않는다
 */
export function pageConclusive(page: RepoReviewPage, downSince: Date | null, now = new Date()): boolean {
  const checkpoint = CHECKPOINT.test(page.title) || page.text.length < SHORT_PAGE_CHARS && CHECKPOINT.test(page.text);
  if (page.complete && !checkpoint && page.githubLinks.length < MAX_GITHUB_LINKS
    && (page.status >= 200 && page.status < 400 || page.status === 404 || page.status === 410)) return true;
  return downSince !== null && now.getTime() - downSince.getTime() >= SITE_DOWN_DAYS * 86_400_000;
}

/** github.com/owner/repo 꼴에서 owner/repo(소문자). 아니면 null */
export function repositoryKey(url: string | null | undefined): string | null {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([a-z0-9-]{1,39})\/([a-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(url?.trim() ?? "");
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** github.com 응답 → 저장소 상태. 삭제·비공개는 404, 법적 차단은 451 — 모두 공개 소스가 없다 */
export function classifyRepoResponse(requested: string, status: number, finalUrl: string): RepoCheck {
  if (status === 404 || status === 451) return { state: "gone" };
  if (status !== 200) return { state: "unknown" };
  const landed = repositoryKey(finalUrl);
  if (!landed) return { state: "unknown" };
  return landed === requested.toLowerCase() ? { state: "alive" } : { state: "moved", to: landed };
}

const normalize = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
/** 주소의 이름 부분 — www.browserless.io → browserless, pawdelta.com → pawdelta */
function hostLabel(url: string | null): string {
  try { return normalize(new URL(url ?? "").hostname.replace(/^www\./, "").split(".")[0] ?? ""); } catch { return ""; }
}

/**
 * 페이지가 가리키는 저장소 중 같은 프로젝트일 수 있는 것 — 주인이나 이름이 옛 저장소·제품 이름·사이트 주소와 겹친다.
 * three.js·DataDog SDK 같은 남의 라이브러리는 빠진다. 같은 주인의 다른 저장소는 이름을 바꾼 것일 수 있어 연다 —
 * 재검수에서는 다른 프로젝트인 때가 더 많았지만(9건) 가르는 일은 사람에게 둔다.
 */
export function relatedRepositoryLinks(input: { repo: string; name: string; url: string; renamedTo: string | null }, page: RepoReviewPage): string[] {
  const [owner, name] = input.repo.split("/");
  const marks = new Set([normalize(owner), normalize(name), normalize(input.name), hostLabel(input.url), hostLabel(page.finalUrl)].filter((mark) => mark.length >= 3));
  const links = page.githubLinks.filter((key) => key.includes("/") && key !== input.repo)
    .filter((key) => key.split("/").some((part) => marks.has(normalize(part))));
  const renamed = input.renamedTo?.toLowerCase();
  return [...new Set([...(renamed && renamed !== input.repo ? [renamed] : []), ...links])];
}

/**
 * 옛 저장소가 없을 때 — 같은 프로젝트로 보이는 저장소가 하나라도 살아 있으면 사람, 하나라도 못 열었으면 다음에 다시,
 * 열어 보지 못한 링크가 남았으면(MAX_RELATED_LINKS 초과) 사람, 아무것도 없으면 내린다.
 * 내리는 판정은 delist_candidate 로 적고 잡이 그 자리에서 차단한다(repo-reviews.ts delistGoneRepository).
 */
export function decideGoneRepository(related: { key: string; check: RepoCheck }[], unchecked: string[] = []):
  { decision: RepoReviewDecision; reason: RepoReviewReason; note: string | null } | null {
  const live = related.filter(({ check }) => check.state === "alive" || check.state === "moved");
  if (live.length) {
    return { decision: "human", reason: "repo_link_alive",
      note: live.map(({ key, check }) => `github.com/${check.state === "moved" ? check.to : key}`).join(" · ") };
  }
  if (related.some(({ check }) => check.state === "unknown")) return null;
  if (unchecked.length) return { decision: "human", reason: "repo_links_unchecked", note: unchecked.map((key) => `github.com/${key}`).join(" · ") };
  return { decision: "delist_candidate", reason: "repo_gone", note: null };
}
