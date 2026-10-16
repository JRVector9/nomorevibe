# PR11 Task1/2 — inactive offline validation

This records the Python/offline foundation and the shared helper's explicit offline actions. Task1's final PR07–10 API/runtime intake and Task3 TypeScript preflight are **not complete**. All services remain inactive and the launcher unconditionally rejects with exit78.

## Implemented scope

- `deploy/oracle/release_contract.py`: strict full catalog/manifest, file/link/mode/hash, version and configured host/readback comparisons.
- `build_release.py`: deterministic packaging of a prepared native tree, actual builder platform guard, no npm/dependency installation or staged execution.
- `manage_release.py`: whole archive verification, caller-owned offline staging, verified pinned current-link CAS/switch/rollback and numeric unit-template rendering.
- Fixed exit78 launcher, nonroot role/scheduler/slice templates, incomplete nonsecret manifest/host/env examples and the directory runbook.
- `tests/test_oracle_runtime.py`: only temporary fixtures and local Python subprocesses; inert Node/CLI bytes do not execute.

Actual host discovery, root-owned installation, Linux systemd validation/start, authenticated SQL, PR10 readiness/canary, host aggregate budgets and real workload/24h/failover remain unimplemented or unverified. Configured host records are not hardware attestation. The native source SHA/version declarations need their approved upstream provenance; file hashes alone do not prove that provenance.

## Executed RED → GREEN

1. A runnable permissive baseline and test were preserved in `/tmp/nomorevibe-pr11-a-baseline-*.py`; hashes: `/tmp/nomorevibe-pr11-a-original-hashes-20261016.json`.
2. Six named tests ran against that baseline: one normal identity control passed; five behavior tests failed with17 AssertionError subfailures. No import/setup errors. Actual exit1,0.033s. Log: `/tmp/nomorevibe-pr11-a-original-red-20261016.log`. These are new-baseline implementation failures, not observed production defects.
3. The first implementation attempt failed because payload root directories (`lib`, etc.) were incorrectly rejected by the path validator. This was an implementation wiring error (1failure/10errors), retained in `/tmp/nomorevibe-pr11-a-first-green-attempt-20261016.log`; not counted as another feature RED. After the narrow directory-path correction, the original13 tests passed in0.108s (`...-second-green-attempt-...log`).
4. Additional negative checks found a malformed symlink path raising TypeError and builder cleanup hiding a publish error. The first capture used exception expectations that reported2 unittest errors; it is retained separately in `...-extra-boundary-red-...log`. Explicit observed-error type assertions then produced4 actual assertion failures including inactive launcher and budget-template behavior (`...-extra-behavior-red-...log`, exit1/0.035s). Minimal fixes preserve ValueError and original+cleanup exception identities, block launcher activation and require explicit budget numbers.
5. The20-case expanded pass was0.195s (`...-expanded-green-...log`). The final23-case driver additionally checks a full archive's inner tamper despite recomputed outer checksum, two actual concurrent offline manager CAS contenders, and local CLI inspect/error output: **23 PASS /0.314s /exit0**, `/tmp/nomorevibe-pr11-a-final-green-20261016.log`.

The original six test bodies/assertions remain unchanged. Later fixture preparation adds the managed inactive launcher required by the completed artifact format; no whole-driver byte-identity claim is made. The baseline copy/hash remains preserved.

## Validation limits and commands

Executed tests use real temporary files/tar archives/symlinks/flock/atomic replace and local Python CLI invocation. Tests inject only local I/O faults and a controlled platform observation; no hardware/host authority is mocked into a ready state. Source mutation, atomic publish failure, inner hash tamper, namespace escape, stale CAS, original+cleanup error preservation, X sentinel preservation and default activation rejection are covered.

The following were not run: real ARM dependency/CLI install/import/version checks, systemd-analyze/start/reboot, OCI metadata, SSH, database/provider/network access, actual native build, full suite/full DB/build/bundle, physical resource/DB budget, real translation/canonical/news/uptime, independent scheduling or failover/24h. There is no DB/container cleanup in this task.

Changed-range command:

```sh
python3 tests/test_oracle_runtime.py
```

The original6 named cases were rerun unchanged: **6 PASS /0.041s /exit0**, `/tmp/nomorevibe-pr11-a-original-six-green-20261016.log`. Comparing their ASTs with the preserved baseline driver actually confirmed all6 method bodies/assertions equal.

Necessary static check actually exited0 (empty output), `/tmp/nomorevibe-pr11-a-compile-20261016.log`:

```sh
PYTHONPYCACHEPREFIX=/tmp/nomorevibe-pr11-a-compile-cache python3 -m py_compile deploy/oracle/release_contract.py deploy/oracle/build_release.py deploy/oracle/manage_release.py deploy/oracle/launch.py tests/test_oracle_runtime.py
```

The final owned-file hash manifest is `/tmp/nomorevibe-pr11-a-final-hashes-20261016.json`. Root owns Git/shared handoff/CI, final dependency integration and all operational validation. No existing TypeScript, common deploy helper, DB or operating service was modified by this phase.

## Root/independent boundary review

Root read all15 frozen implementation/template/driver/validation files and original23/6/compile logs. Independent B review confirmed3 implementation boundaries with real temporary filesystem fixtures: same-inode approved archive A replaced by valid B after hash, an ancestor alias entering each excluded X/Mautic namespace, and staged4555/2555 executable bits. Those3 cases had6 Assertion failures while a normal control passed. The same frozen4 cases passed after minimal fixes (0.072s).

The archive is now copied in bounded chunks to a private anonymous snapshot while hashing, and tar parsing/extraction read that same descriptor. Resolved root components also reject excluded namespaces. Staged mode validation includes all0o7777 bits. One added changed-range case verified cumulative growth bounds, no tar/write on error, real snapshot close, and original read/close exception identities. This extra case was postimplementation validation, not counted as another RED. Final affected5PASS/0.085s/exit0, two-file py_compile exit0. The original23 method bodies and other13 file SHA values were preserved before root documentation changes. Original23/fullsuite/build were not rerun.

Report `/tmp/nomorevibe-pr11-b-artifact-boundary-fix-20261016.md`, patch `/tmp/nomorevibe-pr11-b-artifact-boundary-final-20261016.patch`. Root read the full final patch/negative drivers directly. Final manager SHA `ac2324ffd8e7f74ef5933a496de070f1f2f533734ae590922f235d13719483a1`, driver SHA `75afa3353aca8c1668a7dad0694f14d7c969493e39922470456936fbde1f8932`. No remaining confirmed P1/P2 in this inactive scope. README now states Python3.11+ prerequisite; actual Oracle Python/ARM/systemd/CLI/native provenance/runtime preflight remain unverified.

This remains an offline foundation. Task1 final API intake and Task3 TypeScript/runtime wiring are incomplete. No operational activation, SSH, DB, provider, or real artifact build was performed. Manual whole-project tests and comprehensive builds remain deferred until all PR development is complete.

## Explicit shared-helper actions

`scripts/ops/deploy_shared_images.py` now routes `oracle-plan`, `oracle-install` and `oracle-rollback` before the legacy Keychain/Dokploy/GitHub/SSH prelude. It reuses the frozen native inspect/stage/current-CAS implementation and requires approved archive/hash/SHA/host records. Mutation is restricted to a caller-owned offline root. Rollback requires the exact current SHA. Readiness remains unverified and activation false; native payload, units, env, DB and services are never started by these actions.

The runnable new-integration baseline retained the Keychain prelude: one behavioral assertion failed and one normal offline A→B→A control passed (0.054s). After removing those two prelude lines from the Oracle branch, the same two bodies/assertions passed (0.046s). This baseline failure was an unfinished new integration, not an observed production incident. Final changed-range Oracle tests: **9 PASS/0.286s/exit0**; four original legacy controls: **4 PASS/0.003s/exit0**; two-file py_compile: exit0. No whole Python/Oracle/project suite or build was rerun. The first added CLI negative expected FileNotFoundError while the frozen manager raises ValueError; that fixture-only failure is preserved separately and is not another feature RED.

Root read the complete source diff, added test bodies, conformance and raw logs. C independently reviewed the helper/native boundary without execution; no confirmed P1/P2 remains in this inactive scope. Legacy main parser→EOF bytes, APPS/ORDER/restore behavior and original23 test bodies are preserved. Reports: `/tmp/nomorevibe-pr11-task3-b-final-report-20261016.md`, `...task3-c-readonly-review-20261016.md`. Frozen helper SHA `dc75764682946eaeb6577dd223ac32cea832cdd8dcf8e4149932aa04e6da43aa`, test SHA `3ea17c5f4cf6ffb9ed64ad4495a5104f3a2e42a109996ced53fcfb214ca4bbdc`.

Required automatic CI now explicitly runs `tests/test_oracle_runtime.py` in a separate Python process after the existing shared-helper driver. This closes its previous missing direct CI entry without changing required checks or running a manual whole suite. Its new CI result is pending; previous changed-range results are not a claim that every combined Python case has already passed.

The subsequent TS plan `/tmp/nomorevibe-pr11-task3-ts-preflight-contract-b-20261016.md` reuses actual batch admission/readiness and successful domain ACK readback. Actual host/ownership, approved principal/effective grants/RLS/timeouts, initial genuine domain canary and aggregate pool enforcement remain missing. Supplied records/booleans, installation and heartbeat cannot fill those gaps.
