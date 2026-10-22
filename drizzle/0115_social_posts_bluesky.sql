-- Bluesky 화제 수집(2026-10-22, bluesky-talk 잡) — social_posts 의 출처 목록에 bluesky 를 더한다(lib/social/bluesky-talk.ts).
-- 제약 하나만 바꾼다: 열·색인·다른 표는 그대로다. 새 목록이 옛 값(hn·geeknews·x)을 모두 담으므로 기존 행은 그대로 통과한다.
-- 표가 작아(수천 줄) 다시 거는 검사는 순간이다 — migrate.mjs 의 lock_timeout 10초 안에서 끝난다. 다시 돌려도 같다(IF EXISTS).
ALTER TABLE "social_posts" DROP CONSTRAINT IF EXISTS "social_posts_source_check";
--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_source_check" CHECK (source IN ('hn','geeknews','x','bluesky'));
