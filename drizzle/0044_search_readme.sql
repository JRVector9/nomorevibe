-- 저장소 README 앞부분을 검색 색인에 넣는다(가장 낮은 무게 D). 공개분 31%가 README 를 갖고 있는데 색인이 읽지 않았다.
-- 생성 컬럼은 지우고 다시 만들지 않고 식만 바꾼다(PG17 SET EXPRESSION) — GIN 인덱스는 그대로 두고 값만 다시 계산한다.
-- 표를 한 번 다시 쓰므로 그동안 products 에 배타 잠금이 걸린다(공개 17,975행, 수 초).
ALTER TABLE "products" ADD COLUMN "search_readme" text;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "search_vector" SET EXPRESSION AS (
    setweight(to_tsvector('english', name), 'A') ||
    setweight(to_tsvector('english', coalesce(search_topics, '')), 'A') ||
    setweight(to_tsvector('english', tagline), 'B') ||
    setweight(to_tsvector('english', case when description = tagline then '' else description end), 'B') ||
    setweight(to_tsvector('english', slug || ' ' ||
      coalesce(regexp_replace(repo_url, '^https?://[^/]+/', ''), '') || ' ' ||
      coalesce(replace(regexp_replace(repo_url, '^https?://[^/]+/', ''), '/', ' '), '') || ' ' ||
      case when source <> 'crawler' or claimed_at is not null then coalesce(builder, '') else '' end), 'C') ||
    setweight(to_tsvector('english', left(coalesce(search_page_text, ''), 2000)), 'D') ||
    setweight(to_tsvector('english', left(coalesce(search_readme, ''), 2000)), 'D'));
