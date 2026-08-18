/**
 * 작은 알약 배지 — 카테고리·스택처럼 사실 한 조각을 얹는 자리.
 *
 * 같은 마크업이 목록과 상세에 흩어져 있었다. 한 군데서 바꾸면 다른 데가 어긋나는 종류라
 * 묶는다. 신뢰 표기(검증됨·메이커 신고)는 뜻이 다르므로 TrustBadges가 따로 갖는다.
 */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line bg-bg-soft px-2 py-0.5 text-[10.5px] font-semibold text-fg-2">
      {children}
    </span>
  );
}
