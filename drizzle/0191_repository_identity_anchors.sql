-- 0191 저장소 id 근거 보존(2026-11-21 전수 점검 W0-1 · 소유자 규칙 2026-11-15 「아이디 근거 사라지지 않도록해야해」).
--
-- 메이커 소유 확인(lib/me/maker-claims.ts)은 «우리가 전에 본 그 저장소의 id» 와 지금 GitHub 의 id 를 맞춰 본다. 그 id 가 남는 세 곳은 모두
-- 마지막 값만 갖는다 — crawl_documents.repo_meta(다시 수집하면 덮는다), product_evidence_sources.normalized_facts(갱신마다 덮는다),
-- product_star_observations(7일 보관). 이 표는 저장소 이름(소문자 owner/repo)마다 우리가 본 id 를 덧붙이기만 한다.
--
-- 보존: 세 표의 트리거가 id 를 남긴다 — 행이 생길 때의 값, 값이 바뀔 때의 **옛 값과 새 값**, 행이 지워질 때의 값. 앱 코드의 쓰기 경로가 늘어도 빠지지 않는다.
--   id 가 그대로인 갱신(하루 수십만 번의 재수집·README·보관 정리)은 WHEN 에서 걸러 함수를 부르지 않는다 — 근거 표에 쓰기가 없다.
--   근거 쓰기는 원래 쓰기와 같은 트랜잭션이다 — 옛 id 를 남기지 못하면 덮어쓰기도 commit 되지 않는다. 모양이 맞지 않는 값만 조용히 건너뛴다.
-- 검사: 근거 행은 지울 수 없고(DELETE·TRUNCATE 거절) 마지막 본 시각을 앞으로 옮기는 것 말고는 고칠 수 없다. 보관 정리(db-retention)도 이 표를 건드리지 않는다.
--
-- 함수는 SECURITY INVOKER 다(재생 handler profile 이 SECURITY DEFINER 트리거를 거절한다). 근거를 남기는 쓰기(새 행·id 바뀜·지움)를 하는 계정은
-- 이 표에 SELECT·INSERT·UPDATE 권한이 있어야 한다 — 표 소유 계정(웹·워커·migration)은 그대로 된다.
--
-- 표 잠금: CREATE TRIGGER 는 세 표에 SHARE ROW EXCLUSIVE 를 잡는다(읽기는 막지 않고 쓰기만 기다린다). 그래서 트리거를 맨 끝에 만든다 —
-- 잡은 뒤 commit 까지 남은 문장이 없다. 긴 쓰기 트랜잭션 뒤에서 5초 넘게 기다리면 물러난다(lock_timeout).
-- 기존 행은 이 마이그레이션이 옮기지 않는다 — scripts/ops/backfill-repository-identity-anchors.ts 가 묶음으로 옮긴다(3.5GB 표를 migration 트랜잭션에서 읽지 않는다).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 저장소 열쇠: 소문자 owner/repo(200자까지, ASCII 만). 모양이 다르면 NULL(남기지 않는다). 길이는 정규식 밖에서 잰다 — 횟수를 정한 반복({1,100})은 느리다
CREATE FUNCTION nmv_repository_anchor_key(repo text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN char_length(repo) <= 200 AND repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' THEN lower(repo) END
$$;
--> statement-breakpoint
-- 근거 값: repo_id 는 양의 정수 글자(16자리까지), node_id 는 앞뒤 공백을 뗀 1~200자(공백 없음). 모양이 다르면 NULL
CREATE FUNCTION nmv_repository_anchor_value(kind text, value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE kind
    WHEN 'repo_id' THEN CASE WHEN char_length(value) <= 16 AND value ~ '^[1-9][0-9]*$' THEN value END
    WHEN 'node_id' THEN CASE WHEN char_length(btrim(value, E' \t\n\r')) BETWEEN 1 AND 200 AND btrim(value, E' \t\n\r') !~ '[[:space:]]'
      THEN btrim(value, E' \t\n\r') END
  END
$$;
--> statement-breakpoint
CREATE TABLE repository_identity_anchors (
  repo_key varchar(200) NOT NULL,
  kind varchar(8) NOT NULL,
  value varchar(200) NOT NULL,
  -- 이 근거를 처음 남긴 출처: crawl_document · evidence_source · star_observation
  source varchar(24) NOT NULL,
  -- 백필한 행은 그때 출처에 남아 있던 관측 시각이다(더 일찍 봤더라도 알 수 없다)
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repository_identity_anchors_pkey PRIMARY KEY (repo_key, kind, value),
  CONSTRAINT repository_identity_anchors_kind_check CHECK (kind IN ('repo_id', 'node_id')),
  -- 검증 함수가 NULL(모양이 다름)을 내면 거절한다 — «=» 는 NULL 을 통과시키므로 IS NOT DISTINCT FROM
  CONSTRAINT repository_identity_anchors_key_check CHECK (repo_key IS NOT DISTINCT FROM nmv_repository_anchor_key(repo_key)),
  CONSTRAINT repository_identity_anchors_value_check CHECK (value IS NOT DISTINCT FROM nmv_repository_anchor_value(kind, value)),
  CONSTRAINT repository_identity_anchors_source_check CHECK (source ~ '^[a-z_]{1,24}$'),
  CONSTRAINT repository_identity_anchors_seen_check CHECK (last_seen_at >= first_seen_at)
);
--> statement-breakpoint
-- 주어진 관측(같은 차례의 배열 넷)에서 모양이 맞는 것만, 같은 근거는 하나로. 시각은 지금보다 앞서지 않는다
CREATE FUNCTION nmv_repository_identity_anchor_rows(p_repos text[], p_kinds text[], p_values text[], p_seen timestamptz[])
RETURNS TABLE (repo_key text, kind text, value text, first_seen timestamptz, last_seen timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT g.repo_key, g.kind, g.value, min(g.seen), max(g.seen)
  FROM (SELECT nmv_repository_anchor_key(u.repo) AS repo_key, u.kind, nmv_repository_anchor_value(u.kind, u.value) AS value,
          least(coalesce(u.seen, now()), now()) AS seen
        FROM unnest(p_repos, p_kinds, p_values, p_seen) AS u(repo, kind, value, seen)) g
  WHERE g.repo_key IS NOT NULL AND g.value IS NOT NULL
  GROUP BY g.repo_key, g.kind, g.value
$$;
--> statement-breakpoint
-- 근거를 남긴다(트리거와 백필이 같이 쓴다). 없는 근거만 넣고, 이미 있으면 마지막 본 시각만 — 하루 넘게 앞설 때만 — 옮긴다. 새로 넣은 수를 돌려준다.
-- 넣기·잠그기는 늘 (repo_key, kind, value) 차례다 — 여러 저장소를 한 번에 남기는 쓰기끼리 서로를 기다리며 엇갈리지 않게.
CREATE FUNCTION nmv_record_repository_identity_anchors(p_repos text[], p_kinds text[], p_values text[], p_seen timestamptz[], p_source text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  given integer;
  added integer;
BEGIN
  IF p_repos IS NULL OR cardinality(p_repos) = 0 THEN
    RETURN 0;
  END IF;
  WITH observed AS (
    SELECT * FROM nmv_repository_identity_anchor_rows(p_repos, p_kinds, p_values, p_seen)
  ), inserted AS (
    INSERT INTO repository_identity_anchors (repo_key, kind, value, source, first_seen_at, last_seen_at)
    SELECT r.repo_key, r.kind, r.value, p_source, r.first_seen, r.last_seen FROM observed r ORDER BY r.repo_key, r.kind, r.value
    ON CONFLICT (repo_key, kind, value) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM observed), (SELECT count(*) FROM inserted) INTO given, added;
  IF given > added THEN
    WITH due AS (
      SELECT a.repo_key, a.kind, a.value, r.last_seen
      FROM nmv_repository_identity_anchor_rows(p_repos, p_kinds, p_values, p_seen) r
        JOIN repository_identity_anchors a ON a.repo_key = r.repo_key AND a.kind = r.kind AND a.value = r.value
      WHERE a.last_seen_at < r.last_seen - interval '1 day'
      ORDER BY a.repo_key, a.kind, a.value
      FOR UPDATE OF a
    )
    UPDATE repository_identity_anchors a SET last_seen_at = due.last_seen
    FROM due WHERE a.repo_key = due.repo_key AND a.kind = due.kind AND a.value = due.value;
  END IF;
  RETURN added;
END;
$$;
--> statement-breakpoint
-- 지우지 못하는 근거: 지우기·비우기와, 마지막 본 시각을 앞으로 옮기는 것 말고의 고치기를 DB 가 거절한다(0056 operations_audit 와 같은 방식)
CREATE FUNCTION repository_identity_anchors_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.repo_key = OLD.repo_key AND NEW.kind = OLD.kind AND NEW.value = OLD.value AND NEW.source = OLD.source
    AND NEW.first_seen_at = OLD.first_seen_at AND NEW.last_seen_at >= OLD.last_seen_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'repository_identity_anchors is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_identity_anchors_no_change BEFORE UPDATE OR DELETE ON repository_identity_anchors
  FOR EACH ROW EXECUTE FUNCTION repository_identity_anchors_append_only();
--> statement-breakpoint
CREATE TRIGGER repository_identity_anchors_no_truncate BEFORE TRUNCATE ON repository_identity_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION repository_identity_anchors_append_only();
--> statement-breakpoint
ALTER TABLE repository_identity_anchors ENABLE ALWAYS TRIGGER repository_identity_anchors_no_change;
--> statement-breakpoint
ALTER TABLE repository_identity_anchors ENABLE ALWAYS TRIGGER repository_identity_anchors_no_truncate;
--> statement-breakpoint
-- 수집 원본: repo_meta 의 id(숫자 저장소 id)·node_id. 옛 값의 시각은 그 원본을 받은 시각(fetched_at, UTC 벽시계)이다
CREATE FUNCTION nmv_crawl_documents_identity_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  repos text[] := '{}';
  vals text[] := '{}';
  seen timestamptz[] := '{}';
BEGIN
  IF TG_OP <> 'INSERT' THEN
    repos := ARRAY[OLD.repo::text, OLD.repo::text];
    vals := ARRAY[OLD.repo_meta->>'id', CASE WHEN jsonb_typeof(OLD.repo_meta->'node_id') = 'string' THEN OLD.repo_meta->>'node_id' END];
    seen := ARRAY[OLD.fetched_at AT TIME ZONE 'UTC', OLD.fetched_at AT TIME ZONE 'UTC'];
  END IF;
  IF TG_OP <> 'DELETE' THEN
    repos := repos || ARRAY[NEW.repo::text, NEW.repo::text];
    vals := vals || ARRAY[NEW.repo_meta->>'id', CASE WHEN jsonb_typeof(NEW.repo_meta->'node_id') = 'string' THEN NEW.repo_meta->>'node_id' END];
    seen := seen || ARRAY[now(), now()];
  END IF;
  PERFORM nmv_record_repository_identity_anchors(repos,
    CASE WHEN cardinality(repos) = 4 THEN ARRAY['repo_id', 'node_id', 'repo_id', 'node_id'] ELSE ARRAY['repo_id', 'node_id'] END,
    vals, seen, 'crawl_document');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- 사실 수집: 저장소 출처(kind = 'repository', source_key = 소문자 owner/repo)의 normalized_facts.repositoryId
CREATE FUNCTION nmv_evidence_sources_identity_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  repos text[] := '{}';
  vals text[] := '{}';
  seen timestamptz[] := '{}';
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.kind = 'repository' THEN
    repos := ARRAY[OLD.source_key::text];
    vals := ARRAY[OLD.normalized_facts->>'repositoryId'];
    seen := ARRAY[coalesce(OLD.last_success_at, OLD.observed_at, OLD.updated_at) AT TIME ZONE 'UTC'];
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.kind = 'repository' THEN
    repos := repos || NEW.source_key::text;
    vals := vals || (NEW.normalized_facts->>'repositoryId');
    seen := seen || now();
  END IF;
  PERFORM nmv_record_repository_identity_anchors(repos, array_fill('repo_id'::text, ARRAY[cardinality(repos)]), vals, seen, 'evidence_source');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- 스타 관측: repository_key(소문자 owner/repo)와 repository_id(GraphQL node id). 한 문장이 여러 저장소를 쓰므로 문장 단위로 모아 한 번에 남긴다
CREATE FUNCTION nmv_star_observations_identity_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  repos text[];
  vals text[];
  seen timestamptz[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(o.repository_key::text), array_agg(o.repository_id::text), array_agg(o.observed_at) INTO repos, vals, seen
    FROM anchor_new_rows o WHERE o.repository_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(o.repository_key::text), array_agg(o.repository_id::text), array_agg(o.observed_at) INTO repos, vals, seen
    FROM anchor_old_rows o WHERE o.repository_id IS NOT NULL;
  ELSE
    SELECT array_agg(o.repository_key::text), array_agg(o.repository_id::text), array_agg(o.observed_at) INTO repos, vals, seen
    FROM (SELECT repository_key, repository_id, observed_at FROM anchor_old_rows
          UNION ALL SELECT repository_key, repository_id, observed_at FROM anchor_new_rows) o
    WHERE o.repository_id IS NOT NULL;
  END IF;
  IF repos IS NOT NULL THEN
    PERFORM nmv_record_repository_identity_anchors(repos, array_fill('node_id'::text, ARRAY[cardinality(repos)]), vals, seen, 'star_observation');
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER crawl_documents_identity_anchor_insert AFTER INSERT ON crawl_documents
  FOR EACH ROW WHEN (NEW.repo_meta ? 'id' OR NEW.repo_meta ? 'node_id')
  EXECUTE FUNCTION nmv_crawl_documents_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER crawl_documents_identity_anchor_update AFTER UPDATE OF repo_meta, repo ON crawl_documents
  FOR EACH ROW WHEN (OLD.repo IS DISTINCT FROM NEW.repo
    OR (OLD.repo_meta->>'id') IS DISTINCT FROM (NEW.repo_meta->>'id')
    OR (OLD.repo_meta->>'node_id') IS DISTINCT FROM (NEW.repo_meta->>'node_id'))
  EXECUTE FUNCTION nmv_crawl_documents_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER crawl_documents_identity_anchor_delete AFTER DELETE ON crawl_documents
  FOR EACH ROW WHEN (OLD.repo_meta ? 'id' OR OLD.repo_meta ? 'node_id')
  EXECUTE FUNCTION nmv_crawl_documents_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER product_evidence_sources_identity_anchor_insert AFTER INSERT ON product_evidence_sources
  FOR EACH ROW WHEN (NEW.kind = 'repository' AND NEW.normalized_facts ? 'repositoryId')
  EXECUTE FUNCTION nmv_evidence_sources_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER product_evidence_sources_identity_anchor_update AFTER UPDATE OF normalized_facts, source_key, kind ON product_evidence_sources
  FOR EACH ROW WHEN ((OLD.kind = 'repository' OR NEW.kind = 'repository')
    AND (OLD.kind IS DISTINCT FROM NEW.kind OR OLD.source_key IS DISTINCT FROM NEW.source_key
      OR (OLD.normalized_facts->>'repositoryId') IS DISTINCT FROM (NEW.normalized_facts->>'repositoryId')))
  EXECUTE FUNCTION nmv_evidence_sources_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER product_evidence_sources_identity_anchor_delete AFTER DELETE ON product_evidence_sources
  FOR EACH ROW WHEN (OLD.kind = 'repository' AND OLD.normalized_facts ? 'repositoryId')
  EXECUTE FUNCTION nmv_evidence_sources_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER product_star_observations_identity_anchor_insert AFTER INSERT ON product_star_observations
  REFERENCING NEW TABLE AS anchor_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nmv_star_observations_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER product_star_observations_identity_anchor_update AFTER UPDATE ON product_star_observations
  REFERENCING OLD TABLE AS anchor_old_rows NEW TABLE AS anchor_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nmv_star_observations_identity_anchor();
--> statement-breakpoint
CREATE TRIGGER product_star_observations_identity_anchor_delete AFTER DELETE ON product_star_observations
  REFERENCING OLD TABLE AS anchor_old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION nmv_star_observations_identity_anchor();
