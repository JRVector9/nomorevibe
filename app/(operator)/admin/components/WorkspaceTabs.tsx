import Link from "next/link";
import { secondaryIsActive, type WorkspaceLocation } from "../workspace-navigation";

/** Navigation is derived from URL state. The content continues using each existing server read and action. */
export function WorkspaceTabs({ location, pathname, search, onNavigate }: { location: WorkspaceLocation; pathname: string; search: string; onNavigate?: (href: string) => void }) {
  const query = new URLSearchParams(search);
  return <div className="prototype-workspace-navigation">
    <nav className="tabs admin-workspace-tabs" aria-label={`${location.workspace.label} 세부 화면`}>
      {location.workspace.tabs.map(tab => <Link key={tab.id} href={tab.href} prefetch={false}
        onNavigate={onNavigate ? () => onNavigate(tab.href) : undefined}
        aria-current={location.tab === tab.id ? "page" : undefined}>{tab.label}</Link>)}
    </nav>
    {location.secondary.length > 0 && <nav className="admin-workspace-secondary" aria-label={`${location.workspace.label} 상세 기능`}>
      {location.secondary.map(link => <Link key={link.id} href={link.href} prefetch={false}
        onNavigate={onNavigate ? () => onNavigate(link.href) : undefined}
        className="button small" aria-current={secondaryIsActive(link, pathname, query) ? "page" : undefined}>{link.label}</Link>)}
    </nav>}
  </div>;
}
