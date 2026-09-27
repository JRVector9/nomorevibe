import type { SearchHealth } from "@/lib/operations/search-health-model";

export function SearchHealthPanel({ health, observedAt }: { health: SearchHealth | null; observedAt?: string }) {
  if (!health) return <section className="my-3 rounded-lg border border-warn p-3" role="status">
    <strong className="text-[13px]">검색 데이터 점검 결과를 확인할 수 없습니다</strong>
    <p className="text-[13px] text-fg-3">15분 간격으로 점검합니다. 아직 결과가 없거나, 점검 실패 또는 45분 이상 관측 지연 상태입니다.</p>
  </section>;
  return <section aria-label="검색 데이터 자동 점검" className="my-3 rounded-lg border border-line p-3">
    <p className="text-[13px]"><strong>검색 데이터 점검</strong> · {health.total.toLocaleString("ko-KR")}건 대조
      {observedAt && <> · {new Date(observedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })} KST</>}</p>
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
      {[["갱신 대기", health.pendingGeneration], ["검수 대기", health.pendingVerification],
        ["해시 결함", health.unmarked], ["검색 사본 불일치", health.copiesMismatched],
        ["프로필 누락", health.missing], ["재시도 한도", health.exhausted]].map(([label, count]) =>
        <div key={label}><dt className="inline text-fg-3">{label} </dt><dd className="inline font-mono font-bold">{count}</dd></div>)}
    </dl>
    <p className="mt-2 text-[13px] text-fg-3">최근 15분 갱신 {health.generatedRecent}건 · 검수 {health.verifiedRecent}건.
      원본 변경으로 갱신 대기 중인 해시 {health.mismatched - health.unmarked}건은 정상 처리 대기입니다.</p>
  </section>;
}
