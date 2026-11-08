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
 * 칸 배분(step 3, 운영자 결정 2026-11-08) — 장비 한 대의 동시 실행 칸을 작업 영역(용량 경로)마다 보장·상한으로 나누는 배분표.
 * 줄 = 작업 영역, 열 = 장비 행이 있는 장비, 칸 = 보장·상한 + 지금 점유·대기·최근 1시간 정산. 저장은 장비마다(판 CAS) step 2 의 저장 함수 한 번이고
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
      <h1 className="text-[22px] font-semibold">{EDITOR.label}</h1>
      <p className="text-[15px] text-fg-2">장비 한 대의 동시 실행 칸을 작업 영역마다 나눕니다. 예를 들어 5칸 장비를 카테고리 분류·1차 AI 검수·보류 재심사·2차 갈림 판가름·감사에 1칸씩 보장할 수 있습니다.</p>
      <p className="text-[13px] text-fg-3">비워 둔 칸은 오늘과 같습니다. 저장한 몫은 <strong>다음 입장부터</strong> 쓰이고, 이미 잡힌 칸(예약·진행)은 그대로 끝납니다.{" "}
        <Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="font-semibold text-accent-ink">저장 기록 보기 →</Link></p>
    </header>
    <AllocationMatrix view={view} readOnly={readOnly} />
  </main>;
}
