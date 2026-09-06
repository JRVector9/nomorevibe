import { BuilderBadge } from "@/components/TrustBadges";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { SourceBadge } from "./SourceBadge";

export function BuildProvenance({ product, profile, unclaimed, agents, skills, observedAgentFacts = [] }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  unclaimed: boolean;
  agents: ProductDetailView["agents"];
  skills: ProductDetailView["skills"];
  observedAgentFacts?: ProductDetailView["observedAgentFacts"];
}) {
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5">
      <h2 className="text-[16px] font-extrabold text-fg">어떤 AI로 만들었나</h2>
      <p className="mt-1.5 text-[13px] leading-6 text-fg-3">랭킹에는 반영하지 않는 선택적 제작 provenance입니다.</p>
      {(product.builder || profile?.team.length) ? (
        <div className="mt-4 space-y-3">
          {product.builder && <BuilderBadge builder={product.builder} claim={unclaimed ? "guessed" : "reported"} />}
          {profile?.team.map((member) => (
            <div key={`${member.name}:${member.role}`} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="font-semibold text-fg">{member.name}</span>
              <span className="text-fg-3">{member.role}</span>
            </div>
          ))}
        </div>
      ) : null}
      {observedAgentFacts.length > 0 && <div className="mt-5 space-y-3 border-t border-line pt-4">
        <h3 className="text-[14px] font-bold text-fg">공개 저장소에서 확인한 정보</h3>
        <p className="text-[13px] leading-5 text-fg-3">파일과 설정의 존재를 확인했습니다. 실제 실행 모델이나 전체 제작 과정을 증명하지 않습니다.</p>
        {observedAgentFacts.map((fact, index) => <article key={`${fact.sourceUrl}:${index}`} className="rounded-[10px] bg-bg-soft p-3.5 text-[13px] leading-6">
          <SourceBadge label={fact.label} />
          <dl className="mt-2 text-fg-2"><div><dt className="inline">도구: </dt><dd className="inline">{fact.clientLabel}</dd></div>
            <div><dt className="inline">설정 모델: </dt><dd className="inline">{fact.modelLabel}</dd></div>
            <div><dt className="inline">연결: </dt><dd className="inline">{fact.gatewayLabel}</dd></div></dl>
          {fact.scope && <p>설정 적용 경로: {fact.scope}</p>}
          {fact.role && <p>설정 역할: {fact.role}</p>}
          {fact.coverageLabel && <p className="text-fg-3">{fact.coverageLabel}</p>}
          {fact.relationshipLabel && <p className="text-fg-3">{fact.relationshipLabel}</p>}
          <a href={fact.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline">{fact.sourcePath ?? "커밋 기여 표기"} · {fact.commitSha.slice(0, 7)} ↗</a>
          <p className="text-fg-3">확인: {fact.observedAt.toISOString().slice(0, 10)}</p>
        </article>)}
      </div>}
      <div className="mt-5 space-y-3 border-t border-line pt-4">
        <h3 className="text-[14px] font-bold text-fg">에이전트</h3>
        {agents.length === 0 ? <p className="text-[13px] text-fg-3">공개된 에이전트 정보가 없습니다.</p> : agents.map((agent) => (
          <article key={agent.id} className="rounded-[10px] bg-bg-soft p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-[13px] text-fg">{[agent.provider, agent.client, agent.model].filter(Boolean).join(" · ")}</strong>
              <SourceBadge label={agent.evidenceLabel} />
            </div>
            {agent.roles.length > 0 && <p className="mt-2 text-[13px] leading-5 text-fg-2">역할: {agent.roles.join(" · ")}</p>}
          </article>
        ))}
      </div>
      <div className="mt-5 space-y-3 border-t border-line pt-4">
        <h3 className="text-[14px] font-bold text-fg">사용한 스킬</h3>
        {skills.length === 0 ? <p className="text-[13px] text-fg-3">공개된 스킬 정보가 없습니다.</p> : skills.map((skill) => (
          <article key={skill.id} className="rounded-[10px] bg-bg-soft p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="font-mono text-[13px] text-fg">{skill.namespace}/{skill.name}{skill.version ? `@${skill.version}` : ""}</strong>
              <SourceBadge label={skill.evidenceLabel} />
            </div>
            {skill.hash && <p className="mt-2 break-all font-mono text-[13px] text-fg-3">hash {skill.hash.slice(0, 16)}…</p>}
          </article>
        ))}
        <p className="text-[13px] leading-5 text-fg-3">해시는 동일한 바이트를 가리킬 뿐 저작자를 증명하지 않습니다.</p>
      </div>
    </section>
  );
}
