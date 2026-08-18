import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { LIMITS, type Category } from "@/lib/domain/products/schema";
import * as products from "@/lib/domain/products/repository";
import { cacheOgImage } from "@/lib/domain/products/og";
import { generateEditToken, generateVerifyToken, hashToken } from "@/lib/tokens";
import { logger } from "@/lib/observability/logger";
import * as crawl from "./repository";

/**
 * 발행 — 통과한 후보를 목록에 올린다.
 *
 * 우리가 대신 올리는 것이므로 status는 seeded, source는 crawler다. 랭킹에서 빠지고
 * 미클레임 배지가 붙는다(view.ts). 주인이 나타나 도메인을 증명하면 그때 verified가 된다.
 *
 * 없는 값을 지어내지 않는다. 수집 결과에는 제품 이름도 소개도 없고, 우리가 가진 것은
 * 배포 페이지의 메타와 레포 설명뿐이다. 그것으로 채우고 모자라면 사실(레포 이름)로 메운다.
 */

const MAX_SLUG_ATTEMPTS = 4;

export type PublishResult =
  | { ok: true; slug: string }
  | { ok: false; reason: "no_document" | "no_url" | "already_listed" | "no_description" };

export async function publishCandidate(candidate: CrawlCandidate): Promise<PublishResult> {
  const document = await crawl.getDocument(candidate.repo);
  if (!document) return { ok: false, reason: "no_document" };

  const url = candidate.productUrl ?? document.productUrl;
  if (!url) return { ok: false, reason: "no_url" };

  const draft = draftFrom(candidate.repo, document);

  /**
   * 우리가 아는 것이 이름뿐이면 자동으로 올리지 않는다.
   *
   * 실제로 rilla-dashboard-clone이 소개 없이 발행돼 태그라인 자리에 레포 전체 이름이
   * 들어갔다. 무엇을 하는 것인지 아무도 모르는 항목을 목록에 올리는 것은 "직접 확인한
   * 것만 보여준다"는 원칙과 어긋난다.
   *
   * 사람이 이미 본 것(decidedBy=admin)은 그대로 올린다. 그러지 않으면 심사에서 승인한
   * 항목이 곧바로 심사로 되돌아와 끝나지 않는다.
   */
  if (!draft.hasDescription && candidate.decidedBy !== "admin") {
    return { ok: false, reason: "no_description" };
  }
  const editToken = generateEditToken();

  let slug = "";
  for (let attempt = 0; ; attempt++) {
    slug = await products.nextAvailableSlug(draft.name);
    try {
      await products.insert({
        slug,
        url,
        name: draft.name,
        tagline: draft.tagline,
        description: draft.description,
        category: draft.category,
        // "만든 AI"는 메이커 신고값이다. 우리가 커밋 트레일러를 보고 추측한 것을 여기 넣으면
        // 신고와 추정이 같은 칸에서 섞인다 — 주인이 클레임할 때 직접 밝힌다.
        builder: null,
        stack: draft.stack,
        ogImage: null,
        makerName: null,
        repoUrl: `https://github.com/${candidate.repo}`,
        status: "seeded",
        source: "crawler",
        /**
         * 검증 토큰은 미리 발급해 둔다 — 주인이 나타나면 이 토큰을 자기 도메인에 올려
         * 소유를 증명한다. 수정 키는 만들어서 버린다. 아무도 손에 쥐지 않은 상태여야
         * 클레임 전까지 이 행을 아무도 고칠 수 없다.
         */
        verifyToken: generateVerifyToken(),
        editTokenHash: hashToken(editToken),
      });
      break;
    } catch (e) {
      const constraint = products.uniqueViolation(e);
      if (constraint === "products_url_unique") {
        // 판정 뒤 메이커가 먼저 등록했다 — 우리가 늦은 것이지 오류가 아니다
        return { ok: false, reason: "already_listed" };
      }
      if (constraint !== null && attempt < MAX_SLUG_ATTEMPTS) {
        logger.warn("crawl.publish_slug_conflict", { repo: candidate.repo, slug, attempt });
        continue;
      }
      logger.error("crawl.publish_failed", { repo: candidate.repo, slug, error: e });
      throw e;
    }
  }

  // OG 이미지는 부가 작업이다. 핫링크하지 않는 이유는 등록 경로와 같다 —
  // 상대 서버가 죽으면 목록이 깨지고, 이미지가 사후에 바뀔 수 있다.
  if (draft.ogImage) {
    const path = await cacheOgImage(draft.ogImage, slug);
    if (path) await products.setOgImage(slug, path);
  }

  await crawl.markPublished(candidate.repo, slug);
  logger.info("crawl.published", { repo: candidate.repo, slug, url, category: draft.category });
  return { ok: true, slug };
}

/** 원본에서 목록에 올릴 값을 만든다 */
function draftFrom(repo: string, document: CrawlDocument) {
  const page = (document.pageMeta ?? {}) as { title?: unknown; description?: unknown; ogImage?: unknown };
  const meta = document.repoMeta;
  const repoName = repo.split("/")[1] ?? repo;
  const repoDescription = typeof meta.description === "string" ? meta.description.trim() : "";
  const pageTitle = typeof page.title === "string" ? page.title.trim() : "";
  const pageDescription = typeof page.description === "string" ? page.description.trim() : "";
  const language = typeof meta.language === "string" ? meta.language : null;

  /**
   * 소개가 아무 데도 없으면 레포 이름을 쓴다.
   * 그럴듯한 문장을 만들어 넣으면 그것이 메이커가 쓴 소개와 구분되지 않는다.
   */
  const tagline = pageDescription || repoDescription || repo;

  return {
    /** 소개를 어디서도 못 찾았다는 표시 — 발행할지 말지를 이걸로 가른다 */
    hasDescription: Boolean(pageDescription || repoDescription),
    name: productName(pageTitle || repoName).slice(0, LIMITS.name),
    tagline: tagline.slice(0, LIMITS.tagline),
    description: (repoDescription || pageDescription || tagline).slice(0, LIMITS.description),
    category: classify(meta),
    // 언어는 레포가 알려주는 사실이다. 나머지 스택은 추측이므로 넣지 않는다
    stack: language ? [language] : [],
    ogImage: typeof page.ogImage === "string" ? page.ogImage : null,
  };
}

/**
 * 제목에서 제품 이름만 남긴다.
 *
 * og:title은 "이름 | 마케팅 한 줄" 형태가 흔하다. 실제 수집에서
 * "RevealUI | Build it once. Every product after starts ahead."가 통째로 이름이 됐다.
 * 구분자 앞이 이름이고 뒤는 소개다 — 소개는 이미 따로 있다.
 *
 * 앞뒤 공백이 있는 구분자만 자른다. 그러지 않으면 e-commerce 같은 이름이 잘린다.
 */
function productName(title: string): string {
  const [head] = title.split(/\s+[|·–—]\s+/);
  return head.trim() || title.trim();
}

/**
 * 카테고리 추정.
 *
 * 다섯 칸뿐이라 정확할 수 없고, 정확할 필요도 없다 — 틀리면 Other보다 나쁠 것이 없고
 * 주인이 클레임하면 스스로 고친다. 확실한 신호(topics)를 먼저 보고, 없으면 설명을 본다.
 */
const CATEGORY_KEYWORDS: [Category, string[]][] = [
  ["Finance", ["finance", "fintech", "trading", "invest", "crypto", "banking", "accounting", "budget", "payment"]],
  ["Design", ["design", "figma", "ui-kit", "icons", "illustration", "css", "tailwind", "font", "color"]],
  ["Dev", ["cli", "developer-tools", "devtools", "sdk", "api", "framework", "library", "compiler", "kubernetes", "docker", "devops", "mcp", "agent"]],
  ["Productivity", ["productivity", "todo", "note", "task", "calendar", "workflow", "automation", "tracker", "dashboard"]],
];

function classify(meta: Record<string, unknown>): Category {
  const topics = Array.isArray(meta.topics) ? meta.topics.map((t) => String(t).toLowerCase()) : [];
  const text = [meta.description, meta.language].filter((v) => typeof v === "string").join(" ").toLowerCase();

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => topics.includes(k))) return category;
  }
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) return category;
  }
  return "Other";
}
