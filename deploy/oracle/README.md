# Oracle native release — gated activation foundation

This directory packages and verifies **prepared files**, stages them in a caller-owned offline filesystem, renders/installs nonroot units, defines least-privilege DB roles and an operator canary. Nothing here migrates a database, enables a unit or changes batch/capacity modes. The launcher starts its fixed role process only when every readiness check below is verified; any unknown or rejected check exits78. There is no flag, environment variable, receipt or marker that skips a check, and the default state (no approved record, no verified canary) stays closed.

Target: **surfguide / ap-osaka-1 / osaka-smoke**. `onetwoday`, M3/mini services, X and Mautic are excluded. The complete design and remaining operational gates are in `docs/superpowers/plans/2026-10-16-pipeline-pr11-oracle-runtime.md`.

The offline Python tools require Python **3.11 or later** (`hashlib.file_digest` and `BaseExceptionGroup`). This is a prerequisite for future host preparation, not a verified Oracle installation.

## Prepared release contract

The archive contains `manifest.json` and only `payload/<relative path>` files/internal symlinks. Supported payload roots are `lib`, `scripts`, `drizzle`, `node_modules`, `runtime`, `tools`, and the fixed launcher modules `deploy/oracle/{launch,release_contract,manage_release,oci_identity}.py`. Root files are `package.json`, `package-lock.json`, and `tsconfig.json`. `.env*`, `.npmrc`, `.git`, `credentials.json`, and `auth.json` names are rejected anywhere. This is a conservative filename exclusion, **not a complete secret scanner**. Build input must be reviewed separately.

The manifest records full40 source SHA, project lockfile hash, full file catalog/checksums/executable modes, exact Node24 version/binary hash, fixed Codex0.153.4 / Claude2.1.263 / Grok1.0.46 versions/resolved file hashes, and declared batch contract1. Internal symlinks must point directly to a listed regular file; hardlinks, link chains, special entries, ancestor links, duplicate entries and escaping paths are rejected. Limits:200,000 payload entries,2GiB uncompressed total and512MiB archive. These are parser safeguards, not measured host capacity.

Source SHA and version fields are declarations. An approved source export/CI record and binary/version checks must establish their provenance. Manifest parsing does not prove the actual binary version, loaded source, physical host or PR10 readiness. The trusted expected archive SHA256 is obtained through the approved release channel; a checksum supplied alongside an untrusted archive does not authenticate its producer.

## Future native preparation recipe (not executed in this phase)

1. Use the approved exact SHA source export and unchanged `package-lock.json` in a Linux/aarch64/glibc build environment. Copy only the allowed source paths into a fresh staging directory, including `deploy/oracle/launch.py`. No macOS/Alpine `node_modules`, existing env/auth/npmrc, home, logs or Git metadata may be copied.
2. Prepare production dependencies with the same project lockfile using `npm ci --omit=dev` in that staging directory. Any registry credential is an external build-only injection, removed before packaging and never printed. No dependency resolution occurs on a production release switch.
3. Put the approved exact Node24 binary at `runtime/bin/node`. Verify its version, checksum and glibc/shared-library requirements on the target build platform. Install the pinned Codex/Claude packages in a release-local prefix (`tools/bin/...` and internal targets) and place the separately verified Grok1.0.46 artifact there. Preserve required package notices. Do not pipe an unpinned installer into a shell.
4. Check the actual CLI versions and native dependency imports without inference. Retain the source/lock/binary/installer provenance outside secrets. The builder does not perform those checks by executing the staged code.
5. Run the packager only after the previous checks. Identical prepared bytes/modes and declarations produce identical packaging. Reproducibility of npm/native/CLI installation itself has not been tested or certified here.

Example future package command; `APPROVED_*` values refer to recorded release evidence:

```sh
python3 deploy/oracle/build_release.py --prepared "$PREPARED_NATIVE_TREE" \
  --output "$NEW_ARCHIVE_PATH" --sha "$APPROVED_RELEASE_SHA" \
  --node-version "$APPROVED_EXACT_NODE_VERSION"
```

The packager checks its own Linux/aarch64/glibc platform and refuses other platforms. It never runs npm or any staged program. Unit fixtures replace that platform observation and contain inert text binaries, so they prove packaging logic only.

## Offline inspect, stage and pinned rollback

```sh
python3 deploy/oracle/manage_release.py inspect \
  --archive "$ARCHIVE_PATH" --archive-sha256 "$APPROVED_ARCHIVE_SHA256"
python3 deploy/oracle/manage_release.py stage --staging-root "$OWN_OFFLINE_ROOT" \
  --archive "$ARCHIVE_PATH" --archive-sha256 "$APPROVED_ARCHIVE_SHA256" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
python3 deploy/oracle/manage_release.py switch --staging-root "$OWN_OFFLINE_ROOT" \
  --sha "$APPROVED_RELEASE_SHA" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
```

The root must be an absolute caller-owned **offline** directory, never `/` or an X/Mautic namespace. Managed descendants are limited to `opt/nomorevibe-core`. No other existing tree is scanned, copied or removed. Host files must match the strict schema and exact tenancy/region/instance/OCIDs. `python3 deploy/oracle/oci_identity.py --approved /etc/nomorevibe-core/oracle-identity.json` reads the local IMDSv2 (`169.254.169.254/opc/v2/instance/`, `Authorization: Bearer Oracle`, 2s, 64KiB, no redirect/proxy), compares tenancy/compartment/instance OCID, `ap-osaka-1`, display name `osaka-smoke` and shape with the approved record (`oracle-identity.json.example` format) and prints the observed host record for `--observed-host`. Placeholder examples are rejected.

`stage` verifies the entire archive before writing, then copies into a unique staging directory, checks copied file hashes and publishes an immutable-named release directory. It does not change `current`. Existing release directories are verified and never overwritten. File modes are444/555 in offline staging; this does not claim actual root ownership or nonroot account installation.

`switch` holds a local manager lock, revalidates the target tree and requires the exact previous current SHA (`--expected-current` for subsequent switches). It atomically replaces only the relative `current -> releases/<SHA>` link. A rollback uses the same switch command with an explicitly approved older SHA and the currently observed SHA; no guessed previous release or automatic schema downgrade exists. The first switch omits `--expected-current` and requires no current link. A failed pre-replace operation leaves current unchanged. An error after replace/fsync is not claimed rolled back: read back the link/release before a retry. Output carries no activation or readiness claim.

If work and cleanup both fail, Python exceptions preserve both through `BaseExceptionGroup`. The CLI returns a fixed diagnostic and nonzero status without echoing source paths, host values or arbitrary exception text; in-process callers receive original exceptions. No service is stopped/restarted automatically after an error.

The shared deployment helper also exposes explicit offline actions. These branch before Keychain, Dokploy, GitHub and SSH access:

```sh
python3 scripts/ops/deploy_shared_images.py oracle-plan \
  --sha "$APPROVED_RELEASE_SHA" --archive "$ARCHIVE_PATH" \
  --archive-sha256 "$APPROVED_ARCHIVE_SHA256" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
python3 scripts/ops/deploy_shared_images.py oracle-install \
  --sha "$APPROVED_RELEASE_SHA" --archive "$ARCHIVE_PATH" \
  --archive-sha256 "$APPROVED_ARCHIVE_SHA256" --staging-root "$OWN_OFFLINE_ROOT" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
python3 scripts/ops/deploy_shared_images.py oracle-rollback \
  --sha "$APPROVED_OLDER_SHA" --archive "$APPROVED_OLDER_ARCHIVE_PATH" \
  --archive-sha256 "$APPROVED_OLDER_ARCHIVE_SHA256" --staging-root "$OWN_OFFLINE_ROOT" \
  --expected-current "$RECORDED_CURRENT_SHA" \
  --expected-host "$APPROVED_HOST_RECORD" --observed-host "$RECORDED_HOST_READBACK"
```

`oracle-plan` accepts no staging/current arguments. `oracle-install` stages the approved archive and switches the offline current link; subsequent installs also require `--expected-current`. `oracle-rollback` always requires the exact current SHA and verifies or reconstructs the explicitly approved older target. A failed switch can leave a verified staged cache while preserving the old current link. All three report `readiness: unverified` and `activationAllowed: false`; they do not install units/env files or start a runtime.

## Unit and environment templates

`render_units(cpu_quota_percent, memory_bytes, tasks)` in `manage_release.py` requires three explicit positive integer allocations; there are no measured defaults. Its raw `.slice` input contains required placeholders and is **not directly installable**. Rendering is a pure operation and does not write `/etc` or call systemd. A rendered numeric budget is configuration, not evidence of observed CPU/RSS/heartbeat or DB capacity.

The role/scheduler units use `nomorevibe-core`, a shared slice, distinct state/runtime/env files, `NoNewPrivileges`, read-only system paths and `KillMode=mixed`. They point only to the fixed launcher gate. `TimeoutStopSec=60s` is an unvalidated template based on the current45s drain plus cleanup; actual ARM child/CLI settlement must be checked before enabling. A hard kill does not prove remote work ended. No unit may be enabled in this phase.

Real per-role env files will be root-managed0600 outside releases. Examples are incomplete by design. PR10, actual host preflight, least privilege, model/common HTTP participation and aggregate DB/CPU/RSS/heartbeat constraints must be integrated first; filling an env file does not supply those proofs.

X's account, `/opt/nomorevibe-x`, `/etc/nomorevibe-x.env`, `/var/lib/nomorevibe-x`, timer and UTC10-read/purpose gates remain separate. `/var/backups/nomorevibe/mautic-retired-20261015T050901Z` and the retained Mautic database are outside every operation here.

## Launcher gate (`launch.py`)

Checks run in this order and stop at the first non-verified result: (1) `RELEASE_TAG` equals the `current -> releases/<sha>` link, the running launcher is that release's file, the whole tree re-verifies against `release.json` and every entry is root-owned and not group/other writable; (2) Linux/aarch64/glibc, Python3.11+, account `nomorevibe-core` (never root); (3) `HOST_DB_BUDGET` is enabled for exactly this role/host/release and the process runs inside `nomorevibe-core.slice` with numeric `cpu.max`/`memory.max`/`pids.max`; (4) root-owned approved identity equals IMDS; (5) `scripts/worker-oracle-preflight.ts` reports identity/batch/database/timeouts verified, no rejected check, model verified for model roles, and `workload.ready` (the PR10d canary tuple). Only then it `execve`s `role-worker.ts --role=<role> --kind=primary|standby` (or `worker-supervisor.ts --role=scheduler`). Election and per-claim admission still run in the DB afterwards. The diagnostic `{check,reason}` goes to stdout; stderr keeps the fixed exit78 code.

Known closed states: translation stays closed (no model-bound evidence path), the scheduler preflight has no canary, `DB_POOLER_MODE=pgbouncer` keeps timeouts unknown, and every restart needs a new operator canary because the new boot id no longer matches the stored canary result.

## Least-privilege DB roles (`least-privilege.sql`)

Generated from `lib/runtime/oracle-db-profile.ts` (a unit test keeps them identical). One LOGIN role per service plus `nomorevibe_oracle_attest`; role-level 60s/10s statement, 5s lock and 60s idle-transaction timeouts; connection limits are psql variables chosen from the measured host budget; passwords are set separately with `\password`. Workers may update only candidate identity columns; capability/result evidence updates and anchor deletion belong to the attest role. The runtime preflight reports `database: verified` only for an exact catalog match. Run only after explicit approval on the primary.

## Units (`install_units.py`)

`python3 deploy/oracle/install_units.py --root <staging> --cpu-quota-percent N --memory-bytes N --tasks N --role official-news ...` writes the rendered units (0644) and placeholder env files (0600, never overwritten) under the root. `--apply` requires root `/`, creates the `nomorevibe-core` system account when absent and runs only `systemctl daemon-reload`; it never enables or starts a unit.

## Operator canary (`lib/runtime/oracle-canary-cli.ts`)

With the role env file and a separate `ORACLE_ATTEST_DATABASE_URL`, `node --import tsx lib/runtime/oracle-canary-cli.ts canary --role=<role> --job=<job>` first checks IMDS identity, attests the latest stored ACK (domain readback of the rows that tick wrote, live privilege profile, HTTP permit participation), elects a new boot through normal admission, runs exactly one real tick, and attests that tick in one attest-principal transaction that also deletes the stale PR10d anchor. `attest` re-attests the latest ACK only; `refresh` re-observes capability only (capability expires after15 minutes). A first-ever role needs an existing stored ACK; `product-site-evidence-refresh` cannot produce one in legacy mode.
