import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../components/PageStamp";
import { ModelsDashboardSlot } from "./llm-ops-slots";
import { modelsLegacyTabHref } from "../workspace-navigation";
import "../status/operations.css";
import "./models.css";
import "./llm-ops.css";
import "./dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM 운영 — NoMoreVibe", robots: { index: false } };

const one = (value: string | string[] | undefined) => typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;

/**
 * /admin/models — LLM 운영 대시보드(2026-11-07 승인 시안 PR 1). 대시보드에 필요한 것만 읽는다(llm-ops-slots.tsx).
 * 옛 ?tab= 주소는 새 화면으로, ?advanced=1 은 고급 설정(/admin/models/advanced)으로 넘긴다(modelsLegacyTabHref) — #조각은 브라우저가 지킨다.
 */
export default async function ModelsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  const legacy = modelsLegacyTabHref({ get: name => one(params[name]) });
  if (legacy) redirect(legacy);
  const readOnly = adminWorkspaceReadOnly();
  return <main className="stack"><PageStamp /><h1 className="admin-vh">LLM 운영 · 대시보드</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">LLM 운영 상태를 읽는 중…</p>}>
      <ModelsDashboardSlot readOnly={readOnly} />
    </Suspense>
  </main>;
}
