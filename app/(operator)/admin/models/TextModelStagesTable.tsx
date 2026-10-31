import type { ModelEnv } from "@/lib/operations/pipeline-control";

export function TextModelStagesTable({ models }: { models: ModelEnv }) {
  const stages = [
    ["검색 프로필 생성", models.profile, "ABCLLM_PROFILE_MODEL"],
    ["검색 키워드 검수", models.verify, "SEARCH_VERIFY_MODEL"],
    ["심사 사유 번역", models.translate, "ABCLLM_MODEL"],
    ["제품 다국어 번역", models.productTranslate, "등록부 · product-translate"],
    ["한국어 소개 번역", models.koreanTagline ?? models.translate, "MODEL_REGISTRY_CONFIG · product-tagline-ko / ABCLLM_MODEL"],
    ["검색 질의 번역", models.searchQuery ?? models.translate, "MODEL_REGISTRY_CONFIG · search-query-translate / ABCLLM_MODEL"],
    ["수집 소개 생성", models.tagline, "등록부 · crawl-tagline"],
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
