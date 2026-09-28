# Scheduler redundancy and demand-aware restart

Goal: keep two scheduler pollers independently observable, and restart a live crawler/reviewer primary only when eligible data has not been stored despite a healthy scheduler. Repeated primary boots let the existing role lease quarantine promote the standby.

1. Make scheduler replica observation keys include each container hostname behind an explicit flag. Test distinct keys and missing-host rejection. Keep the current singleton key when the flag is absent.
2. Derive a restart signal from P0 structured progress: require `scheduler=scheduled`, a crawler/reviewer `no_progress` stage, no progressing or upstream-error stage in that role, and two consecutive 15-second samples. Idle, paused, retry and unknown states must not restart.
3. On confirmed stall, abort the active supervisor, let it drain and make the candidate exit nonzero so Swarm first restarts its primary. Do not release its role lease as a normal handoff. The existing 45-second lease, 20-second standby grace and repeated-boot quarantine govern subsequent promotion.
4. Test consecutive/cleared signals, DB observation error, primary versus standby, and role candidate exit. Verify scheduler coalescing against two concurrent pollers in PostgreSQL before setting the Dokploy replica count to two.
5. Roll out scheduler first, then crawler and reviewer standby after release tags, credentials, health and fencing checks. Record live recovery time rather than inferring it from accelerated DB tests.

No server/DB streaming configuration changes are part of this plan.
