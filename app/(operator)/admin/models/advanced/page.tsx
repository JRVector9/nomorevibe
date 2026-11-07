import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../../components/PageStamp";
import { MODELS_ADVANCED_LABEL } from "../../workspace-navigation";
import { AdvancedEditorsIndex, ModelsAdvancedAnalysis } from "./advanced-slots";
import "../../status/operations.css";
import "../models.css";
import "../llm-ops.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `${MODELS_ADVANCED_LABEL} — NoMoreVibe`, robots: { index: false } };

/**
 * /admin/models/advanced — 고급 설정(2026-11-07 승인 시안 PR 5). 편집기 목록(즉시 그림) → 장애 분석(읽는 동안 Suspense).
 * 옛 /admin/models?advanced=1 은 여기로 넘어온다(modelsLegacyTabHref).
 */
export default async function ModelsAdvancedPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const readOnly = adminWorkspaceReadOnly();
  return <main className="stack llm-ops" data-llm-page="advanced">
    <PageStamp />
    {/* 관리자 틀은 화면 이름을 메뉴(두 번째 줄의 「고급 설정」)로 보이고 h1 은 낭독용으로만 둔다(admin.css .admin-workspace-view h1) */}
    <h1 className="text-[22px] font-semibold">{MODELS_ADVANCED_LABEL}</h1>
    <AdvancedEditorsIndex />
    <Suspense fallback={<p aria-busy="true" className="notice">모델 설정·운영 관측을 읽는 중…</p>}>
      <ModelsAdvancedAnalysis readOnly={readOnly} />
    </Suspense>
  </main>;
}
