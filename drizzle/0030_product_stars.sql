ALTER TABLE "products" ADD COLUMN "stars" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stars_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "owner_type" varchar(20);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stars_checked_at" timestamp;--> statement-breakpoint
CREATE INDEX "products_public_stars_idx" ON "products" USING btree ("stars" DESC NULLS LAST,"id") WHERE "products"."status" in ('seeded', 'verified') and "products"."stars" >= 2000 and "products"."stars" < 100000;--> statement-breakpoint
CREATE INDEX "products_stars_refresh_idx" ON "products" USING btree ("id") WHERE "products"."status" in ('seeded', 'verified') and "products"."repo_url" is not null;--> statement-breakpoint
-- 제품에 현재 연결된 저장소의 최신 원본부터 고른다. 유효성 조건은 그 다음에 적용한다.
with latest as (
  select distinct on (p.id) p.id, d.repo_meta, d.fetched_at
  from products p join crawl_documents d
    on lower(d.repo) = lower(regexp_replace(p.repo_url, '^https?://(www[.])?github[.]com/([^/]+/[^/#?]+?)([.]git)?/?$', '\2'))
  where p.repo_url ~ '^https?://(www[.])?github[.]com/[^/]+/[^/#?]+/?$'
  order by p.id, d.fetched_at desc, d.id desc
), parsed as (
  select id, fetched_at, repo_meta->'owner'->>'type' owner_type,
    case when jsonb_typeof(repo_meta->'stargazers_count') = 'number'
      and repo_meta->>'stargazers_count' ~ '^[0-9]+$'
      then (repo_meta->>'stargazers_count')::numeric end stars
  from latest
)
update products p set stars = parsed.stars::int, stars_at = parsed.fetched_at,
  owner_type = case when parsed.owner_type in ('User','Organization') then parsed.owner_type end
from parsed where p.id = parsed.id and parsed.stars between 0 and 2147483647;
