import "server-only";
import { protectedCoverUrl } from "@/lib/domain/products/cover-url";
import { makerFollowKey } from "@/components/me/FollowSlot";
import { savableProduct } from "@/components/product-detail/savable";
import { safeExternalUrl } from "@/components/product-detail/format";
import { githubStarEnabled, publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { parseGithubRepository } from "@/lib/github/repositories";
import { englishLang } from "@/lib/i18n/content-language";
import { logger } from "@/lib/observability/logger";
import { talkVisibility } from "@/lib/social/flags";
import { productTalk } from "@/lib/social/talk";
import { githubOwnerFromRepositoryUrl, repositoryOperator } from "./github-owner";
import type { ProductDetailView, PublicProduct } from "./detail-view";
import { shortReadmeExcerpt } from "./readme-excerpt";

/**
 * 상세 화면의 머리·소개·미리보기 값(2026-11-15 공개 HTML 이름·요약만, 문서 4.2) — 서버 HTML 에는 이름(h1)·요약·빵부스러기·JSON-LD 만 남고,
 * 나머지는 같은 출처 API(/api/products/[slug]/details)로 화면 JS 가 받는다. 부품이 실제로 읽는 칸만 담는다.
 * 내부 id 는 로그인 운영자 확인·팔로가 켜졌을 때만(그 단추가 쓰는 때만) 담는다.
 */
export type DetailHero = {
  url: string;
  accessMode: PublicProduct["accessMode"];
  category: string;
  ogImage: string | null;
  repoUrl: string | null;
  repoGone: boolean;
  stars: number | null;
  unclaimed: boolean;
  tagline: string;
  taglineKo: string | null;
  taglineSource: PublicProduct["taglineSource"];
  translation?: PublicProduct["translation"];
  risingRank: number | null;
  talkRank: number | null;
  health: ProductDetailView["health"];
  languages: string[];
  /** 지금 운영 주체(GitHub) — 머리 메타 줄 */
  owner: { login: string } | null;
  /** 개인 GitHub 스타 단추를 둘지 */
  githubStar: boolean;
  /** 저장할 수 있는 제품인가(savable.ts) */
  savable: boolean;
  /** 팔로 단추 — 로그인 기능이 켜졌을 때만. 메이커는 열쇠가 지금 주인과 같을 때만 */
  follow: { productKey: string; maker: { key: string; login: string } | null } | null;
  /** 피드백 설정 메뉴(GitHub 저장소일 때만) */
  feedbackSettings: boolean;
};

export type DetailIntro = {
  /** 한 줄 소개와 다른 소개 글(그 언어로 고른 것) */
  text: string | null;
  textLang?: string;
  descriptionTranslation: { machine: boolean; pending: boolean; translated: boolean; sourceLocale: string | null; original: string | null } | null;
  /** 메이커가 준 소개인가(주인 확인됨) — 출처 줄 */
  makerSource: boolean;
  profile: ProductDetailView["profile"];
  readmeExcerpt: string | null;
  repo: string | null;
  repoGone: boolean;
};

export type DetailMedia = {
  ogImage: string | null;
  items: Pick<ProductDetailView["media"][number], "src" | "width" | "height" | "altText" | "sourceMissing" | "lastSuccessAt">[];
};

export type DetailAside = {
  /** 운영자 상자 — 주인 없는 GitHub 저장소 제품만 */
  ownerContact: { productId?: number; installable: boolean; authEnabled: boolean; githubEnabled: boolean } | null;
  /** 검증 전 제품 안내 */
  unverified: boolean;
};

export type DetailPageData = { hero: DetailHero; intro: DetailIntro; media: DetailMedia; aside: DetailAside };

export async function detailPageData(detail: ProductDetailView, product: PublicProduct & { descriptionTranslation?: PublicProduct["translation"] }): Promise<DetailPageData> {
  const repositoryUrl = detail.repository?.facts?.repositoryUrl ?? null;
  const owner = repositoryOperator(product.repoUrl, repositoryUrl)?.owner ?? null;
  const auth = publicUserAuthEnabled();
  const talkView = await talkVisibility().catch(() => ({ visible: false, preview: false }));
  const talk = talkView.visible
    ? await productTalk(product.id, product.repoUrl).catch((error: unknown) => { logger.warn("detail.talk_unavailable", { slug: product.slug, error }); return null; })
    : null;
  const makerKey = auth && owner ? await makerFollowKey(product.id, product.repoUrl, owner.login).catch(() => null) : null;
  const githubRepo = Boolean(product.repoUrl && parseGithubRepository(product.repoUrl));

  const originalDescription = product.description.trim() !== product.tagline.trim() ? product.description : null;
  const selected = product.descriptionTranslation;
  const description = originalDescription && (selected?.ready ? selected.text : originalDescription);

  return {
    hero: {
      url: product.url, accessMode: product.accessMode, category: product.category, ogImage: protectedCoverUrl(product.ogImage), repoUrl: product.repoUrl,
      repoGone: Boolean(product.repoGone), stars: product.stars ?? null, unclaimed: detail.unclaimed,
      tagline: product.tagline, taglineKo: product.taglineKo, taglineSource: product.taglineSource, translation: product.translation,
      risingRank: detail.risingRank, talkRank: talk?.qualifies ? talk.rank : null, health: detail.health,
      languages: (detail.repository?.facts?.languages ?? []).slice(0, 2).map((item) => item.name),
      owner: owner ? { login: owner.login } : null,
      githubStar: githubStarEnabled() && !product.repoGone && githubRepo,
      savable: savableProduct(product, detail.unclaimed),
      follow: auth ? { productKey: String(product.id), maker: makerKey && owner ? { key: makerKey, login: owner.login } : null } : null,
      feedbackSettings: githubRepo,
    },
    intro: {
      text: description || null,
      textLang: description ? selected?.lang ?? englishLang(description) : undefined,
      descriptionTranslation: description && selected ? {
        machine: Boolean(selected.translated && selected.provenance === "machine"), pending: Boolean(selected.pending), translated: Boolean(selected.translated),
        sourceLocale: selected.sourceLocale ?? null, original: selected.translated ? originalDescription : null,
      } : null,
      makerSource: Boolean(description) && !detail.unclaimed,
      profile: detail.profile,
      readmeExcerpt: shortReadmeExcerpt(detail.readmeExcerpt),
      repo: product.repoUrl ? safeExternalUrl(product.repoUrl) : null,
      repoGone: Boolean(product.repoGone),
    },
    media: {
      ogImage: protectedCoverUrl(product.ogImage),
      items: detail.media.map(({ src, width, height, altText, sourceMissing, lastSuccessAt }) => ({ src, width, height, altText, sourceMissing, lastSuccessAt })),
    },
    aside: {
      ownerContact: detail.unclaimed && githubOwnerFromRepositoryUrl(product.repoUrl)
        ? { productId: auth ? product.id : undefined, installable: product.accessMode === "installable", authEnabled: auth, githubEnabled: githubStarEnabled() }
        : null,
      unverified: product.status === "unverified",
    },
  };
}
