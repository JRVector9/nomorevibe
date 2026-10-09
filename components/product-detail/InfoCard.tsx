import type { ReactNode } from "react";
import { SITE_REPO_RELATION, SITE_REPO_RELATION_LABEL } from "@/lib/copy/terms";
import { formatPublicDate } from "@/lib/format/time";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { repositoryOperator } from "@/lib/domain/products/github-owner";
import { categoryLabel } from "@/lib/domain/products/labels";
import { safeExternalUrl } from "./format";

const LINK = "text-accent-ink hover:underline";

function Row({ label, children, sub }: { label: string; children: ReactNode; sub?: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-line py-2.5 text-[13px]">
      <dt className="shrink-0 text-fg-2">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-medium text-fg wrap-anywhere">
        {children}
        {sub && <span className="block text-[13px] font-normal text-fg-2">{sub}</span>}
      </dd>
    </div>
  );
}

/** 공개 정보를 어디서 읽었는지 — 저장소는 GitHub, 공식 사이트 지문은 공개 페이지, 그 밖의 출처는 공개 링크 */
function checkedFrom(freshness: ProductDetailView["freshness"]): string | undefined {
  const names = freshness.filter((item) => item.lastSuccessAt !== null)
    .map((item) => item.provider === "github" ? "GitHub" : item.provider === "product_site" ? "공개 페이지" : "공개 링크");
  return [...new Set(names)].join(" · ") || undefined;
}

/**
 * 정보 카드 하나 — 객관적 정보·저장소 사실·갱신 상태에 흩어졌던 것을 여덟 줄로.
 *
 * 운영 주체는 GitHub 이 지금 이 저장소의 주인이라고 답한 계정이다(UX-15) — 등록한 저장소 주소가 옮기기 전 주소면
 * 그 계정은 '주요 기여자'로 따로 적는다(github-owner.ts repositoryOperator).
 * '정보 갱신'은 GitHub·공개 페이지에서 사실을 읽은 때다 — AI 흔적 검사('무엇으로 만들었나')와는 다른 일이다(UX-16).
 */
export function InfoCard({ product, repository, freshness, unclaimed }: {
  product: ProductDetailView["product"];
  repository: ProductDetailView["repository"];
  freshness: ProductDetailView["freshness"];
  unclaimed: boolean;
}) {
  const now = new Date();
  const facts = repository?.facts ?? null;
  const operator = repositoryOperator(product.repoUrl, facts?.repositoryUrl);
  const repoUrl = safeExternalUrl(facts?.repositoryUrl ?? product.repoUrl ?? null);
  const installable = product.accessMode === "installable";
  const site = installable ? null : safeExternalUrl(product.url);
  const displayUrl = product.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const lastRead = freshness.map((item) => item.lastSuccessAt).filter((at): at is Date => at !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  // 공개·보관·fork 는 값을 읽었을 때만 말한다 — 보관·fork 를 둘 다 확인해야 '활성'(FactsStrip 과 같은 규칙)
  const visibility = facts?.public === true ? "공개" : facts?.public === false ? "비공개" : null;
  const activity = !facts ? null : facts.archived === true ? "보관됨" : facts.fork === true ? "fork"
    : facts.archived === false && facts.fork === false ? "활성" : "상태 미확인";

  return (
    <section aria-labelledby="info-title" className="rounded-[18px] bg-bg-soft px-5 pb-1.5 pt-[18px]">
      <h2 id="info-title" className="m-0 mb-0.5 text-[13px] font-semibold tracking-[0.02em] text-fg-2">정보</h2>
      <dl className="m-0">
        {operator
          ? <Row label="운영 주체" sub="GitHub 저장소 소유자"><a href={operator.owner.profileUrl} target="_blank" rel="noopener noreferrer" className={LINK}>@{operator.owner.login} ↗</a></Row>
          : product.makerName && <Row label="메이커" sub={unclaimed ? "우리 추정" : "신고값"}>{product.makerName}</Row>}
        {operator?.contributor && (
          <Row label="주요 기여자" sub="이전 저장소 주소의 계정">
            <a href={operator.contributor.profileUrl} target="_blank" rel="noopener noreferrer" className={LINK}>@{operator.contributor.login} ↗</a>
          </Row>
        )}
        {site && <Row label="웹사이트"><a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className={LINK}>{displayUrl} ↗</a></Row>}
        {/* 사라졌다고 확정된 저장소(repoGone)로는 링크를 걸지 않는다 */}
        {repoUrl && product.repoGone && (
          <Row label="저장소"><span className="font-normal text-fg-2">사라짐 · 삭제 또는 비공개</span></Row>
        )}
        {repoUrl && !product.repoGone && (
          <Row label="저장소" sub={facts ? [visibility, activity].filter(Boolean).join(" · ") : undefined}>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer" className={LINK}>{facts?.repositoryKey ?? "열기"} ↗</a>
          </Row>
        )}
        {installable && <Row label="웹사이트"><span className="font-normal text-fg-2">없음 · 저장소가 제품 페이지</span></Row>}
        {/* 누가 누구의 주소를 적어 두었는지 읽었을 때만 */}
        {facts?.relationshipState && <Row label={SITE_REPO_RELATION_LABEL}>{SITE_REPO_RELATION[facts.relationshipState]}</Row>}
        <Row label="분야">{categoryLabel(product.category)}</Row>
        <Row label="이용 방식">{installable ? "직접 설치" : "웹사이트"}</Row>
        {product.stack.length > 0 && <Row label="기술 스택">{product.stack.join(" · ")}</Row>}
        {lastRead && <Row label="정보 갱신" sub={checkedFrom(freshness)}>{formatPublicDate(lastRead, now)}</Row>}
      </dl>
    </section>
  );
}
