import Link from "next/link";
import type { WorkspaceLocation } from "../workspace-navigation";
import "./workspace-tabs.css";

/**
 * Navigation is derived from URL state. The content continues using each existing server read and action.
 * 켤 탭과 2차 메뉴 항목은 주소 해석(resolveWorkspace)이 정한다 — 심사 큐의 stage·state 처럼 주소 글자만으로 고를 수 없는 것이 있어서.
 */
export function WorkspaceTabs({ location, onNavigate }: { location: WorkspaceLocation; onNavigate?: (href: string) => void }) {
  const tabLabel = location.workspace.tabs.find(tab => tab.id === location.tab)?.label ?? location.workspace.label;
  return <div className="prototype-workspace-navigation">
    <nav className="tabs admin-workspace-tabs" aria-label={`${location.workspace.label} 세부 화면`}>
      {location.workspace.tabs.map(tab => <Link key={tab.id} href={tab.href} prefetch={false}
        onNavigate={onNavigate ? () => onNavigate(tab.href) : undefined}
        aria-current={location.tab === tab.id ? "page" : undefined}>{tab.label}</Link>)}
      {location.workspace.id === "models" && location.tab === "list" && <span className="admin-model-section-jumps" role="group" aria-label="모델 화면 바로가기">
        {[["models", "모델 목록"], ["tasks", "작업별 적용 현황"], ["operations", "운영 설정"]].map(([id, label]) => <Link key={id}
          href={`/admin/models#${id}`} prefetch={false} onNavigate={onNavigate ? () => onNavigate(`/admin/models#${id}`) : undefined}>{label}</Link>)}
      </span>}
    </nav>
    {location.secondary.length > 0 && <nav className="admin-workspace-secondary" aria-label={`${tabLabel} 상세 기능`}>
      {location.secondary.map(link => <Link key={link.id} href={link.href} prefetch={false}
        onNavigate={onNavigate ? () => onNavigate(link.href) : undefined}
        className="button small" aria-current={location.secondaryTab === link.id ? "page" : undefined}>{link.label}</Link>)}
    </nav>}
  </div>;
}
