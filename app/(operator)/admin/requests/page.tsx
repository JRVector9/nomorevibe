import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import { requestWorkspaceTab } from "@/lib/operations/admin-request-workspace-model";
import { PageStamp } from "../components/PageStamp";
import { ContactCreateForm } from "./RequestForms";
import { PrototypeRequestWorkspace } from "./PrototypeRequestWorkspace";
import { RegistrationPanel, RequestHistoryPanel } from "./WorkspaceParts";
import "./workspace.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "요청함 — NoMoreVibe", robots: { index: false, follow: false } };
export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const secret = authSecret(); if (!secret) throw new Error("admin_auth_unconfigured");
  const params = await searchParams, tab = requestWorkspaceTab(params);
  return <main className="stack request-workspace"><PageStamp /><h1 className="sr-only">요청함</h1>
    <div className="toolbar"><details><summary className="button">받은 문의 수동 접수</summary><div className="panel pad mt"><p className="small muted mb">contact@nomorevibe.com으로 받은 메일을 수동 접수합니다. 회신은 기존 메일함에서 보내세요.</p><ContactCreateForm csrfToken={adminRequestToken("contact-requests", admin, secret)} expiresAt={admin.exp} /></div></details></div>
    {tab === "registration" ? <RegistrationPanel /> : tab === "history" ? <RequestHistoryPanel params={params} /> : <PrototypeRequestWorkspace tab={tab} params={params} admin={admin} secret={secret} />}
  </main>;
}
