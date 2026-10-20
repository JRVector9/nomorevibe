CREATE TABLE "social_posts" (
  "id" serial PRIMARY KEY,
  "source" varchar(16) NOT NULL,
  "external_id" varchar(64) NOT NULL,
  "kind" varchar(12) NOT NULL,
  "title" varchar(300) NOT NULL,
  "link_url" text NOT NULL,
  "link_target" varchar(12) NOT NULL,
  "repository_key" varchar(200),
  "posted_at" timestamptz NOT NULL,
  "points" integer NOT NULL DEFAULT 0,
  "comments" integer NOT NULL DEFAULT 0,
  "front_page" boolean NOT NULL DEFAULT false,
  "state" varchar(12) NOT NULL DEFAULT 'visible',
  "state_reason" varchar(64),
  "state_changed_at" timestamptz,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_posts_source_check" CHECK (source IN ('hn','geeknews','x')),
  CONSTRAINT "social_posts_kind_check" CHECK (kind IN ('link','show')),
  CONSTRAINT "social_posts_link_target_check" CHECK (link_target IN ('repo','issue','pull','path','site')),
  CONSTRAINT "social_posts_repository_check" CHECK (
    (link_target = 'site' AND repository_key IS NULL)
    OR (link_target <> 'site' AND repository_key ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$')
  ),
  CONSTRAINT "social_posts_counts_check" CHECK (points >= 0 AND comments >= 0),
  CONSTRAINT "social_posts_state_check" CHECK (state IN ('visible','hidden','gone')),
  CONSTRAINT "social_posts_seen_check" CHECK (last_seen_at >= first_seen_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "social_posts_source_external_idx" ON "social_posts" ("source", "external_id");
--> statement-breakpoint
CREATE INDEX "social_posts_repository_idx" ON "social_posts" ("repository_key", "posted_at" DESC) WHERE "repository_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "social_posts_posted_idx" ON "social_posts" ("posted_at" DESC);
--> statement-breakpoint
CREATE TABLE "social_post_observations" (
  "post_id" integer NOT NULL REFERENCES "social_posts"("id") ON DELETE CASCADE,
  "observed_at" timestamptz NOT NULL,
  "points" integer NOT NULL,
  "comments" integer NOT NULL,
  PRIMARY KEY ("post_id", "observed_at"),
  CONSTRAINT "social_post_observations_counts_check" CHECK (points >= 0 AND comments >= 0)
);
--> statement-breakpoint
CREATE TABLE "social_talk_decisions" (
  "repository_key" varchar(200) PRIMARY KEY,
  "excluded" boolean NOT NULL DEFAULT false,
  "home_decision" varchar(12),
  "reason" varchar(200),
  "decided_by" varchar(120) NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_talk_decisions_repository_check" CHECK (repository_key ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  CONSTRAINT "social_talk_decisions_home_check" CHECK (home_decision IS NULL OR home_decision IN ('approved','talk_only'))
);
