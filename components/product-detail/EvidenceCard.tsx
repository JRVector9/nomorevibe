import type { ProductDetailView } from "@/lib/domain/products/detail-view";

const CHIP = "rounded-full bg-bg-card px-[11px] py-1.5 text-[13px] font-medium tabular-nums";

/**
 * 근거 — 출처 종류별 개수와 갱신 문제 수.
 * 'GitHub에서 확인'은 링크가 아니라 저장소를 GitHub 에서 한 번이라도 읽었는지 — 오래됐으면 '확인 필요'가 따로 센다.
 * 응답만 확인한 링크·자동으로 찾은 링크는 있을 때만 알약을 더한다.
 */
export function EvidenceCard({ links, freshness }: {
  links: ProductDetailView["links"];
  freshness: ProductDetailView["freshness"];
}) {
  const count = (label: ProductDetailView["links"][number]["evidenceLabel"]) => links.filter((link) => link.evidenceLabel === label).length;
  const github = freshness.filter((item) => item.provider === "github" && item.lastSuccessAt !== null).length;
  const problems = freshness.filter((item) => item.state === "failed" || item.state === "stale" || item.state === "disconnected").length;
  const chips: Array<[string, number]> = [
    ["GitHub에서 확인", github],
    ["공식 출처", count("공식 출처에서 확인")],
    ["메이커 제공", count("메이커 제공·미검증")],
    ...([["출처 응답 확인", count("출처 응답 확인·관계 미확인")], ["자동 감지", count("자동 감지")]] as Array<[string, number]>)
      .filter(([, n]) => n > 0),
  ];

  return (
    <section aria-labelledby="evidence-title" className="rounded-[18px] bg-bg-soft px-5 py-[18px]">
      <h2 id="evidence-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">근거</h2>
      {links.length === 0 && freshness.length === 0 ? (
        <p className="m-0 mt-2.5 text-[13px] leading-[1.5] text-fg-2">연결된 외부 출처가 없습니다.</p>
      ) : (
        <ul className="m-0 mt-2.5 flex list-none flex-wrap gap-1.5 p-0">
          {chips.map(([label, n]) => <li key={label} className={CHIP}>{label} <span className="text-fg-2">{n}</span></li>)}
          {problems > 0 && <li className="rounded-full border border-down/30 bg-down/5 px-[11px] py-1.5 text-[13px] font-medium text-down">확인 필요 {problems}</li>}
        </ul>
      )}
    </section>
  );
}
