import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { PageStamp } from "../components/PageStamp";
import { PrototypeNewsContent, PrototypeRankingContent, PrototypeSocialContent } from "./PrototypeContentViews";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "콘텐츠 운영 — NoMoreVibe", robots: { index: false, follow: false } };

type Query = Record<string, string | string[] | undefined>;

/** Workspace entrypoint only: the original authenticated page, loaders and actions remain authoritative. */
export default async function ContentWorkspace({ searchParams }: { searchParams: Promise<Query> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : "social";
  return <main><PageStamp />{tab === "ranking" ? <PrototypeRankingContent /> : tab === "news" ? <PrototypeNewsContent query={params} /> : <PrototypeSocialContent query={params} />}</main>;
}
