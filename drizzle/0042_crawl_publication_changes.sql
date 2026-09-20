CREATE TABLE "crawl_publication_changes" (
  "id" serial PRIMARY KEY,
  "repo" varchar(200) NOT NULL,
  "delta" integer NOT NULL CHECK ("delta" IN (-1, 1)),
  "occurred_at" timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);
--> statement-breakpoint
CREATE INDEX "crawl_publication_changes_time_idx" ON "crawl_publication_changes" ("occurred_at");
--> statement-breakpoint
LOCK TABLE "crawl_candidates" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Published candidates are terminal; updated_at records their publication transition.
-- Seed once before installing the trigger, inside the migration transaction.
INSERT INTO "crawl_publication_changes" ("repo", "delta", "occurred_at")
SELECT "repo", 1, "updated_at" FROM "crawl_candidates" WHERE "state" = 'published';
--> statement-breakpoint
CREATE FUNCTION record_crawl_publication_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE was_published boolean := false; is_published boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN was_published := OLD.state = 'published'; END IF;
  IF TG_OP <> 'DELETE' THEN is_published := NEW.state = 'published'; END IF;
  IF was_published IS DISTINCT FROM is_published THEN
    INSERT INTO crawl_publication_changes (repo, delta)
    VALUES (CASE WHEN TG_OP = 'DELETE' THEN OLD.repo ELSE NEW.repo END,
            CASE WHEN is_published THEN 1 ELSE -1 END);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER crawl_publication_change
AFTER INSERT OR UPDATE OF state OR DELETE ON crawl_candidates
FOR EACH ROW EXECUTE FUNCTION record_crawl_publication_change();
