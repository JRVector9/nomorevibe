export type AssignmentSaveKind = "execution" | "ranks";
export type AssignmentSaveAnswer = { ok?: true; message?: string; issues?: string[]; warnings?: string[] } | null;
export type AssignmentSaveResult = {
  kind: AssignmentSaveKind; ok: boolean; message: string; issues: readonly string[]; warnings: readonly string[];
  /** A lost response does not prove that the server rolled back the write. */
  unconfirmed?: boolean;
};

/** Shared by the flow panel and models drawer. Never retry a write with an unknown outcome. */
export async function saveAssignmentChanges(changes: readonly { kind: AssignmentSaveKind; form: FormData }[],
  actions: Record<AssignmentSaveKind, (previous: null, form: FormData) => Promise<AssignmentSaveAnswer>>,
  refresh: () => void): Promise<AssignmentSaveResult[]> {
  const results: AssignmentSaveResult[] = [];
  for (const { kind, form } of changes) {
    let answer: AssignmentSaveAnswer;
    let unconfirmed = false;
    try {
      answer = await actions[kind](null, form);
      if (answer == null) throw new Error("assignment_save_response_missing");
    }
    catch {
      unconfirmed = true;
      answer = { issues: ["저장 응답을 확인하지 못했습니다. 적용됐을 수 있으니 다시 누르기 전에 현재 배정과 최근 변경 기록을 확인하세요."] };
    }
    const ok = !!answer?.ok;
    results.push({ kind, ok, unconfirmed, message: answer?.message ?? "", warnings: answer?.warnings ?? [],
      issues: answer?.issues ?? (ok ? [] : ["저장하지 못했습니다."]) });
    if (!ok || answer?.issues?.length) break;
  }
  // Request fresh data after every outcome. router.refresh itself does not await that read.
  refresh();
  return results;
}
