/**
 * 보여줄 것이 없을 때의 자리.
 *
 * 빈 화면과 고장난 화면은 사용자에게 다른 뜻이다. 같은 상자를 쓰되 문구는 호출부가
 * 정한다 — "아직 없다"와 "지금 못 불러온다"를 한 문장으로 뭉뚱그리면 안 된다.
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-line bg-bg-card p-12 text-center text-[13px] text-fg-3">
      {children}
    </div>
  );
}
