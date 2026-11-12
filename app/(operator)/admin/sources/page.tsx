import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../components/PageStamp";
import { OPS_FRESH_COOKIE } from "../status/fresh";
import { jobControlCsrf } from "../status/job-control-csrf";
import { SourcesSlot } from "./slots";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "수집·작업 — NoMoreVibe", robots: { index: false } };

const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";

/**
 * /admin/sources — 운영 콘솔 「수집·작업」(2026-11-12 최종 시안 화면 5, 조각 4a). ?source=<열쇠> 는 그 수집원의 상세, ?job=<잡> 은 주기 작업 줄의 조치(주기·멈춤)를 연다.
 * 모델(LLM)을 쓰지 않는 수집원과 주기 작업만 본다. 옛 수집 설정(/admin/settings)·작업 흐름(/admin/status?tab=jobs)은 같은 메뉴의 탭으로 그대로 남는다.
 */
export default async function SourcesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  const readOnly = adminWorkspaceReadOnly();
  const secret = authSecret();
  const csrf = secret && !readOnly ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : null;
  const fresh = (await cookies()).has(OPS_FRESH_COOKIE);
  return <main className="stack"><PageStamp /><h1 className="admin-vh">수집·작업</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">수집원과 주기 작업을 읽는 중…</p>}>
      <SourcesSlot selected={one(params.source) || null} openJob={one(params.job) || null} readOnly={readOnly} csrf={csrf} fresh={fresh} />
    </Suspense>
  </main>;
}
