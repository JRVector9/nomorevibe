# Direct native host reboot boundary — implementation and evidence

Current objective is recovery support for the exact indeterminate GPU request c2acef26-0b62-4a0c-bddf-789fba97a793, preserving unknown usage. This document records local implementation, not production release. Worktree `/Users/jr/Desktop/projects/nomorevibe-provider-boot-boundary-20261025`, branch `codex/provider-boot-boundary-20261025`, exact base `bfe0c8fc046c028b83c7b769ad149d5c0fcfd1aa`. Shared-root user files and CODEX_HANDOFF are untouched; root owns their update and all actual operations.

## Investigation and decision

The original owner is application boot2135c4db-b7ac-4c79-91d5-8703190332d2 in reviewer container0e89834f1bea. Dispatch was06:53:36.121Z; durable local-end event13332 was06:53:46.995Z, with one dispatch/one local terminal and matching binding. The unknown reason in the actual event is transport_unknown. The old GPU qwen process429414 was already stopped06:51:28.395Z; old boot e1d32f64-1525-4bd3-ae85-ca328aa8e425 ended its journal06:53:30Z, and current boot d3a48a77-a3e9-427f-8e84-08080e2631fb began around06:54:17Z. Service interruption/reboot could explain transport failure; late admission alone is not established as c2's sole cause.

Readiness PID2496661 had stopped06:45:08Z and lacked full boot/startTicks/namespace/cgroup identity. Current PID11665 started07:00:41Z, after dispatch. Neither can satisfy V1. V2 supports a different historical-owner/launchd topology. Do not relabel current processes, invent old identities, fabricate two gateways, or reuse another request's receipt.

Read-only DB→remote CLOCK_BOOTTIME→DB measurements produced a386283us sandwich with boot interval06:54:17.161784–06:54:17.548070Z, strictly after local end. A later sample corroborated it. Original service/container full serving contracts independently canonical-hash to de4ecad4e1118200a2b6b4e07de765e7251fc6f7fc3724a74ed296ecb618b983. Actual inside child279 has the exact owner boot. Proxy environment is absent; NODE_OPTIONS only changes address-family connection timing. Seven original runtime source files/default Undici implementation were captured; repository source hashes agree with be71. Old tailscaled journal contains30 records binding100.77.43.63 to the same machine hash70aba7a0d5acb0df77d7add923a6d26f5a708df119a7ac75f2d76e346262547e. Old/current native journals show multiproc_executor world_size4=local_world_size4, TP4/PP1/DP1, loopback/file IPC and local worker PIDs. This binds the whole native inference host, rather than only a frontend.

All raw artifacts are private under `/private/tmp/nomorevibe-c2ace-readonly-20261025`. Initial provider bundle SHA673b4fe2e2b95e6b09d61ab93bbcf6f202077035c81b538de0eb256553edad0f is historical preparation, not a fresh operational plan. GPU/provider/DB service actions, stop/release/config/model calls and actual migration were0 in this phase.

## Implementation

- Strict V3 direct Linux boot plan/receipt and integer DB-clock sandwich calculations; explicit zero gateways, full native serving contract, source/endpoint/old/current journal artifact hashes, original owner association and exact local-end reference.
- Migration `drizzle/0130_direct_provider_boot_boundary.sql` (idx130,131st journal row): strict SQL equivalent, authoritative local_model_direct binding/model/backend/group/revision/C, spawned group and local-end DB checks; preserve old V1/V2 bodies/OIDs and all CHECK OIDs through additive delegation.
- Existing locked capacity release and CLI artifact verification reuse the same one-row withdrawn/event/audit transaction. Usage, settled_at, dispatch binding and business results remain unchanged. Actual owner-child↔CID association is a privileged raw-collector requirement, never inferred from a PID number alone.
- Independent search_profile review caught same-millisecond future control timestamps; V3 now compares exact microseconds in both TS/SQL. V1/V2 rules remain unchanged. Its separate private helper owns no GPU actions and is root-operated only.

## Actual verification

- New unit RED2: old V1/V2 union rejected the strict new version. Initial real DB RED2: journal remained130 and old terminal CHECK rejected V3.
- Final scoped boundary unit **19/19**, including CLI artifact tampering and1us local-end boundary.
- Final actual PostgreSQL17/pgvector boundary integration **28/28**, four files: V1 Linux10, V1 launchd5, V2 historical8, V3 direct boot5. Nonempty130→131 keeps request bytes/CHECK OIDs, dry-run rolls back, exact apply yields one row/event/audit, unknown usage remains unknown, replay does not duplicate, terminal is immutable.
- Shared **373-case** null/missing/extra/topology/clock matrix rejected by both TS and actual SQL. Authoritative binding mutations7 and local-end/owner record mutations5 fail closed.
- Official Next typegen, project tsc --noEmit, scoped ESLint and git diff --check passed. No manual whole-suite/build was run; required PR CI is pending root's final combined push.
- Private read-only collectors passed py_compile. Before-bundle collector was actually run. Post-cutoff receipt collector is prepared and has not run against production, since owner cutoff has not occurred.

Failures preserved: first Green attempt hit a fixture function clone error, fixed fixture cloning. Broad malformed-input matrix exposed Zod dirty refinements throwing on invalid BigInt/plan hash; V3 base validation now gates arithmetic. One matrix mutation accidentally retained shared plan/receipt object references; JSON-independent copies corrected the test. First tsc rejected BigInt literals under the existing target; BigInt constructors retain exact arithmetic without changing tsconfig. Existing historical migration assertion expected130; it now follows the131-row journal and verifies the additive trigger line. Existing Vite native-loader warning remains.

## Next commands and root-only operations

```sh
cd /Users/jr/Desktop/projects/nomorevibe-provider-boot-boundary-20261025
npm test -- tests/provider-boot-boundary.test.ts tests/provider-boundary-release.test.ts tests/provider-boundary-launchd.test.ts tests/provider-boundary-historical-owner.test.ts tests/provider-boundary-cli.test.ts
env TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32788/nomorevibe_test npm run test:integration -- tests/integration/provider-boot-boundary.test.ts tests/integration/provider-boundary-release.test.ts tests/integration/provider-boundary-launchd.test.ts tests/integration/provider-boundary-historical-owner.test.ts
npx tsc --noEmit
git diff --check
# Read-only fresh before bundle; requires preserved raw prerequisites and exact source revision:
python3 /private/tmp/nomorevibe-c2ace-readonly-20261025/build-provider-bundle.py /private/tmp/nomorevibe-c2ace-readonly-20261025/provider-bundle-fresh
# Only after root's actual original-owner cutoff, using its exact reviewed plan:
# python3 /private/tmp/nomorevibe-c2ace-readonly-20261025/collect-receipt-bundle.py PLAN_JSON OUTPUT_DIRECTORY
```

Root reviews final diff/independent review before a single combined push/PR; required latest-base CI stays mandatory. Actual order: main checks/images → draining and valid-call reconciliation →0130 exactly once, journal131/hash readback → fresh exact original-owner/runtime/DB plan and approved hash → original owner ingress cutoff/replacement block → fresh same-host boot receipt without native stop → official dry-run/apply and request/event/audit/unknown-usage readback → owner restore/open → ordinary new-code deployment. A changed request, binding, control, owner, host, boot, nonlocal native topology, clock or incomplete raw proof blocks release. No external page investigation or synthetic model generation is authorized.
