import type { RelationshipState } from "@/lib/db/schema";

/**
 * 공개 화면 용어표(2026-10-08 UX 감사 UX-14) — 내부 용어·영어를 방문자가 읽는 말로 바꾼 것.
 *
 * 같은 뜻은 같은 말로 쓴다. 화면에 아래 옛말을 새로 쓰지 말고 이 상수를 가져다 쓴다.
 * 옛말 → 새말:
 *   미클레임 → 운영자 미확인 · 최근 push(푸시) → 최근 코드 업데이트 · 최신 release → 최신 버전
 *   7일 푸시 → 최근 7일 업데이트 · 이번 주 태어난 → 이번 주 새로 생긴 · 서비스 연결 → 사이트와 저장소
 *   "Build something. Ship it." → FOOTER_SLOGAN · "Launch with /nomorevibe" → LAUNCH_TITLE
 * 응답 시간(ms)은 용어가 아니라 자리의 문제다 — 상세의 툴팁(title)으로만 보인다.
 */

/** 우리가 찾아 올렸고 주인이 아직 확인하지 않은 프로젝트(view.ts isUnclaimed) — 옛 '미클레임' */
export const UNCLAIMED_LABEL = "운영자 미확인";
/** UNCLAIMED_LABEL 옆 툴팁 */
export const UNCLAIMED_HINT = "공개 정보로 우리가 찾아 올린 프로젝트입니다. 아직 운영자가 직접 확인하지 않았습니다.";

/** 저장소에 마지막으로 코드가 올라온 때(GitHub pushed_at) — 옛 '최근 push'·'최근 푸시' */
export const LAST_CODE_UPDATE_LABEL = "최근 코드 업데이트";
/** 가장 최근 GitHub 릴리스 — 옛 '최신 release' */
export const LATEST_VERSION_LABEL = "최신 버전";
/** 지난 7일 동안 코드가 올라온 횟수 — 옛 '7일 푸시' */
export const RECENT_WEEK_UPDATES_LABEL = "최근 7일 업데이트";

/** 저장소를 처음 만든 날이 끝난 7일 안인 프로젝트 수의 이름 — 옛 '이번 주 태어난' */
export const NEW_THIS_WEEK_LABEL = "이번 주 새로 생긴";
/** 같은 집계를 집계 기준 창에서 부르는 이름 — 옛 '태어난 프로젝트' */
export const NEW_PROJECTS_LABEL = "새로 생긴 프로젝트";

/** 정보 카드의 '사이트 ↔ 저장소' 줄 이름 — 옛 '서비스 연결' */
export const SITE_REPO_RELATION_LABEL = "사이트와 저장소";
/** 그 줄의 값 — 누가 누구의 주소를 적어 두었는지를 그대로 말한다 */
export const SITE_REPO_RELATION: Record<RelationshipState, string> = {
  bidirectional: "서로 주소를 적어 둠",
  site_link: "사이트에 이 저장소 주소가 있음",
  repository_link: "저장소에 이 사이트 주소가 있음",
  maker_reported: "메이커가 알려 줌 · 확인 전",
  disconnected: "연결이 끊김",
};

/** 상세 소개 아래 출처 — 옛 '자동 감지 · 저장소 README 기준' */
export const README_INTRO_SOURCE = "저장소 README에서 가져옴";
/** 카드·상세의 공유 미리보기 이미지 설명 — 옛 '공개 페이지 대표 이미지' */
export const PREVIEW_IMAGE_LABEL = "사이트 미리보기 이미지";

/** 푸터 한 줄 — 옛 "Build something. Ship it." */
export const FOOTER_SLOGAN = "만들고, 세상에 내놓으세요.";
/** /launch 제목 조각(pageTitle 에 넘긴다) — 옛 "Launch with /nomorevibe" */
export const LAUNCH_TITLE = "프로젝트 공개하기";
