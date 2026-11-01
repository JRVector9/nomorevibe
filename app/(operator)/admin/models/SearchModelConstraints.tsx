import type { ModelServerHealth } from "@/lib/operations/model-servers";

/** These endpoints select their loaded model server-side. No model identity or vector-space proof is invented. */
export function SearchModelConstraints({ health, embeddingModel, dimensions, probedAgo }: {
  health: ModelServerHealth[]; embeddingModel: string; dimensions: number;
  /** 이 렌더의 자동 확인 결과가 관측 표(probe:search-server:…)에 남은 시점 설명 — 한 화면이 넘긴다 */
  probedAgo?: string | null;
}) {
  const state = (name: ModelServerHealth["name"]) => {
    const row = health.find(item => item.name === name);
    return !row ? "연결 환경 미설정" : row.ok ? "서버 /health 응답 확인" : `서버 확인 실패 · ${row.error ?? "미확인"}`;
  };
  return <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="search-model-heading">
    <h2 id="search-model-heading" className="text-[18px] font-semibold">검색 모델 · 임베딩·재정렬</h2>
    <p className="text-[13px] text-fg-2">검수 외의 두 모델 호출도 이 화면에서 확인합니다. 아래 상태는 서버 응답이며 개별 모델의 시험 호출 결과와 다릅니다.{probedAgo ? ` 확인 자동(렌더) · ${probedAgo}.` : ""}</p>
    <dl className="grid min-w-0 gap-3 text-[13px] sm:grid-cols-2">
      <div className="min-w-0 rounded-lg border border-line p-3"><dt className="font-semibold">의미 검색 임베딩</dt>
        <dd className="break-all">{embeddingModel} · {dimensions}차원</dd><dd>{state("임베딩")}</dd></div>
      <div className="min-w-0 rounded-lg border border-line p-3"><dt className="font-semibold">검색 결과 재정렬</dt>
        <dd>서버에 적재된 모델 · 모델 식별자 미확인</dd><dd>{state("재정렬")}</dd></div>
    </dl>
    <p className="text-[13px] text-fg-3">추가·제거·저장 보류: 현재 두 API는 호출자가 모델을 고르는 계약이 없습니다. 임베딩은 제품·검색어의 모델 파일, 차원, 전처리와 검증 표본이 같은 벡터 공간이어야 합니다. 검증된 등록부 항목과 색인 이전 계약이 준비되면 선택 기능을 연결할 수 있습니다. 현재 모델·벡터·접수 설정은 보존합니다.</p>
  </section>;
}
