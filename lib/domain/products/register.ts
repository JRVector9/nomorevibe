import { normalizeUrl, extractOgImage } from "@/lib/net/normalize";
import { assertPublicUrl, allowPrivate } from "@/lib/net/ssrf";
import { fetchPage } from "@/lib/net/fetch";
import { generateEditToken, generateVerifyToken, hashToken } from "@/lib/tokens";
import { logger } from "@/lib/observability/logger";
import type { RegisterInput } from "./schema";
import { type Result, ok, fail } from "./errors";
import * as repo from "./repository";
import { cacheOgImage } from "./og";

export type RegisterOutput = {
  slug: string;
  editToken: string;
  verifyToken: string;
};

const MAX_SLUG_ATTEMPTS = 4;

/** 도메인이 바뀐 리다이렉트만 따라간다. 같은 도메인 안의 경로 이동은 입력 주소를 지킨다. */
export function resolveCanonical(inputUrl: string, finalUrl: string | undefined): string {
  if (!finalUrl) return inputUrl;
  const normalized = normalizeUrl(finalUrl, allowPrivate());
  if (!normalized) return inputUrl;
  try {
    if (new URL(normalized).host === new URL(inputUrl).host) return inputUrl;
  } catch {
    return inputUrl;
  }
  return normalized;
}

/**
 * 제품 등록 유스케이스 — HTTP를 모른다.
 * 라우트 핸들러도, (로드맵의) GitHub 시드 크롤러도 이 함수를 그대로 호출한다.
 */
export async function registerProduct(input: RegisterInput): Promise<Result<RegisterOutput>> {
  const url = normalizeUrl(input.url, allowPrivate());
  if (!url) {
    logger.warn("register.rejected", { reason: "url_format", rawUrl: input.url });
    return fail({ kind: "invalid", message: "URL 형식이 올바르지 않습니다" });
  }

  const guard = await assertPublicUrl(url);
  if (!guard.ok) {
    // SSRF 가드에 걸린 등록은 공격 시도일 수 있으므로 반드시 남긴다
    logger.warn("register.rejected", { reason: "ssrf_guard", url, detail: guard.reason });
    return fail({ kind: "invalid", message: guard.reason });
  }

  // 중복 URL은 에러가 아니라 "업데이트하라"는 신호 (스킬 재실행이 가장 흔한 시나리오)
  const existing = await repo.findByUrl(url);
  if (existing) {
    if (existing.status === "banned") {
      return fail({ kind: "forbidden", message: "등록할 수 없는 URL입니다" });
    }
    return fail({ kind: "duplicate", slug: existing.slug, status: existing.status });
  }

  // 실제로 떠 있는 서비스인지 우리가 직접 확인한다
  const page = await fetchPage(url);
  if (!page || page.status < 200 || page.status >= 400) {
    // 가장 흔한 등록 실패 사유 — 배포가 안 됐거나 URL 오타다
    logger.warn("register.rejected", {
      reason: "unreachable",
      url,
      status: page?.status ?? null,
    });
    return fail({
      kind: "unreachable",
      message: `URL에 접속할 수 없습니다 (${page ? `HTTP ${page.status}` : "연결 실패"})`,
    });
  }

  /**
   * 리다이렉트로 도메인이 바뀌면 목적지를 기준값으로 삼는다.
   *
   * 배포 주소가 다른 도메인으로 넘기는 경우가 흔하다 (hibicalc.vercel.app → hibicalc.com).
   * 입력 URL을 그대로 저장하면 같은 사이트가 두 주소로 등록돼 중복 방지가 뚫린다.
   *
   * 다만 같은 도메인 안에서의 경로 리다이렉트는 따라가지 않는다. 사이트가 루트에서
   * 기본 페이지로 넘기는 것은 내부 라우팅일 뿐이고, 사람이 공유하는 주소는 루트다.
   * (ko.wikipedia.org → ko.wikipedia.org/wiki/위키백과:대문 을 저장하면 안 된다)
   *
   * finalUrl이 없으면 입력 주소를 쓴다 — 정규화에 실패했다고 등록을 막을 이유는 없다.
   */
  const canonical = resolveCanonical(url, page.finalUrl);
  if (canonical !== url) {
    const alias = await repo.findByUrl(canonical);
    if (alias) {
      if (alias.status === "banned") {
        return fail({ kind: "forbidden", message: "등록할 수 없는 URL입니다" });
      }
      logger.info("register.redirect_duplicate", { input: url, canonical, existing: alias.slug });
      return fail({ kind: "duplicate", slug: alias.slug, status: alias.status });
    }
    logger.info("register.canonicalized", { input: url, canonical });
  }

  const editToken = generateEditToken();
  const verifyToken = generateVerifyToken();

  // slug 생성과 insert 사이의 동시 등록 경합은 unique 위반을 잡아 재시도로 해소한다
  let slug = "";
  for (let attempt = 0; ; attempt++) {
    slug = await repo.nextAvailableSlug(input.name);
    try {
      await repo.insert({
        slug,
        url: canonical,
        name: input.name,
        tagline: input.tagline,
        description: input.description,
        category: input.category,
        builder: input.builder ?? null,
        stack: input.stack ?? [],
        ogImage: null,
        makerName: input.maker_name ?? null,
        repoUrl: input.repo_url ?? null,
        verifyToken,
        editTokenHash: hashToken(editToken),
      });
      break;
    } catch (e) {
      const constraint = repo.uniqueViolation(e);
      if (constraint === "products_url_unique") {
        const winner = await repo.findByUrl(canonical);
        return fail({ kind: "duplicate", slug: winner?.slug, status: winner?.status });
      }
      if (constraint !== null && attempt < MAX_SLUG_ATTEMPTS) {
        // 동시 등록 경합 — 자주 보이면 slug 생성 전략을 재검토해야 한다는 신호
        logger.warn("register.slug_conflict", { slug, attempt, constraint });
        continue;
      }
      logger.error("register.insert_failed", { url, slug, error: e });
      throw e;
    }
  }

  // OG 이미지는 등록 성공 후 부가 작업 — 실패해도 등록 자체는 유효하다.
  // 다만 조용히 실패하면 목록에 아이콘이 빠진 이유를 알 수 없으므로 남긴다.
  const ogUrl = extractOgImage(page.html, canonical);
  if (ogUrl) {
    const path = await cacheOgImage(ogUrl, slug);
    if (path) await repo.setOgImage(slug, path);
    else logger.info("register.og_skipped", { slug, ogUrl });
  }

  logger.info("register.succeeded", { slug, url: canonical, builder: input.builder ?? null });
  return ok({ slug, editToken, verifyToken });
}
