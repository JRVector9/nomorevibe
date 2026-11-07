import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { llmHistoryFilter } from "@/lib/operations/llm-ops-history";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../../components/PageStamp";
import { ModelsHistorySlot } from "../llm-ops-slots";
import "../llm-ops.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM 운영 · 기록 — NoMoreVibe", robots: { index: false } };

const one = (value: string | string[] | undefined) => typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;

/** 기록 — 재실행 패널 · 최근 1시간 실패 · 호출 기록 · 설정·조치 변경 기록 한 표(2026-11-07 승인 시안 PR 3). ?kind=connection|limit|rank|action · ?failed=1 · ?before=<id> */
export default async function ModelsHistoryPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  const filter = llmHistoryFilter({ kind: one(params.kind), failed: one(params.failed), before: one(params.before) });
  return <main className="stack"><PageStamp /><h1 className="admin-vh">LLM 운영 · 기록</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">재실행 대기·호출·변경 기록을 읽는 중…</p>}><ModelsHistorySlot filter={filter} readOnly={adminWorkspaceReadOnly()} /></Suspense>
  </main>;
}
