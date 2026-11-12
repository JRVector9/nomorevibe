import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../../components/PageStamp";
import { ModelAddSlot } from "../console/slots";
import type { ModelAddStep } from "./ModelAddFlow";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "모델 추가 — NoMoreVibe", robots: { index: false } };

const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 모델 추가 세 걸음(2026-11-12 최종 시안 흐름 3, 조각 3a) — ?id=<만든 연결>&step=2|3 */
export default async function ModelAddPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = (await searchParams) ?? {};
  const id = UUID.test(one(params.id)) ? one(params.id) : null;
  const step: ModelAddStep = !id ? 1 : one(params.step) === "3" ? 3 : 2;
  return <main className="stack"><PageStamp /><h1 className="admin-vh">모델 추가</h1>
    <Suspense fallback={<p aria-busy="true" className="notice">모델 목록을 읽는 중…</p>}>
      <ModelAddSlot id={id} step={step} readOnly={adminWorkspaceReadOnly()} />
    </Suspense>
  </main>;
}
