-- 0160 (2026-11-01): 장부 두 표(model_capacity_requests·model_capacity_events)의 "live rebuild" 로 자란 CHECK 여섯 개를 그대로 트리거로 옮긴다.
-- 0159 는 아직 병합되지 않은 PR #772 의 번호다 — 이 파일은 0160 이고, 0159 가 뒤에 병합되면 그쪽이 when 을 더 뒤로 받아야 한다(drizzle 은 when 순서로 건너뛴다).
--
-- 왜: 0096·0099·0118·0125·0149·0151·0155·0157·0158 이 "(이전 술어 전체) OR (가지)" 로 CHECK 를 다시 만들어 dispatch_check 586KB(conbin 7.0MB)·
-- terminal_check 515KB(6.2MB)·events terminal_check 650KB(8.4MB) 가 됐다. PostgreSQL 은 INSERT/UPDATE 문마다 ExecRelCheck 에서 conbin 을
-- stringToNode → expression_planner → ExecInitExpr 로 다시 세우므로 행 한 건 쓰기가 약 66ms(이 CHECK 없이 4ms)였다(docs/operations/2026-11-01-ledger-check-cost.md).
-- PL/pgSQL 트리거 안의 SELECT 는 세션마다 한 번 계획이 캐시되므로 같은 술어를 거기서 평가하면 문장마다 ExecInitExpr 만 남는다(실측 6.4ms).
--
-- 어떻게(기계적, 글자 하나 고치지 않는다):
--   1. model_capacity_check_rules — 표·제약 이름·순번·술어(pg_get_expr(conbin), 지금 PostgreSQL 이 저장한 그대로의 정규형)를 행으로 둔다.
--   2. nmv_model_capacity_check_guard_rebuild(표) — 그 행들로 nmv_<표>_check_guard() 트리거 함수를 (다시) 만든다. 제약 이름은 알파벳 순서(CHECK 평가 순서와 같다),
--      같은 제약의 가지(ordinal)는 OR 로 왼쪽부터 평가하고 TRUE 가 나오면 멈춘다(SQL OR 의 3값 논리·단락과 같다). 결과가 FALSE 일 때만
--      ERRCODE 23514·CONSTRAINT·TABLE·SCHEMA 를 원래 제약과 같게 RAISE 한다(NULL 은 CHECK 처럼 통과). 열 참조는 `FROM (SELECT (NEW).*) AS <표>` 로 NEW 에 맺는다.
--   3. 표마다 BEFORE INSERT OR UPDATE FOR EACH ROW 트리거(<표>_zz_check_guard — 기존 guard 트리거 뒤에 오도록 이름을 zz 로 둔다; CHECK 는 늘 BEFORE 트리거 뒤였다).
--   4. 여섯 CHECK 를 DROP 한다. 남은 작은 CHECK(class·epoch·hash·identity·ordinal·pool·state·token / id·epoch·hash·state·reason·evidence)는 그대로다.
--
-- 앞으로 가지를 더할 때: 통째 OR 재조립 대신 model_capacity_check_rules 에 (표, 제약 이름, 다음 ordinal, 가지) 행 하나를 INSERT 하고
-- SELECT nmv_model_capacity_check_guard_rebuild('<표>') 를 부른다. 트리거는 새 쓰기만 검사한다(기존 행은 CHECK 가 받아들였던 행이므로 상태가 같다).
-- 함수 본문·행·해시·인덱스·권한은 바뀌지 않는다. 되돌리기: 트리거·함수를 지우고 rules 의 ordinal 1 술어로 ADD CONSTRAINT ... CHECK (...) 를 다시 건다.
--> statement-breakpoint
CREATE TABLE model_capacity_check_rules (
  table_name text NOT NULL,
  constraint_name text NOT NULL,
  ordinal integer NOT NULL,
  predicate text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_capacity_check_rules_pk PRIMARY KEY (table_name, constraint_name, ordinal),
  CONSTRAINT model_capacity_check_rules_table_check CHECK (table_name IN ('model_capacity_requests','model_capacity_events')),
  CONSTRAINT model_capacity_check_rules_ordinal_check CHECK (ordinal >= 1),
  CONSTRAINT model_capacity_check_rules_predicate_check CHECK (char_length(btrim(predicate)) > 0 AND position('$guard$' IN predicate) = 0),
  CONSTRAINT model_capacity_check_rules_source_check CHECK (char_length(btrim(source)) > 0)
);
--> statement-breakpoint
COMMENT ON TABLE model_capacity_check_rules IS '0160: 장부 CHECK 술어(제약 이름·가지 순번). nmv_model_capacity_check_guard_rebuild(표) 가 이 행들로 nmv_<표>_check_guard() 를 만든다.';
--> statement-breakpoint
CREATE FUNCTION nmv_model_capacity_check_guard_rebuild(tbl text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  rule record;
  body text := '';
  current_name text := NULL;
  rules integer := 0;
  violation text;
BEGIN
  IF tbl NOT IN ('model_capacity_requests','model_capacity_events') THEN RAISE EXCEPTION 'model_capacity_check_rules_table_unknown: %', tbl; END IF;
  FOR rule IN SELECT constraint_name, ordinal, predicate FROM model_capacity_check_rules WHERE table_name = tbl ORDER BY constraint_name, ordinal LOOP
    IF position('$guard$' IN rule.predicate) > 0 THEN RAISE EXCEPTION 'model_capacity_check_rules_quoting_tag_collision: %', rule.constraint_name; END IF;
    IF rule.constraint_name IS DISTINCT FROM current_name THEN
      IF current_name IS NOT NULL THEN
        body := body || format(E'  IF ok IS FALSE THEN RAISE EXCEPTION USING ERRCODE = ''23514'', CONSTRAINT = %L, TABLE = %L, SCHEMA = ''public'', MESSAGE = %L, DETAIL = ''Failing row contains '' || left(NEW::text, 4000) || ''.''; END IF;\n',
          current_name, tbl, format('new row for relation "%s" violates check constraint "%s"', tbl, current_name));
      END IF;
      current_name := rule.constraint_name;
      body := body || E'  ok := false;\n';
    END IF;
    body := body || format(E'  IF ok IS NOT TRUE THEN SELECT (%s) INTO leaf FROM (SELECT (NEW).*) AS %I; ok := ok OR leaf; END IF;\n', rule.predicate, tbl);
    rules := rules + 1;
  END LOOP;
  IF rules = 0 THEN RAISE EXCEPTION 'model_capacity_check_rules_empty: %', tbl; END IF;
  body := body || format(E'  IF ok IS FALSE THEN RAISE EXCEPTION USING ERRCODE = ''23514'', CONSTRAINT = %L, TABLE = %L, SCHEMA = ''public'', MESSAGE = %L, DETAIL = ''Failing row contains '' || left(NEW::text, 4000) || ''.''; END IF;\n',
    current_name, tbl, format('new row for relation "%s" violates check constraint "%s"', tbl, current_name));
  EXECUTE format('CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql SET plan_cache_mode = force_generic_plan AS $guard$ DECLARE ok boolean; leaf boolean; BEGIN%s  RETURN NEW; END $guard$',
    'nmv_' || tbl || '_check_guard', E'\n' || body);
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION nmv_model_capacity_check_guard_rebuild(text) IS '0160: model_capacity_check_rules 의 행으로 nmv_<표>_check_guard() 트리거 함수를 다시 만든다. 가지를 더한 뒤 반드시 부른다.';
--> statement-breakpoint
DO $$
DECLARE
  tbl text;
  n text;
  names text[];
  moved integer := 0;
  expression text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['model_capacity_requests','model_capacity_events'] LOOP
    names := CASE tbl
      WHEN 'model_capacity_requests' THEN ARRAY['model_capacity_requests_dispatch_check','model_capacity_requests_logical_check','model_capacity_requests_members_check','model_capacity_requests_terminal_check']
      ELSE ARRAY['model_capacity_events_kind_check','model_capacity_events_terminal_check'] END;
    FOREACH n IN ARRAY names LOOP
      SELECT pg_get_expr(conbin, conrelid) INTO STRICT expression FROM pg_constraint WHERE conrelid = tbl::regclass AND conname = n AND contype = 'c';
      INSERT INTO model_capacity_check_rules(table_name, constraint_name, ordinal, predicate, source) VALUES (tbl, n, 1, expression, '0160_ledger_check_rules');
      moved := moved + 1;
    END LOOP;
    PERFORM nmv_model_capacity_check_guard_rebuild(tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION %I()', tbl || '_zz_check_guard', tbl, 'nmv_' || tbl || '_check_guard');
    FOREACH n IN ARRAY names LOOP EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, n); END LOOP;
  END LOOP;
  IF moved <> 6 THEN RAISE EXCEPTION 'model_capacity_check_rules_moved_unexpected: %', moved; END IF;
END $$;
