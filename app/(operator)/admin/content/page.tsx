import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import TalkPage from "../talk/page";
import NewsPage from "../news/page";
import RankingPage from "../ranking/page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "콘텐츠 운영 — NoMoreVibe", robots: { index: false, follow: false } };

type Query = Record<string, string | string[] | undefined>;

/** Workspace entrypoint only: the original authenticated page, loaders and actions remain authoritative. */
export default async function ContentWorkspace({ searchParams }: { searchParams: Promise<Query> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : "social";
  if (tab === "ranking") return <RankingPage />;
  if (tab === "news") return <NewsPage searchParams={Promise.resolve({
    state: typeof params.state === "string" ? params.state : undefined,
    page: typeof params.page === "string" ? params.page : undefined,
  })} />;
  return <TalkPage searchParams={Promise.resolve(params)} />;
}
