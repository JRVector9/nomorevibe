import type { LicensePresentation, ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDate, formatNumber, safeExternalUrl } from "./format";
import { SourceBadge } from "./SourceBadge";

function RepoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2.5 text-[13px] last:border-b-0">
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right font-semibold text-fg">{children}</dd>
    </div>
  );
}

function LicenseBlock({ license }: { license: LicensePresentation }) {
  if (license.state === "missing") {
    return <p className="text-[13px] text-fg-3">라이선스 확인 안 됨</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong className={license.state === "conflict" ? "text-down" : "text-fg"}>{license.label}</strong>
        {license.state === "conflict" && <span className="text-[13px] text-down">두 값을 모두 확인하세요</span>}
      </div>
      {license.maker && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-bg-soft px-3 py-2">
          <span>{license.maker.spdxId ?? license.maker.value}</span>
          <SourceBadge label={license.maker.sourceLabel} />
        </div>
      )}
      {license.observed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-bg-soft px-3 py-2">
          <span>{license.observed.spdxId ?? license.observed.value}</span>
          <SourceBadge label={license.observed.sourceLabel} />
        </div>
      )}
    </div>
  );
}

export function RepositoryEvidence({ repository, license }: {
  repository: ProductDetailView["repository"];
  license: ProductDetailView["license"];
}) {
  const facts = repository?.facts;
  const repositoryUrl = safeExternalUrl(facts?.repositoryUrl ?? repository?.sourceUrl ?? null);
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-extrabold text-fg">저장소와 라이선스</h2>
        {facts && <SourceBadge label={repository?.provider === "github" ? "GitHub에서 확인" : "공식 출처에서 확인"} />}
      </div>
      {!repository ? (
        <p className="mt-4 rounded-[10px] bg-bg-soft px-4 py-3 text-[13px] leading-6 text-fg-3">저장소 미제공</p>
      ) : !facts ? (
        <p className="mt-4 rounded-[10px] bg-bg-soft px-4 py-3 text-[13px] leading-6 text-fg-3">저장소 정보를 수집하고 있습니다.</p>
      ) : (
        <dl className="mt-3">
          {repositoryUrl && <RepoRow label="저장소"><a href={repositoryUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{facts.repositoryKey ?? "열기"} ↗</a></RepoRow>}
          <RepoRow label="공개 여부">{facts.public === null ? "확인 안 됨" : facts.public ? "공개 저장소" : "비공개 저장소"}</RepoRow>
          <RepoRow label="저장소 생성일">{formatDate(facts.createdAt)}</RepoRow>
          <RepoRow label="최근 push">{formatDate(facts.pushedAt)}</RepoRow>
          <RepoRow label="stars / forks">★ {formatNumber(facts.stars)} · forks {formatNumber(facts.forks)}</RepoRow>
          <RepoRow label="contributors">{facts.contributors ? `${formatNumber(facts.contributors.count)}명${facts.contributors.incomplete ? "+" : ""}` : "확인 안 됨"}</RepoRow>
          <RepoRow label="상태">{facts.archived ? "보관됨" : facts.fork ? "fork 저장소" : "활성"}</RepoRow>
          {facts.languages.length > 0 && <RepoRow label="주요 언어">{facts.languages.map((item) => `${item.name} ${item.percent}%`).join(" · ")}</RepoRow>}
          <RepoRow label="서비스 연결">{facts.relationshipState === "bidirectional" ? "서비스 ↔ 저장소 연결 확인" : facts.relationshipState === "disconnected" ? "연결 끊김" : "일부 방향만 확인"}</RepoRow>
          <RepoRow label="최신 release">{facts.latestRelease ? <>{facts.latestRelease.tagName} · {formatDate(facts.latestRelease.publishedAt)}</> : "확인 안 됨"}</RepoRow>
        </dl>
      )}
      <div className="mt-5 border-t border-line pt-4 text-[13px] leading-6 text-fg-2">
        <LicenseBlock license={license} />
        <p className="mt-3 text-fg-3">자동 감지는 법률 자문이나 사용 허가를 보증하지 않습니다.</p>
      </div>
    </section>
  );
}
