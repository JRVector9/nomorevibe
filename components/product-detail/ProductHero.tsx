import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { ProductTagline } from "@/components/ProductTagline";
import { UNCLAIMED_HINT, UNCLAIMED_LABEL } from "@/lib/copy/terms";
import type { TaglineSource } from "@/lib/db/schema";
import { formatCount } from "@/lib/format/number";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { repositoryOperator } from "@/lib/domain/products/github-owner";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { categoryLabel } from "@/lib/domain/products/labels";
import { InstallPrompt } from "./InstallPrompt";
import { SaveButton } from "./SaveButton";
import { ShareButton } from "./ShareButton";

/** 홈 '지금 뜨는'과 같은 순위 — 20위 안일 때만 배지 */
const RISING_BADGE_MAX = 20;

/** 메이커가 쓴 소개가 없어 우리가 채운 줄 — 누가 무엇을 보고 적었는지 */
const TAGLINE_SOURCE_LABELS: Record<Exclude<TaglineSource, "maker">, string> = {
  ai_page: "AI가 요약 · 페이지 글에서",
  ai_readme: "AI가 요약 · README에서",
  ai_both: "AI가 요약 · 페이지와 README에서",
  ai_fixed: "AI가 요약 · 검수에서 고쳐 썼습니다",
  editor: "직접 요약 · 페이지를 보고 적었습니다",
};

/** 단추 — 모바일(390px)에서 네 개가 한 줄에 들도록 좁은 화면은 글자·여백을 조금 줄인다 */
const BUTTON = "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-[14px] font-medium sm:px-5 sm:text-[15px]";

/** 응답 시간은 용어가 아니라 자리의 문제 — 툴팁으로만(UX-14) */
const latencyTitle = (health: ProductDetailView["health"]) => health.latencyMs === null ? undefined : `응답 시간 ${health.latencyMs}ms`;

/** 오래된 확인은 온라인이라 하지 않고, 한 번 실패는 연속 실패 기준(down) 전까지 '불안정'이라 하지 않는다 */
function HealthStatus({ health }: { health: ProductDetailView["health"] }) {
  if (!health.checkedAt) return <span>가동 상태 확인 전</span>;
  if (!isHealthCurrent(health.checkedAt)) return <span>가동 상태 재확인 필요</span>;
  if (health.down) return <span className="text-down">접속 불안정</span>;
  if (health.lastCheckSucceeded === false) return <span className="text-down">최근 접속 확인 실패</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={latencyTitle(health)}>
      <i aria-hidden className="inline-block h-2 w-2 rounded-full bg-up" />
      온라인
    </span>
  );
}

/**
 * 상세 머리 — 아이콘 80 · 이름 40 · 한 줄 소개 20 · 메타 한 줄 · 버튼.
 *
 * 큰 이미지는 두지 않는다: 공개 제품의 54%는 256px 아이콘뿐이고 스크린샷은 0이다(2026-10-02).
 * 넓은 이미지가 있으면 오른쪽 열의 PreviewFigure 가 작게 보여 준다.
 *
 * 단추는 [제품 방문하기][GitHub][공유][저장] 넷이다(UX-31). 같은 사이트로 가는 도메인 글자 링크는 뺐다 —
 * 사이트 주소는 정보 카드의 '웹사이트' 줄이 보여 준다.
 */
export function ProductHero({ product, unclaimed, risingRank, health, languages, repositoryUrl = null }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  risingRank: number | null;
  health: ProductDetailView["health"];
  /** 저장소 언어 상위 둘 — RepositoryFacts.languages 에서 */
  languages: string[];
  /** GitHub 이 알려 준 저장소의 정식 주소(RepositoryFacts.repositoryUrl) — 운영 주체를 지금 주인으로 정한다(UX-15) */
  repositoryUrl?: string | null;
}) {
  const owner = repositoryOperator(product.repoUrl, repositoryUrl)?.owner ?? null;
  const installable = product.accessMode === "installable";
  const safeIcon = product.ogImage?.startsWith("/") ? product.ogImage : null;

  return (
    <section className="border-b border-line pb-7 pt-6">
      <div className="flex flex-wrap items-start gap-[22px]">
        <div className="shrink-0 overflow-hidden rounded-[18px] border border-line bg-bg-soft [&_img]:rounded-none [&_img]:border-0">
          <ProductIcon name={product.name} ogImage={safeIcon} size={80} />
        </div>
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">{product.name}</h1>
            {risingRank !== null && risingRank <= RISING_BADGE_MAX && (
              <Link prefetch={false} href="/#rising" className="inline-flex h-7 items-center rounded-full bg-accent-soft px-[11px] text-[13px] font-semibold text-accent-ink">
                지금 뜨는 {risingRank}위
              </Link>
            )}
          </div>
          {/* 한 줄 소개는 공용 부품으로만 그린다(C2). 출처 줄은 아래 — 편집자가 쓴 줄('직접 요약')까지 밝히는 상세의 목록을 쓴다 */}
          <ProductTagline tagline={product.tagline} source={product.taglineSource} showSource={false}
            className="max-w-[720px] text-[20px] leading-[1.35] tracking-[-0.01em] text-fg" />
          {/* 지은 줄은 무엇을 보고 지었는지까지 밝힌다 — 메이커가 소개를 쓰면 이 표시는 사라진다 */}
          {product.taglineSource !== "maker" && (
            <p className="text-[13px] text-fg-2">{TAGLINE_SOURCE_LABELS[product.taglineSource]}</p>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-fg-2 tabular-nums">
            <span className="text-fg">{categoryLabel(product.category)}</span>
            {product.stars !== null && product.stars !== undefined && <><span aria-hidden>·</span><span className="font-medium text-fg">★ {formatCount(product.stars)}</span></>}
            {languages.length > 0 && <><span aria-hidden>·</span><span>{languages.join(" · ")}</span></>}
            {owner && <><span aria-hidden>·</span><span>GitHub @{owner.login}</span></>}
            <span aria-hidden>·</span>
            {installable ? <span>직접 설치</span> : <HealthStatus health={health} />}
            {unclaimed && <><span aria-hidden>·</span><span title={UNCLAIMED_HINT}>{UNCLAIMED_LABEL}</span></>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* 저장소가 사라졌다고 확정되면(repoGone) 열리지 않는 저장소로 보내거나 설치하라고 하지 않는다 */}
            {installable && product.repoGone ? (
              <span className={`${BUTTON} bg-bg-soft text-down`}>저장소가 사라졌습니다</span>
            ) : installable ? (
              <>
                <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className={`${BUTTON} bg-accent-solid text-white hover:opacity-90`}>GitHub 저장소 열기</a>
                <InstallPrompt repoUrl={product.repoUrl ?? product.url} />
              </>
            ) : (
              <>
                <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className={`${BUTTON} bg-accent-solid text-white hover:opacity-90`}>제품 방문하기</a>
                {product.repoUrl && !product.repoGone && <a href={product.repoUrl} target="_blank" rel="noopener noreferrer" aria-label="GitHub 저장소" className={`${BUTTON} bg-bg-soft text-fg`}>GitHub</a>}
              </>
            )}
            <ShareButton title={product.name} path={`/p/${product.slug}`} />
            <SaveButton slug={product.slug} name={product.name} />
          </div>
          {product.repoGone && (
            <p className="text-[13px] text-fg-2">
              {installable
                ? "GitHub 저장소가 사라졌습니다(삭제 또는 비공개). 지금은 설치할 수 없어 목록에서 가렸습니다."
                : "GitHub 저장소가 사라졌습니다(삭제 또는 비공개)."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
