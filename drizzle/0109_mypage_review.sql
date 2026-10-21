-- 마이페이지 전체 리뷰(2026-10-21) 뒷정리 — 0108 은 운영에 적용됐으므로 고치지 않고 여기에 더한다.
-- CONCURRENTLY 는 쓸 수 없다 — 마이그레이터가 밀린 마이그레이션 전체를 한 트랜잭션으로 돌린다(0024·0058 주석).
-- 네 표 모두 0108 에서 새로 만든 작은 표라 색인 만들기의 SHARE 잠금(그 표의 쓰기만 기다리게 하고 읽기는 그대로)은 1초 안이다.
-- products·public_users 는 읽기만 한다(ACCESS SHARE) — 로그인한 요청의 세션 읽기를 막지 않는다.

-- 제품을 지우면(메이커가 승인한 완전 삭제) FK cascade 가 product_id 로 지운다 — 색인이 없으면 제품 잠금을 쥔 채 표 전체를 훑는다.
-- 내 프로젝트 탭의 제품별 저장 수도 이 열로 센다
CREATE INDEX IF NOT EXISTS "user_saved_products_product_idx" ON "user_saved_products" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_product_idx" ON "notifications" ("product_id");
--> statement-breakpoint
-- 계정 삭제(lib/me/account.ts)가 이 열로 지운다
CREATE INDEX IF NOT EXISTS "email_outbox_user_idx" ON "email_outbox" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maker_replies_author_idx" ON "maker_replies" ("author_user_id");
--> statement-breakpoint
-- 지운 제품을 가리키는 제품 팔로 — 0108 뒤의 완전 삭제가 남겼다. 이제는 삭제와 같은 트랜잭션에서 지운다(removeProductAndEvidence).
-- 남은 줄은 팔로 탭에 보이지 않아 풀 수 없는데 머리 숫자·팔로 상한에는 들어간다. 제품 id 는 다시 쓰지 않으므로 지운다
DELETE FROM "user_follows" f
 WHERE f."target_type" = 'product'
   AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id"::text = f."target_key");
