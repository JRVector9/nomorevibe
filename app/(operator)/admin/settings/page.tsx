import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import CrawlSettingsPage from "../page";
import CategoriesPage from "../categories/page";
import EvidencePage from "../evidence/page";
import GitHubAccountsPage from "../github-accounts/page";
import GitHubIntegrationsPage from "../github-integrations/page";
import ActivityPage from "../activity/page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "설정·기록 — NoMoreVibe", robots: { index: false, follow: false } };

type Query = Record<string, string | string[] | undefined>;
const scalar = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;

/** Reuses each source's server data, permission checks and mutation boundary; no duplicate settings store. */
export default async function SettingsWorkspace({ searchParams }: { searchParams: Promise<Query> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const tab = scalar(params.tab) ?? "collection";
  if (tab === "history") return <ActivityPage searchParams={Promise.resolve({
    group: scalar(params.group), actor: scalar(params.actor), failed: scalar(params.failed),
    before: scalar(params.before), target: scalar(params.target),
  })} />;
  if (tab === "evidence") {
    const sources = scalar(params.view) === "sources";
    return <>
      <nav className="admin-workspace-subtabs" aria-label="분류·근거 설정">
        <Link href="/admin/settings?tab=evidence" aria-current={!sources ? "page" : undefined}>카테고리 기준</Link>
        <Link href="/admin/settings?tab=evidence&view=sources" aria-current={sources ? "page" : undefined}>근거 수집</Link>
      </nav>
      {sources ? <EvidencePage /> : <CategoriesPage />}
    </>;
  }
  if (tab === "integrations") {
    const delivery = scalar(params.view) === "delivery";
    return <>
      <nav className="admin-workspace-subtabs" aria-label="외부 연동 구분">
        <Link href="/admin/settings?tab=integrations" aria-current={!delivery ? "page" : undefined}>GitHub 수집 자격</Link>
        <Link href="/admin/settings?tab=integrations&view=delivery" aria-current={delivery ? "page" : undefined}>GitHub 전송 운영</Link>
      </nav>
      {delivery ? <GitHubIntegrationsPage /> : <GitHubAccountsPage />}
    </>;
  }
  return <CrawlSettingsPage />;
}
