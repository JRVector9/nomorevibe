import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { requestWorkspaceTab } from "@/lib/operations/admin-request-workspace-model";
import { PageStamp } from "../components/PageStamp";
import { OPS_FRESH_COOKIE } from "../status/fresh";
import { ContactsPanel } from "./ContactsPanel";
import { PostsPanel } from "./PostsPanel";
import { CorrectionRequestsPanel, OpenRequestsPanel, RegistrationPanel, RequestHistoryPanel } from "./WorkspaceParts";
import "../audit/takedown.css";
import "./workspace.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "요청함 — NoMoreVibe", robots: { index: false, follow: false } };
export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const secret = authSecret(); if (!secret) throw new Error("admin_auth_unconfigured");
  const params = await searchParams;
  const tab = requestWorkspaceTab(params);
  const content = tab === "correction" ? <CorrectionRequestsPanel />
    : tab === "contact" ? <ContactsPanel params={params} admin={admin} secret={secret} />
    : tab === "posts" ? <PostsPanel params={params} admin={admin} secret={secret} />
    : tab === "registration" ? <RegistrationPanel />
    : tab === "history" ? <RequestHistoryPanel />
    : <OpenRequestsPanel fresh={(await cookies()).has(OPS_FRESH_COOKIE)} />;
  return <main className="request-workspace"><PageStamp /><h1 className="sr-only">요청함</h1>{content}</main>;
}
