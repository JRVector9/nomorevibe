import type { ProductDetailView } from "@/lib/domain/products/detail-view";

/** 막대·점 색 — 무채색 네 단계. 색은 이름으로만(globals.css) 쓰므로 셋째·넷째는 보조 글자색을 바탕에 섞는다 */
const SHADES = [
  "var(--text)",
  "var(--text-2)",
  "color-mix(in srgb, var(--text-2) 60%, var(--bg))",
  "color-mix(in srgb, var(--text-2) 30%, var(--bg))",
];

/** 저장소 언어 구성 — 상위 셋과 나머지를 묶은 '외' 하나 */
export function LanguageBar({ repository }: { repository: ProductDetailView["repository"] }) {
  const languages = repository?.facts?.languages ?? [];
  if (languages.length === 0) return null;
  const top = languages.slice(0, 3);
  const rest = Math.max(0, Math.round((100 - top.reduce((sum, item) => sum + item.percent, 0)) * 10) / 10);
  const rows = rest > 0 ? [...top, { name: `${languages[3]?.name ?? "기타"} 외`, percent: rest }] : top;
  return (
    <section aria-labelledby="lang-title" className="flex flex-col gap-2.5">
      <h2 id="lang-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">언어 구성</h2>
      <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-line">
        {rows.map((item, index) => <span key={item.name} style={{ width: `${item.percent}%`, background: SHADES[index] }} />)}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-[13px] text-fg tabular-nums">
        {rows.map((item, index) => (
          <li key={item.name} className="inline-flex items-center gap-[7px]">
            <i aria-hidden className="inline-block h-[9px] w-[9px] rounded-full" style={{ background: SHADES[index] }} />
            {item.name} <span className="text-fg-2">{item.percent}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
