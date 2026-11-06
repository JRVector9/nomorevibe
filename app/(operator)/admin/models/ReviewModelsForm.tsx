"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { ADMIN_MODEL_STAGES, type AdminModelStage, type AdminStagePools } from "@/lib/llm/admin-model-stages";
import { AI_TASKS, isAiLiveTask } from "@/lib/llm/ai-tasks";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import { AssignmentMovedNotice } from "../settings/AssignmentMovedNotice";
import { TaskRanksPointer } from "../settings/TaskRanksPointer";
import { saveReviewModels, type ModelSaveState } from "./actions";
import { ModelSaveBar } from "./ModelChips";
import { changedStagePools, StagePoolFields } from "./StageModelPoolsForm";

/**
 * 단계별 모델 선택(설정). 1차 AI 검수 순위·2차 투표·2차 대체 칸은 없앴다(PR C1) — 실행 쪽이 「작업 ↔ 모델」 순위만 읽으므로 여기서 바꾸면 동작이 바뀌지 않는다.
 * 그 자리에 「작업 ↔ 모델」로 가는 안내(TaskRanksPointer)만 둔다. 남은 칸은 직접 모델 단계의 단계 풀이다(PR C2 가 옮긴다).
 */
export function ReviewModelsForm({ settings, version, models, defaults = {}, saveAction = saveReviewModels, locked = false }: {
  settings: CrawlSettings; version: string;
  models?: readonly ModelDefinition[]; defaults?: Record<string, string>; saveAction?: typeof saveReviewModels;
  /** 배정 표 플래그가 켜졌으면(PR 3b-D) 이 폼의 칸(단계별 모델 풀)은 배정 표로 옮겨졌다 — 읽기 전용, 저장 바 없음 */
  locked?: boolean;
}) {
  const router = useRouter();
  const [pools, setPools] = useState<AdminStagePools>(settings.stageModelPools ?? {}), [poolBaseline, setPoolBaseline] = useState<AdminStagePools>(settings.stageModelPools ?? {});
  const [formVersion, setVersion] = useState(version);
  const [state, action, pending] = useActionState<ModelSaveState, FormData>(async (previous, form) => {
    try { const result = await saveAction(previous, form);
      if (result?.ok && result.version) { setVersion(result.version); setPoolBaseline(pools); router.refresh(); }
      return result;
    } catch { return { issues: ["저장 결과를 확인하지 못했습니다. 새로고침해 현재 설정을 확인해주세요."] }; }
  }, null);
  const hiddenStageIds: readonly AdminModelStage[] = ["human-review", "split-confirm", "split-tiebreak", "held-review-retry", "product-intro-check"];
  const stageIds: AdminModelStage[] = ADMIN_MODEL_STAGES
    .map(stage => stage.id)
    .filter(stageId => !hiddenStageIds.includes(stageId)
      && !AI_TASKS.some(task => isAiLiveTask(task.id) && (task.adminStage === stageId || task.id === stageId)));
  const changes = changedStagePools(poolBaseline, pools);
  return <form action={action} id="model-settings" className="flex scroll-mt-28 md:scroll-mt-6 flex-col gap-4" data-models-dirty={changes.length > 0}>
    <input type="hidden" name="settingsVersion" value={formVersion} />
    {models && <input type="hidden" name="stageModelPools" value={JSON.stringify(pools)} />}
    <div><h2 className="text-[20px] font-bold">설정 바꾸기</h2><p className="mt-2 text-[13px] leading-relaxed text-fg-2">현재 선택한 모델입니다. 모델을 추가·제거한 뒤 저장해야 적용됩니다. 이후 작업 묶음부터 반영하며, 진행 중·미확인 요청과 기존 업무 기록은 원래 계약에 남습니다.</p></div>
    <TaskRanksPointer what="1차 AI 검수·2차 AI 검수(투표자·대체) 모델" />
    <p className="text-[13px] leading-relaxed text-fg-2">사람 확인 · AI 보조 배정은 <Link className="underline" prefetch={false} href="/admin/models/human#human-review">사람 확인 · AI 보조 화면</Link>에서 바꿉니다. 소개 검수는 CLI 환경 설정을 읽는 읽기 전용이며, 실제 사용 모델은 운영현황에서 확인합니다.</p>
    {locked && <AssignmentMovedNotice detail="이 폼의 모델 칸(단계별 모델 풀)은 읽기 전용이고 저장하지 않습니다." />}
    {models && <fieldset disabled={pending || locked} data-readonly={locked || undefined}><StagePoolFields draft={pools} models={models} defaults={defaults} stageIds={stageIds} update={(id, keys) => setPools(current => ({ ...current, [id]: keys }))} /></fieldset>}
    <p className="text-[13px] leading-relaxed text-fg-2">풀을 비우면 현재 기본 모델을 사용합니다. 단계 켜짐·발행 보호·물리 슬롯 상한은 별도입니다. 선택은 실행 권한을 부여하지 않으며, 실제 호출은 워커의 연결·실행 계약·용량 검증을 통과해야 합니다.</p>
    <ModelSaveNotice state={pending ? null : state} />{!locked && models && <ModelSaveBar pending={pending} changes={changes} label="모델 설정 저장" />}
  </form>;
}
export function ModelSaveNotice({ state }: { state: ModelSaveState }) {
  if (state?.issues) return <div role="alert" className="rounded-lg border border-down/30 bg-down/5 p-3 text-[13px] text-down">
    <p className="font-semibold">{state.issues.some(issue => issue.includes("다른 곳에서 설정이 바뀌었습니다")) ? "저장 거절 · 다른 곳에서 설정을 수정했습니다" : "저장하지 못했습니다"}</p>
    <ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
  </div>;
  if (state?.ok && state.warnings?.length) return <div role="status" className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-[13px]">
    <p className="font-semibold">모델 설정을 저장했습니다 · 아직 쓰일 수 없는 순위가 있습니다(그동안은 다음 순위로 넘어갑니다)</p>
    <ul>{state.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
  </div>;
  return state?.ok ? <p role="status" className="rounded-lg border border-up/30 bg-up/5 p-3 text-[13px] text-up">모델 설정을 저장했습니다.</p> : null;
}
