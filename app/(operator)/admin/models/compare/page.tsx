import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { SAMPLE_COMPARE_TASKS } from "@/lib/operations/model-sample-compare";
import { PageStamp } from "../../components/PageStamp";
import { SampleCompareSlot } from "../console/slots";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "표본 비교 — NoMoreVibe", robots: { index: false } };

const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";

/** 표본 비교(2026-11-12 최종 시안 흐름 2, 조각 3a) — ?task=<작업>&candidate=<연결 id>&model=<서버 이름> */
export default async function SampleComparePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  const task = SAMPLE_COMPARE_TASKS.some(entry => entry.task === one(params.task)) ? one(params.task) : SAMPLE_COMPARE_TASKS[0].task;
  return <main className="stack"><PageStamp /><h1 className="admin-vh">표본 비교</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">모델과 비교 기록을 읽는 중…</p>}>
      <SampleCompareSlot task={task} candidate={one(params.candidate) || null} model={one(params.model) || null} readOnly={adminWorkspaceReadOnly()} />
    </Suspense>
  </main>;
}
