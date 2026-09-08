import { BuilderBadge } from "@/components/TrustBadges";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { SourceBadge } from "./SourceBadge";

function known(value: string) {
  return value !== "미확인" && !value.startsWith("미확인 (");
}

/** Optional, compact development evidence. Empty or guessed provenance has no public section. */
export function BuildProvenance({ product, unclaimed, agents, skills, observedAgentFacts = [] }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  agents: ProductDetailView["agents"];
  skills: ProductDetailView["skills"];
  observedAgentFacts?: ProductDetailView["observedAgentFacts"];
}) {
  const reportedBuilder = unclaimed ? null : product.builder;
  if (!reportedBuilder && agents.length === 0 && skills.length === 0 && observedAgentFacts.length === 0) return null;

  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5">
      <h2 className="text-[16px] font-extrabold text-fg">개발 근거</h2>
      <p className="mt-1.5 text-[13px] leading-6 text-fg-3">
        확인된 신고와 공개 저장소에서 발견한 지침·설정만 표시합니다. 랭킹에는 반영하지 않습니다.
      </p>

      <div className="mt-4 space-y-3">
        {reportedBuilder && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-bg-soft px-3.5 py-3">
            <span className="text-[13px] font-semibold text-fg-2">메이커가 신고한 개발 도구</span>
            <BuilderBadge builder={reportedBuilder} claim="reported" />
          </div>
        )}

        {agents.map((agent) => (
          <article key={agent.id} className="rounded-[10px] bg-bg-soft px-3.5 py-3 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-fg">{[agent.provider, agent.client, agent.model].filter(Boolean).join(" · ")}</strong>
              <SourceBadge label={agent.evidenceLabel} />
            </div>
            {agent.roles.length > 0 && <p className="mt-1.5 leading-5 text-fg-2">역할: {agent.roles.join(" · ")}</p>}
          </article>
        ))}

        {skills.map((skill) => (
          <article key={skill.id} className="rounded-[10px] bg-bg-soft px-3.5 py-3 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="break-all font-mono text-fg">{skill.namespace}/{skill.name}{skill.version ? `@${skill.version}` : ""}</strong>
              <SourceBadge label={skill.evidenceLabel} />
            </div>
            {skill.hash && <p className="mt-1.5 break-all font-mono text-fg-3">hash {skill.hash.slice(0, 16)}…</p>}
          </article>
        ))}

        {observedAgentFacts.map((fact, index) => (
          <article key={`${fact.sourceUrl}:${index}`} className="rounded-[10px] border border-line px-3.5 py-3 text-[13px] leading-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-fg">{fact.sourcePath ?? "커밋 기여 표기"}</strong>
              <SourceBadge label={fact.label} />
            </div>
            {(known(fact.clientLabel) || known(fact.modelLabel) || known(fact.gatewayLabel)) && (
              <p className="mt-1.5 text-fg-2">
                {[known(fact.clientLabel) ? fact.clientLabel : null, known(fact.modelLabel) ? fact.modelLabel : null,
                  known(fact.gatewayLabel) ? fact.gatewayLabel : null].filter(Boolean).join(" · ")}
              </p>
            )}
            {fact.scope && <p className="text-fg-3">적용 경로: {fact.scope}</p>}
            {fact.role && <p className="text-fg-3">설정 역할: {fact.role}</p>}
            {fact.coverageLabel && <p className="text-fg-3">{fact.coverageLabel}</p>}
            {fact.relationshipLabel && <p className="text-fg-3">{fact.relationshipLabel}</p>}
            <a href={fact.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 block break-all text-accent underline">
              공개 근거 · {fact.commitSha.slice(0, 7)} ↗
            </a>
          </article>
        ))}
      </div>

      {observedAgentFacts.length > 0 && (
        <p className="mt-3 text-[13px] leading-5 text-fg-3">
          지침·설정 파일은 발견 사실만 뜻하며 실제 실행 모델이나 전체 제작 과정을 증명하지 않습니다.
        </p>
      )}
    </section>
  );
}
