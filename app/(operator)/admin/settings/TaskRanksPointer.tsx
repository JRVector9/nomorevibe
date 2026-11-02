import Link from "next/link";

/**
 * 1차·2차 심사 모델 칸이 옮겨진 곳(2026-11-02 소유자 결정, PR C1) — 실행 쪽은 「작업 ↔ 모델」의 1차 AI 검수·2차 AI 검수(투표자 1·2·3) 순위만 읽는다.
 * 크롤 설정(SettingsForm)·단계별 모델(ReviewModelsForm)·운영센터 머리(예전 2차 표 바로 바꾸기 자리)가 같은 글을 쓴다. 옛 설정 값은 편집하지 않는다(가져오기 출처로만 남는다).
 */
export function TaskRanksPointer({ what = "1차·2차 심사 모델" }: { what?: string }) {
  return <p role="note" data-task-ranks-pointer="true" className="rounded-[9px] border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg-2">
    {what}은(는) <Link href="/admin/models/tasks#tasks" prefetch={false} className="font-semibold text-accent-ink underline">작업 ↔ 모델</Link>
    {" "}에서 1·2·3순위로 정합니다(2차는 투표자 칸마다 따로). 이 화면은 바꾸지 않습니다 — 순위가 없으면 그 심사는 돌지 않고 상태 화면에 까닭이 보입니다.</p>;
}
