-- Add repository work without changing old answers or enabling dispatch/apply.
ALTER TABLE llm_assist_controls DROP CONSTRAINT llm_assist_control_task;
--> statement-breakpoint
ALTER TABLE llm_assist_controls ADD CONSTRAINT llm_assist_control_task CHECK (task IN ('uptime','repo_move'));
--> statement-breakpoint
INSERT INTO llm_assist_controls(task) VALUES ('repo_move');
--> statement-breakpoint
ALTER TABLE llm_assist_work ADD CONSTRAINT llm_assist_work_repo_move_binding CHECK (task <> 'repo_move' OR (
  origin_job = 'product-repo-review'
  AND jsonb_typeof(source->'snapshot') = 'object'
  AND jsonb_typeof(source->'snapshot'->'id') = 'number'
  AND (source->'snapshot'->>'id')::numeric = product_id
  AND jsonb_typeof(source->'snapshot'->'updatedAt') = 'string'
  AND length(source->'snapshot'->>'updatedAt') > 0
  AND jsonb_typeof(source->'snapshot'->'repoUrl') = 'string'
  AND jsonb_typeof(source->'snapshot'->'url') = 'string'
  AND jsonb_typeof(source->'snapshot'->'repoLinkVersion') = 'number'
  AND (source->'snapshot'->>'repoLinkVersion')::numeric BETWEEN 1 AND 9007199254740991
  AND jsonb_typeof(source->'oldRepository') = 'object'
  AND jsonb_typeof(source->'candidates') = 'array'
  AND jsonb_array_length(source->'candidates') BETWEEN 1 AND 3
  AND jsonb_typeof(source->'uncheckedRepositoryUrls') = 'array'
  AND (input IS NULL OR (
    input->>'task' = 'repo' AND input->'subject'->>'type' = 'product'
    AND (input->'subject'->>'id')::numeric = product_id
    AND input->>'policyVersion' = policy_version AND input->>'promptVersion' = prompt_version
    AND input->'context'->>'oldRepositoryUrl' = source->'snapshot'->>'repoUrl'
  ) IS TRUE)
) IS TRUE);
