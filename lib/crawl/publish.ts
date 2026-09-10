import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { LIMITS, type Category } from "@/lib/domain/products/schema";
import * as products from "@/lib/domain/products/repository";
import { cacheOgImage } from "@/lib/domain/products/og";
import { generateEditToken, generateVerifyToken, hashToken } from "@/lib/tokens";
import { logger } from "@/lib/observability/logger";
import * as crawl from "./repository";
import { classifyCategory, type ClassifyInput } from "./classify";
import { getSettings } from "./settings";
import { judgeRevision } from "./rules";
import { guardPublication, publicationSourceChanged, PublicationStateChangedError } from "./publication-guard";
import { loadAgentJudgeInput } from "./agent-evidence";
import { summarizeAgentEvidence, type AgentEvidenceSummary } from "@/lib/domain/evidence/agents/summary";
import type { JobLease } from "@/lib/jobs/control";
import { ReviewApprovalChangedError } from "./agent-review-repository";

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
  | { ok: false; reason: "no_document" | "no_url" | "already_listed" | "no_description" | "publication_state_changed" | "review_approval_changed" | "source_changed" | "stale_judgement" | AgentEvidenceSummary["reason"] };

type PublicationSnapshot = {
  document: CrawlDocument;
  url: string;
  settings: Awaited<ReturnType<typeof getSettings>>;
  checkedEvidence: Awaited<ReturnType<typeof loadAgentJudgeInput>> | null;
  draft: ReturnType<typeof draftFrom>;
};

export type PreparedClassification = {
  input: ClassifyInput;
  snapshot: PublicationSnapshot;
};

type Preclassification = {
  decision?: { revision: number | null; sourceHash: string | null };
  category: Category | null;
  snapshot?: PublicationSnapshot;
};

async function preparePublication(candidate: CrawlCandidate): Promise<
  { ok: true; snapshot: PublicationSnapshot } | Exclude<PublishResult, { ok: true }>
> {
  const document = await crawl.getDocument(candidate.repo);
  if (!document) return { ok: false, reason: "no_document" };
  if (publicationSourceChanged(candidate, document)) return { ok: false, reason: "source_changed" };
  const url = candidate.productUrl ?? document.productUrl;
  if (!url) return { ok: false, reason: "no_url" };

  const settings = await getSettings();
  const checkedEvidence = settings.agentEvidence.enforceEligibility && candidate.decidedBy !== "admin"
    ? await loadAgentJudgeInput(document, settings) : null;
  if (checkedEvidence) {
    const summary = summarizeAgentEvidence(checkedEvidence);
    if (!summary.eligible) return { ok: false, reason: summary.reason };
  }
  /**
   * 자동 승인은 그 판정이 본 원본에 대해서만 유효하다.
   *
   * codex 재현: 200일 때 승인된 후보가 발행 전에 다시 수집돼 404가 됐는데, reviewMode off/observe
   * 의 발행은 규칙을 다시 태우지 않아 죽은 페이지가 seeded로 올라갔다. 수집은 원본이 바뀌면
   * 후보를 되돌리지만(saveFetchedDocument), 후보 생성이 재수집과 겹치면 그 되돌림을 비껴간다.
   *
   * 그래서 판정이 본 원본의 리비전(judgeRevision)을 지금 원본과 맞춰 본다. 다르면 판정으로
   * 돌려보낸다 — 여기서 다시 판정하지 않는다. 판정은 한 곳에서만 하고, 발행은 "판정받은 그
   * 원본인가"만 본다. 전에는 두 워커의 시계(fetchedAt > judgedAt)를 비교해, 시계가 어긋나면
   * 새 원본을 놓쳤다. 리비전이 없는 옛 후보도 한 번 판정을 다시 받는다 — 안전한 쪽이다.
   *
   * 사람의 결정은 규칙으로 뒤집지 않는다. AI 승인은 판정이 남긴 signals를 그대로 이어받으므로
   * (agent-review-repository) 원본이 그대로면 여기를 지난다.
   */
  if (candidate.decidedBy === "auto") {
    const judged = (candidate.signals as { judgedRevision?: unknown } | null)?.judgedRevision;
    if (judged !== judgeRevision(document)) return { ok: false, reason: "stale_judgement" };
  }
  const draft = draftFrom(candidate.repo, document);
  if (!draft.hasDescription && candidate.decidedBy !== "admin") {
    return { ok: false, reason: "no_description" };
  }
  return { ok: true, snapshot: { document, url, settings, checkedEvidence, draft } };
}

export async function publishCandidate(
  candidate: CrawlCandidate,
  lease?: JobLease,
  preclassification?: Preclassification,
): Promise<PublishResult> {
  const prepared = preclassification?.snapshot
    ? { ok: true as const, snapshot: preclassification.snapshot }
    : await preparePublication(candidate);
  if (!prepared.ok) return prepared;
  const { document, url, settings, checkedEvidence, draft } = prepared.snapshot;

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
  /**
   * 카테고리는 문장을 읽어야 정해진다.
   *
   * 키워드 규칙은 대부분을 Other로 떨어뜨렸고, "…Offers, Payments…"라는 소개 하나로
   * 업무 도구를 Finance로 보내기도 했다. 읽고 고르는 일은 읽을 수 있는 쪽에 맡기고,
   * 분류가 실패하면 규칙 결과를 그대로 쓴다 — 카테고리 하나 때문에 발행을 막지 않는다.
   */
  const classificationInput = {
      repo: candidate.repo,
      url,
      name: draft.name,
      tagline: draft.tagline,
      topics: draft.topics,
      language: draft.language,
    };
  const category = (
    preclassification === undefined
      ? await classifyCategory(classificationInput)
      : preclassification.category
  ) ?? draft.category;
  const editToken = generateEditToken();
  // Search metadata is a discovery hint, not a maker or model assertion.
  const builder = null;

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
        category,
        // Search hints are not maker or model assertions; observed facts have a separate view.
        builder,
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
      }, tx => guardPublication(tx, {candidate,document,settings,slug,scanId:checkedEvidence?.scanId ?? null,lease,decision:preclassification?.decision}));
      break;
    } catch (e) {
      if (e instanceof PublicationStateChangedError) return {ok:false,reason:"publication_state_changed"};
      if (e instanceof ReviewApprovalChangedError) return {ok:false,reason:"review_approval_changed"};
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

  logger.info("crawl.published", { repo: candidate.repo, slug, url, category });
  return { ok: true, slug };
}

/**
 * Builds the same facts used by direct publication so the job can classify its ten
 * approved candidates in one CLI call. The returned snapshot travels with the result;
 * the publication transaction locks and compares it after the model call so source or
 * admin changes cannot be published from a stale classification.
 */
export async function prepareCandidateClassification(
  candidate: CrawlCandidate,
): Promise<PreparedClassification | null> {
  const prepared = await preparePublication(candidate);
  if (!prepared.ok) return null;
  const { url, draft } = prepared.snapshot;
  return { input: {
    repo: candidate.repo,
    url,
    name: draft.name,
    tagline: draft.tagline,
    topics: draft.topics,
    language: draft.language,
  }, snapshot: prepared.snapshot };
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
    // 분류가 함께 볼 것들 — 규칙도 이것으로 고르고, LLM도 같은 사실을 본다
    language,
    topics: Array.isArray(meta.topics) ? meta.topics.map((t) => String(t)) : [],
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
 *
 * 하이픈-마이너스도 구분자다. 실데이터 451건에서 60자를 넘긴 이름 21건 중 11건이
 * "DEEPSEEKAGENTS - AI-Powered Agentic Swarms…"처럼 그것으로 갈라져 있었다. 앞뒤 공백
 * 조건이 있어 e-commerce·Well-Architected·Ready-to-use는 그대로 남는다(확인함).
 *
 * 콜론("Vibe Coding Starter Guide: from Design to…")은 넣지 않았다. 앞에 공백이 없어
 * 같은 조건으로 거를 수 없고, 이름 안에 콜론을 쓰는 제품과 가릴 방법이 없다.
 */
function productName(title: string): string {
  const [head] = title.split(/\s+[|·–—-]\s+/);
  return head.trim() || title.trim();
}

/**
 * 카테고리 추정.
 *
 * 모델과 CLI를 쓸 수 없을 때도 발행을 멈추지 않는 최종 폴백이다. 확실한 신호(topics)를
 * 먼저 보고, 없으면 설명을 본다. 단어가 여러 뜻인 경우를 줄이기 위해 좁은 표현만 둔다.
 */
const CATEGORY_KEYWORDS: { category: Category; topics: string[]; text: string[] }[] = [
  { category: "Security", topics: ["security", "cybersecurity", "privacy", "phishing", "fraud"], text: ["cybersecurity", "phishing detection", "fraud prevention"] },
  { category: "Games", topics: ["game", "games", "gaming", "video-game", "game-development", "indie-game", "godot", "unity"], text: ["playable game", "video game", "puzzle game", "battle game", "game editor", "game creation", "game information"] },
  { category: "Sports", topics: ["sports", "fitness", "workout", "football", "soccer", "basketball", "running"], text: ["fitness training", "workout", "football team", "sports league"] },
  { category: "Health", topics: ["health", "wellness", "mental-health", "medical", "therapy"], text: ["mental health", "medical support", "therapy", "wellness"] },
  { category: "Commerce", topics: ["commerce", "ecommerce", "e-commerce", "marketplace", "shopping", "retail"], text: ["online marketplace", "online store", "shopping platform", "product marketplace"] },
  { category: "Finance", topics: ["finance", "fintech", "trading", "investing", "crypto", "banking", "accounting"], text: ["stock valuation", "financial analysis", "investment portfolio", "accounting software"] },
  { category: "Education", topics: ["education", "learning", "teaching", "tutoring", "course"], text: ["online course", "learning platform", "study tool", "teaching assistant"] },
  { category: "Media", topics: ["video", "audio", "music", "film", "podcast", "news"], text: ["video editor", "audio editor", "film creation", "music creation", "news reader"] },
  { category: "Marketing", topics: ["marketing", "seo", "advertising", "growth", "campaign"], text: ["marketing campaign", "seo tool", "advertising platform", "sales enablement"] },
  { category: "Business", topics: ["business", "crm", "hr", "operations", "invoicing", "project-management"], text: ["customer relationship management", "business operations", "invoice management", "project documentation"] },
  { category: "Data", topics: ["data", "analytics", "database", "business-intelligence", "visualization"], text: ["data analytics", "business intelligence", "data visualization", "database management"] },
  { category: "Social", topics: ["social", "community", "messaging", "dating"], text: ["social network", "community platform", "two-way messaging", "dating app"] },
  { category: "Design", topics: ["design", "figma", "ui-kit", "icons", "illustration"], text: ["design tool", "ui kit", "icon library", "illustration tool"] },
  { category: "Dev", topics: ["cli", "developer-tools", "devtools", "sdk", "api", "framework", "library", "compiler", "kubernetes", "docker", "devops", "mcp"], text: ["developer tool", "software development", "command line", "api client", "sdk", "devops"] },
  { category: "Productivity", topics: ["productivity", "todo", "note", "task", "calendar", "workflow", "automation", "tracker"], text: ["task manager", "note taking", "team calendar", "workflow automation", "time tracking"] },
  { category: "Lifestyle", topics: ["travel", "food", "recipe", "home", "hobby", "wedding"], text: ["travel planner", "recipe app", "wedding celebration", "wedding invitation"] },
];

function classify(meta: Record<string, unknown>): Category {
  const topics = Array.isArray(meta.topics) ? meta.topics.map((t) => String(t).toLowerCase()) : [];
  const text = [meta.description, meta.language].filter((v) => typeof v === "string").join(" ").toLowerCase();

  // Hosting or operating a game server is infrastructure, not a playable game.
  if (/\bgame servers?\b/.test(text) && /\b(?:self-host|hosting|docker|kubernetes|infrastructure)\b/.test(text)) {
    return "Dev";
  }
  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.topics.some((keyword) => topics.includes(keyword))) return rule.category;
  }
  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.text.some((keyword) => text.includes(keyword))) return rule.category;
  }
  return "Other";
}
