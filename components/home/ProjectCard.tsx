import { StarMetric } from "@/components/StarMetric";
import Link from "next/link";
import type { BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectTile } from "@/components/home/ProjectTile";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { HomeCardProduct } from "@/components/home/types";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { ProductActivityRow } from "./ProductActivityRow";
import { IntroductionSource } from "./IntroductionSource";

/**
 * 홈 카드 — 타일 · 이름 · 한 줄 · "분야 · @소유자" / ★ 증가.
 *
 * 미클레임·저장소·관심 수는 방문자에게 뜻이 없어 뺐다(상세에서 밝힌다). 메이커가 신고한 제작 도구만
 * 메타 줄 끝에 붙는다 — 수집기 추정값은 공개 뷰모델에서 이미 null 이다(view.ts toListItem).
 */
export function ProjectCard({ product, saved, onToggleSave }: {
  product: HomeCardProduct;
  saved: boolean;
  onToggleSave: (slug: string) => void;
  browseState: BrowseState;
}) {
  const owner = githubOwnerFromRepositoryUrl(product.repoUrl);
  const maker = owner ? `@${owner.login}` : product.makerName ? `@${product.makerName.replace(/^@/, "")}` : null;

  return (
    <article className="project-card">
      <Link prefetch={false} href={`/p/${product.slug}`} className="card-visual" aria-label={`${product.name} 상세 보기`}>
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={64} installable={product.accessMode === "installable"} />
      </Link>
      <div className="project-body">
        <div className="project-title-row">
          <h3 className="project-title"><Link prefetch={false} href={`/p/${product.slug}`}>{product.name}</Link></h3>
          <button
            type="button"
            className={`cover-saved${saved ? " active" : ""}`}
            aria-label={`${product.name} ${saved ? "저장 취소" : "저장"}`}
            aria-pressed={saved}
            onClick={() => onToggleSave(product.slug)}
          >
            <Icon name="bookmark" size={16} />
          </button>
        </div>
        <p className="project-tagline" title={product.tagline}>{product.tagline}</p>
        <IntroductionSource source={product.taglineSource} />
        <div className="project-bottom">
          <span className="project-meta">
            {categoryLabel(product.category)}
            {maker && (owner ? <> · <a href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title="GitHub 저장소 소유자">{maker}</a></> : <> · {maker}</>)}
            {product.builder && product.builderClaim === "reported" && <> · {product.builder}</>}
            {product.health?.down && <> · <span className="meta-down">응답 없음</span></>}
          </span>
          <StarMetric value={product} />
        </div>
        <ProductActivityRow activity={product.activity} />
      </div>
    </article>
  );
}
