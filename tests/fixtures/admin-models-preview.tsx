import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { redesignObservation, redesignModels, redesignAssignments } from "./admin-models-redesign";
import AdminModelsPreviewUI, { type AdminModelsPreviewData } from "./admin-models-preview-ui";
const choices = ["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b"].map(model => ({ provider: "abcllm" as const, model, label: model }));
export const previewData: AdminModelsPreviewData = { observation: redesignObservation(), models: redesignModels, assignments: redesignAssignments, choices,
  settings: { ...DEFAULT_CRAWL_SETTINGS, firstReview: choices[0], firstReviewAdditional: [choices[1]], stageModelPools: { "product-translate": ["m1:translation"] } } };
/** Offline fixture only. Never mount as a public route or load production credentials. */
export default function AdminModelsPreview() { return <AdminModelsPreviewUI data={previewData} />; }
