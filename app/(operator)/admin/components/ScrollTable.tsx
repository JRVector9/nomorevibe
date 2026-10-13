/**
 * 넓은 표를 감싸 가로로만 스크롤시킨다(2026-10-08 UX 감사 ADM-30) — 390px 화면에서 페이지 전체가 옆으로 밀리지 않게.
 * 스크롤되는 영역은 키보드로도 닿아야 하므로 tabIndex 와 이름(label)을 단다.
 *
 *   <ScrollTable label="요청 목록">
 *     <table className="td-table">…</table>
 *   </ScrollTable>
 *
 * 클래스만 필요하면(이미 감싼 div 가 있을 때) ADMIN_TABLE_SCROLL 을 붙인다.
 */
export const ADMIN_TABLE_SCROLL = "admin-table-scroll";

export function ScrollTable({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className={ADMIN_TABLE_SCROLL} role="region" aria-label={label} tabIndex={0}>{children}</div>;
}
