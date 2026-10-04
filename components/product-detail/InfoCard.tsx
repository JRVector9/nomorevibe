import type { ReactNode } from "react";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { categoryLabel } from "@/lib/domain/products/labels";
import { formatDate, safeExternalUrl } from "./format";

const RELATIONSHIP = {
  bidirectional: "서비스 ↔ 저장소 연결 확인",
  site_link: "서비스 → 저장소 링크 확인",
  repository_link: "저장소 → 서비스 링크 확인",
  maker_reported: "메이커 제공 · 관계 미확인",
  disconnected: "연결 끊김",
} as const;

const LINK = "text-accent-ink hover:underline";

function Row({ label, children, sub }: { label: string; children: ReactNode; sub?: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-line py-2.5 text-[13px]">
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-medium text-fg wrap-anywhere">
        {children}
        {sub && <span className="block text-[13px] font-normal text-fg-3">{sub}</span>}
      </dd>
    </div>
  );
}

/** 마지막 확인이 어디서 왔는지 — 저장소는 GitHub, 공식 사이트 지문은 공개 페이지, 그 밖의 출처는 공개 링크 */
function checkedFrom(freshness: ProductDetailView["freshness"]): string | undefined {
  const names = freshness.filter((item) => item.lastSuccessAt !== null)
    .map((item) => item.provider === "github" ? "GitHub" : item.provider === "product_site" ? "공개 페이지" : "공개 링크");
  return [...new Set(names)].join(" · ") || undefined;
}

/** 정보 카드 하나 — 객관적 정보·저장소 사실·갱신 상태에 흩어졌던 것을 여덟 줄로 */
export function InfoCard({ product, repository, freshness, unclaimed }: {
  product: ProductDetailView["product"];
  repository: ProductDetailView["repository"];
  freshness: ProductDetailView["freshness"];
  unclaimed: boolean;
}) {
  const facts = repository?.facts ?? null;
  const owner = githubOwnerFromRepositoryUrl(product.repoUrl);
  const repoUrl = safeExternalUrl(facts?.repositoryUrl ?? product.repoUrl ?? null);
  const installable = product.accessMode === "installable";
  const site = installable ? null : safeExternalUrl(product.url);
  const displayUrl = product.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const lastChecked = freshness.map((item) => item.lastSuccessAt).filter((at): at is Date => at !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  // 공개·보관·fork 는 값을 읽었을 때만 말한다 — 보관·fork 를 둘 다 확인해야 '활성'(FactsStrip 과 같은 규칙)
  const visibility = facts?.public === true ? "공개" : facts?.public === false ? "비공개" : null;
  const activity = !facts ? null : facts.archived === true ? "보관됨" : facts.fork === true ? "fork"
    : facts.archived === false && facts.fork === false ? "활성" : "상태 미확인";

  return (
    <section aria-labelledby="info-title" className="rounded-[18px] bg-bg-soft px-5 pb-1.5 pt-[18px]">
      <h2 id="info-title" className="m-0 mb-0.5 text-[13px] font-semibold tracking-[0.02em] text-fg-3">정보</h2>
      <dl className="m-0">
        {owner
          ? <Row label="운영 주체" sub="GitHub 저장소 소유자"><a href={owner.profileUrl} target="_blank" rel="noopener noreferrer" className={LINK}>@{owner.login} ↗</a></Row>
          : product.makerName && <Row label="메이커" sub={unclaimed ? "우리 추정" : "신고값"}>{product.makerName}</Row>}
        {site && <Row label="웹사이트"><a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className={LINK}>{displayUrl} ↗</a></Row>}
        {repoUrl && (
          <Row label="저장소" sub={facts ? [visibility, activity].filter(Boolean).join(" · ") : undefined}>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer" className={LINK}>{facts?.repositoryKey ?? "열기"} ↗</a>
          </Row>
        )}
        {installable && <Row label="웹사이트"><span className="font-normal text-fg-3">없음 · 저장소가 제품 페이지</span></Row>}
        {facts && <Row label="서비스 연결">{facts.relationshipState ? RELATIONSHIP[facts.relationshipState] : "관계 미확인"}</Row>}
        <Row label="분야">{categoryLabel(product.category)}</Row>
        <Row label="이용 방식">{installable ? "직접 설치" : "웹사이트"}</Row>
        {product.stack.length > 0 && <Row label="기술 스택">{product.stack.join(" · ")}</Row>}
        <Row label="마지막 확인" sub={checkedFrom(freshness)}>{lastChecked ? formatDate(lastChecked) : "확인 전"}</Row>
      </dl>
    </section>
  );
}
