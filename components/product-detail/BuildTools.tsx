import { BuilderBadge } from "@/components/TrustBadges";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

const CHIP = "inline-flex min-h-11 flex-wrap items-center gap-2 rounded-full bg-bg-soft px-3.5 text-[14px] text-fg";

/** '미확인'·'미확인 (…)' 이 아니면 아는 값 — 예전 개발 근거 구획과 같은 규칙 */
const known = (value: string) => Boolean(value.trim()) && !value.startsWith("미확인");

/**
 * 무엇으로 만들었나 — 홈의 같은 이름 구획과 짝. 알약 하나가 도구 하나, 그 옆에 근거 링크.
 * 개발 기여 표기도 사용 주장이지 실행 증명이 아니다 — 근거의 종류를 그대로 밝힌다.
 */
export function BuildTools({ product, unclaimed, agents, observedAgentFacts, skills }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  agents: ProductDetailView["agents"];
  observedAgentFacts: ProductDetailView["observedAgentFacts"];
  skills: ProductDetailView["skills"];
  toolScan: ProductDetailView["toolScan"];
}) {
  const reported = !unclaimed && product.builder && known(product.builder) ? product.builder : null;
  const identifiedAgents = agents.filter((agent) => [agent.provider, agent.client, agent.model].some((value) => value && known(value)));
  // 설정·지침 파일만으로 제작 도구를 단정하지 않는다. 개발 기여 근거가 있는 도구만 묶는다.
  const attributed = observedAgentFacts.filter((fact) => fact.developmentAttributed);
  const observed = new Map<string, ProductDetailView["observedAgentFacts"]>();
  for (const fact of attributed) {
    const key = fact.clientLabel;
    observed.set(key, [...(observed.get(key) ?? []), fact]);
  }
  if (!reported && identifiedAgents.length === 0 && observed.size === 0) return null;
  // 수집 범위와 제품·저장소 관계 — 어느 흔적에든 붙어 있으면 첫 것 하나씩 한 줄로
  const notes = [
    attributed.find((fact) => fact.coverageLabel)?.coverageLabel,
    attributed.find((fact) => fact.relationshipLabel)?.relationshipLabel,
  ].filter(Boolean);

  return (
    <section aria-labelledby="tools-title" className="flex flex-col gap-2.5">
      <h2 id="tools-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-3">무엇으로 만들었나</h2>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {/* 배지가 이미 '메이커 신고'를 달고 있어 알약을 한 겹 더 씌우지 않는다 */}
          {reported && <li className="inline-flex h-10 items-center"><BuilderBadge builder={reported} claim="reported" /></li>}
          {identifiedAgents.map((agent) => (
            <li key={agent.id} className={CHIP}>
              {[agent.provider, agent.client, agent.model].filter((value) => value && known(value)).join(" · ")}
              <span className="text-[13px] text-fg-3">{agent.evidenceLabel}</span>
            </li>
          ))}
          {[...observed].map(([label, facts]) => (
            <li key={label} className={CHIP}>
              {/* 모델은 도구만큼 궁금한 값 — 흔적 중 하나라도 이름을 알면 도구 뒤에 */}
              {[label, facts.map((fact) => fact.modelLabel).find(known)].filter(Boolean).join(" · ")}
              <span className="text-[13px] text-fg-3">{facts[0].label}</span>
              <a href={facts[0].sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[13px] text-accent-ink hover:underline"
                aria-label={`${label} 근거 ${facts[0].commitSha.slice(0, 7)}`}>근거 {facts[0].commitSha.slice(0, 7)} ↗</a>
              {facts.length > 1 && <span className="text-[13px] text-fg-3">외 {facts.length - 1}</span>}
            </li>
          ))}
          {skills.map((skill) => (
            <li key={skill.id} className="inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 font-mono text-[13px] text-fg">
              {skill.namespace}/{skill.name}{skill.version ? `@${skill.version}` : ""}
              <span className="font-sans text-[13px] text-fg-3">{skill.evidenceLabel}</span>
            </li>
          ))}
        </ul>
      {observed.size > 0 && notes.length > 0 && <p className="m-0 text-[13px] text-fg-3">{notes.join(" · ")}</p>}
    </section>
  );
}
