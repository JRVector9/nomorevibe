import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { PageStamp } from "../../components/PageStamp";
import { ModelsHistorySlot } from "../llm-ops-slots";
import "../llm-ops.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM 운영 · 기록 — NoMoreVibe", robots: { index: false } };

/** 기록 — 열린 호출 표와 기존 변경 기록으로 가는 길(2026-11-07 승인 시안 PR 1). 재실행 패널·기록 한 표는 다음 단계(PR 3)다. */
export default async function ModelsHistoryPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  return <main className="stack"><PageStamp /><h1 className="admin-vh">LLM 운영 · 기록</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">열린 호출을 읽는 중…</p>}><ModelsHistorySlot /></Suspense>
  </main>;
}
