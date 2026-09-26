ALTER TABLE "product_search_profiles" ADD COLUMN "needs_refresh" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "source_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "repair_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Match JS String.slice's UTF-16 units, including a split supplementary character at the boundary.
-- bytea allows that isolated surrogate to be compared without storing invalid PostgreSQL text.
CREATE FUNCTION search_profile_prefix(value text, units integer) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE used integer := 0; i integer; code integer; width integer;
BEGIN
  FOR i IN 1..least(length(value), units) LOOP
    code := ascii(substr(value, i, 1));
    width := CASE WHEN code > 65535 THEN 2 ELSE 1 END;
    IF used + width > units THEN
      RETURN decode('01', 'hex') || convert_to(substr(value, 1, i - 1), 'UTF8') || decode(lpad(to_hex(55296 + (code - 65536) / 1024), 4, '0'), 'hex');
    END IF;
    used := used + width;
    IF used = units THEN RETURN decode('00', 'hex') || convert_to(substr(value, 1, i), 'UTF8'); END IF;
  END LOOP;
  RETURN decode('00', 'hex') || convert_to(value, 'UTF8');
END;
$$;
--> statement-breakpoint
CREATE FUNCTION search_profile_description(value text, tagline text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT AS $$
  -- ECMAScript trim whitespace, matching profileEvidence's optional description.
  SELECT CASE WHEN btrim(value, ws) = btrim(tagline, ws) THEN NULL ELSE search_profile_prefix(value, 600) END
  FROM (SELECT chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
    chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279) AS ws) trimmed;
$$;
--> statement-breakpoint
CREATE FUNCTION invalidate_product_search_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE product_search_profiles
    SET needs_refresh = true, source_revision = source_revision + 1,
        attempts = 0, error_code = null, retry_at = null
    WHERE product_id = NEW.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_search_profile_input_changed
AFTER UPDATE OF name, url, category, tagline, description, search_topics, search_page_text, search_readme ON products
FOR EACH ROW
WHEN (ROW(OLD.name, OLD.url, OLD.category, OLD.tagline, OLD.description, OLD.search_topics, OLD.search_page_text, OLD.search_readme)
      IS DISTINCT FROM ROW(NEW.name, NEW.url, NEW.category, NEW.tagline, NEW.description, NEW.search_topics, NEW.search_page_text, NEW.search_readme)
  AND ROW(OLD.name, OLD.url, OLD.category, OLD.tagline, search_profile_description(OLD.description, OLD.tagline),
          coalesce(OLD.search_topics, ''), search_profile_prefix(coalesce(OLD.search_page_text, ''), 1500), search_profile_prefix(coalesce(OLD.search_readme, ''), 1500))
      IS DISTINCT FROM ROW(NEW.name, NEW.url, NEW.category, NEW.tagline, search_profile_description(NEW.description, NEW.tagline),
          coalesce(NEW.search_topics, ''), search_profile_prefix(coalesce(NEW.search_page_text, ''), 1500), search_profile_prefix(coalesce(NEW.search_readme, ''), 1500)))
EXECUTE FUNCTION invalidate_product_search_profile();
--> statement-breakpoint
CREATE FUNCTION invalidate_product_search_profile_note() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_id integer; new_id integer; target_id integer; note_id integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    note_id := OLD.id;
    IF OLD.ai_reason IS NOT NULL THEN old_id := OLD.product_id; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    note_id := NEW.id;
    IF NEW.ai_reason IS NOT NULL THEN new_id := NEW.product_id; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.product_id = NEW.product_id AND (OLD.ai_reason IS NULL) = (NEW.ai_reason IS NULL)
       AND search_profile_prefix(nullif(OLD.ai_reason, ''), 600) IS NOT DISTINCT FROM search_profile_prefix(nullif(NEW.ai_reason, ''), 600)
    THEN RETURN NEW; END IF;
  END IF;
  -- Do not lock products after an audit row: admin removal locks product before audit.
  -- A writer racing this transaction sees the revision change, or commits before this trigger marks it dirty.
  FOR target_id IN SELECT DISTINCT id FROM unnest(ARRAY[old_id, new_id]) AS ids(id) WHERE id IS NOT NULL ORDER BY id LOOP
    IF (SELECT coalesce(max(id), 0) FROM product_audit_items WHERE product_id = target_id AND ai_reason IS NOT NULL) > note_id THEN CONTINUE; END IF;
    UPDATE product_search_profiles
      SET needs_refresh = true, source_revision = source_revision + 1,
          attempts = 0, error_code = null, retry_at = null
      WHERE product_id = target_id;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_search_profile_note_changed
AFTER INSERT OR UPDATE OF product_id, ai_reason OR DELETE ON product_audit_items
FOR EACH ROW EXECUTE FUNCTION invalidate_product_search_profile_note();
