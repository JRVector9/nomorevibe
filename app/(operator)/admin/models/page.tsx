import { TextModelStagesTable } from "./TextModelStagesTable";
import { ModelRegistryTable } from "./ModelRegistryTable";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { listGatewayModels } from "@/lib/crawl/agent-review-gateway";
import { configuredHumanModelsReady, humanReviewModelDisplay } from "@/lib/operations/admin-models-human";
import { currentModelEnv } from "@/lib/operations/model-env";
import { PageStamp } from "../components/PageStamp";
import { HumanReviewSwitch } from "../review/HumanReviewSwitch";
import { ReviewModelsForm } from "./ReviewModelsForm";
import { reviewModelOptions } from "./model-options";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { LiveModels } from "./LiveModels";
import { modelRecoveryBlocked, type ModelStageAssignment } from "@/lib/operations/admin-models-view";
import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { configuredModel, modelForPurpose, modelRequestName, MODEL_PURPOSE_ENV, readModelRegistry } from "@/lib/llm/model-registry";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { AiConnection } from "../status/AiConnection";
import { agentRequest } from "@/lib/operations/agent-client";
import type { AgentStatus } from "@/lib/operations/contracts";
import { screenModelConfig } from "@/lib/screen-review/vision-review";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/lib/domain/products/embedding";
import { modelServerHealth } from "@/lib/operations/model-servers";
import { SearchModelConstraints } from "./SearchModelConstraints";
import "../status/operations.css";
import "./models.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "단계별 모델 — NoMoreVibe", robots: { index: false } };

export default async function ModelsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  // Admin registry overrides (0148) are part of the registry this page shows and validates against.
  await ensureServingContracts();
  const [settings, gatewayModels, models] = await Promise.all([getSettings(), listGatewayModels(), currentModelEnv()]);

  const registry = readModelRegistry();
  const defaults = Object.fromEntries(ADMIN_MODEL_STAGES.map(stage => [stage.id, stage.purpose === "screen-review" ? screenModelConfig()?.model ?? "미설정"
    : stage.purpose in MODEL_PURPOSE_ENV ? configuredModel(stage.purpose as keyof typeof MODEL_PURPOSE_ENV) : modelRequestName(modelForPurpose(stage.purpose))]));
  const assignments: ModelStageAssignment[] = [
    { id: "first-review", label: "1차 검수", models: [settings.firstReview ?? { provider: "abcllm", model: modelRequestName(modelForPurpose("ai1-preset")) }, ...(settings.firstReviewAdditional ?? [])] },
    { id: "second-review", label: "2차 검수", models: [...settings.secondReview.voters, ...(settings.secondReview.fallbacks ?? [])] },
    ...ADMIN_MODEL_STAGES.map(stage => ({ id: stage.id, label: stage.label, models: (settings.stageModelPools?.[stage.id]?.length
      ? settings.stageModelPools[stage.id]! : [defaults[stage.id]]).map(model => ({ provider: stage.provider, model })) })),
  ];
  return <main className="mx-auto flex max-w-[1440px] flex-col gap-5 px-8 pt-7 pb-28 max-sm:px-4">
    <PageStamp />
    <header className="flex flex-col gap-2"><h1 className="text-[26px] font-bold">단계별 모델</h1>
      <Link href="/admin/models/contracts" className="text-[14px] underline">모델 연결(엔진 주소·키·계약) 관리 →</Link>
      <p className="text-[14px] text-fg-2">멈춘 단계와 모델을 먼저 확인하고, 아래에서 다음 작업에 쓸 모델을 바꿉니다.</p>
      <Link href="/admin/status" prefetch={false} className="text-[13px] font-semibold text-accent-ink">운영센터에서 실제 워커 경로·용량 확인 →</Link>
    </header>
    <Suspense fallback={<p aria-busy="true">운영 DB 실측 확인 중…</p>}><LiveModelsSlot assignments={assignments} models={registry.models} /></Suspense>
    <ReviewModelsForm settings={settings} version={settingsFormVersion(settings)} models={registry.models} defaults={defaults}
      firstChoices={reviewModelOptions(gatewayModels, false)} secondChoices={reviewModelOptions(gatewayModels, true)} />
    <details className="rounded-xl border border-line bg-bg-card p-4"><summary className="cursor-pointer font-semibold">참고 · 카테고리 분류 / 검색 모델 / 모델 등록부 / 다른 LLM 단계</summary>
    <div className="mt-4 flex min-w-0 flex-col gap-5">
    <Suspense fallback={<p aria-busy="true">카테고리 분류 모델 확인 중…</p>}><CategoryModelsSlot reviewMode={settings.reviewMode} /></Suspense>
    <Suspense fallback={<p aria-busy="true">검색 모델 서버 확인 중…</p>}><SearchModelsSlot /></Suspense>
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="human-model-heading">
      <h2 id="human-model-heading" className="text-[18px] font-semibold">사람 검토 단계</h2>
      <p className="text-[13px] text-fg-2">직접 판단: 사람이 심사 큐에서 결정합니다. 위에서 선택한 사람 위임 검수 모델을 켜면 기존 정책에 따라 자동 판단하고, 불확실하거나 실패한 항목은 사람이 검토합니다.</p>
      <Suspense fallback={<p aria-busy="true">사람 위임 모델 연결 확인 중…</p>}>
        <HumanSlot enabled={settings.humanReview.enabled} generation={settings.humanReview.generation} keys={settings.stageModelPools?.["human-review"] ?? []} />
      </Suspense>
      <Link prefetch={false} href="/admin/review" className="text-[13px] font-semibold text-accent-ink">사람이 검토할 심사 큐 열기 →</Link>
    </section>
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="text-model-heading">
      <h2 id="text-model-heading" className="text-[18px] font-semibold">다른 LLM 단계</h2>
      <p className="text-[13px] text-fg-2">아래는 풀을 비웠을 때 사용하는 웹 프로세스의 배포 기본값입니다. 위 단계별 모델 풀에서 저장한 선택이 새 작업에 우선합니다. 실제 호출과 점유는 위 모델 카드에서 확인하세요.</p>
      <TextModelStagesTable models={models} />
      <p className="text-[13px] text-fg-2">감사 재심사·공개분 필터·갈림 재검토·보류 재시도·화면 판별과 LLM 보강은 각 단계에 검증된 모델 계약을 사용합니다. 등록된 모델 설정을 바꿀 때는 해당 단계의 검증 계약과 용량 정책도 함께 확인해야 합니다. 카테고리 분류는 운영센터에서 검증된 CLI 모델과 예비 모델을 선택할 수 있습니다.</p>
      <div className="flex flex-wrap gap-4 text-[13px] font-semibold text-accent-ink"><Link href="/admin/audit" prefetch={false}>감사 단계 설정 →</Link><Link href="/admin/status#ai-model-title" prefetch={false}>카테고리 분류 모델 선택 →</Link><Link href="/admin/status" prefetch={false}>단계별 실제 경로 →</Link></div>
    </section>
    <ModelRegistryTable />
    </div></details>
  </main>;
}

async function LiveModelsSlot({ assignments, models }: { assignments: ModelStageAssignment[]; models: ReturnType<typeof readModelRegistry>["models"] }) {
  const { readModelOpsStates } = await import("@/lib/operations/ops-runner/repository");
  const states = await readModelOpsStates().catch(() => []);
  return <LiveModels observation={await readAdminModelsObservation()} opsStates={states} assignments={assignments} models={models}
    restartModels={models.map(row => ({ key: row.key, label: row.displayName, blockedReason: modelRecoveryBlocked(row.equipment, row.provider) }))} />;
}

async function CategoryModelsSlot({ reviewMode }: { reviewMode: string }) {
  const initial = await agentRequest<AgentStatus>("status").catch(() => null);
  return <section className="rounded-xl border border-line bg-bg-card p-5"><h2 className="mb-3 text-[18px] font-semibold">카테고리 분류 모델</h2>
    <AiConnection initial={initial} reviewMode={reviewMode} /></section>;
}

async function SearchModelsSlot() {
  return <SearchModelConstraints health={await modelServerHealth()} embeddingModel={EMBEDDING_MODEL} dimensions={EMBEDDING_DIMENSIONS} />;
}

async function HumanSlot({ enabled, generation, keys }: { enabled: boolean; generation: number; keys: string[] }) {
  return <HumanReviewSwitch key={generation} enabled={enabled} generation={generation} ready={await configuredHumanModelsReady(keys)}
    {...humanReviewModelDisplay(keys)} />;
}
