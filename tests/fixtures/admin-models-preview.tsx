import { ReviewModelsForm } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { previewSave } from "./admin-models-preview-actions";

export default function AdminModelsPreview() {
  const choices = ["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b", "conflict", "failure"]
    .map(model => ({ provider: "abcllm" as const, model, label: model }));
  return <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-8 py-7 max-sm:px-4">
    <h1 className="text-[26px] font-bold">단계별 모델</h1>
    <p>로컬 시험 데이터 · 운영 DB와 모델을 호출하지 않습니다.</p>
    <ReviewModelsForm settings={{ ...DEFAULT_CRAWL_SETTINGS, firstReview: choices[0] }} version="preview-v1"
      firstChoices={choices} secondChoices={choices} saveAction={previewSave} />
  </main>;
}
