/** Deliberately fictional fixtures for /design. Never import from production data paths. */
export type DemoProduct = {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  type: "launch" | "radar";
  tone: string;
  glyph: string;
  maker: string;
  condition: string;
  task: string;
  needsFeedback: boolean;
  stars?: number;
  repo?: string;
  license?: string;
  updated: boolean;
};
export const products: DemoProduct[] = [
  {
    slug: "frameit",
    name: "FrameIt",
    tagline: "스크린샷을 공유하고 싶은 이미지로 바꿔보세요.",
    category: "디자인",
    type: "launch",
    tone: "violet",
    glyph: "F",
    maker: "Alex Kim",
    condition: "가입 없이 · 무료 체험",
    task: "스크린샷을 꾸미고 이미지로 내보내기",
    needsFeedback: true,
    updated: true,
  },
  {
    slug: "vocalclip",
    name: "VocalClip",
    tagline: "떠오른 생각을 짧고 선명한 오디오 콘텐츠로.",
    category: "콘텐츠",
    type: "launch",
    tone: "navy",
    glyph: "wave",
    maker: "Jin Park",
    condition: "가입 필요 · 카드 불필요",
    task: "텍스트로 첫 음성 클립 만들기",
    needsFeedback: true,
    updated: false,
  },
  {
    slug: "interview-prep",
    name: "Interview Prep AI",
    tagline: "나에게 맞는 질문으로 준비하는 첫 모의 면접.",
    category: "교육",
    type: "launch",
    tone: "blue",
    glyph: "dots",
    maker: "Sora Lee",
    condition: "가입 필요 · 샘플 제공",
    task: "모의 면접을 시작하고 결과 확인하기",
    needsFeedback: false,
    updated: true,
  },
  {
    slug: "notegen",
    name: "NoteGen",
    tagline: "흩어진 메모에서 다음 아이디어를 찾아보세요.",
    category: "생산성",
    type: "launch",
    tone: "navy",
    glyph: "N",
    maker: "Mina Choi",
    condition: "가입 없이 · 샘플 제공",
    task: "샘플 메모를 정리하고 PDF로 내보내기",
    needsFeedback: true,
    updated: true,
  },
  {
    slug: "planty",
    name: "Planty",
    tagline: "내 식물에게 필요한 돌봄을, 제때 알려드려요.",
    category: "라이프스타일",
    type: "launch",
    tone: "green",
    glyph: "leaf",
    maker: "Hana Jung",
    condition: "가입 필요 · 무료",
    task: "식물을 추가하고 첫 돌봄 알림 설정하기",
    needsFeedback: true,
    updated: false,
  },
  {
    slug: "taskwave",
    name: "TaskWave",
    tagline: "할 일을 가볍게 정리하고 중요한 일에 집중하세요.",
    category: "생산성",
    type: "launch",
    tone: "violet",
    glyph: "~",
    maker: "David Kim",
    condition: "가입 없이 · 무료",
    task: "오늘 할 일 세 개를 정리하기",
    needsFeedback: false,
    updated: false,
  },
  {
    slug: "agentdesk",
    name: "AgentDesk",
    tagline: "내 컴퓨터에서 실행하는 AI 에이전트 작업 공간.",
    category: "개발 도구",
    type: "radar",
    tone: "ice",
    glyph: "triangle",
    maker: "메이커 미연결",
    condition: "설치 필요 · API 키 필요",
    task: "설치와 첫 실행 흐름 확인하기",
    needsFeedback: false,
    stars: 12480,
    repo: "agentdesk/agentdesk",
    license: "MIT",
    updated: true,
  },
  {
    slug: "memos",
    name: "MemoS",
    tagline: "언어 모델을 위한 오래 기억하는 메모리 레이어.",
    category: "개발 도구",
    type: "radar",
    tone: "violet",
    glyph: "M",
    maker: "메이커 미연결",
    condition: "설치 필요",
    task: "문서에서 시작 방법 찾기",
    needsFeedback: false,
    stars: 6102,
    repo: "memos-ai/memos",
    license: "Apache-2.0",
    updated: false,
  },
  {
    slug: "ui-bits",
    name: "UI Bits",
    tagline: "아이디어를 빠르게 화면으로 만드는 UI 모음.",
    category: "디자인",
    type: "radar",
    tone: "yellow",
    glyph: "B",
    maker: "메이커 미연결",
    condition: "브라우저에서 보기",
    task: "필요한 컴포넌트 찾기",
    needsFeedback: false,
    stars: 2890,
    repo: "uibits/components",
    updated: false,
  },
];
export const productBySlug = (slug: string) =>
  products.find((p) => p.slug === slug);
export const screens = [
  ["P01", "홈", ""],
  ["P02", "Launches", "launches"],
  ["P03", "Radar", "radar"],
  ["P04", "제품 상세", "p/frameit"],
  ["P05", "제품 등록", "launch"],
  ["P06", "관리 권한 확인", "p/agentdesk/claim"],
  ["P07", "테스트 시작", "p/notegen/test"],
  ["P08", "피드백 작성", "tests/notegen/feedback"],
  ["P09", "피드백 상세", "feedback/f1"],
  ["P10", "미션 탐색", "missions"],
  ["P11", "빌더 대시보드", "dashboard"],
  ["P12", "업데이트 작성", "dashboard/products/frameit/updates/new"],
  ["P13", "크레딧", "credits"],
  ["P14", "크레딧 정책", "credits/how-it-works"],
  ["P15", "피드백 요청", "sprints/new"],
  ["P16", "캠페인 결과", "sprints/demo"],
  ["P17", "Agent Runs", "dashboard/agent-runs"],
  ["P18", "요금 안내", "pricing"],
  ["P18", "청구 관리", "settings/billing"],
  ["P19", "내 활동", "me"],
  ["P19", "알림", "notifications"],
  ["P20", "신뢰 정책", "trust"],
  ["P20", "이의제기", "appeals/demo"],
  ["P21", "운영 검토", "admin/review"],
] as const;
export const href = (path = "") => `/design${path ? "/" + path : ""}`;
export function validDesignPath(path: string) {
  return (
    screens.some((s) => s[2] === path) ||
    (/^p\/[^/]+(?:\/(?:test|claim))?$/.test(path) &&
      !!productBySlug(path.split("/")[1])) ||
    (/^tests\/[^/]+\/feedback$/.test(path) &&
      !!productBySlug(path.split("/")[1])) ||
    /^feedback\/f[\w-]+$/.test(path)
  );
}
