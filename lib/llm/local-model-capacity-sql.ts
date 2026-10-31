/** 0118과 Drizzle의 같은 추가 분기. 기존 장부 CHECK 본문은 그대로 둔다. */
const fields = (value: string, names: readonly string[]) => `(CASE WHEN jsonb_typeof(${value})='object' THEN
  (${value}) ?& ARRAY[${names.map(name => `'${name}'`).join(",")}]
  AND (${value}) - ARRAY[${names.map(name => `'${name}'`).join(",")}]='{}'::jsonb ELSE false END)`;
const string = (value: string, max: number) => `(jsonb_typeof(${value})='string' AND char_length(${value} #>> '{}') BETWEEN 1 AND ${max}
  AND (${value} #>> '{}')=btrim(${value} #>> '{}') AND (${value} #>> '{}') !~ '[[:cntrl:]]')`;
const match = (value: string, pattern: string) => `(jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '${pattern}')`;
const integer = (value: string, zero = false) => `(CASE WHEN jsonb_typeof(${value})='number' AND (${value})::text ~ '^[0-9]+$'
  THEN (${value})::text::numeric BETWEEN ${zero ? 0 : 1} AND 9007199254740991 ELSE false END)`;
const digest = (value: string) => match(value, "^[a-f0-9]{64}$");
const uuid = (value: string) => match(value, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
const all = (parts: readonly string[]) => `(${parts.join(" AND ")})`;

function target(value: string): string {
  const base = (kind: string, purposes: string[], keys: string[], extra: string[]) => all([
    fields(value, ["kind", "purpose", ...keys]), `${value}->>'kind'='${kind}'`,
    `${value}->>'purpose' IN (${purposes.map(purpose => `'${purpose}'`).join(",")})`, ...extra,
  ]);
  return `(${[
    base("assist", ["assist_review", "intro_correction"], ["workId", "workRevision", "claimToken", "task", "subjectId", "backendId"],
      [uuid(`${value}->'workId'`), integer(`${value}->'workRevision'`), uuid(`${value}->'claimToken'`),
        `nmv_local_assist_task_valid(${value}->>'task')`, `(${value}->>'purpose'='assist_review' OR ${value}->>'task'='intro_recheck')`,
        integer(`${value}->'subjectId'`), match(`${value}->'backendId'`, "^[a-z0-9][a-z0-9-]{0,59}$")]),
    base("audit", ["audit", "second_opinion", "screen"], ["itemId", "slug"], [integer(`${value}->'itemId'`), string(`${value}->'slug'`, 80)]),
    base("published", ["published_filter"], ["secondReviewId", "slug"], [integer(`${value}->'secondReviewId'`), string(`${value}->'slug'`, 80)]),
    base("candidate", ["held_qwen", "human_deepseek"], ["attemptId", "candidateId", "repo"],
      [integer(`${value}->'attemptId'`), integer(`${value}->'candidateId'`), string(`${value}->'repo'`, 200), match(`${value}->'repo'`, "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]),
    base("split", ["qwen_tiebreak", "deepseek_confirm"], ["tiebreakId", "candidateId", "generationKey", "repo"],
      [integer(`${value}->'tiebreakId'`), integer(`${value}->'candidateId'`), digest(`${value}->'generationKey'`), string(`${value}->'repo'`, 200), match(`${value}->'repo'`, "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]),
  ].join(" OR ")})`;
}

/**
 * binding.job.name 이 purpose 로 정해지는 표(lib/llm/local-model-capacity-contract.ts localModelJob) — 0124 까지의 합성 잡 이름과
 * 2026-10-31(PR 3a-C, migration 0155) 단계마다 나눈 잡 이름. 옛 표는 바이트 그대로 둔다(0124 가 만든 CHECK 가지가 그 문자열이다).
 */
type JobNameCase = (t: string) => string;
const legacyJobName: JobNameCase = t => `CASE ${t}->>'purpose' WHEN 'screen' THEN 'audit-screen-review' WHEN 'audit' THEN 'product-audit'
      WHEN 'second_opinion' THEN 'product-audit' WHEN 'published_filter' THEN 'product-audit'
      WHEN 'qwen_tiebreak' THEN 'second-review' ELSE 'human-deepseek-review' END`;
const splitJobName: JobNameCase = t => `CASE ${t}->>'purpose' WHEN 'screen' THEN 'audit-screen-review' WHEN 'audit' THEN 'audit-qwen'
      WHEN 'second_opinion' THEN 'audit-second-opinion' WHEN 'published_filter' THEN 'audit-second-opinion'
      WHEN 'qwen_tiebreak' THEN 'split-tiebreak' WHEN 'deepseek_confirm' THEN 'split-confirm' WHEN 'held_qwen' THEN 'held-qwen-retry' ELSE 'human-deepseek-review' END`;

function binding(value: string, jobName: JobNameCase = legacyJobName): string {
  const t = `(${value}->'target')`, job = `(${value}->'job')`;
  return all([
    fields(value, ["kind", "version", "target", "logicalWorkKey", "routeId", "provider", "model", "backendId", "physicalGroup", "deploymentRevision",
      "inputHash", "sourceRevisionHash", "reviewPolicyHash", "promptVersion", "wireHash", "servingContractHash", "totalTokenBound", "chargedTokens", "job"]),
    `${value}->>'kind'='local_model_direct'`, `${value}->'version'='1'::jsonb`, target(t),
    string(`${value}->'logicalWorkKey'`, 160), string(`${value}->'routeId'`, 120), `${value}->>'provider'='local-direct'`, string(`${value}->'model'`, 200),
    string(`${value}->'backendId'`, 120), string(`${value}->'physicalGroup'`, 120), string(`${value}->'deploymentRevision'`, 200),
    ...["inputHash", "sourceRevisionHash", "reviewPolicyHash", "wireHash", "servingContractHash"].map(key => digest(`${value}->'${key}'`)),
    string(`${value}->'promptVersion'`, 160), integer(`${value}->'totalTokenBound'`), integer(`${value}->'chargedTokens'`),
    `${value}->'totalTokenBound'=${value}->'chargedTokens'`, fields(job, ["name", "token", "requestedVersion"]),
    string(`${job}->'name'`, 120), uuid(`${job}->'token'`), integer(`${job}->'requestedVersion'`, true),
    `${value}->>'logicalWorkKey'='direct:' || (${t}->>'kind') || ':' || CASE ${t}->>'kind'
      WHEN 'audit' THEN ${t}->>'itemId' WHEN 'published' THEN ${t}->>'secondReviewId'
      WHEN 'assist' THEN ${t}->>'subjectId' ELSE ${t}->>'candidateId' END || ':' || CASE WHEN ${t}->>'kind'='assist' THEN ${t}->>'task' ELSE ${t}->>'purpose' END`,
    `${value}->>'routeId'=CASE WHEN ${t}->>'kind'='assist' THEN 'local-assist-' || (${t}->>'task') || '-' || (${t}->>'backendId') ELSE 'local-' || replace(${t}->>'purpose','_','-') END`,
    `(${t}->>'kind'<>'assist' OR ${t}->>'backendId'=${value}->>'backendId')`,
    `${job}->>'name'=CASE WHEN ${t}->>'kind'='assist' THEN CASE WHEN ${t}->>'task' IN ('decision_audit','semantic_exception') THEN 'product-llm-assist-audit-review' ELSE 'product-llm-assist-review' END ELSE ${jobName(t)} END`,
  ]);
}

function dispatch(value: string, jobName: JobNameCase = legacyJobName): string {
  return all([
    fields(value, ["requestId", "owner", "token", "epoch", "revision", "policyHash", "binding", "bindingHash"]),
    uuid(`${value}->'requestId'`), fields(`(${value}->'owner')`, ["instanceId", "bootId"]),
    string(`(${value}->'owner')->'instanceId'`, 120), uuid(`(${value}->'owner')->'bootId'`), uuid(`${value}->'token'`),
    integer(`${value}->'epoch'`), integer(`${value}->'revision'`), digest(`${value}->'policyHash'`), digest(`${value}->'bindingHash'`),
    binding(`(${value}->'binding')`, jobName),
  ]);
}

function terminal(value: string, jobName: JobNameCase = legacyJobName): string {
  const u = `(${value}->'actualUsage')`;
  return all([
    fields(value, ["kind", "version", "dispatch", "responseHash", "finishReason", "actualUsage", "provenance"]),
    `${value}->>'kind'='local_model_terminal'`, `${value}->'version'='1'::jsonb`, dispatch(`(${value}->'dispatch')`, jobName), digest(`${value}->'responseHash'`),
    `${value}->>'finishReason' IN ('stop','length','tool_calls','function_call','content_filter')`,
    `((${u}='null'::jsonb AND ${value}->>'provenance'='unknown') OR ${all([
      fields(u, ["inputTokens", "outputTokens", "totalTokens"]), ...["inputTokens", "outputTokens", "totalTokens"].map(key => integer(`${u}->'${key}'`, true)),
      `${value}->>'provenance'='upstream_reported'`,
      `(${u}->>'inputTokens')::numeric + (${u}->>'outputTokens')::numeric=(${u}->>'totalTokens')::numeric`,
      `(${u}->>'totalTokens')::numeric<=(${value}->'dispatch'->'binding'->>'totalTokenBound')::numeric`,
    ])})`,
  ]);
}

const directLogicalSql = all([
  "logical_work_key ~ '^direct:(audit|published|candidate|split):[1-9][0-9]{0,15}:(audit|second_opinion|screen|published_filter|held_qwen|human_deepseek|qwen_tiebreak|deepseek_confirm)$'",
  "class='background' AND pool='reviewer' AND provider='local-direct'",
  "CASE WHEN split_part(logical_work_key,':',3) ~ '^[1-9][0-9]{0,15}$' THEN split_part(logical_work_key,':',3)::numeric BETWEEN 1 AND 9007199254740991 ELSE false END",
  "route_id='local-' || replace(split_part(logical_work_key,':',4),'_','-')",
  "logical_member_keys IS NULL",
  "((split_part(logical_work_key,':',2)='audit' AND split_part(logical_work_key,':',4) IN ('audit','second_opinion','screen')) OR (split_part(logical_work_key,':',2)='published' AND split_part(logical_work_key,':',4)='published_filter') OR (split_part(logical_work_key,':',2)='candidate' AND split_part(logical_work_key,':',4) IN ('held_qwen','human_deepseek')) OR (split_part(logical_work_key,':',2)='split' AND split_part(logical_work_key,':',4) IN ('qwen_tiebreak','deepseek_confirm')))",
]);
export const localModelLogicalSql = `(${directLogicalSql} OR ${all([
  "logical_work_key ~ '^direct:assist:[1-9][0-9]{0,15}:[a-z_]{1,32}$'", "class='background' AND pool='reviewer' AND provider='local-direct'",
  "nmv_local_assist_task_valid(split_part(logical_work_key,':',4))",
  "CASE WHEN split_part(logical_work_key,':',3) ~ '^[1-9][0-9]{0,15}$' THEN split_part(logical_work_key,':',3)::numeric BETWEEN 1 AND 9007199254740991 ELSE false END",
  "left(route_id,length('local-assist-' || split_part(logical_work_key,':',4) || '-'))='local-assist-' || split_part(logical_work_key,':',4) || '-'",
  "substring(route_id from length('local-assist-' || split_part(logical_work_key,':',4) || '-')+1) ~ '^[a-z0-9][a-z0-9-]{0,59}$'", "logical_member_keys IS NULL",
])})`;

const dispatchSql = (jobName: JobNameCase) => all([
  "dispatch_binding IS NOT NULL AND dispatch_binding_hash ~ '^[a-f0-9]{64}$' AND dispatched_at IS NOT NULL AND state IN ('dispatched','indeterminate','settled','withdrawn')",
  localModelLogicalSql, binding("dispatch_binding", jobName),
  "dispatch_binding->>'logicalWorkKey'=logical_work_key AND dispatch_binding->>'routeId'=route_id AND dispatch_binding->>'provider'=provider AND dispatch_binding->>'model'=model",
  "dispatch_binding->>'physicalGroup'=group_id AND dispatch_binding->>'backendId'=provider_budget_id",
]);
const terminalSql = (jobName: JobNameCase) => all([
  "terminal_evidence IS NOT NULL AND terminal_evidence_hash ~ '^[a-f0-9]{64}$' AND settled_at IS NOT NULL AND state='settled'",
  terminal("terminal_evidence", jobName),
  "terminal_evidence->'dispatch'->'binding'=dispatch_binding AND terminal_evidence->'dispatch'->>'bindingHash'=dispatch_binding_hash",
  "terminal_evidence->'dispatch'->>'requestId'=request_id::text AND terminal_evidence->'dispatch'->'owner'->>'instanceId'=owner_instance_id",
  "terminal_evidence->'dispatch'->'owner'->>'bootId'=owner_boot_id::text AND terminal_evidence->'dispatch'->>'token'=token::text",
  "(terminal_evidence->'dispatch'->>'epoch')::numeric=epoch AND (terminal_evidence->'dispatch'->>'revision')::numeric=revision",
  "terminal_evidence->'dispatch'->>'policyHash'=policy_hash",
]);
const eventTerminalSql = (jobName: JobNameCase) => all([
  "kind='dispatch_settled' AND from_state IN ('dispatched','indeterminate') AND to_state='settled'",
  terminal("evidence", jobName), "evidence->'dispatch'->>'requestId'=request_id::text",
  "evidence->'dispatch'->'epoch'=to_jsonb(epoch) AND evidence->'dispatch'->'revision'=to_jsonb(revision) AND evidence->'dispatch'->>'policyHash'=policy_hash",
]);

/** 0118~0124 가 만든 가지(합성 잡 이름) — 바이트 그대로 */
export const localModelDispatchSql = dispatchSql(legacyJobName);
export const localModelTerminalSql = terminalSql(legacyJobName);
export const localModelEventTerminalSql = eventTerminalSql(legacyJobName);

/**
 * 0155(PR 3a-C) 가 OR 로 더한 가지 — 같은 local_model_direct 모양에 binding.job.name 만 단계마다 나눈 잡 이름이다. 옛 가지는 그대로 남아
 * 3a-C 전에 띄운 행(product-audit·second-review·human-deepseek-review 로 적힌 것)이 계속 통과한다. 새 행은 실제 잡 lease(새 이름)로만 생긴다.
 */
export const localModelSplitJobsDispatchSql = dispatchSql(splitJobName);
export const localModelSplitJobsTerminalSql = terminalSql(splitJobName);
export const localModelSplitJobsEventTerminalSql = eventTerminalSql(splitJobName);
