-- Add only V2 historical-owner + strict Linux systemd physical exit.
-- Existing CHECKs, top-level/transition guards and durable owner-record validation stay byte-identical.
DO $$
DECLARE definition text; needle text; part text[];
BEGIN
  -- Preserve the exact launchd-only V2 body; CREATE OR REPLACE below retains its public OID/signature.
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_v2_valid(jsonb)'::regprocedure);
  IF definition NOT LIKE 'CREATE OR REPLACE FUNCTION public.nmv_provider_boundary_release_v2_valid(%' THEN
    RAISE EXCEPTION 'historical_systemd_predecessor_changed';
  END IF;
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_v2_valid\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_v2_launchd_0132(');

  -- Derive the new branch from the archived, complete Linux V1 physical validator.
  definition:=pg_get_functiondef('public.nmv_provider_boundary_release_valid_linux_0126(jsonb)'::regprocedure);
  FOREACH part SLICE 1 IN ARRAY ARRAY[
    ARRAY['ARRAY[''version'',''kind'',''createdAt'',''request'',''control'',''owner'',''gateways'',''provider'',''beforeArtifactHash'']','ARRAY[''version'',''kind'',''createdAt'',''request'',''control'',''originalOwner'',''currentIngressOwner'',''gateways'',''provider'',''beforeArtifactHash'']'],
    ARRAY['ARRAY[''version'',''kind'',''planHash'',''owner'',''gateways'',''provider'']','ARRAY[''version'',''kind'',''planHash'',''originalOwnerProofHash'',''currentIngressOwner'',''gateways'',''provider'']'],
    ARRAY['p->''version'' IS DISTINCT FROM ''1''::jsonb','p->''version'' IS DISTINCT FROM ''2''::jsonb'],
    ARRAY['r->''version'' IS DISTINCT FROM ''1''::jsonb','r->''version'' IS DISTINCT FROM ''2''::jsonb'],
    ARRAY['p->''owner''','p->''currentIngressOwner'''], ARRAY['r->''owner''','r->''currentIngressOwner'''],
    ARRAY['v->>''startedAt''>q->>''dispatchAt''','v->>''startedAt''>(CASE WHEN i=0 THEN p->>''createdAt'' ELSE q->>''dispatchAt'' END)'],
    ARRAY['nmv_boundary_identity_valid(v)','nmv_boundary_identity_valid_linux_0126(v)'],
    ARRAY['nmv_boundary_exit_valid(c)','nmv_boundary_exit_valid_linux_0126(c)']]
  LOOP
    IF strpos(definition,part[1])=0 THEN RAISE EXCEPTION 'historical_systemd_predecessor_changed'; END IF;
    definition:=replace(definition,part[1],part[2]);
  END LOOP;
  needle:='BEGIN'||chr(10);
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
    RAISE EXCEPTION 'historical_systemd_predecessor_changed';
  END IF;
  definition:=replace(definition,needle,needle||'  IF NOT nmv_boundary_original_owner_valid(p->''originalOwner'') OR p->''originalOwner''->>''instanceId'' IS DISTINCT FROM q->''owner''->>''instanceId'' OR p->''originalOwner''->>''bootId'' IS DISTINCT FROM q->''owner''->>''bootId'' OR r->>''originalOwnerProofHash'' IS DISTINCT FROM encode(sha256(convert_to(nmv_boundary_canonical(p->''originalOwner''),''UTF8'')),''hex'') THEN RETURN false; END IF;'||chr(10));
  EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.nmv_provider_boundary_release_valid_linux_0126\(',
    'CREATE FUNCTION public.nmv_provider_boundary_release_v2_systemd_valid(');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nmv_provider_boundary_release_v2_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN nmv_provider_boundary_release_v2_launchd_0132(e) OR nmv_provider_boundary_release_v2_systemd_valid(e);
END $$;
