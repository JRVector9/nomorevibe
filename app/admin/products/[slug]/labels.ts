import type { DeclarationSource, LinkKind, ProductUpdateSourceKind, RelationshipState, SourceState } from "@/lib/db/schema";
import type { ProductHistoryKind } from "@/lib/domain/products/history";
import { banReasonLabel } from "../ban-reasons";

/**
 * 제품 상세의 상태값 라벨(2026-10-08 UX 감사 ADM-28) — 화면에는 한국어를, 원래 코드는 title 툴팁으로만 보인다.
 * 맵에 없는 코드는 코드 그대로 보인다(새 코드가 생겨도 빈칸이 되지 않게).
 */

export const PRODUCT_STATUS_LABELS: Record<string, string> = {
  verified: "검증됨", seeded: "미클레임", unverified: "검증 대기", banned: "차단됨",
};

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  repository: "저장소", app_store: "App Store", play_store: "Google Play", npm: "npm", pypi: "PyPI", crates: "crates.io",
  documentation: "문서", support: "지원", rss: "RSS", changelog: "변경 기록", video: "영상",
};

export const DECLARATION_LABELS: Record<DeclarationSource, string> = { maker: "메이커 선언", discovered: "수집에서 찾음" };

export const SOURCE_STATE_LABELS: Record<SourceState, string> = {
  unobserved: "아직 확인 안 함", ok: "정상", failed: "실패", stale: "오래됨", disconnected: "연결 끊김",
};

/** 공개 상세(InfoCard)와 같은 말 */
export const RELATIONSHIP_LABELS: Record<RelationshipState, string> = {
  bidirectional: "서비스 ↔ 저장소 연결 확인", site_link: "서비스 → 저장소 링크 확인", repository_link: "저장소 → 서비스 링크 확인",
  maker_reported: "메이커 제공 · 관계 미확인", disconnected: "연결 끊김",
};

export const UPDATE_SOURCE_LABELS: Record<ProductUpdateSourceKind, string> = {
  maker: "메이커", github_release: "GitHub 릴리스", feed: "피드", site_change: "사이트 변경", repository_change: "저장소 변경",
  activity_digest: "활동 요약",
};

/** 외부 출처에서 정규화한 사실의 이름 */
export const FACT_LABELS: Record<string, string> = {
  stars: "스타", forks: "포크", contributors: "기여자", license: "라이선스", relationship: "관계", pushedAt: "마지막 push",
  latestRelease: "최신 릴리스",
};

/** 근거 감사 행(product_evidence_audit) */
export const EVIDENCE_AUDIT_LABELS: Record<string, string> = {
  "admin.product.ban": "차단", "admin.product.unban": "차단 해제", "admin.update.hide": "업데이트 숨김",
  "admin.update.restore": "업데이트 복원", "admin.evidence.refresh.queue": "근거 갱신 예약(관리자)",
  "maker.refresh.queue": "근거 갱신 예약(메이커)", "maker.update.create": "메이커 업데이트 작성", "maker.update.edit": "메이커 업데이트 수정",
  "maker.update.delete": "메이커 업데이트 삭제", "maker.profile.save": "메이커 정보 저장", "maker.links.replace": "메이커 링크 바꿈",
  "maker.links.remove": "메이커 링크 지움", "maker.media.replace": "메이커 이미지 바꿈", "maker.provenance.replace": "빌드 출처 바꿈(메이커)",
  "system.provenance.replace": "빌드 출처 바꿈(시스템)",
};

export const HISTORY_KIND_LABELS: Record<ProductHistoryKind, string> = {
  admin: "작업 로그", review: "심사", audit: "발행분 감사", repo_review: "저장소 확인", status: "상태",
};

/** '이 제품의 기록' 줄의 행동 — 출처마다 코드가 다르다(lib/domain/products/history.ts) */
const HISTORY_ACTION_LABELS: Record<ProductHistoryKind, Record<string, string>> = {
  admin: {
    "product-ban": "차단", "product-unban": "차단 해제", "repo-review-keep": "저장소 사라짐 · 유지", "repo-review-delist": "저장소 사라짐 · 내림",
    "claim-invite": "클레임 초대 보냄", "product-refresh": "근거 갱신 예약", "update-hide": "업데이트 숨김", "update-restore": "업데이트 복원",
    "intro-keep": "소개 그대로 둠", "audit-remove": "감사 · 내림", "audit-keep": "감사 · 유지", "takedown-remove": "내려달라는 요청 · 내림",
    "takedown-dismiss": "내려달라는 요청 · 둠", "candidate-approve": "후보 승인", "candidate-reject": "후보 거부",
    "evidence-collect": "근거 더 모으기", "published-second-keep": "2차 심사 · 유지", "published-second-ban": "2차 심사 · 내림",
  },
  review: {
    "ai-approve": "AI 심사 · 승인", "ai-reject": "AI 심사 · 거부", "ai-needs_review": "AI 심사 · 사람 확인",
    "admin-approve": "관리자 승인", "admin-reject": "관리자 거부",
  },
  audit: {
    "ai-approve": "AI · 문제없음", "ai-reject": "AI · 내릴 후보", "ai-needs_review": "AI · 사람 확인",
    "human-removed": "사람 · 내림", "human-kept": "사람 · 유지",
  },
  repo_review: {
    "ai-keep": "AI · 유지", "ai-delist_candidate": "AI · 내릴 후보", "ai-human": "AI · 사람 확인",
    "operator-keep": "운영자 · 유지", "operator-delist": "운영자 · 내림",
  },
  status: { "admin.product.ban": "차단됨", "admin.product.unban": "차단 풀림" },
};

export function historyActionLabel(kind: ProductHistoryKind, action: string): string {
  return HISTORY_ACTION_LABELS[kind][action] ?? action;
}

/** 기록 줄의 사유 — 차단 사유 코드는 라벨로 */
export function historyNote(kind: ProductHistoryKind, action: string, note: string | null): string | null {
  if (!note) return null;
  const ban = (kind === "status" && action === "admin.product.ban") || (kind === "admin" && action === "product-ban");
  return ban ? note.split(" · ").map(banReasonLabel).join(" · ") : note;
}

export function labelOf(labels: Record<string, string>, code: string | null | undefined): string {
  if (!code) return "—";
  return labels[code] ?? code;
}
