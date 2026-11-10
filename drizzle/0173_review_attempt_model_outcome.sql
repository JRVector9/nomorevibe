-- 0173: 사람 몫 위임 검수(human-deepseek-review)의 모델 원래 답 — 2026-11-10 운영자 요청.
-- crawl_review_attempts.outcome 은 확신 문턱(DEEPSEEK_MIN_CONFIDENCE 0.9)·승인 불가 사유·근거 나이 규칙을 적용한 뒤의 결정만 남겨,
-- 「사람에게 남김」이 모델의 판단 보류(근거 부족)인지 확신이 모자란 승인·반려 의견인지 가를 수 없었다. 적용 전 원래 답과 남긴 까닭을
-- 따로 적는다: {"decision": "approve"|"reject"|"needs_review", "confidence": number|null, "holdCause": 원인|null} (lib/crawl/delegated-hold.ts).
-- 위임 시도(kind = 'delegated')가 끝날 때만 쓰고, 옛 행은 NULL 이다(원래 답을 알 수 없음).
--
-- 더하기만 한다: 기본값 없는 NULL 열이라 표를 다시 쓰지 않는다(메타데이터 변경). 옛 코드는 이 열을 읽거나 쓰지 않는다.
-- 새 코드는 이 열을 쓰므로 배포 순서는 migrate → 앱이다(DRAIN 은 이전 코드로).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE crawl_review_attempts ADD COLUMN IF NOT EXISTS model_outcome jsonb;
