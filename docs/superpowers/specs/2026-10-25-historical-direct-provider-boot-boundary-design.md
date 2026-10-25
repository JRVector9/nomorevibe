# Historical owner + direct provider boot boundary V4

Root approved this narrow design on 2026-10-25. Base: `87ecc4b1bf2a3803fdc62ad10c77ebff0f43b05b`. No production calls, model requests, manual audit decisions, deployment, push or migration occur in this implementation phase.

## Problem and rule

V3 requires an observed live original owner identity that predates dispatch. A correctly recorded original process group can finish and its container can be replaced before the operator prepares recovery. A new ingress container cannot stand in for that historical identity. V2 already proves a historical original owner from durable process-group/local-end rows, but its provider boundary is launchd plus two gateways. The supported direct native GPU reboot is a different physical topology.

V4 composes the existing V2 historical owner authority with the existing V3 direct native provider boot authority. No owner identity, Docker wait ACK, native terminal, model usage or business result is invented. Old container absence alone grants no release authority.

Two alternatives were rejected: weakening V3's owner birth/exit rule would change existing evidence semantics; making V2 accept a GPU provider would conflate its gateway/launchd topology. A distinct version keeps old plan/receipt bytes and contracts intact.

## Plan and receipt

Plan version4 has the existing request/control/beforeArtifactHash and V2 `originalOwner` plus `currentIngressOwner`. It also has V3 `provider`, `servingContract`, `transport`, `ownerAssociation`, `localEnd`, `bootWitness`. `gateways` is exactly empty. It has no `owner` field. Both objects are strict.

`originalOwner` is the unchanged durable_process_group_exit schema: owner_opened, complete dispatch-relevant spawn-intent/spawned/group_exited set, exact IDs/seq/PID/run text hash, local-end ID/evidence hash, privileged artifact hash. Every original group must be closed by plan creation. The current ingress has a real independently observed container identity born by plan creation and may have started after dispatch. Receipt version4 contains `originalOwnerProofHash`, actual `currentIngressOwner` exit observation, empty gateways, and V3 provider observation with a fresh boot witness.

The original owner instance/boot equals the immutable request owner. `ownerAssociation` must identify an exact member of originalOwner.groups, matching spawnedEventId/PID/runIdHash. `localEnd.eventId` equals originalOwner.localEndEventId. The two local-end hash fields intentionally remain different domains: V2 originalOwner.localEndEvidenceHash is SHA256 of PostgreSQL evidence::text; V3 localEnd.evidenceHash is SHA256 of boundary ASCII-canonical JSON. Both must prove the same authoritative event under their original rules.

Receipt proof hash is boundary-canonical originalOwner. Current ingress exit must follow plan creation. Provider observation and its DB-before witness must follow current ingress exit. Plan/receipt provider identity, machine/node/native endpoint/boot IDs and conservative boot intervals must agree, with the same V3 sandwich, freshness and microsecond inequalities. Dispatch and local-end precede both boot lower bounds; the later original process-group exit need only precede plan creation, since that local process can close after the native host reboot.

Full serving contract and single_direct_http/attempts1/redirect:error/proxy:false/durableQueue:false/source artifact remain mandatory. The GPU is not stopped by this feature.

## Authoritative records and state transition

The release hook retains fence→control→request locks, exact token/binding/epoch/revision/policy/control timestamp CAS, before artifact, operator/reference, atomic audit and existing immutable terminal behavior.

V4 invokes unchanged `nmv_boundary_original_owner_records_valid` and the existing evaluateLocalCallEnded-based owner helper. Its SQL function has no plan-version restriction and can validate V4 directly. A new records guard additionally checks V3 binding/serving contract fields, canonical local-end ID/time/evidence/1:1 counters and the ownerAssociation's membership in the authoritative original group. It does not manufacture a V3 plan with a fake old owner or a fake startedAt to reuse V3's record function.

Only indeterminate→withdrawn is authorized. Existing binding/token/charge remain intact, settled_at remains NULL, usage remains unknown, and no native terminal or domain result is produced. Same evidence replay remains idempotent; altered receipt/evidence cannot rewrite a release.

## Additive SQL and compatibility

Add `0131_historical_direct_provider_boot_boundary.sql` and journal entry idx131/when1794086400043, making132 rows. All prior SQL bytes, including0130, remain unchanged. Existing V1/V2/V3 helper bodies/OIDs and CHECK definitions/OIDs/validation are preserved. Preserve the current public release validator/transition trigger OIDs while archiving their exact prior bodies in new functions and delegating all non-V4 cases.

Create `nmv_provider_boundary_release_v4_valid(jsonb)` from the exact V3 strict validator by checked substitutions for version, historical/current ingress fields and ingress birth bound, then append originalOwner proof/membership constraints. Each expected source fragment must exist; unexpected predecessor changes abort migration. Add `nmv_boot_historical_records_valid(jsonb,jsonb)` for actual row authority. Add archives `nmv_boot_historical_previous_release_valid(jsonb)` and `nmv_boot_historical_previous_transition_guard()`. Existing public dispatch wrappers gain only a V4 branch and a V4 same-transaction trigger guard.

## Verification and boundaries

Use synthetic fixtures, not actual production decisions. Observe unit RED before schema support. In disposable PostgreSQL, populate a130-entry predecessor with an unresolved direct request and durable closed owner, prove V4 false, migrate0130+0131, then prove strict V4 true with exact132 journal hashes. Capture complete nonempty row/CHECK/function catalogs before and after and verify all old function bodies/OIDs or exact archive equality as appropriate.

Run matching TypeScript/PostgreSQL null/missing/extra/topology/clock negatives, forged owner/event/run/group/local-end/hash/association tests, new unclosed group tests, wrong native binding/CAS/fence/control tests, direct UPDATE/INSERT bypass rejection, old V1/V2/V3 parity, dry-run rollback, exact one released event/audit and immutable replay. CLI must require every original owner/current ingress/native boot/transport artifact. Only targeted regressions and necessary type/lint checks run locally. Root and an independent reviewer inspect the final diff before any push.

Operational migration/release uses fresh new V4 plan/receipt and actual root-reviewed raw artifacts later. Current capacity and original LLM routes/settings remain untouched. The repository's runtime source changes do not itself restore or judge any product.
