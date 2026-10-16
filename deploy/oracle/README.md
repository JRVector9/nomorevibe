# Oracle native release — inactive offline foundation

This directory currently packages and verifies **prepared files** and stages them in a caller-owned offline filesystem. It does not install dependencies, contact a host, discover OCI identity, change a unit, start a worker, migrate a database, or issue a model/HTTP request. The launcher always exits78. There is no environment flag or marker to bypass it.

Target: **surfguide / ap-osaka-1 / osaka-smoke**. `onetwoday`, M3/mini services, X and Mautic are excluded. The complete design and remaining operational gates are in `docs/superpowers/plans/2026-10-16-pipeline-pr11-oracle-runtime.md`.

The offline Python tools require Python **3.11 or later** (`hashlib.file_digest` and `BaseExceptionGroup`). This is a prerequisite for future host preparation, not a verified Oracle installation.

## Prepared release contract

The archive contains `manifest.json` and only `payload/<relative path>` files/internal symlinks. Supported payload roots are `lib`, `scripts`, `drizzle`, `node_modules`, `runtime`, `tools`, and the fixed `deploy/oracle/launch.py`. Root files are `package.json`, `package-lock.json`, and `tsconfig.json`. `.env*`, `.npmrc`, `.git`, `credentials.json`, and `auth.json` names are rejected anywhere. This is a conservative filename exclusion, **not a complete secret scanner**. Build input must be reviewed separately.

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

The root must be an absolute caller-owned **offline** directory, never `/` or an X/Mautic namespace. Managed descendants are limited to `opt/nomorevibe-core`. No other existing tree is scanned, copied or removed. Host files must match the strict schema and exact tenancy/region/instance/OCIDs. These are supplied comparison records; actual OCI metadata acquisition/authentication is not implemented. Placeholder examples are rejected.

`stage` verifies the entire archive before writing, then copies into a unique staging directory, checks copied file hashes and publishes an immutable-named release directory. It does not change `current`. Existing release directories are verified and never overwritten. File modes are444/555 in offline staging; this does not claim actual root ownership or nonroot account installation.

`switch` holds a local manager lock, revalidates the target tree and requires the exact previous current SHA (`--expected-current` for subsequent switches). It atomically replaces only the relative `current -> releases/<SHA>` link. A rollback uses the same switch command with an explicitly approved older SHA and the currently observed SHA; no guessed previous release or automatic schema downgrade exists. The first switch omits `--expected-current` and requires no current link. A failed pre-replace operation leaves current unchanged. An error after replace/fsync is not claimed rolled back: read back the link/release before a retry. Output carries no activation or readiness claim.

If work and cleanup both fail, Python exceptions preserve both through `BaseExceptionGroup`. The CLI returns a fixed diagnostic and nonzero status without echoing source paths, host values or arbitrary exception text; in-process callers receive original exceptions. No service is stopped/restarted automatically after an error.

## Unit and environment templates

`render_units(cpu_quota_percent, memory_bytes, tasks)` in `manage_release.py` requires three explicit positive integer allocations; there are no measured defaults. Its raw `.slice` input contains required placeholders and is **not directly installable**. Rendering is a pure operation and does not write `/etc` or call systemd. A rendered numeric budget is configuration, not evidence of observed CPU/RSS/heartbeat or DB capacity.

The role/scheduler units use `nomorevibe-core`, a shared slice, distinct state/runtime/env files, `NoNewPrivileges`, read-only system paths and `KillMode=mixed`. They point only to the fixed exit78 launcher. `TimeoutStopSec=60s` is an unvalidated template based on the current45s drain plus cleanup; actual ARM child/CLI settlement must be checked before enabling. A hard kill does not prove remote work ended. No unit may be enabled in this phase.

Real per-role env files will be root-managed0600 outside releases. Examples are incomplete by design. PR10, actual host preflight, least privilege, model/common HTTP participation and aggregate DB/CPU/RSS/heartbeat constraints must be integrated first; filling an env file does not supply those proofs.

X's account, `/opt/nomorevibe-x`, `/etc/nomorevibe-x.env`, `/var/lib/nomorevibe-x`, timer and UTC10-read/purpose gates remain separate. `/var/backups/nomorevibe/mautic-retired-20261015T050901Z` and the retained Mautic database are outside every operation here.
