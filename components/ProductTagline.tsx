import type { TaglineSource } from "@/lib/db/schema";
import { IntroductionSource } from "./home/IntroductionSource";

/**
 * 제품 한 줄 소개 — 카드·상세·인기·랭킹·홈 보드가 모두 이 컴포넌트로 그린다(UX-13 한국어 소개의 자리).
 *
 * 지금은 원문 소개와 'AI가 요약' 출처만 그린다. 한국어 소개(taglineKo)를 먼저 보이고 원문을 토글로 두는 일은
 * 데이터 품질 작업(PUB-6)이 이 파일 안에서 한다 — 화면 쪽은 소개를 직접 그리지 말고 이 컴포넌트에 값만 넘긴다.
 */
export function ProductTagline({ tagline, source, className, showSource = true }: {
  tagline: string;
  /** 한국어 한 줄 소개 — 없으면 원문만 */
  taglineKo?: string | null;
  source?: TaglineSource | null;
  className?: string;
  /** 출처 줄('AI가 요약 · …')을 붙일지 — 좁은 행에서는 끈다 */
  showSource?: boolean;
}) {
  return (
    <>
      <p className={className} title={tagline}>{tagline}</p>
      {showSource && <IntroductionSource source={source ?? undefined} />}
    </>
  );
}
