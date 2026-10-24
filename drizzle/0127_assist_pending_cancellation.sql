-- Pre-dispatch waiting cancellation is not a reserved-slot exit or remote terminal.
-- Preserve every prior kind/evidence branch verbatim, including provider_boundary_exit.
DO $$
DECLARE old_predicate text;
BEGIN
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate
    FROM pg_constraint WHERE conrelid='model_capacity_events'::regclass AND conname='model_capacity_events_kind_check';
  ALTER TABLE model_capacity_events DROP CONSTRAINT model_capacity_events_kind_check;
  EXECUTE 'ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_kind_check CHECK (('||old_predicate||') OR coalesce(kind=''wait_cancelled'' AND from_state=''waiting'' AND to_state=''withdrawn'' AND reason IS NULL AND evidence IS NULL,false))';
END $$;
