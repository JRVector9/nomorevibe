import type { TaskAssignView } from "./llm-task-assign-view";

export type UnifiedModelTaskUse = Readonly<{ key: string; label: string; place: string; href: string; paused: boolean }>;

/** 모델 상세와 작업 필터가 같은 배정 자료를 쓴다. 실제 적용 설정·투표자 칸도 한 작업 줄로 센다. */
export function unifiedModelTaskUses(view: TaskAssignView): Readonly<Record<string, readonly UnifiedModelTaskUse[]>> {
  const uses: Record<string, UnifiedModelTaskUse[]> = {};
  for (const row of view.rows) {
    for (const connectionId of new Set(row.choices.filter(choice => choice.connectionId && !choice.off).map(choice => choice.connectionId!))) {
      const choices = row.choices.filter(choice => choice.connectionId === connectionId && !choice.off);
      (uses[connectionId] ??= []).push({ key: row.key, label: row.label,
        place: row.mode === "fallback" ? choices.map(choice => `${choice.position}순위`).join("·") : row.mode === "workload_pool" ? "동시에 사용" : "별도 적용 설정",
        href: `/admin/models#${row.anchor}`, paused: row.paused });
    }
  }
  return uses;
}
