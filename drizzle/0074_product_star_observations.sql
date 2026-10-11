ALTER TABLE "products" ADD COLUMN "repo_link_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE FUNCTION "bump_product_repo_link_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.repo_link_version := CASE WHEN NEW.repo_url IS DISTINCT FROM OLD.repo_url
    THEN OLD.repo_link_version + 1 ELSE OLD.repo_link_version END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "products_repo_link_version" BEFORE UPDATE OF "repo_url", "repo_link_version" ON "products"
FOR EACH ROW EXECUTE FUNCTION "bump_product_repo_link_version"();
--> statement-breakpoint
CREATE TABLE "product_star_observation_runs" (
  "id" serial PRIMARY KEY,
  "cycle_at" timestamptz NOT NULL,
  "window_starts_at" timestamptz NOT NULL,
  "deadline_at" timestamptz NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'preparing',
  "policy_version" varchar(40) NOT NULL,
  "policy" jsonb NOT NULL,
  "target_count" integer NOT NULL DEFAULT 0,
  "success_count" integer NOT NULL DEFAULT 0,
  "failure_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "product_star_observation_runs_status_check" CHECK (status IN ('preparing','collecting','closed','failed')),
  CONSTRAINT "product_star_observation_runs_window_check" CHECK (window_starts_at < deadline_at AND deadline_at = cycle_at),
  CONSTRAINT "product_star_observation_runs_counts_check" CHECK (target_count >= 0 AND success_count >= 0 AND failure_count >= 0 AND success_count + failure_count <= target_count)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_star_observation_runs_cycle_idx" ON "product_star_observation_runs" ("cycle_at");
--> statement-breakpoint
CREATE TABLE "product_star_observations" (
  "run_id" integer NOT NULL REFERENCES "product_star_observation_runs"("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL,
  "slug" varchar(80) NOT NULL,
  "repo_url" text NOT NULL,
  "repository_key" varchar(200) NOT NULL,
  "repository_id" varchar(200),
  "repo_link_version" integer NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "stars" integer,
  "observed_at" timestamptz,
  "archived" boolean,
  "error_class" varchar(64),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  CONSTRAINT "product_star_observations_run_id_product_id_pk" PRIMARY KEY (run_id, product_id),
  CONSTRAINT "product_star_observations_status_check" CHECK (status IN ('pending','ok','not_found','empty','blocked','failed')),
  CONSTRAINT "product_star_observations_value_check" CHECK ((stars IS NULL OR stars >= 0) AND attempts BETWEEN 0 AND 3 AND repo_link_version >= 1 AND (status <> 'ok' OR (stars IS NOT NULL AND observed_at IS NOT NULL AND archived IS NOT NULL AND repository_id IS NOT NULL AND char_length(btrim(repository_id)) > 0)))
);
--> statement-breakpoint
CREATE INDEX "product_star_observations_product_idx" ON "product_star_observations" ("product_id", "run_id");
--> statement-breakpoint
CREATE INDEX "product_star_observations_pending_idx" ON "product_star_observations" ("run_id", "next_attempt_at", "product_id") WHERE status = 'pending';
