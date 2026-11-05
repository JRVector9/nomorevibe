import { AdminShell } from "./AdminShell";
import { currentAdmin } from "@/lib/auth/admin";
import { analyticsPropertyUrl } from "@/lib/analytics/property-url";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import "./admin.css";
import "./prototype-content-type.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Each page and mutation retains its server-side authorization check.
  // 계정 — 로그인 전이면 계정 없이 그린다. 메뉴 배지는 AdminShell 이 인증된 화면에서 따로 읽는다(레이아웃을 기다리게 하지 않는다)
  const admin = await currentAdmin().catch(() => null);
  // 이 시각은 레이아웃을 그릴 때마다(처음·자동 갱신·새로고침) 바뀐다 — 화면 머리의 "마지막 갱신"이 된다.
  // 화면을 옮길 때는 레이아웃을 다시 그리지 않으므로 AdminShell 이 배지를 다시 받으며 그 시각을 쓴다
  const renderedAt = new Date().toISOString();
  return <AdminShell account={admin?.login} renderedAt={renderedAt}
    analyticsUrl={admin ? analyticsPropertyUrl() : null}>
    {admin && adminWorkspaceReadOnly() && <aside role="note" className="border-b border-line bg-accent-soft px-6 py-2 text-[13px] text-accent-ink">
      실데이터 · 읽기 전용 미리보기 — 운영 복제본을 조회합니다. 저장·승인·반려·작업 실행은 차단됩니다.
    </aside>}
    {children}
  </AdminShell>;
}
