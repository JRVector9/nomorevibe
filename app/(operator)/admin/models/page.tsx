import { TextModelStagesTable } from "./TextModelStagesTable";
import { ModelRegistryTable } from "./ModelRegistryTable";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { listGatewayModels } from "@/lib/crawl/agent-review-gateway";
import { deepseekReviewReady } from "@/lib/crawl/deepseek-review";
import { currentModelEnv } from "@/lib/operations/model-env";
import { PageStamp } from "../components/PageStamp";
import { HumanReviewSwitch } from "../review/HumanReviewSwitch";
import { ReviewModelsForm } from "./ReviewModelsForm";
import { reviewModelOptions } from "./model-options";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { LiveModels } from "./LiveModels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "단계별 모델 — NoMoreVibe", robots: { index: false } };

export default async function ModelsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const [settings, gatewayModels, models] = await Promise.all([getSettings(), listGatewayModels(), currentModelEnv()]);

  return <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-8 py-7 max-sm:px-4">
    <PageStamp />
    <header className="flex flex-col gap-2"><h1 className="text-[26px] font-bold">단계별 모델</h1>
      <p className="text-[14px] text-fg-3">1차·2차 검수 모델과 사람이 직접 판단할 단계를 관리합니다. 모델 선택과 단계의 실행 스위치는 각각 적용됩니다.</p>
      <Link href="/admin/status" prefetch={false} className="text-[13px] font-semibold text-accent-ink">운영센터에서 실제 워커 경로·용량 확인 →</Link>
    </header>
    <ReviewModelsForm key={settingsFormVersion(settings)} settings={settings} version={settingsFormVersion(settings)}
      firstChoices={reviewModelOptions(gatewayModels, false)} secondChoices={reviewModelOptions(gatewayModels, true)} />
    <Suspense fallback={<p aria-busy="true">운영 DB 실측 확인 중…</p>}><LiveModelsSlot /></Suspense>
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="human-model-heading">
      <h2 id="human-model-heading" className="text-[18px] font-semibold">사람 검토 단계</h2>
      <p className="text-[13px] text-fg-2">직접 판단: 사람이 심사 큐에서 결정합니다. DeepSeek 위임을 켜면 기존 정책에 따라 자동 판단하고, 불확실하거나 실패한 항목은 사람이 검토합니다.</p>
      <Suspense fallback={<p aria-busy="true">DeepSeek 연결 확인 중…</p>}>
        <HumanSlot enabled={settings.humanReview.enabled} generation={settings.humanReview.generation} />
      </Suspense>
      <Link prefetch={false} href="/admin/review" className="text-[13px] font-semibold text-accent-ink">사람이 검토할 심사 큐 열기 →</Link>
    </section>
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="text-model-heading">
      <h2 id="text-model-heading" className="text-[18px] font-semibold">다른 LLM 단계</h2>
      <p className="text-[13px] text-fg-3">아래 경로는 현재 배포 환경과 검증된 모델 계약으로 관리하며 이 메뉴에서 변경할 수 없습니다. 표는 웹 프로세스의 설정값입니다. 실제 실행 워커의 설정·연결 상태는 운영센터에서 확인하세요.</p>
      <TextModelStagesTable models={models} />
      <p className="text-[13px] text-fg-3">감사 재심사·공개분 필터·갈림 재검토·보류 재시도·화면 판별과 LLM 보강은 각 단계에 검증된 모델 계약을 사용합니다. 등록된 모델 설정을 바꿀 때는 해당 단계의 검증 계약과 용량 정책도 함께 확인해야 합니다. 카테고리 분류는 운영센터에서 검증된 CLI 모델과 예비 모델을 선택할 수 있습니다.</p>
      <div className="flex flex-wrap gap-4 text-[13px] font-semibold text-accent-ink"><Link href="/admin/audit" prefetch={false}>감사 단계 설정 →</Link><Link href="/admin/status#ai-model-title" prefetch={false}>카테고리 분류 모델 선택 →</Link><Link href="/admin/status" prefetch={false}>단계별 실제 경로 →</Link></div>
    </section>
    <ModelRegistryTable />
  </main>;
}

async function LiveModelsSlot() {
  return <LiveModels observation={await readAdminModelsObservation()} />;
}

async function HumanSlot({ enabled, generation }: { enabled: boolean; generation: number }) {
  return <HumanReviewSwitch key={generation} enabled={enabled} generation={generation} ready={await deepseekReviewReady()} />;
}
