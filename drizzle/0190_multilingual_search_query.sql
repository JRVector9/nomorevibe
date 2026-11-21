-- Widen the active websearch dispatch and terminal guards, including local-direct.
-- Since 0160 the guards use stored predicates. The original branch is deparsed SQL.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  normalized_old constant text := $sql$sourceLocale'::text) = ANY (ARRAY['ko'::text, 'zh-Hans'::text, 'zh-Hant'::text]$sql$;
  normalized_new constant text := $sql$sourceLocale'::text) = ANY (ARRAY['ko'::text, 'zh-Hans'::text, 'zh-Hant'::text, 'ja'::text, 'han'::text]$sql$;
  literal_old constant text := $sql$sourceLocale' IN ('ko','zh-Hans','zh-Hant')$sql$;
  literal_new constant text := $sql$sourceLocale' IN ('ko','zh-Hans','zh-Hant','ja','han')$sql$;
  guard_name text;
BEGIN
  FOREACH guard_name IN ARRAY ARRAY[
    'model_capacity_requests_dispatch_check',
    'model_capacity_requests_terminal_check',
    'model_capacity_events_terminal_check'
  ] LOOP
    UPDATE model_capacity_check_rules
       SET predicate = replace(replace(predicate, normalized_old, normalized_new), literal_old, literal_new)
     WHERE constraint_name = guard_name
       AND (strpos(predicate, normalized_old) > 0 OR strpos(predicate, literal_old) > 0);

    IF NOT EXISTS (SELECT FROM model_capacity_check_rules WHERE constraint_name = guard_name AND strpos(predicate, normalized_new) > 0)
      OR NOT EXISTS (SELECT FROM model_capacity_check_rules WHERE constraint_name = guard_name AND strpos(predicate, literal_new) > 0) THEN
      RAISE EXCEPTION 'multilingual_search_guard_not_widened: %', guard_name;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');
