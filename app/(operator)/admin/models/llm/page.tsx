import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { llmFixField } from "@/lib/operations/llm-ops-links";
import { PageStamp } from "../../components/PageStamp";
import { LlmOpsSlot } from "../llm-ops-slots";
import "../llm-ops.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM 운영 · 연결 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";

/**
 * LLM 운영 — 연결(서버)과 CLI 도구 한 줄씩(2026-11-07 승인 시안 PR 2). ?edit=<연결 id> 는 그 행을 펼치고, ?add=1 은 「+ 연결 추가」를 연다.
 * ?fix=<칸>(limit·key·address·version·enabled)은 펼친 연결 폼의 그 칸에 초점을 둔다 — 행의 문제 표시가 이 주소로 온다.
 * 예전 /admin/models/tasks#connections 와 ?tab=connections·capacity 는 그대로 살아 있거나 여기로 온다.
 */
export default async function LlmOpsPage({ searchParams }: Props) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  return <main className="stack"><PageStamp /><h1 className="admin-vh">LLM 운영 · 연결과 한도</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">연결·한도·배정을 읽는 중…</p>}>
      <LlmOpsSlot readOnly={adminWorkspaceReadOnly()} editId={one(params.edit) || null} fix={llmFixField(one(params.fix))} adding={one(params.add) === "1"} />
    </Suspense>
  </main>;
}
