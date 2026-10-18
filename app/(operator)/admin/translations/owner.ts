import { batchOwnerForJob, type BatchMode } from "@/lib/jobs/batches";

/** 화면에 적는 역할 이름 — 기존 방식의 text 는 지금 글("기존 text 워커") 그대로 둔다 */
const OWNER_NAMES: Record<string, { name: string; subject: string }> = {
  text: { name: "기존 text 워커", subject: "기존 text 워커가" },
  translation: { name: "분리 번역 역할(translation)", subject: "분리 번역 역할(translation)이" },
};

/**
 * 공개 번역(product-translate) 모델 호출을 맡은 역할의 문구(ops-v8 PR8). 전에는 "기존 text 워커만"으로 고정돼 있었다.
 * 작업 배치 방식(job_batch_control.mode)으로 정한다 — 기존 방식(legacy)은 text, 분리(versioned)는 translation, 비우는 중(draining)은 없음.
 * mode 가 null 이면 복제본에서 읽지 못한 것이라 "보류"로 적는다(옛 글로 짐작하지 않는다).
 */
export function translationOwnerText(mode: BatchMode | null): { page: string; accepted: string } {
  if (mode === null) return { page: "모델 호출 담당은 확인 보류입니다 — 복제본에서 작업 배치를 읽지 못했습니다.",
    accepted: "접수했습니다. 담당 역할이 처리합니다." };
  const owner = batchOwnerForJob("product-translate", mode);
  if (owner === null) return { page: "작업 배치를 비우는 중(draining)이라 지금은 모델 호출을 맡은 역할이 없습니다.",
    accepted: "접수했습니다. 작업 배치 전환이 끝나면 담당 역할이 처리합니다." };
  const label = OWNER_NAMES[owner] ?? { name: `${owner} 역할`, subject: `${owner} 역할이` };
  return { page: `모델 호출은 ${label.name}만 수행합니다.`, accepted: `접수했습니다. ${label.subject} 처리합니다.` };
}
