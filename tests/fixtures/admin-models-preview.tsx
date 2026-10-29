import { ReviewModelsForm } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { previewSave, previewStageSave, previewProbe, previewAdmission } from "./admin-models-preview-actions";
import { StageModelPoolsForm } from "@/app/(operator)/admin/models/StageModelPoolsForm";
import { LiveModels } from "@/app/(operator)/admin/models/LiveModels";
import { readModelRegistry } from "@/lib/llm/model-registry";
import { buildAdminModelsObservation } from "@/lib/operations/admin-models-observation";

export default function AdminModelsPreview() {
  const choices = ["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b", "conflict", "failure"]
    .map(model => ({ provider: "abcllm" as const, model, label: model }));
  const at = "2026-10-29T01:00:00.000Z", route = { routeId: "product-translate", provider: "abcllm", model: "M1 · 시험 데이터", groupId: "m1", providerBudgetId: "m1" };
  const observation = buildAdminModelsObservation({ observedAt: "2026-10-29T02:00:00.000Z", control: {
    mode: "open", epoch: 1, revision: 2, policy: null, policyHash: null, updatedAt: at },
    metrics: [{ ...route, succeeded1h: 3, failed1h: 1, withdrawn1h: 2, unclassified1h: 0, waiting: 2, reserved: 0, dispatched: 0, indeterminate: 1, lastSuccessAt: at }],
    requests: [{ ...route, requestId: "29877f65-9f95-4efb-88f9-aea5f39a28b2", state: "indeterminate", queuedAt: at, stateSince: at,
      dispatchedAt: at, reservedUntil: null, ownerInstanceId: "fixture-m1", localEndRecorded: true }] });
  return <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-8 py-7 max-sm:px-4">
    <h1 className="text-[26px] font-bold">단계별 모델</h1>
    <p>로컬 시험 데이터 · 운영 DB와 모델을 호출하지 않습니다.</p>
    <ReviewModelsForm settings={{ ...DEFAULT_CRAWL_SETTINGS, firstReview: choices[0] }} version="preview-v1"
      firstChoices={choices} secondChoices={choices} saveAction={previewSave} />
    <StageModelPoolsForm pools={{ "product-translate": ["m1:translation"], "reason-translate": ["mlx:text"] }}
      models={readModelRegistry().models} defaults={{}} version="preview-v1" saveAction={previewStageSave} probeAction={previewProbe} />
    <LiveModels observation={observation} probeAction={previewProbe} admissionAction={previewAdmission} />
  </main>;
}
