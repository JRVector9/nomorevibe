-- Generated from lib/runtime/oracle-db-profile.ts; tests fail if this file and the profile differ.
-- Run once by a PostgreSQL administrator on the primary after explicit approval, for example:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v translation_connections=N ... -f deploy/oracle/least-privilege.sql
-- Then set each password interactively with \password <role>. This file contains no secret and grants no migration/DDL right.
BEGIN;

-- translation
CREATE ROLE nomorevibe_oracle_translation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :translation_connections;
ALTER ROLE nomorevibe_oracle_translation SET statement_timeout = '60s';
ALTER ROLE nomorevibe_oracle_translation SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_translation SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.crawl_review_attempts TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.crawl_settings TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT ON TABLE public.dr_process_group_events TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.dr_writer_fence TO nomorevibe_oracle_translation;
GRANT UPDATE (id) ON TABLE public.dr_writer_fence TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT ON TABLE public.job_batch_candidates TO nomorevibe_oracle_translation;
GRANT UPDATE (host, boot_id, release, policy_hash, observed_at) ON TABLE public.job_batch_candidates TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_translation;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT, UPDATE ON TABLE public.jobs TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.model_capacity_control TO nomorevibe_oracle_translation;
GRANT UPDATE (cursor, updated_at) ON TABLE public.model_capacity_control TO nomorevibe_oracle_translation;
GRANT INSERT ON TABLE public.model_capacity_events TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT, UPDATE ON TABLE public.model_capacity_requests TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operations_observations TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.product_health TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.product_intro_checks TO nomorevibe_oracle_translation;
GRANT UPDATE (product_id) ON TABLE public.product_intro_checks TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT, UPDATE ON TABLE public.product_korean_taglines TO nomorevibe_oracle_translation;
GRANT SELECT, UPDATE ON TABLE public.product_translations TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.products TO nomorevibe_oracle_translation;
GRANT UPDATE (id) ON TABLE public.products TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT, UPDATE ON TABLE public.role_leases TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.second_reviews TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.takedown_requests TO nomorevibe_oracle_translation;
GRANT UPDATE (slug) ON TABLE public.takedown_requests TO nomorevibe_oracle_translation;
GRANT SELECT, INSERT, UPDATE ON TABLE public.text_translations TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.uptime_control TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.uptime_gates TO nomorevibe_oracle_translation;
GRANT SELECT ON TABLE public.uptime_observations TO nomorevibe_oracle_translation;
GRANT USAGE ON SEQUENCE public.model_capacity_events_id_seq TO nomorevibe_oracle_translation;
GRANT USAGE ON SEQUENCE public.model_capacity_requests_queue_ordinal_seq TO nomorevibe_oracle_translation;
GRANT USAGE ON SEQUENCE public.dr_process_group_events_id_seq TO nomorevibe_oracle_translation;

-- product-health
CREATE ROLE nomorevibe_oracle_product_health LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :product_health_connections;
ALTER ROLE nomorevibe_oracle_product_health SET statement_timeout = '60s';
ALTER ROLE nomorevibe_oracle_product_health SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_product_health SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT ON TABLE public.dr_process_group_events TO nomorevibe_oracle_product_health;
GRANT SELECT ON TABLE public.dr_writer_fence TO nomorevibe_oracle_product_health;
GRANT UPDATE (id) ON TABLE public.dr_writer_fence TO nomorevibe_oracle_product_health;
GRANT SELECT ON TABLE public.http_origin_control TO nomorevibe_oracle_product_health;
GRANT UPDATE (id) ON TABLE public.http_origin_control TO nomorevibe_oracle_product_health;
GRANT INSERT ON TABLE public.http_origin_events TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT, UPDATE ON TABLE public.http_origin_hops TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT ON TABLE public.job_batch_candidates TO nomorevibe_oracle_product_health;
GRANT UPDATE (host, boot_id, release, policy_hash, observed_at) ON TABLE public.job_batch_candidates TO nomorevibe_oracle_product_health;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_product_health;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT, UPDATE ON TABLE public.jobs TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operations_observations TO nomorevibe_oracle_product_health;
GRANT SELECT ON TABLE public.product_health TO nomorevibe_oracle_product_health;
GRANT UPDATE (slug) ON TABLE public.product_health TO nomorevibe_oracle_product_health;
GRANT SELECT ON TABLE public.products TO nomorevibe_oracle_product_health;
GRANT UPDATE (id) ON TABLE public.products TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT, UPDATE ON TABLE public.role_leases TO nomorevibe_oracle_product_health;
GRANT SELECT ON TABLE public.uptime_control TO nomorevibe_oracle_product_health;
GRANT UPDATE (id) ON TABLE public.uptime_control TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT, UPDATE ON TABLE public.uptime_gates TO nomorevibe_oracle_product_health;
GRANT SELECT, INSERT ON TABLE public.uptime_observations TO nomorevibe_oracle_product_health;
GRANT USAGE ON SEQUENCE public.http_origin_events_id_seq TO nomorevibe_oracle_product_health;
GRANT USAGE ON SEQUENCE public.dr_process_group_events_id_seq TO nomorevibe_oracle_product_health;

-- site-evidence
CREATE ROLE nomorevibe_oracle_site_evidence LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :site_evidence_connections;
ALTER ROLE nomorevibe_oracle_site_evidence SET statement_timeout = '60s';
ALTER ROLE nomorevibe_oracle_site_evidence SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_site_evidence SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT ON TABLE public.dr_process_group_events TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.dr_writer_fence TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (id) ON TABLE public.dr_writer_fence TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.evidence_settings TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (id) ON TABLE public.evidence_settings TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT, UPDATE ON TABLE public.evidence_source_claims TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.evidence_source_control TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (cursor) ON TABLE public.evidence_source_control TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.http_origin_control TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (id) ON TABLE public.http_origin_control TO nomorevibe_oracle_site_evidence;
GRANT INSERT ON TABLE public.http_origin_events TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT, UPDATE ON TABLE public.http_origin_hops TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT ON TABLE public.job_batch_candidates TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (host, boot_id, release, policy_hash, observed_at) ON TABLE public.job_batch_candidates TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT, UPDATE ON TABLE public.jobs TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operations_observations TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT, UPDATE ON TABLE public.product_evidence_sources TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.product_links TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.product_refresh_requests TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (progress, updated_at) ON TABLE public.product_refresh_requests TO nomorevibe_oracle_site_evidence;
GRANT SELECT ON TABLE public.products TO nomorevibe_oracle_site_evidence;
GRANT UPDATE (id) ON TABLE public.products TO nomorevibe_oracle_site_evidence;
GRANT SELECT, INSERT, UPDATE ON TABLE public.role_leases TO nomorevibe_oracle_site_evidence;
GRANT USAGE ON SEQUENCE public.http_origin_events_id_seq TO nomorevibe_oracle_site_evidence;
GRANT USAGE ON SEQUENCE public.product_evidence_sources_id_seq TO nomorevibe_oracle_site_evidence;
GRANT USAGE ON SEQUENCE public.dr_process_group_events_id_seq TO nomorevibe_oracle_site_evidence;

-- official-news
CREATE ROLE nomorevibe_oracle_official_news LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :official_news_connections;
ALTER ROLE nomorevibe_oracle_official_news SET statement_timeout = '60s';
ALTER ROLE nomorevibe_oracle_official_news SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_official_news SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_official_news;
GRANT SELECT ON TABLE public.crawl_settings TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT ON TABLE public.dr_process_group_events TO nomorevibe_oracle_official_news;
GRANT SELECT ON TABLE public.dr_writer_fence TO nomorevibe_oracle_official_news;
GRANT UPDATE (id) ON TABLE public.dr_writer_fence TO nomorevibe_oracle_official_news;
GRANT SELECT ON TABLE public.http_origin_control TO nomorevibe_oracle_official_news;
GRANT UPDATE (id) ON TABLE public.http_origin_control TO nomorevibe_oracle_official_news;
GRANT INSERT ON TABLE public.http_origin_events TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT, UPDATE ON TABLE public.http_origin_hops TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT ON TABLE public.job_batch_candidates TO nomorevibe_oracle_official_news;
GRANT UPDATE (host, boot_id, release, policy_hash, observed_at) ON TABLE public.job_batch_candidates TO nomorevibe_oracle_official_news;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_official_news;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT, UPDATE ON TABLE public.jobs TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT ON TABLE public.news_items TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operations_observations TO nomorevibe_oracle_official_news;
GRANT SELECT, INSERT, UPDATE ON TABLE public.role_leases TO nomorevibe_oracle_official_news;
GRANT USAGE ON SEQUENCE public.http_origin_events_id_seq TO nomorevibe_oracle_official_news;
GRANT USAGE ON SEQUENCE public.news_items_id_seq TO nomorevibe_oracle_official_news;
GRANT USAGE ON SEQUENCE public.dr_process_group_events_id_seq TO nomorevibe_oracle_official_news;

-- scheduler
CREATE ROLE nomorevibe_oracle_scheduler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :scheduler_connections;
ALTER ROLE nomorevibe_oracle_scheduler SET statement_timeout = '10s';
ALTER ROLE nomorevibe_oracle_scheduler SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_scheduler SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_scheduler;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_scheduler;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_scheduler;
GRANT SELECT, INSERT, UPDATE ON TABLE public.jobs TO nomorevibe_oracle_scheduler;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operations_observations TO nomorevibe_oracle_scheduler;

-- attest
CREATE ROLE nomorevibe_oracle_attest LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :attest_connections;
ALTER ROLE nomorevibe_oracle_attest SET statement_timeout = '60s';
ALTER ROLE nomorevibe_oracle_attest SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_attest SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.evidence_source_claims TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.http_origin_control TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.http_origin_hops TO nomorevibe_oracle_attest;
GRANT SELECT, INSERT ON TABLE public.job_batch_candidates TO nomorevibe_oracle_attest;
GRANT UPDATE (capability, result_evidence) ON TABLE public.job_batch_candidates TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.job_batch_control TO nomorevibe_oracle_attest;
GRANT UPDATE (id) ON TABLE public.job_batch_control TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.jobs TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.news_items TO nomorevibe_oracle_attest;
GRANT SELECT, DELETE ON TABLE public.operations_observations TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.product_evidence_sources TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.product_korean_taglines TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.product_refresh_requests TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.product_translations TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.text_translations TO nomorevibe_oracle_attest;
GRANT SELECT ON TABLE public.uptime_observations TO nomorevibe_oracle_attest;

COMMIT;
