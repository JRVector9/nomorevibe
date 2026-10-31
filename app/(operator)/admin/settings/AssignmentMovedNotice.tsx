import Link from "next/link";

/**
 * 배정 표 플래그(MODEL_ASSIGNMENT_TABLE, 3b-B)가 켜진 뒤(PR 3b-D) — 1차·추가 1차·2차 투표·2차 대체·단계별 모델 풀 칸은 읽기 전용이고 배정 화면에서 바꾼다.
 * 크롤 설정(SettingsForm)·단계별 모델(ReviewModelsForm)이 같은 글을 쓴다. 플래그가 꺼져 있으면(기본) 보이지 않고 칸은 그대로 편집된다.
 */
export function AssignmentMovedNotice({ detail = "아래 모델 칸은 읽기 전용이고, 다른 설정을 저장해도 값은 그대로 남습니다." }: { detail?: string }) {
  return <p role="note" data-assignment-moved="true" className="rounded-[9px] border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg-2">
    배정 표로 옮겨짐 — <Link href="/admin/models/assignments" prefetch={false} className="font-semibold text-accent-ink underline">/admin/models/assignments</Link>
    {" "}에서 바꿉니다. {detail}</p>;
}
