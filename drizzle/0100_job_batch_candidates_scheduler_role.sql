-- PR11g: the Oracle scheduler's candidate row (role 'scheduler'). Additive only: the existing 0082 role predicate is kept whole as the
-- left operand (PostgreSQL stores it as the identical expression; pg_get_constraintdef proves it) and only the scheduler branch is added,
-- so every existing row still satisfies it. Tables, columns, other constraints, the 0098 trigger and grants are unchanged.
ALTER TABLE job_batch_candidates DROP CONSTRAINT job_batch_candidates_role_check;
--> statement-breakpoint
ALTER TABLE job_batch_candidates ADD CONSTRAINT job_batch_candidates_role_check CHECK ((role IN ('crawler','reviewer','publisher','text','maintenance','translation','product-health','site-evidence','official-news')) OR role = 'scheduler');
