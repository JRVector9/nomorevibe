# Thumbnail fallback (approved conversation design)

User authorized the previously proposed order and production backfill: existing OG → site app/apple-touch/favicon → project README/logo/banner/screenshot → GitHub owner avatar → branded initials default. Preserve existing images and maker media. Project image candidates must be related, not badges, ads, tracking pixels or arbitrary first files.

One resolver discovers candidates and validates/normalizes downloaded bytes to WebP. All external requests use the existing SSRF-aware capped fetch, with total/stage deadlines. Icon images remain small on neutral surfaces; labels distinguish icons/avatars/defaults from product screenshots. Use source metadata and a versioned internal cache URL; never hotlink downloaded images.

Persist source, source URL, dimensions, last check, retry deadline and attempt count in a thumbnail state table. Atomic writes guard product URL/repository/update timestamp/current image and active job lease. Existing maker images/media win over in-flight work. Failed upgrades retain the previous image. Lower-priority results retry for better sources; unchanged existing OGs are preserved.

Collector extracts icon/manifest hints from HTML it already fetched. Publication enqueues the bounded background job after successful commit; the scheduled maintenance job also catches missed enqueue/failures and direct registration. A resumable CLI applies the same resolver to a frozen missing-image cohort, with concurrency capped and per-result durable receipts. Genuine source images and defaults are reported separately.

Acceptance: source order and failures tested; unsafe/oversize/invalid images rejected; ICO/PNG/SVG supported safely; CAS/maker protection/retries tested; full initial cohort processed and counted; all affected services deployed; actual desktop/mobile images loaded and source labels verified. No AI-review policy changes.
