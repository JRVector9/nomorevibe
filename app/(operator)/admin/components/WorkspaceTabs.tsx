import Link from "next/link";
import { secondaryIsActive, type WorkspaceLocation } from "../workspace-navigation";

/** Navigation is derived from URL state. The content continues using each existing server read and action. */
export function WorkspaceTabs({ location, pathname, search }: { location: WorkspaceLocation; pathname: string; search: string }) {
  const query = new URLSearchParams(search);
  return <div className="admin-workspace-navigation">
    <nav className="admin-workspace-tabs" aria-label={`${location.workspace.label} 세부 화면`}>
      {location.workspace.tabs.map(tab => <Link key={tab.id} href={tab.href} prefetch={false}
        aria-current={location.tab === tab.id ? "page" : undefined}>{tab.label}</Link>)}
    </nav>
    {location.secondary.length > 0 && <nav className="admin-workspace-secondary" aria-label={`${location.workspace.label} 상세 기능`}>
      {location.secondary.map(link => <Link key={link.id} href={link.href} prefetch={false}
        aria-current={secondaryIsActive(link, pathname, query) ? "page" : undefined}>{link.label}</Link>)}
    </nav>}
  </div>;
}
