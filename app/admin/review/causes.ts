import type { AmbiguityCause } from "@/lib/crawl/rules";


/**
 * 갈래마다 사람이 할 판단이 다르다.
 *
 * 저장된 사유는 전부 "ambiguous"라 목록만 봐서는 무엇을 정해야 하는지 알 수 없다.
 * 여기에 갈래별로 "무엇을 묻는 것인지"와 "어느 쪽이면 어느 결정인지"를 적어 둔다.
 * 같은 갈래는 판단도 같으므로 묶어서 처리할 수 있다.
 */
export type CauseKey = AmbiguityCause | "ai_reject" | "resolved" | "unknown";

export const CAUSE_GUIDE: Record<CauseKey, {
  label: string;
  summary: string;
  question: string;
  hints: { decision: string; when: string }[];
}> = {
  host_excluded_subpath: {
    label: "호스트는 제외 대상, 배포물은 하위 경로",
    summary: "owner.github.io 루트면 개인 홈페이지지만, 그 아래 경로는 올려둔 제품일 수 있습니다.",
    question: "이 페이지는 바로 쓸 수 있는 서비스입니까, 다른 것을 소개하는 페이지입니까?",
    hints: [
      { decision: "승인", when: "페이지에서 곧바로 입력·조작·확인이 된다 — 계산기, 대시보드, 에디터, 게임" },
      { decision: "거부 · 배포물이 아님", when: "설치 방법·문서·발표 자료가 본문이다. 실제 물건은 CLI나 라이브러리다" },
      { decision: "거부 · 개인 사이트", when: "이력·포트폴리오·블로그다" },
    ],
  },
  page_status_unknown: {
    label: "배포 URL 응답 미확인",
    summary: "수집기가 아직 이 URL을 열어보지 못했습니다. 수집이 끝나면 자동으로 다시 판정됩니다.",
    question: "지금은 판단하지 않아도 됩니다.",
    hints: [
      { decision: "그대로 두기", when: "며칠 안에 자동으로 빠집니다" },
      { decision: "직접 확인", when: "3일 넘게 남아 있다 — 봇 차단이나 리다이렉트일 수 있다" },
    ],
  },
  push_time_unknown: {
    label: "마지막 푸시 시각 미상",
    summary: "레포 메타에 pushed_at 이 없어 살아있는 프로젝트인지 확인할 수 없습니다.",
    question: "이 저장소가 아직 살아 있습니까?",
    hints: [
      { decision: "승인", when: "저장소를 열어보니 최근 활동이 있다" },
      { decision: "거부 · 배포물이 아님", when: "비어 있거나 오래 방치돼 있다" },
    ],
  },
  agent_evidence: {
    label: "개발 AI 근거 부족",
    summary: "공개된 근거가 기준에 못 미칩니다. 지침·설정 파일이 있다고 그 AI로 개발했다는 확인은 아닙니다.",
    question: "AI로 만들었다는 공개 근거가 충분합니까?",
    hints: [
      { decision: "추가 수집", when: "근거가 더 있을 법하다 — 같은 입력당 2회까지" },
      { decision: "거부", when: "근거를 찾을 수 없다" },
    ],
  },
  ai_reject: {
    label: "AI가 거부로 판정함",
    summary: "규칙이 못 가른 것을 AI 심사가 갈랐습니다. 사유를 확인하고 묶어서 처리할 수 있습니다.",
    question: "AI가 든 사유가 맞습니까?",
    hints: [
      { decision: "선택 거부", when: "사유가 맞다 — 스타터 템플릿, 라이브러리, 강의 자료, 문서 사이트 같은 것" },
      { decision: "개별 승인", when: "AI가 틀렸다 — 사유를 남기면 AI 판정과 별개로 기록됩니다" },
    ],
  },
  resolved: {
    label: "지금 기준으로는 보류가 아님",
    summary: "판정한 뒤 시간이 지났거나 기준이 바뀌어, 다시 판정하면 승인이나 거부로 갈립니다.",
    question: "사람이 볼 필요가 없습니다.",
    hints: [
      { decision: "재판정", when: "크롤 설정에서 재판정하면 큐에서 한 번에 빠집니다" },
      { decision: "직접 결정", when: "지금 처리하고 싶다면 각 항목의 근거에 새 판정이 적혀 있습니다" },
    ],
  },
  unknown: {
    label: "갈래를 다시 계산하지 못함",
    summary: "원본이 없어 규칙을 되짚을 수 없습니다. 추가 수집을 걸거나 직접 확인해주세요.",
    question: "원본 없이 판단해야 합니다.",
    hints: [{ decision: "추가 수집", when: "원본을 다시 받아온다" }],
  },
};

export const causeLabel = (cause: CauseKey) => CAUSE_GUIDE[cause]?.label ?? cause;
