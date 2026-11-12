import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";

/**
 * 운영 콘솔 글꼴(2026-11-12 「1인 운영 콘솔 시안」) — 본문 IBM Plex Sans KR, 숫자·사실 줄·눈썹은 IBM Plex Mono.
 * next/font 가 빌드 때 받아 같은 주소에서 내준다(브라우저는 Google 에 묻지 않는다). 관리자 layout 에서만 쓰고 공개 사이트는 시스템 글꼴 그대로다.
 * 글꼴 이름은 CSS 변수로만 넘긴다 — prototype.css 의 --f-sans·--f-mono 가 이 변수를 맨 앞에 두고 시스템 글꼴로 이어 간다.
 * 한국어 글자는 Google 이 나눠 둔 조각(unicode-range)마다 쓰일 때만 받는다 — 미리 받는 것은 latin 조각뿐이다.
 */
const sans = IBM_Plex_Sans_KR({ weight: ["400", "500", "600"], subsets: ["latin"], display: "swap", variable: "--font-console-sans" });
const mono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], display: "swap", variable: "--font-console-mono" });

/** 관리자 화면을 감싸는 칸에 다는 클래스 — 두 글꼴 변수를 정의한다 */
export const CONSOLE_FONT_CLASS = [sans.variable, mono.variable].filter(Boolean).join(" ");
