import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../../components/PageStamp";
import { FeedSourceAddSlot } from "../slots";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "수집원 추가 — NoMoreVibe", robots: { index: false } };

/** 수집원 추가 세 걸음(2026-11-12 최종 시안 흐름 4, 조각 4a) — ?kind=feed 면 둘째 걸음(주소와 규칙)부터 */
export default async function SourceAddPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  return <main className="stack"><PageStamp /><h1 className="admin-vh">수집원 추가</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">수집원을 읽는 중…</p>}>
      <FeedSourceAddSlot kind={params.kind === "feed" ? "feed" : null} readOnly={adminWorkspaceReadOnly()} />
    </Suspense>
  </main>;
}
