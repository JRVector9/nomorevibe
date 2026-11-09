import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { readCapacityAllocationView } from "@/lib/operations/admin-capacity-allocation";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { llmHistoryHref } from "@/lib/operations/llm-ops-history";
import { PageStamp } from "../../components/PageStamp";
import { modelsAdvancedEditor } from "../../workspace-navigation";
import { AdvancedEditorLinks, advancedEditorTitle } from "../advanced/AdvancedEditorLinks";
import { AllocationMatrix } from "./AllocationMatrix";
import "../llm-ops.css";
import "./allocation.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: advancedEditorTitle("allocation"), robots: { index: false } };
const EDITOR = modelsAdvancedEditor("allocation");

/**
 * 칸 배분(step 3, 운영자 결정 2026-11-08; 화면 개편 2026-11-09 승인 시안 #alloc) — 장비 한 대의 동시 실행 칸을 작업 영역(용량 경로)마다 보장·상한으로 나누는 배분표.
 * 줄 = 작업 영역(갈래별), 열 = 서버(연결 이름 + 모델; 연결마다 가른 장비는 묶음 머리 아래 연결 열), 칸 = 보장·상한 한 줄(지금·대기는 켤 때만). 저장은 장비마다(판 CAS) step 2 의 저장 함수 한 번이고
 * 다음 입장부터 바로 쓰인다 — DRAIN·배포·"읽은 판"이 없다. 읽기 전용 미리보기는 저장 칸을 감춘다.
 */
export default async function CapacityAllocationPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const readOnly = adminWorkspaceReadOnly();
  const view = await readCapacityAllocationView();
  return <main className="stack">
    <PageStamp />
    <header className="grid gap-1">
      <AdvancedEditorLinks next={["devices", "limits"]} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-[22px] font-semibold">{EDITOR.label}</h1>
        <p className="text-[13px] text-fg-2">서버 한 대의 동시 실행 칸을 작업마다 보장·상한으로 나눕니다. 이미 잡힌 칸은 그대로 끝납니다.{" "}
          <Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="font-semibold text-accent-ink">저장 기록 →</Link></p>
      </div>
    </header>
    <AllocationMatrix view={view} readOnly={readOnly} />
  </main>;
}
