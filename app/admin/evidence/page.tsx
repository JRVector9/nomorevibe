import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { currentEvidenceSettings } from "@/lib/domain/evidence/refresh";
import { AdminNav } from "../AdminNav";
import { EvidenceSettingsForm } from "./EvidenceSettingsForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "근거 설정 — NoMoreVibe", robots: { index: false } };

export default async function AdminEvidencePage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const settings = await currentEvidenceSettings();
  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">근거 수집 설정</h1>
        <p className="text-[13px] text-fg-3">외부 근거의 주기와 실패 기준</p>
        <div className="ml-auto"><AdminNav current="/admin/evidence" /></div>
      </div>
      <p className="mt-4 max-w-[720px] text-[13px] leading-6 text-fg-2">
        주기는 수집 작업이 각 출처를 다시 확인하는 간격입니다. 마지막으로 성공한 객관적 사실은
        실패 시 지우지 않고, 아래 기준을 넘으면 오래됨으로 표시합니다.
      </p>
      <div className="mt-5"><EvidenceSettingsForm initialSettings={settings} /></div>
    </main>
  );
}
