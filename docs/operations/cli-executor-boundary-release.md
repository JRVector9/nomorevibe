# Manual CLI executor boundary release

This privileged DR path releases one dispatched publication classify CLI request after review and fencing of its entire physical executor service. It never stops/restarts a service, calls a model, retries work, grants a slot, manufactures `CliProcessTerminal`/process-group events, or certifies business success. Original token, binding, C, unknown usage and `settled_at = NULL` remain unchanged.

Strict schemas: `lib/llm/cli-executor-boundary-contract.ts`.

- Plan: createdAt/reviewReference; exact request ID, owner/token hash/epoch/revision/policy/binding/dispatch time/budget/group/route/provider/model/logical/input/payload/transport/C; current DR lineage/epoch and exact DRAIN control including microsecond updatedAt; executor identity; ordered unique task/full-CID candidates; isolation; bounded before-native interval; six raw artifact hashes.
- Receipt: canonical planHash/observedAt; exact executor/isolation; whole-service desired/running/replacement/orphan counts zero and restart blocked; terminal task and container closure for every candidate; no replay; five fresh raw artifact hashes.

Endpoint is exact client base `http://100.92.77.66:3020`, with `/rpc` separate. Hash base bytes without trailing slash. `executor.specHash` is the closed executor's ORIGINAL before-service execution spec hash, not the post-scale-zero hash. The receipt repeats that original identity. The closure artifact must compare actual after-spec with the original projected to replicas0 only; preserve API/other spec fields exactly. All historical candidate images/specs/source must be reviewed in inventory artifacts; one source field does not erase differences.

`taskHistoryGap = false` covers only the interval from actual before-native capture (native dispatch absent, one current task) through service closure, not permanent Swarm history. Cover every interval candidate. Root independently verifies authentic/exhaustive raw observations and source/config, then approves exact hashes. Typed assertions and artifact hashes bind reviewed bytes; they cannot authenticate invented observations themselves.

Isolation: private PID, unprivileged, named vault volume only, no host PID/socket mounts/escape. Closure: actual container inspect PID0/nonrunning, or removed container with trusted init exit. Historical namespace inode is unnecessary. Private namespace init exit closes processes ([Linux documentation](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)); trusted Swarm task lifecycle is monotonic and binds task/container ([Docker documentation](https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/)). These implications require reviewed isolation and trusted lifecycle evidence.

Endpoint closure: no listener, or identified/hashed trusted forwarder with exact backend service, backend0, no alternative executor and RPC unavailable. Pin daemon/node/Linux VM boot after zero with an exact retained running-container witness. A Desktop listener alone is not a live backend.

No replay: reviewed source, durableQueue=false, oldCallerAuthorityRevoked=true, pendingRpcCannotReplay=true, newBootCannotReplay=true. Review role/job/native token authority, single-use dispatch, closed RPC/service and in-memory transport. Do not fabricate logical publisher exit or substitute it for physical executor closure. Maintain the complete service fence through the transaction. Freshness alone does not hold a fence; later restart is a separate rollout.

Lifetimes: plan30min, receipt5min, DB evaluation30s. Canonical locks recheck active DR lineage/epoch and exact DRAIN generation/policy/updatedAt. OPEN→DRAIN ABA invalidates the plan. Unknown/incomplete/conflicting facts need a new review, not altered assertions or retry.

## Prepare private documents

Use directory0700/files0600. Populate actual captures, never fixtures. Retain raw bytes as `<sha256>.json` without normalization. Compute canonical plan hash and set receipt.planHash; separately approve file hashes:

```sh
node --import tsx --input-type=module -e '
import {readFileSync} from "node:fs";
import {cliExecutorPlanSchema,cliExecutorPlanHash} from "./lib/llm/cli-executor-boundary-contract.ts";
console.log(cliExecutorPlanHash(cliExecutorPlanSchema.parse(JSON.parse(readFileSync(process.argv[1],"utf8")))));
' "$STATE/plan.private.json"
shasum -a 256 "$STATE/plan.private.json" "$STATE/receipt.private.json"
```

All eleven referenced artifact hashes/private modes are checked before DB connection. Default executes canonical transaction then rolls back, including prospective event/audit. DB URL is stdin only:

```sh
node --import tsx scripts/ops/model-cli-executor-boundary-release.ts \
  --plan="$STATE/plan.private.json" --plan-sha=REVIEWED_PLAN_FILE_SHA256 \
  --receipt="$STATE/receipt.private.json" --receipt-sha=REVIEWED_RECEIPT_FILE_SHA256 \
  --artifact-dir="$STATE/artifacts" --operator=REVIEWED_OPERATOR \
  --reference=EXACT_PLAN_REVIEW_REFERENCE --database-url-stdin \
  < "$STATE/database-url.private"
```

After separate dry-run approval, maintaining the fence, add `--apply` to identical arguments. No automatic apply/retry or HTTP API exists. Bounds: lock1s, statement3s, transaction10s (PG17+).

Apply stdout: `{dryRun:false,result:{kind:"released",requestId,auditId}}`; exact replay: `already_released` with no extra writes. Read back row/event/exact audit. Only state, terminal_evidence, terminal_evidence_hash, updated_at change; other request columns and all other requests stay equal. Expect one dispatch_released/dispatched→withdrawn/reasonNULL, audit action model-cli-executor-boundary-release, no process-group changes. Audit detail: reason,planHash,bindingHash,previousState,state,chargedTokensPreserved,modelTerminal=false,usageKnown=false,businessResult=false. This means privileged closure withdrawal, not output/usage/business recovery.

## Validate source

```sh
node --import tsx scripts/ops/generate-cli-executor-boundary-sql.ts
git diff --exit-code -- drizzle/0134_cli_executor_boundary_exit.sql
node node_modules/vitest/vitest.mjs run tests/cli-executor-boundary.test.ts tests/cli-executor-boundary-cli.test.ts
TEST_DATABASE_URL=OWN_LOCAL_PG17_FIXTURE node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/cli-executor-boundary-release.test.ts
```

0134 retains complete predecessor CHECK branches. Generated strict Zod shape plus explicit SQL cross-field/hash/row/freshness/transition guards accept the additive kind; existing kinds keep their rules.
