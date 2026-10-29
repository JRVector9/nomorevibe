import { ReviewModelsForm } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { LiveModels } from "@/app/(operator)/admin/models/LiveModels";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import type { ModelStageAssignment } from "@/lib/operations/admin-models-view";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import type { ModelOption } from "@/app/(operator)/admin/settings/ModelRows";
import { previewSave, previewProbe, previewOpsSubmit, previewOpsRead } from "./admin-models-preview-actions";
export type AdminModelsPreviewData = { observation: AdminModelsObservation; models: readonly ModelDefinition[]; assignments: ModelStageAssignment[]; settings: CrawlSettings; choices: ModelOption[] };
export default function AdminModelsPreviewUI({ data }: { data: AdminModelsPreviewData }) {
  return <div className="admin-area"><aside className="admin-sidebar"><div className="admin-brand-row"><strong className="p-3 text-[18px]">NoMoreVibe</strong><button type="button" className="admin-menu-toggle">메뉴</button></div><nav className="admin-sidebar-menu mt-8 p-3 text-[13px] font-semibold"><p>운영센터</p><p className="mt-4 rounded-lg bg-accent-soft p-3 text-accent-ink">단계별 모델</p></nav></aside>
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-8 py-7 max-sm:px-4">
      <header><h1 className="text-[26px] font-bold">단계별 모델</h1><p className="mt-2 text-[13px] text-fg-2">고정 시험 데이터 · 운영 DB·모델 호출 없음</p></header>
      <LiveModels observation={data.observation} models={data.models} assignments={data.assignments} probeAction={previewProbe}
        opsActions={{ submitAction: previewOpsSubmit, readAction: previewOpsRead }} />
      <ReviewModelsForm settings={data.settings} version="fixture-cas" firstChoices={data.choices} secondChoices={data.choices} models={data.models} defaults={{}} saveAction={previewSave} />
      <details className="rounded-xl border border-line p-4"><summary>참고 · 카테고리 분류 / 검색 모델 / 모델 등록부 / 다른 LLM 단계</summary><p>이 파일은 화면 검토용 고정 데이터입니다.</p></details>
    </main></div>;
}
