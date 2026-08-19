import { Tag } from "@/components/Tag";
import type { ProductDetailView, ProductLinkView } from "@/lib/domain/products/detail-view";
import { formatDate, safeExternalUrl } from "./format";
import { SourceBadge } from "./SourceBadge";

const LINK_LABELS: Record<ProductLinkView["kind"], string> = {
  repository: "GitHub 저장소",
  app_store: "App Store",
  play_store: "Play Store",
  npm: "npm",
  pypi: "PyPI",
  crates: "crates.io",
  documentation: "문서",
  support: "지원",
  rss: "RSS",
  changelog: "Changelog",
  video: "영상",
};

const PRICING_LABELS = {
  free: "무료",
  freemium: "부분 유료",
  paid: "유료",
  open_source: "오픈소스",
  contact: "문의",
  unknown: "확인 안 됨",
} as const;

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3 border-b border-line py-3 last:border-b-0">
      <dt className="text-[13px] text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] font-semibold leading-5 text-fg">{children}</dd>
    </div>
  );
}

export function ProductFacts({ product, profile, links, unclaimed }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  links: ProductDetailView["links"];
  unclaimed: boolean;
}) {
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5">
      <h2 className="text-[16px] font-extrabold text-fg">객관적 정보</h2>
      <dl className="mt-3">
        {product.makerName && <FactRow label="메이커">{product.makerName} <span className="font-normal text-fg-3">· {unclaimed ? "우리 추정" : "신고값"}</span></FactRow>}
        <FactRow label="등록일">{formatDate(product.createdAt)}</FactRow>
        <FactRow label="카테고리">{product.category}</FactRow>
        {profile && <FactRow label="가격">{PRICING_LABELS[profile.pricingModel]}</FactRow>}
        {profile?.platforms.length ? <FactRow label="플랫폼"><span className="flex flex-wrap justify-end gap-1">{profile.platforms.map((item) => <Tag key={item}>{item}</Tag>)}</span></FactRow> : null}
        {product.stack.length ? <FactRow label="기술 스택"><span className="flex flex-wrap justify-end gap-1">{product.stack.map((item) => <Tag key={item}>{item}</Tag>)}</span></FactRow> : null}
      </dl>
      {links.length > 0 ? (
        <div className="mt-5 space-y-2.5 border-t border-line pt-4">
          {links.map((link) => {
            const href = safeExternalUrl(link.url);
            if (!href) return null;
            return (
              <a
                key={link.id}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-[10px] border border-line px-3.5 py-3 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="flex items-center justify-between gap-2 text-[13px] font-bold text-fg">
                  {LINK_LABELS[link.kind]} <span aria-hidden>↗</span>
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <SourceBadge label={link.evidenceLabel} />
                  <span className="text-[13px] text-fg-3">
                    {link.verifiedAt ? `${formatDate(link.verifiedAt)} 확인` : "확인 대기"}
                  </span>
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 rounded-[10px] bg-bg-soft px-4 py-3 text-[13px] leading-6 text-fg-3">연결된 공식 링크가 없습니다.</p>
      )}
    </section>
  );
}
