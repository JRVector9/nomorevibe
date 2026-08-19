import { BuilderBadge } from "@/components/TrustBadges";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { SourceBadge } from "./SourceBadge";

export function BuildProvenance({ product, profile, unclaimed, agents, skills }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  unclaimed: boolean;
  agents: ProductDetailView["agents"];
  skills: ProductDetailView["skills"];
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
