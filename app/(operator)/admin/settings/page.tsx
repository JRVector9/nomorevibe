import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { PageStamp } from "../components/PageStamp";
import { PrototypeCollectionSettings, PrototypeEvidenceSettings, PrototypeIntegrationsSettings, PrototypeSettingsHistory } from "./PrototypeSettingsViews";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "설정·기록 — NoMoreVibe", robots: { index: false, follow: false } };
type Query = Record<string,string|string[]|undefined>;
export default async function SettingsWorkspace({ searchParams }: { searchParams: Promise<Query> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const query = await searchParams;
  const tab = typeof query.tab === "string" ? query.tab : "collection";
  return <main><PageStamp />{tab==="history"?<PrototypeSettingsHistory query={query}/>:tab==="evidence"?<PrototypeEvidenceSettings/>:tab==="integrations"?<PrototypeIntegrationsSettings/>:<PrototypeCollectionSettings/>}</main>;
}
