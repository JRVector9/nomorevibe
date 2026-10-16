-- Generated from lib/runtime/oracle-db-profile.ts (ORACLE_REFRESH_PROFILE); tests fail if this file and the profile differ.
-- Optional. Apply only after the host capability-refresh timer policy is approved, after least-privilege.sql, for example:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v refresh_connections=1 -f deploy/oracle/refresh-principal.sql
-- Then set the password interactively with \password nomorevibe_oracle_refresh. It can rewrite only job_batch_candidates.capability.
BEGIN;

-- refresh
CREATE ROLE nomorevibe_oracle_refresh LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :refresh_connections;
ALTER ROLE nomorevibe_oracle_refresh SET statement_timeout = '10s';
ALTER ROLE nomorevibe_oracle_refresh SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_refresh SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_refresh;
GRANT SELECT ON TABLE public.http_origin_control TO nomorevibe_oracle_refresh;
GRANT SELECT ON TABLE public.http_origin_hops TO nomorevibe_oracle_refresh;
GRANT SELECT ON TABLE public.job_batch_candidates TO nomorevibe_oracle_refresh;
GRANT UPDATE (capability) ON TABLE public.job_batch_candidates TO nomorevibe_oracle_refresh;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_refresh;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_refresh;

COMMIT;
