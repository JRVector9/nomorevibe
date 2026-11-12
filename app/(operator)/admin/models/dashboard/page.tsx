import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../../components/PageStamp";
import { ModelsDashboardSlot } from "../llm-ops-slots";
import "../../status/operations.css";
import "../models.css";
import "../llm-ops.css";
import "../dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM 운영 — NoMoreVibe", robots: { index: false } };

/**
 * LLM 운영 대시보드(2026-11-07 승인 시안 PR 1) — 화면은 그대로이고 주소만 /admin/models 에서 옮겼다(2026-11-12 운영 콘솔 조각 3a:
 * /admin/models 는 모델 목록). 접수 칸(#admission)·장비 점유·단계 띠·먼저 할 일이 여기 있다. 메뉴는 「모델 › 고급 설정 › 대시보드」.
 */
export default async function ModelsDashboardPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  return <main className="stack"><PageStamp /><h1 className="admin-vh">LLM 운영 · 대시보드</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">LLM 운영 상태를 읽는 중…</p>}>
      <ModelsDashboardSlot readOnly={adminWorkspaceReadOnly()} />
    </Suspense>
  </main>;
}
