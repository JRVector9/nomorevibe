-- V4 composes unchanged durable original-owner records with the strict V3 direct native boot proof.
-- Existing SQL, validators, function OIDs and CHECKs remain intact; no terminal/usage authority is created.
DO $$
DECLARE definition text; part text[];
BEGIN
 definition:=pg_get_functiondef('public.nmv_provider_boundary_release_v3_valid(jsonb)'::regprocedure);
 FOREACH part SLICE 1 IN ARRAY ARRAY[ARRAY['ARRAY[''version'',''kind'',''createdAt'',''request'',''control'',''owner'',''gateways'',''provider'',''servingContract'',''transport'',''ownerAssociation'',''localEnd'',''bootWitness'',''beforeArtifactHash'']','ARRAY[''version'',''kind'',''createdAt'',''request'',''control'',''originalOwner'',''currentIngressOwner'',''gateways'',''provider'',''servingContract'',''transport'',''ownerAssociation'',''localEnd'',''bootWitness'',''beforeArtifactHash'']'],
ARRAY['ARRAY[''version'',''kind'',''planHash'',''owner'',''gateways'',''provider'']','ARRAY[''version'',''kind'',''planHash'',''originalOwnerProofHash'',''currentIngressOwner'',''gateways'',''provider'']'],
ARRAY['p->''version'' IS DISTINCT FROM ''3''::jsonb','p->''version'' IS DISTINCT FROM ''4''::jsonb'],
ARRAY['r->''version'' IS DISTINCT FROM ''3''::jsonb','r->''version'' IS DISTINCT FROM ''4''::jsonb'],
ARRAY['p->''owner''','p->''currentIngressOwner'''],
ARRAY['r->''owner''','r->''currentIngressOwner'''],
ARRAY['p->''currentIngressOwner''->>''startedAt''<=q->>''dispatchAt''','p->''currentIngressOwner''->>''startedAt''<=p->>''createdAt'''],
ARRAY[' RETURN coalesce(p->''currentIngressOwner''',' IF NOT nmv_boundary_original_owner_valid(p->''originalOwner'')
  OR p->''originalOwner''->''instanceId'' IS DISTINCT FROM q->''owner''->''instanceId'' OR p->''originalOwner''->''bootId'' IS DISTINCT FROM q->''owner''->''bootId''
  OR r->>''originalOwnerProofHash'' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p->''originalOwner''),''UTF8'')),''hex'')
  OR l->''eventId'' IS DISTINCT FROM p->''originalOwner''->''localEndEventId''
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->''originalOwner''->''groups'') g WHERE g->''spawnedEventId''=a->''spawnedEventId'' AND g->''pid''=a->''pid'' AND g->''runIdHash''=a->''runIdHash'') THEN RETURN false; END IF;
 RETURN coalesce(p->''currentIngressOwner''']] LOOP
  IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'historical_boot_boundary_predecessor_changed'; END IF;
  definition:=replace(definition,part[1],part[2]);
 END LOOP;
 EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_v3_valid\(','CREATE FUNCTION public.nmv_provider_boundary_release_v4_valid(');
END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; part text[];
BEGIN
 definition:=pg_get_functiondef('public.nmv_boot_records_valid(jsonb,jsonb)'::regprocedure);
 FOREACH part SLICE 1 IN ARRAY ARRAY[ARRAY['p->''version'' IS DISTINCT FROM ''3''::jsonb','p->''version'' IS DISTINCT FROM ''4''::jsonb OR NOT nmv_boundary_original_owner_records_valid(p,v) OR l->''eventId'' IS DISTINCT FROM p->''originalOwner''->''localEndEventId'''],
ARRAY[' OR g.recorded_at<(p->''owner''->>''startedAt'')::timestamptz','
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->''originalOwner''->''groups'') x WHERE x->''spawnedEventId''=a->''spawnedEventId'' AND x->''pid''=a->''pid'' AND x->''runIdHash''=a->''runIdHash'')']] LOOP
  IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'historical_boot_boundary_predecessor_changed'; END IF;
  definition:=replace(definition,part[1],part[2]);
 END LOOP;
 EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_boot_records_valid\(','CREATE FUNCTION public.nmv_boot_historical_records_valid(');
END $$;
--> statement-breakpoint
DO $$
DECLARE definition text; needle text:='  RETURN NEW;'||chr(10)||'END'; part text[];
BEGIN
 FOREACH part SLICE 1 IN ARRAY ARRAY[ARRAY['nmv_provider_boundary_release_valid','nmv_boot_historical_previous_release_valid'],ARRAY['nmv_provider_boundary_transition_guard','nmv_boot_historical_previous_transition_guard']] LOOP
  definition:=pg_get_functiondef(('public.'||part[1]||CASE WHEN part[1]='nmv_provider_boundary_transition_guard' THEN '()' ELSE '(jsonb)' END)::regprocedure);
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.'||part[1]||'\(','CREATE FUNCTION public.'||part[2]||'(');
 END LOOP;
 definition:=pg_get_functiondef('public.nmv_provider_boundary_transition_guard()'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'historical_boot_boundary_predecessor_changed'; END IF;
 EXECUTE replace(definition,needle,'  IF NEW.terminal_evidence->''plan''->''version''=''4''::jsonb AND NOT nmv_boot_historical_records_valid(NEW.terminal_evidence->''plan'',to_jsonb(NEW)) THEN RAISE EXCEPTION ''provider_boot_historical_records_mismatch''; END IF;'||chr(10)||needle);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
 IF e->'plan'->'version'='4'::jsonb THEN RETURN nmv_provider_boundary_release_v4_valid(e); END IF;
 RETURN nmv_boot_historical_previous_release_valid(e);
END $$;
