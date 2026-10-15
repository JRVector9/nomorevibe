import { describe, expect, it, vi } from "vitest";
import { getTableColumns, type Table } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createReviewInput, reviewHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { publishedInputHash } from "@/lib/crawl/second-review";
import { secondReviewPolicyHash } from "@/lib/crawl/second-review-ownership";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { itemBindingHash, itemWorkKey, type Ai2ItemBinding, type ItemBinding } from "@/lib/jobs/items/types";
import type { ReplayCombinedState } from "@/lib/operations/pipeline-replay-combined-capture";
import { assessReplayAi2Target } from "@/lib/operations/pipeline-replay-ai2-target";

const reference = "2001-11-01T00:00:00.000Z", wall = "2026-10-16T00:00:00.123456Z", target = 201;
const boot = "11111111-1111-4111-8111-111111111111", token = "22222222-2222-4222-8222-222222222222";
type State = ReplayCombinedState;
type Raw = State["domain"]["tables"]["jobs"][number];
type Item = State["items"]["tables"]["pipeline_item_leases"][number];
function row(table: Table, values: Record<string, unknown>): Raw {
  return { ...Object.fromEntries(Object.values(getTableColumns(table)).map(column => [column.name, null])), ...values } as Raw;
}
function hydrate<T>(value: Raw, table: Table): T {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([name, column]) => [name,
    value[column.name] === null ? null : column.dataType === "date" ? new Date(String(value[column.name]))
      : column.mapFromDriverValue(value[column.name])])) as T;
}
const vote = (state: State, id = target) => state.domain.tables.second_reviews.find(row => row.id === id)!;
const candidate = (state: State) => state.domain.tables.crawl_candidates[0];
const document = (state: State) => state.domain.tables.crawl_documents[0];
const settings = (state: State) => state.domain.tables.crawl_settings[0].values as unknown as CrawlSettings;
const stage = (state: State) => state.items.tables.pipeline_stage_modes.find(row => row.stage === "ai2")!;
function refresh(state: State, scanId: number | null = null, replaceUniverse = true): ReviewInput {
  const scan = state.domain.tables.agent_repository_scans.find(row => row.id === scanId);
  const observations = scan ? state.domain.tables.agent_repository_observations.filter(row => row.scan_id === scan.id) : [];
  const input = createReviewInput(hydrate(candidate(state), schema.crawlCandidates), hydrate(document(state), schema.crawlDocuments),
    settings(state), { scan: scan ? hydrate(scan, schema.agentRepositoryScans) : null,
      observations: observations.map(row => ({ id: `observation:${row.id}`, observation: row.facts as never })) }, new Date(reference));
  for (const first of state.domain.tables.crawl_review_attempts) Object.assign(first, { input_hash: input.inputHash,
    source_revision_hash: input.sourceRevisionHash, policy_hash: input.policyHash, snapshot: input.snapshot,
    source: JSON.parse(JSON.stringify(input.source)), valid_until: input.validUntil.toISOString() });
  for (const entry of state.domain.tables.second_reviews) Object.assign(entry, {
    input_hash: entry.published_slug ? publishedInputHash(entry.published_slug as string) : input.inputHash,
    generation_key: secondReviewGeneration(entry.first_attempt_id as number | null, input, entry.trigger as string) });
  if (replaceUniverse) {
    const frozenInput = JSON.parse(JSON.stringify(input));
    state.domain.universe = [{ candidateId: candidate(state).id as number, inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, frozenInput, frozenHash: reviewHash(frozenInput) }];
  }
  return input;
}
function fixture(published = false) {
  const policy: CrawlSettings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" },
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
      voters: [{ provider: "abcllm", model: "second-model" }, { provider: "abcllm", model: "other-second" }],
      fallbacks: [{ provider: "abcllm", model: "backup-model" }, { provider: "abcllm", model: "first-model" }] } };
  const state: State = { kind: "pipeline-replay-combined-state", version: 1, domain: { version: 1,
    referenceTime: reference, universe: [], tables: {
      crawl_settings: [row(schema.crawlSettings, { id: 1, values: policy })],
      crawl_candidates: [row(schema.crawlCandidates, { id: 11, repo: "target/app", product_url: "https://target.example",
        state: published ? "published" : "approved", reason: "passed", decided_by: "auto", judged_at: reference,
        published_slug: published ? "target-app" : null })],
      crawl_documents: [row(schema.crawlDocuments, { id: 31, repo: "target/app", product_url: "https://target.example",
        fetched_at: "2001-10-31T23:59:59.000Z", page_status: 200,
        repo_meta: { description: "A deployed project tracker", stargazers_count: 12, fork: false, archived: false,
          owner: { type: "User" } },
        page_meta: { title: "Project tracker", description: "Manage projects and tasks in your browser",
          textSample: "Create projects and manage tasks in the application.", repositoryKeys: ["target/app"],
          readmeSample: "An online project tracker", readmeSampleVersion: README_SAMPLE_VERSION } })],
      crawl_review_attempts: published ? [] : [row(schema.crawlReviewAttempts, { id: 101, candidate_id: 11,
        kind: "automatic", state: "succeeded", provider: "abcllm", model: "first-model", attempt_number: 1,
        prompt_version: REVIEW_PROMPT_VERSION, rules_version: REVIEW_RULES_VERSION,
        outcome: { decision: "approve", confidence: .94, reason: "A deployed app", evidenceIds: ["product"] },
        completed_at: reference })],
      second_reviews: [row(schema.secondReviews, { id: target, candidate_id: 11, repo: "target/app", status: "pending",
        published_slug: published ? "target-app" : null, trigger: published ? "sample" : "ai_approved", signals: [],
        first_decision: "approve", first_confidence: published ? null : .94, first_model: published ? null : "first-model",
        first_attempt_id: published ? null : 101, provider: "abcllm", model: "second-model", failure_count: 0 })],
      products: published ? [row(schema.products, { id: 51, slug: "target-app", url: "https://target.example",
        repo_url: "https://github.com/target/app", status: "seeded" })] : [],
      agent_repository_scans: [], agent_repository_observations: [], crawl_frontier: [], jobs: [],
      operations_observations: [], capacity_calls: [],
    } }, items: { kind: "pipeline-replay-item-state", version: 1, tables: {
      pipeline_stage_modes: (["fetch", "ai1", "ai2"] as const).map(stage => ({ stage,
        mode: stage === "ai2" ? "items" : "legacy", draining_from: null, epoch: stage === "ai2" ? 7 : 1,
        writer_contract_version: stage === "ai2" ? 1 : 0, updated_at: wall })), pipeline_item_leases: [],
    } } };
  return { state, input: refresh(state) };
}
function binding(state: State, input: ReviewInput, id = target): Ai2ItemBinding {
  const entry = vote(state, id);
  return { stage: "ai2", secondReviewId: id, candidateId: entry.candidate_id as number,
    source: entry.published_slug ? { kind: "published", slug: entry.published_slug as string,
      productId: state.domain.tables.products.find(row => row.slug === entry.published_slug)!.id as number }
      : { kind: "first_attempt", firstAttemptId: entry.first_attempt_id as number },
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: secondReviewPolicyHash(mergeWithDefaults(settings(state))),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    reviewer: { provider: entry.provider as string, model: entry.model as string }, generationKey: entry.generation_key as string,
    vote: (entry.fallback_for_id ?? id) as number, fallbackForId: entry.fallback_for_id as number | null };
}
function eligible(state: State, input: ReviewInput, id = target, membership: "included" | "outside" = "included") {
  return { kind: "eligible", targetId: id, binding: binding(state, input, id), inputMembership: membership };
}
const negative = (reason: string, id = target) => ({ kind: "ineligible", targetId: id, reason });
const unknown = (reason: string) => ({ kind: "unknown", targetId: target, reason });
function owner(binding: ItemBinding, values: Partial<Item> = {}): Item {
  // Raw committed evidence only, not a receipt or an assertion that a claim ran.
  return { stage: binding.stage, work_key: itemWorkKey(binding), binding, binding_hash: itemBindingHash(binding),
    owner_instance_id: "foreign-owner", owner_boot_id: boot, token, stage_epoch: 1, item_epoch: 3,
    lease_until: "2026-10-16T00:01:30.123Z", created_at: wall, updated_at: wall, ...values };
}
function fallback() {
  const value = fixture(), root = vote(value.state);
  Object.assign(root, { status: "resolved", resolution: "fallback" });
  value.state.domain.tables.second_reviews.push({ ...root, id: 202, model: "backup-model", fallback_for_id: target,
    status: "pending", resolution: null });
  return value;
}
function scan(id: number, startedAt: string): Raw {
  return row(schema.agentRepositoryScans, { id, github_repository_id: 91, repository_key: "target/app", scope: "",
    scope_hash: "a".repeat(64), commit_sha: "b".repeat(40), detector_version: DEFAULT_CRAWL_SETTINGS.agentEvidence.detectorVersion,
    state: "complete", coverage: { limited: false }, started_at: startedAt, completed_at: "2001-10-31T23:59:59.000Z" });
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}

describe("explicit snapshot contract and reason ordering", () => {
  it.each([false, true])("returns the exact current binding without authority for published=%s", published => {
    const { state, input } = fixture(published), result = assessReplayAi2Target(state, target, wall);
    expect(result).toEqual(eligible(state, input));
    expect(Object.keys(result).sort()).toEqual(["binding", "inputMembership", "kind", "targetId"]);
    if (published) expect(binding(state, input).inputHash).not.toBe(vote(state).input_hash);
  });
  it.each(["legacy", "draining"] as const)("keeps %s admission inactive before any unknown/source condition", mode => {
    const { state } = fixture(); stage(state).mode = mode; stage(state).draining_from = mode === "draining" ? "items" : null;
    state.domain.tables.crawl_settings = [];
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("stage_inactive"));
  });
  it("rejects contract0 while other stages do not gate a valid AI2 target", () => {
    const { state, input } = fixture(); stage(state).writer_contract_version = 0;
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("stage_inactive"));
    stage(state).writer_contract_version = 1;
    for (const other of state.items.tables.pipeline_stage_modes.filter(row => row.stage !== "ai2")) {
      other.mode = "draining"; other.draining_from = "legacy";
    }
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it.each(["failed", "agreed", "needs_human", "resolved"])("preserves not_pending for %s before settings ambiguity", status => {
    const { state } = fixture(); vote(state).status = status; state.domain.tables.crawl_settings = [];
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("not_pending"));
  });
  it("returns not_pending for an absent target ID", () => {
    expect(assessReplayAi2Target(fixture().state, 999, wall)).toEqual(negative("not_pending", 999));
  });
  it("keeps a live chain ahead of context invalidity and support unknown", () => {
    const { state, input } = fixture(); state.items.tables.pipeline_item_leases.push(owner(binding(state, input)));
    state.domain.tables.crawl_settings = []; candidate(state).state = "rejected";
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("running"));
  });
  it("reports ambiguous settings without choosing id1 or canonical row order", () => {
    const { state } = fixture(); state.domain.tables.crawl_settings.push({ ...state.domain.tables.crawl_settings[0], id: 10 });
    for (const rows of [state.domain.tables.crawl_settings, [...state.domain.tables.crawl_settings].reverse()]) {
      const copy = structuredClone(state); copy.domain.tables.crawl_settings = rows;
      expect(assessReplayAi2Target(copy, target, wall)).toEqual(unknown("ambiguous_settings"));
    }
  });
  it("preserves support unknown for an invalid candidate with ambiguous settings", () => {
    const { state } = fixture(); candidate(state).state = "rejected";
    state.domain.tables.crawl_settings.push({ ...state.domain.tables.crawl_settings[0], id: 10 });
    expect(assessReplayAi2Target(state, target, wall)).toEqual(unknown("ambiguous_settings"));
  });
  it.each(["no settings", "no explicit reviewer"])("does not consult environment for %s", scenario => {
    const { state } = fixture(); if (scenario === "no settings") state.domain.tables.crawl_settings = [];
    else delete settings(state).firstReview;
    vi.stubEnv("CRAWL_REVIEW_MODEL", "first-model");
    try { expect(assessReplayAi2Target(state, target, wall)).toEqual(unknown("implicit_first_reviewer")); }
    finally { vi.unstubAllEnvs(); }
  });
  it.each(["readmeSample", "readmeSampleVersion"])("reports missing stored %s rather than invalidating the current input", key => {
    const { state } = fixture(); delete (document(state).page_meta as Record<string, unknown>)[key];
    expect(assessReplayAi2Target(state, target, wall)).toEqual(unknown("missing_stored_readme"));
  });
  it("does not consult the ambient wall clock", () => {
    const { state, input } = fixture(); vi.useFakeTimers();
    try { vi.setSystemTime("1901-01-01"); const old = assessReplayAi2Target(state, target, wall);
      vi.setSystemTime("2101-01-01"); expect(assessReplayAi2Target(state, target, wall)).toEqual(old);
      expect(old).toEqual(eligible(state, input)); } finally { vi.useRealTimers(); }
  });
  it("accepts the identical semantic scope and rejects a conflicting one", async () => {
    const { state, input } = fixture();
    await withReviewReplayContext({ referenceTime: new Date(reference) }, async () => {
      expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    });
    await withReviewReplayContext({ referenceTime: new Date("2001-11-01T00:00:00.001Z") }, async () => {
      expect(() => assessReplayAi2Target(state, target, wall)).toThrow("replay_clock_scope_conflict");
    });
  });
  it("clones every returned binding while preserving frozen input and all raw state", () => {
    const { state, input } = fixture(true), before = structuredClone(state); freeze(state);
    const a = assessReplayAi2Target(state, target, wall), b = assessReplayAi2Target(state, target, wall);
    expect(a).toEqual(eligible(state, input)); expect(a).toEqual(b);
    if (a.kind !== "eligible" || b.kind !== "eligible" || a.binding.source.kind !== "published") throw new Error("expected_eligible_control");
    a.binding.reviewer.model = "changed"; a.binding.source.productId = 999;
    expect(b).toEqual(eligible(before, input)); expect(state).toEqual(before);
  });
});

describe("committed item arbitration at an explicit microsecond wall", () => {
  it.each([
    ["2026-10-16T00:00:00.123455Z", false], [wall, false], ["2026-10-16T00:00:00.123457Z", true],
  ] as const)("uses lease_until=%s and strict future ownership (%s)", (leaseUntil, live) => {
    const { state, input } = fixture(); state.items.tables.pipeline_item_leases.push(owner(binding(state, input), { lease_until: leaseUntil }));
    expect(assessReplayAi2Target(state, target, wall)).toEqual(live ? negative("running") : eligible(state, input));
  });
  it("treats both three- and six-digit spellings of the same instant identically", () => {
    const { state, input } = fixture(); state.items.tables.pipeline_item_leases.push(owner(binding(state, input), { lease_until: "2026-10-16 09:00:00.123+09:00" }));
    expect(assessReplayAi2Target(state, target, "2026-10-16T00:00:00.123Z"))
      .toEqual(assessReplayAi2Target(state, target, "2026-10-16T00:00:00.123000Z"));
  });
  it("never discounts a healthy owner with an old epoch or changed binding", () => {
    const { state, input } = fixture(), old = binding(state, input); old.generationKey = "a".repeat(64); old.candidateId = 999;
    state.items.tables.pipeline_item_leases.push(owner(old, { stage_epoch: 1, owner_instance_id: "same-or-foreign" }));
    expect(stage(state).epoch).toBe(7);
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("running"));
  });
  it("accepts a released logical row and checks exhausted item epoch only after current context", () => {
    const { state, input } = fixture(); state.items.tables.pipeline_item_leases.push(owner(binding(state, input), {
      owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null, item_epoch: 0 }));
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    state.items.tables.pipeline_item_leases[0].item_epoch = Number.MAX_SAFE_INTEGER;
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("running"));
    document(state).product_url = "https://changed.example";
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed"));
  });
  it("protects root and every sibling work key even when its persisted candidate binding is foreign", () => {
    const { state, input } = fallback();
    const sibling = { ...vote(state, 202), id: 203, candidate_id: 999 };
    state.domain.tables.second_reviews.push(sibling);
    const foreign = { ...binding(state, input, 202), secondReviewId: 203, candidateId: 999 };
    state.items.tables.pipeline_item_leases.push(owner(foreign));
    expect(assessReplayAi2Target(state, 202, wall)).toEqual(negative("running", 202));
  });
  it("does not turn candidate ANY-generation protection into target-chain exclusion", () => {
    const { state, input } = fixture(), other: Raw = { ...vote(state), id: 203, model: "other-second", generation_key: "b".repeat(64) };
    state.domain.tables.second_reviews.push(other);
    const foreign = { ...binding(state, input), secondReviewId: 203, vote: 203, generationKey: "b".repeat(64) };
    state.items.tables.pipeline_item_leases.push(owner(foreign));
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    other.generation_key = vote(state).generation_key;
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it("does not collide with another stage's equal numeric identity", () => {
    const { state, input } = fixture();
    state.items.tables.pipeline_item_leases.push(owner({ stage: "ai1", candidateId: target, inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, promptVersion: REVIEW_PROMPT_VERSION,
      rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider: "abcllm", model: "first-model" } }));
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
});

describe("current source and upstream identity storage adapter", () => {
  const invalid: Array<[string, (state: State) => void]> = [
    ["missing candidate", state => { state.domain.tables.crawl_candidates = []; }],
    ["missing document", state => { state.domain.tables.crawl_documents = []; }],
    ["different candidate repository", state => { candidate(state).repo = "another/app"; }],
    ["different document URL", state => { document(state).product_url = "https://changed.example"; }],
    ["unpublished human state", state => { candidate(state).decided_by = "admin"; }],
    ["wrong candidate state", state => { candidate(state).state = "needs_review"; }],
    ["disabled settings", state => { settings(state).enabled = false; }],
    ["disabled second review", state => { settings(state).secondReview.enabled = false; }],
    ["removed primary model", state => { settings(state).secondReview.voters = []; }],
    ["wrong provider", state => { vote(state).provider = "claude-cli"; }],
    ["first confidence mismatch", state => { vote(state).first_confidence = .5; }],
    ["same first model", state => { vote(state).model = "first-model"; settings(state).secondReview.voters.push({ provider: "abcllm", model: "first-model" }); }],
    ["wrong current input", state => { vote(state).input_hash = "a".repeat(64); }],
    ["wrong generation", state => { vote(state).generation_key = "b".repeat(64); }],
    ["missing first", state => { state.domain.tables.crawl_review_attempts = []; }],
    ["first wrong candidate", state => { state.domain.tables.crawl_review_attempts[0].candidate_id = 99; }],
    ["first source mismatch", state => { state.domain.tables.crawl_review_attempts[0].source_revision_hash = "c".repeat(64); }],
    ["first policy mismatch", state => { state.domain.tables.crawl_review_attempts[0].policy_hash = "d".repeat(64); }],
    ["first prompt mismatch", state => { state.domain.tables.crawl_review_attempts[0].prompt_version = "old"; }],
    ["first rules mismatch", state => { state.domain.tables.crawl_review_attempts[0].rules_version = "old"; }],
    ["first failed", state => { state.domain.tables.crawl_review_attempts[0].state = "failed"; }],
    ["first manual", state => { state.domain.tables.crawl_review_attempts[0].kind = "admin_override"; }],
    ["first model absent", state => { state.domain.tables.crawl_review_attempts[0].model = null; vote(state).first_model = null; }],
    ["expired unpublished source", state => { document(state).fetched_at = "2001-10-01T00:00:00.000Z"; refresh(state, null, false); }],
  ];
  it.each(invalid)("rejects current %s through the public domain rules", (_label, mutate) => {
    const { state } = fixture(); mutate(state); expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed"));
  });
  it.each(["other provider", "other model", "failed", "manual"])("keeps gate referenced reviewer when newer first is %s", variant => {
    const { state, input } = fixture(), newer: Raw = { ...state.domain.tables.crawl_review_attempts[0], id: 999 };
    if (variant === "other provider") newer.provider = "claude-cli";
    if (variant === "other model") newer.model = "another-first";
    if (variant === "failed") newer.state = "failed";
    if (variant === "manual") newer.kind = "admin_override";
    state.domain.tables.crawl_review_attempts.push(newer);
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it("rejects the older gate when the same provider/model has a newer success", () => {
    const { state } = fixture(); state.domain.tables.crawl_review_attempts.push({ ...state.domain.tables.crawl_review_attempts[0], id: 999 });
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed"));
  });
  it.each(["ai_held", "ai_decided"])("preserves normal %s and its broad latest first provider selection", trigger => {
    const { state } = fixture(); candidate(state).state = "needs_review"; vote(state).trigger = trigger;
    const decision = trigger === "ai_held" ? "needs_review" : "reject";
    vote(state).first_decision = decision;
    (state.domain.tables.crawl_review_attempts[0].outcome as Record<string, unknown>).decision = decision;
    const input = refresh(state);
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    state.domain.tables.crawl_review_attempts.push({ ...state.domain.tables.crawl_review_attempts[0], id: 999, provider: "claude-cli" });
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed"));
  });
  it("allows grok first history only under the same explicit configured identity", () => {
    const { state, input } = fixture(); state.domain.tables.crawl_review_attempts[0].provider = "grok-cli";
    expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed"));
    settings(state).firstReview = { provider: "grok-cli", model: "first-model" };
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it("keeps missing and null first confidence equivalent", () => {
    const { state, input } = fixture(); vote(state).first_confidence = null;
    const outcome = state.domain.tables.crawl_review_attempts[0].outcome as Record<string, unknown>; delete outcome.confidence;
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    outcome.confidence = null; expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it("preserves aliases, policy-only rebinding and pending rows beyond result retry caps", () => {
    const { state, input } = fixture(); settings(state).secondReview.voters[0].model = " [MLX] SECOND-MODEL ";
    settings(state).secondReview.agreeAt = .99; settings(state).reviewMode = "observe"; vote(state).failure_count = 99;
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it.each(["microseconds", "id tie", "detector not filtered", "foreign scope ignored"])("selects actual latest scan by %s before Date hydration", scenario => {
    const { state } = fixture();
    const correct = scan(80, "2001-10-31T23:59:58.000002Z"), distractor = scan(81, "2001-10-31T23:59:58.000001Z");
    if (scenario === "id tie") { correct.id = 82; distractor.started_at = correct.started_at; }
    if (scenario === "detector not filtered") { correct.detector_version = "old-detector"; correct.scope_hash = "c".repeat(64); }
    if (scenario === "foreign scope ignored") { distractor.started_at = "2001-10-31T23:59:59.000Z"; distractor.scope = "packages"; }
    state.domain.tables.agent_repository_scans = [distractor, correct];
    const input = refresh(state, correct.id as number);
    expect(input.source.scanId).toBe(correct.id);
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    state.domain.tables.agent_repository_scans.reverse();
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it("builds input from only the selected scan's observations, independent of raw observation order", () => {
    const { state } = fixture(), selected = scan(80, "2001-10-31T23:59:58.000002Z");
    state.domain.tables.agent_repository_scans = [selected];
    const facts = { kind: "instruction_file", client: "claude", compatibleClients: ["claude"], modelDeveloper: null,
      declaredModelId: null, gateway: null, routing: "unknown", role: null, scope: "", keyPath: null,
      ruleId: "claude.v1", sourcePath: "CLAUDE.md", commitSha: "b".repeat(40), blobSha: "c".repeat(40),
      sourceUrl: "https://github.com/target/app/blob/main/CLAUDE.md" };
    state.domain.tables.agent_repository_observations = [
      row(schema.agentRepositoryObservations, { id: 82, scan_id: 80, facts: { ...facts, client: "cursor" } }),
      row(schema.agentRepositoryObservations, { id: 81, scan_id: 80, facts }),
      row(schema.agentRepositoryObservations, { id: 999, scan_id: 999, facts: { ...facts, declaredModelId: "foreign-model" } }),
    ];
    const input = refresh(state, 80);
    expect(input.snapshot.evidence).toHaveLength(2);
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    state.domain.tables.agent_repository_observations.reverse();
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
});

describe("fallback and published product identity", () => {
  it("accepts the exact fallback chain and preserves same-first fallback as reference-only", () => {
    const { state, input } = fallback();
    expect(assessReplayAi2Target(state, 202, wall)).toEqual(eligible(state, input, 202));
    vote(state, 202).model = "first-model";
    expect(assessReplayAi2Target(state, 202, wall)).toEqual(eligible(state, input, 202));
  });
  it.each([
    ["candidate_id", 999], ["repo", "other/app"], ["first_attempt_id", 999], ["trigger", "ai_decided"],
    ["first_confidence", .5], ["first_model", "other-first"], ["first_decision", "reject"],
    ["generation_key", "a".repeat(64)], ["input_hash", "b".repeat(64)], ["status", "failed"], ["resolution", "superseded"],
  ])("rejects fallback root %s mismatch", (key, value) => {
    const { state } = fallback(); vote(state)[key as string] = value;
    expect(assessReplayAi2Target(state, 202, wall)).toEqual(negative("input_changed", 202));
  });
  it.each(["sample", "risk"])("keeps published %s null-first semantics without an auto-only rule", trigger => {
    const { state, input } = fixture(true); vote(state).trigger = trigger; candidate(state).decided_by = "admin";
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it("does not add unpublished-only expiry to a current published generation", () => {
    const { state } = fixture(true); document(state).fetched_at = "2001-10-01T00:00:00.000Z";
    const input = refresh(state, null, false);
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input, target, "outside"));
  });
  it.each(["homepage", "canonical url", "normalized repo url"])("uses product identity by %s", identity => {
    const { state, input } = fixture(true), product = state.domain.tables.products[0];
    if (identity === "homepage") product.repo_url = null;
    if (identity === "canonical url") { product.url = "https://github.com/target/app"; product.repo_url = null; }
    if (identity === "normalized repo url") { product.url = "https://other.example"; product.repo_url = "HTTP://WWW.GITHUB.COM/TARGET/APP.git///"; }
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it.each(["banned beats lower seeded", "lower id wins", "unrelated slug exists"])("preserves repository selection: %s", scenario => {
    const { state, input } = fixture(true), product = state.domain.tables.products[0];
    if (scenario === "banned beats lower seeded") { product.status = "banned";
      state.domain.tables.products.push({ ...product, id: 1, slug: "other", status: "seeded" });
      expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    } else if (scenario === "lower id wins") {
      state.domain.tables.products.push({ ...product, id: 1, slug: "other" });
      expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed"));
    } else { product.url = "https://other.example"; product.repo_url = null;
      expect(assessReplayAi2Target(state, target, wall)).toEqual(negative("input_changed")); }
  });
  it("distinguishes replacement product ID despite identical slug/input/source/generation", () => {
    const { state, input } = fixture(true), before = assessReplayAi2Target(state, target, wall);
    state.domain.tables.products[0].id = 52;
    const after = assessReplayAi2Target(state, target, wall);
    expect(after).toEqual(eligible(state, input)); expect(after).not.toEqual(before);
  });
});

describe("compound membership and whole-state validation", () => {
  it.each([null, undefined, [], {}, { kind: "pipeline-replay-item-state", version: 1 }])("rejects malformed combined input %j", value => {
    expect(() => assessReplayAi2Target(value, target, wall)).toThrow();
  });
  it.each(["empty", "other candidate", "other input", "other source"])("keeps eligible outside membership for %s", scenario => {
    const { state, input } = fixture();
    if (scenario === "empty") state.domain.universe = [];
    if (scenario === "other candidate") state.domain.universe[0].candidateId = 999;
    if (scenario === "other input" || scenario === "other source") {
      const other = fixture();
      if (scenario === "other input") (document(other.state).page_meta as Record<string, unknown>).title = "Another actual input";
      else document(other.state).id = 32;
      refresh(other.state); state.domain.universe = other.state.domain.universe;
    }
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input, target, "outside"));
  });
  it("includes only the exact current compound identity and is invariant under unrelated rows/order", () => {
    const { state, input } = fixture();
    state.domain.tables.second_reviews.push(...Array.from({ length: 137 }, (_, index) => ({ ...vote(state), id: 1000 + index,
      candidate_id: 1000 + index, generation_key: reviewHash(index) })));
    state.items.tables.pipeline_item_leases.push(...Array.from({ length: 137 }, (_, index) => owner({ ...binding(state, input),
      secondReviewId: 1000 + index, candidateId: 1000 + index, vote: 1000 + index })));
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
    Object.values(state.domain.tables).forEach(rows => rows.reverse()); state.items.tables.pipeline_stage_modes.reverse();
    state.items.tables.pipeline_item_leases.reverse();
    expect(assessReplayAi2Target(state, target, wall)).toEqual(eligible(state, input));
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid target ID %s", id => {
    expect(() => assessReplayAi2Target(fixture().state, id, wall)).toThrow();
  });
  it.each(["2026-10-16T00:00:00Z", "2026-10-16T00:00:00.1234Z", "2026-10-16T09:00:00.123456+09:00",
    "2026-02-30T00:00:00.000Z", "invalid"])("rejects a noncanonical or invalid wall %s", instant => {
    expect(() => assessReplayAi2Target(fixture().state, target, instant)).toThrow();
  });
  const invalid: Array<[string, (state: State) => void]> = [
    ["root authority", state => { Object.assign(state, { verified: true }); }],
    ["wrong version", state => { Object.assign(state, { version: 2 }); }],
    ["missing table", state => { Reflect.deleteProperty(state.domain.tables, "jobs"); }],
    ["incomplete row", state => { Reflect.deleteProperty(document(state), "page_meta"); }],
    ["unknown row column", state => { document(state).unrecorded = true; }],
    ["tampered frozen", state => { state.domain.universe[0].frozenHash = "a".repeat(64); }],
    ["partial item owner", state => { const { input } = fixture(); state.items.tables.pipeline_item_leases.push(owner(binding(state, input), { token: null })); }],
    ["unsafe stage epoch", state => { stage(state).epoch = Number.MAX_SAFE_INTEGER + 1; }],
    ["unsafe domain row", state => { candidate(state).id = Number.MAX_SAFE_INTEGER + 1; }],
    ["duplicate foreign key", state => { state.domain.tables.products.push(row(schema.products, { id: 999 }), row(schema.products, { id: 999 })); }],
  ];
  it.each(invalid)("validates %s before a stage early return", (_label, mutate) => {
    const { state } = fixture(); mutate(state); stage(state).mode = "legacy";
    expect(() => assessReplayAi2Target(state, target, wall)).toThrow();
  });
});
