import type { ModelEnv } from "@/lib/operations/pipeline-control";

/** text 일곱 단계는 「작업 ↔ 모델」 1순위(PR B — 그 연결의 계약에 묶인 순위의 장부 이름), 소개 검수는 아직 이 프로세스의 env 다(PR C). */
const ranked = (model: string | undefined) => model || "순위 없음 — 돌지 않음";
export function TextModelStagesTable({ models }: { models: ModelEnv }) {
  const stages = [
    ["검색 프로필 생성", ranked(models.profile), "작업 ↔ 모델 · product-search-profile"],
    ["검색 키워드 검수", ranked(models.verify), "작업 ↔ 모델 · product-search-verify"],
    ["심사 사유 번역", ranked(models.translate), "작업 ↔ 모델 · reason-translate"],
    ["제품 다국어 번역", ranked(models.productTranslate), "작업 ↔ 모델 · product-translate"],
    ["한국어 소개 번역", ranked(models.koreanTagline), "작업 ↔ 모델 · product-tagline-ko (GPT 경로)"],
    ["검색 질의 번역", ranked(models.searchQuery), "작업 ↔ 모델 · search-query-translate"],
    ["수집 소개 생성", ranked(models.tagline), "작업 ↔ 모델 · crawl-tagline"],
    ["소개 검수", models.introCheck, "INTRO_CHECK_MODEL · Claude CLI"],
  ];
  return <>
    <p className="mb-2 text-[13px] text-fg-3 sm:hidden">표를 좌우로 밀어 모든 설정을 확인하세요.</p>
    <div className="overflow-x-auto" role="region" tabIndex={0} aria-label="단계별 모델 설정 표"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b border-line">
    <th className="whitespace-nowrap py-2 pr-4">단계</th><th className="py-2 pr-4">배포 기본 모델</th><th className="py-2">기본값 출처</th>
  </tr></thead><tbody>{stages.map(([stage, model, location]) => <tr key={stage} className="border-b border-line align-top">
    <th className="whitespace-nowrap py-3 pr-4 font-semibold">{stage}</th><td className="min-w-[180px] break-all py-3 pr-4 font-mono">{model}</td>
    <td className="py-3 font-mono text-fg-3">{location}</td>
  </tr>)}</tbody></table></div>
  </>;
}
