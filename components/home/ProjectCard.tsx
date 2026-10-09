import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StarMetric } from "@/components/StarMetric";
import type { BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectTile } from "@/components/home/ProjectTile";
import type { HomeCardProduct } from "@/components/home/types";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { TimeInput } from "@/lib/format/time";
import { ProductActivityRow } from "./ProductActivityRow";
import "./cards.css";

/**
 * 홈 카드 — 타일 · 이름 · @소유자 · 한 줄 소개 · 메타 한 줄("분야 · 최근 업데이트 n일 전" / ★ 증가).
 *
 * 카드 하나가 링크 하나다(UX-30): 제목 링크가 ::after 로 카드 전체를 덮고, 커버 링크는 탭·읽기 도구에서 뺀다.
 * 저장 버튼과 소유자 링크만 그 위에 올려 따로 누른다.
 * 미클레임·저장소·관심 수는 방문자에게 뜻이 없어 뺐다(상세에서 밝힌다). 메이커가 신고한 제작 도구만
 * 소유자 옆에 붙는다 — 수집기 추정값은 공개 뷰모델에서 이미 null 이다(view.ts toListItem).
 */
export function ProjectCard({ product, saved, onToggleSave, now }: {
  product: HomeCardProduct & { listedAt?: TimeInput };
  saved: boolean;
  onToggleSave: (slug: string) => void;
  browseState: BrowseState;
  /** 서버가 읽은 시각 — 넘기면 서버와 브라우저가 같은 'n일 전'을 그린다. 없으면 지금 */
  now?: Date | string | number;
}) {
  const owner = githubOwnerFromRepositoryUrl(product.repoUrl);
  const maker = owner ? `@${owner.login}` : product.makerName ? `@${product.makerName.replace(/^@/, "")}` : null;
  const builder = product.builder && product.builderClaim === "reported" ? product.builder : null;
  const at = now ?? new Date();
  const href = `/p/${product.slug}`;

  return (
    <article className="project-card">
      <Link prefetch={false} href={href} className="card-visual" tabIndex={-1} aria-hidden="true">
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={64} installable={product.accessMode === "installable"} category={product.category} />
      </Link>
      <div className="project-body">
        <div className="project-title-row">
          <h3 className="project-title"><Link prefetch={false} href={href} className="card-link">{product.name}</Link></h3>
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
        {(maker || builder) && (
          <p className="card-byline card-dots">
            {maker && (owner
              ? <a className="card-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title="GitHub 저장소 소유자"><span>{maker}</span></a>
              : <span>{maker}</span>)}
            {builder && <span>{builder}</span>}
          </p>
        )}
        <ProductTagline tagline={product.tagline} source={product.taglineSource} className="project-tagline" />
        <div className="card-meta">
          {/* 조각 사이 '·'는 CSS 가 넣는다(card-dots) — 빠진 조각 옆에 점만 남지 않게 */}
          <span className="card-meta-text card-dots">
            <span>{categoryLabel(product.category)}</span>
            <ProductActivityRow activity={product.activity} now={at} />
            {product.health?.down && <span className="meta-down">응답 없음</span>}
          </span>
          <StarMetric value={product} now={at} listedAt={product.listedAt} />
        </div>
      </div>
    </article>
  );
}
