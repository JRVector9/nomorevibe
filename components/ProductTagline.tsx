import type { TaglineSource } from "@/lib/db/schema";
import { IntroductionSource } from "./home/IntroductionSource";

/**
 * 제품 한 줄 소개 — 카드·상세·인기·랭킹·홈 보드가 모두 이 컴포넌트로 그린다. 화면 쪽은 소개를 직접 그리지 말고 값만 넘긴다.
 *
 * 한국어 소개(taglineKo, UX-13)가 있으면 그것을 먼저 보이고 원문은 뒤에 둔다 — 좁은 자리(카드·행)는 툴팁(title)으로,
 * 상세는 '원문 보기' 토글로(original="toggle"). taglineKo 는 지금 소개에서 옮긴 것만 온다(korean-tagline.ts taglineKoField) —
 * 소개가 바뀌어 아직 다시 옮기지 않았으면 비어 있어 원문만 보인다.
 * 'AI가 요약' 출처 줄은 보이는 글이 AI 가 쓴 것일 때만 붙는다 — 한국어 줄(늘 AI 가 옮긴 것)이나 AI 가 지은 원문.
 */
export function ProductTagline({ tagline, taglineKo, source, className, showSource = true, original = "tooltip" }: {
  tagline: string;
  /** 한국어 한 줄 소개 — 없으면 원문만 */
  taglineKo?: string | null;
  source?: TaglineSource | null;
  className?: string;
  /** 출처 줄('AI가 요약 · …')을 붙일지 — 좁은 행에서는 끈다 */
  showSource?: boolean;
  /** 한국어 줄이 있을 때 원문을 어디에 둘지 — tooltip: 줄의 title(카드·행), toggle: 아래 '원문 보기'(상세) */
  original?: "tooltip" | "toggle";
}) {
  const korean = taglineKo?.trim() || null;
  if (!korean) {
    return (
      <>
        <p className={className} title={tagline}>{tagline}</p>
        {showSource && <IntroductionSource source={source ?? undefined} />}
      </>
    );
  }
  return (
    <>
      <p className={className} title={original === "tooltip" ? `원문: ${tagline}` : korean}>{korean}</p>
      {showSource && <IntroductionSource source={source ?? undefined} korean />}
      {original === "toggle" && (
        <details className="text-[13px] leading-[1.5] text-fg-2">
          <summary className="inline-flex min-h-8 cursor-pointer select-none items-center text-accent-ink hover:underline">원문 보기</summary>
          <p className="m-0 mt-1 max-w-[720px] text-[15px] leading-[1.5] text-fg-2">{tagline}</p>
        </details>
      )}
    </>
  );
}
