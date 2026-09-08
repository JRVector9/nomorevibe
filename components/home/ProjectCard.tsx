import Link from "next/link";
import { hrefWith, type BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectCover, coverArtFor } from "@/components/home/ProjectCover";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { HomeCardProduct } from "@/components/home/types";

function interestCount(product: HomeCardProduct): number {
  if (typeof product.validClicks === "number") return product.validClicks;
  return product.metrics?.clicks ?? 0;
}

function makerLabel(product: HomeCardProduct): string {
  if (product.makerName) return product.makerName;
  if (product.unclaimed) return "미클레임";
  return product.slug;
}

export function ProjectCard({
  product,
  saved,
  onToggleSave,
  browseState,
}: {
  product: HomeCardProduct;
  saved: boolean;
  onToggleSave: (slug: string) => void;
  browseState: BrowseState;
}) {
  const hasRepository = Boolean(product.repoUrl);
  const interest = interestCount(product);
  const initial = makerLabel(product).replace(/^@/, "").slice(0, 1).toUpperCase();

  return (
    <article className="project-card">
      <div className="card-visual">
        <Link
          href={`/p/${product.slug}`}
          className="cover-open"
          aria-label={`${product.name} 상세 보기`}
        >
          <ProjectCover name={product.name} ogImage={product.ogImage} art={coverArtFor(product.slug)} />
        </Link>
        <button
          type="button"
          className={`cover-saved${saved ? " active" : ""}`}
          aria-label={`${product.name} ${saved ? "저장 취소" : "저장"}`}
          aria-pressed={saved}
          onClick={() => onToggleSave(product.slug)}
        >
          <Icon name="bookmark" size={14} />
        </button>
      </div>
      <div className="project-body">
        <div className="project-title-row">
          <h3 className="project-title">
            <Link href={`/p/${product.slug}`} className="title-open">{product.name}</Link>
          </h3>
          {hasRepository && <span className="tiny-tag">저장소</span>}
          {product.unclaimed && <span className="tiny-tag tiny-tag-muted">미클레임</span>}
        </div>
        <p className="project-tagline" title={product.tagline}>{product.tagline}</p>
        <div className="project-tags">
          <Link className="pill" href={hrefWith(browseState, { category: product.category, sort: "recent" })}>
            {categoryLabel(product.category)}
          </Link>
          {product.builder && product.builderClaim === "reported" && (
            <Link
              className="pill tool"
              href={hrefWith(browseState, { builder: product.builder, sort: "recent" })}
              title="제작자 등록 정보"
            >
              {product.builder}
            </Link>
          )}
          {product.health?.down && <span className="pill pill-down">응답 없음</span>}
        </div>
        <div className="project-bottom">
          <span className="maker">
            <span className="avatar" aria-hidden="true">{initial}</span>
            {product.makerName ? `@${product.makerName.replace(/^@/, "")}` : makerLabel(product)}
          </span>
          <div className="card-actions">
            <span className="save-count" title="이 브라우저에 저장">
              <Icon name="bookmark" size={11} />
              {saved ? "저장됨" : "저장"}
            </span>
            <span className="vote" title="NoMoreVibe를 통한 관심">
              <Icon name="up" size={12} />
              {interest}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
