-- 최초 발굴 글의 출처만 보존한다. 기존 행/심사 판정/화제성 점수는 바꾸지 않는다.
SET LOCAL lock_timeout = '5s';
ALTER TABLE crawl_frontier ADD COLUMN discovery_source jsonb;
