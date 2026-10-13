/**
 * 메뉴를 누른 즉시 뜨는 화면.
 *
 * 어드민 페이지는 모두 force-dynamic 이라 서버가 조회를 끝낼 때까지 브라우저가 아무것도
 * 그리지 않았다 — 메뉴를 눌러도 한참 동안 이전 화면 그대로라 눌린 것인지 알 수 없었다.
 * 이 파일 하나로 Next 가 전환 즉시 이 골격을 띄우고 본문이 준비되면 바꿔 끼운다.
 *
 * 사이드바는 레이아웃(AdminShell)이 들고 있어 그대로 남는다 — 여기서 다시 그리지 않는다.
 */
export default function AdminLoading() {
  return (
    <main aria-busy="true" aria-live="polite" className="pt-9">
      <span className="sr-only">불러오는 중</span>
      <div className="h-[30px] w-[220px] animate-pulse rounded-[8px] bg-bg-soft" />
      <div className="mt-3 h-[16px] w-[340px] max-w-full animate-pulse rounded-[6px] bg-bg-soft" />
      <div className="mt-6 flex flex-col gap-3">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="h-[72px] animate-pulse rounded-[12px] border border-line bg-bg-soft" />
        ))}
      </div>
    </main>
  );
}
