-- 공개 제품의 GitHub 저장소가 사라졌는지 — product-stars-refresh 가 이미 부르는 GET /repos/{owner}/{repo} 의 답을 적는다.
-- 확정적인 답만 적는다: 'ok'(200) · 'not_found'(404) · 'blocked'(451, 한도가 아닌 403). 시간 초과·5xx 는 적지 않는다.
-- repo_missing_since 는 지금 이어지는 404 의 시작 — 200 이 오면 비운다. 하루 넘게 404 가 이어져야 사라졌다고 본다(repository.ts repoGone).
-- 값이 없는 열만 더한다(테이블을 다시 쓰지 않는다). 옛 코드는 이 열을 모르고 그대로 돈다
ALTER TABLE "products" ADD COLUMN "repo_status" varchar(16);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "repo_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "repo_missing_since" timestamp;
