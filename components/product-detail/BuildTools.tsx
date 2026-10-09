import { BuilderBadge } from "@/components/TrustBadges";
import { AI_LEVEL_LABELS } from "@/lib/domain/evidence/ai-level-labels";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";

const CHIP = "inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 text-[14px] text-fg";

/** '미확인'·'미확인 (…)' 이 아니면 아는 값 — 예전 개발 근거 구획과 같은 규칙 */
const known = (value: string) => value !== "미확인" && !value.startsWith("미확인 (");

/**
 * 무엇으로 만들었나 — 홈의 같은 이름 구획과 짝. 알약 하나가 도구 하나, 그 옆에 근거 링크.
 * 흔적은 사용 주장이지 실행 증명이 아니다 — 문구에 '흔적'을 남긴다.
 *
 * 여기서 말하는 것은 'AI 흔적 검사'(저장소 파일·커밋 서명 조사)다. 정보 카드의 '정보 갱신'(GitHub 에서 사실을 읽음)과
 * 다른 일이라 '확인'이라는 한 낱말로 둘을 부르지 않는다(UX-16) — 정보는 갱신됐는데 검사는 아직일 수 있다.
 *
 * 검사 결과는 AI 제작 근거 단계(1~3) 이름과 설명만 쓴다 — PR·커밋·파일 링크와 도구 목록은 내지 않는다(2026-10-10 운영자 결정 D3).
 * 예전 조사의 흔적 알약(observedAgentFacts)은 agentEvidence.displayObservedFacts 가 켜졌을 때만 들어온다.
 */
export function BuildTools({ product, unclaimed, agents, observedAgentFacts, skills, aiLevel }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  agents: ProductDetailView["agents"];
  observedAgentFacts: ProductDetailView["observedAgentFacts"];
  skills: ProductDetailView["skills"];
  aiLevel: ProductDetailView["aiLevel"];
}) {
  const reported = unclaimed ? null : product.builder;
  // 같은 도구의 흔적은 알약 하나로 — 이름을 모르는 공유 형식(AGENTS.md 등)은 한데 묶는다
  const observed = new Map<string, ProductDetailView["observedAgentFacts"]>();
  for (const fact of observedAgentFacts) {
    const key = fact.clientLabel.startsWith("미확인") ? "미확인 도구" : fact.clientLabel;
    observed.set(key, [...(observed.get(key) ?? []), fact]);
  }
  const nothing = !reported && agents.length === 0 && skills.length === 0 && observed.size === 0;
  // 검사는 GitHub 저장소에만 한다 — 저장소가 없거나 사라졌으면 '대기 중'이 아니라 검사할 수 없다
  const scannable = githubOwnerFromRepositoryUrl(product.repoUrl) !== null && !product.repoGone;
  const level = scannable && aiLevel.checked ? aiLevel.level : null;
  // 검사했지만 1~3단계 근거가 없다 — 흔적 알약이 보이는 동안은 그 말과 어긋나 쓰지 않는다
  const noTrace = scannable && aiLevel.checked && level === null && observed.size === 0;
  // 수집 범위와 제품·저장소 관계 — 어느 흔적에든 붙어 있으면 첫 것 하나씩 한 줄로
  const notes = [
    observedAgentFacts.find((fact) => fact.coverageLabel)?.coverageLabel,
    observedAgentFacts.find((fact) => fact.relationshipLabel)?.relationshipLabel,
  ].filter(Boolean);

  return (
    <section aria-labelledby="tools-title" className="flex flex-col gap-2.5">
      <h2 id="tools-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">무엇으로 만들었나</h2>
      {!nothing && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {/* 배지가 이미 '메이커 신고'를 달고 있어 알약을 한 겹 더 씌우지 않는다 */}
          {reported && <li className="inline-flex h-10 items-center"><BuilderBadge builder={reported} claim="reported" /></li>}
          {agents.map((agent) => (
            <li key={agent.id} className={CHIP}>
              {[agent.provider, agent.client, agent.model].filter(Boolean).join(" · ")}
              <span className="text-[13px] text-fg-2">{agent.evidenceLabel}</span>
            </li>
          ))}
          {[...observed].map(([label, facts]) => (
            <li key={label} className={CHIP}>
              {/* 모델은 도구만큼 궁금한 값 — 흔적 중 하나라도 이름을 알면 도구 뒤에 */}
              {[label, facts.map((fact) => fact.modelLabel).find(known)].filter(Boolean).join(" · ")}
              <span className="text-[13px] text-fg-2">{facts[0].label}</span>
              <a href={facts[0].sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[13px] text-accent-ink hover:underline"
                aria-label={`${label} 근거 ${facts[0].commitSha.slice(0, 7)}`}>근거 {facts[0].commitSha.slice(0, 7)} ↗</a>
              {facts.length > 1 && <span className="text-[13px] text-fg-2">외 {facts.length - 1}</span>}
            </li>
          ))}
          {skills.map((skill) => (
            <li key={skill.id} className="inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 font-mono text-[13px] text-fg">
              {skill.namespace}/{skill.name}{skill.version ? `@${skill.version}` : ""}
              <span className="font-sans text-[13px] text-fg-2">{skill.evidenceLabel}</span>
            </li>
          ))}
        </ul>
      )}
      {level ? (
        <div className="flex max-w-[720px] flex-col gap-1">
          <p className="m-0 text-[14px] font-semibold leading-[1.5] text-fg">AI 제작 근거 {level}단계 · {AI_LEVEL_LABELS[level].title}</p>
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2">{AI_LEVEL_LABELS[level].description}</p>
        </div>
      ) : noTrace ? (
        <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">검사에서 AI 코딩 도구 흔적을 찾지 못했습니다 — AI 없이 만들었다는 뜻은 아닙니다.</p>
      ) : nothing && (
        <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">
          {scannable
            ? "AI 흔적 검사 대기 중 — 검사가 끝나면 저장소의 설정 파일과 커밋 서명에서 찾은 AI 코딩 도구 흔적이 여기에 보입니다."
            : `${product.repoGone ? "GitHub 저장소가 사라져" : "공개 GitHub 저장소가 없어"} AI 흔적 검사를 할 수 없습니다. 메이커가 신고하면 여기에 표시됩니다.`}
        </p>
      )}
      {observed.size > 0 && notes.length > 0 && <p className="m-0 text-[13px] text-fg-2">{notes.join(" · ")}</p>}
    </section>
  );
}
