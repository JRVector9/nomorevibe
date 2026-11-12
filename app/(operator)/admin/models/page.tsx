import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../components/PageStamp";
import { modelsLegacyTabHref } from "../workspace-navigation";
import { ModelConsoleSlot } from "./console/slots";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "모델 — NoMoreVibe", robots: { index: false } };

const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";

/**
 * /admin/models — 운영 콘솔 「모델」 목록(2026-11-12 최종 시안 화면 4, 조각 3a). ?model=<연결 id> 는 그 모델의 상세를 연다.
 * 그 전의 LLM 운영 대시보드는 /admin/models/dashboard(고급 설정)로 옮겼다. 옛 ?tab= 주소는 새 화면으로, ?advanced=1 은 고급 설정으로 넘긴다(modelsLegacyTabHref).
 */
export default async function ModelsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  const legacy = modelsLegacyTabHref({ get: name => one(params[name]) || null });
  if (legacy) redirect(legacy);
  return <main className="stack"><PageStamp /><h1 className="admin-vh">모델</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">모델 목록을 읽는 중…</p>}>
      <ModelConsoleSlot selected={one(params.model) || null} readOnly={adminWorkspaceReadOnly()} />
    </Suspense>
  </main>;
}
