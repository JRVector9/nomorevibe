import { z } from "zod";
import { ASSIST_POLICY_VERSION, ASSIST_SCHEMA_VERSION, assistHash, assistInputSchema, assistSourceSchema,
  validateAssistOutcome, type AssistInput, type AssistOutcome, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { MAX_RELATED_LINKS, pageConclusive, repositoryKey, type RepoCheck, type RepoReviewPage } from "./repo-review";

const revision = z.string().min(1).max(100);
const repositoryUrl = z.url().refine(value => repositoryKey(value) !== null, "invalid_github_repository");
/** PostgreSQL ::text values stay strings: JS Date would discard the CAS microseconds. */
export const repoMoveSnapshotSchema = z.object({
  id: z.number().int().positive().safe(), slug: z.string().min(1).max(80), url: z.url(), repoUrl: repositoryUrl,
  repoLinkVersion: z.number().int().positive().safe(), updatedAt: revision,
  name: z.string().max(120), description: z.string().max(8000), status: z.string().max(20), source: z.string().max(20),
  accessMode: z.enum(["website", "installable"]), claimedAt: revision.nullable(), activeMaker: z.boolean(),
  repoStatus: z.string().max(16).nullable(), repoCheckedAt: revision.nullable(), repoMissingSince: revision.nullable(),
  repoRenamedTo: z.string().max(160).nullable(),
  review: z.object({ reviewedAt: revision, operatorDecision: z.enum(["keep", "delist"]).nullable(), operatorAt: revision.nullable() }).strict().nullable(),
}).strict();
export type RepoMoveSnapshot = z.infer<typeof repoMoveSnapshotSchema>;

const observation = z.discriminatedUnion("state", [z.object({ state: z.literal("alive") }).strict(),
  z.object({ state: z.literal("gone") }).strict(), z.object({ state: z.literal("unknown") }).strict(),
  z.object({ state: z.literal("moved"), to: z.string().refine(value => repositoryKey(`https://github.com/${value}`) === value) }).strict()]);
export const repoMoveCandidateSchema = z.object({
  kind: z.literal("repo_move"), snapshot: repoMoveSnapshotSchema, oldRepository: observation,
  page: assistSourceSchema.nullable(),
  candidates: z.array(z.object({ url: repositoryUrl, check: observation }).strict()).min(1).max(MAX_RELATED_LINKS),
  uncheckedRepositoryUrls: z.array(repositoryUrl).max(24),
}).strict().superRefine((value, ctx) => {
  const keys = value.candidates.map(item => repositoryKey(item.url));
  if (new Set(keys).size !== keys.length || keys.includes(repositoryKey(value.snapshot.repoUrl))) {
    ctx.addIssue({ code: "custom", message: "duplicate_or_old_repository" });
  }
});
export type RepoMoveCandidate = z.infer<typeof repoMoveCandidateSchema>;
export type RepoMoveInput = Extract<AssistInput, { task: "repo" }>;
export type RepoMoveOutcome = Extract<AssistOutcome, { task: "repo" }>;

/** Source identity excludes collection wall time so unchanged observations do not monopolize the queue. */
export function repoMoveSource(sourceId: string, kind: AssistSource["kind"], url: string | null, text: string,
  observedAt: string, completeness: AssistSource["completeness"], httpStatus: number | null): AssistSource {
  const content = text.replaceAll("\0", "").slice(0, 100_000).replace(/\p{Cs}/gu, "");
  if (text.length > 100_000 && completeness === "complete") completeness = "truncated";
  return assistSourceSchema.parse({ sourceId, kind, url, text: content, observedAt,
    revision: assistHash({ url, text: content, completeness, httpStatus }), completeness, httpStatus });
}

export function repositoryMoveCandidate(snapshot: RepoMoveSnapshot, oldRepository: RepoCheck, page: RepoReviewPage | null,
  related: readonly { key: string; check: RepoCheck }[], unchecked: readonly string[], observedAt: string): RepoMoveCandidate {
  const seen = new Set<string>();
  const candidates = related.flatMap(({ key, check }) => {
    const destination = check.state === "moved" ? check.to : key;
    if (seen.has(destination) || destination === repositoryKey(snapshot.repoUrl)) return [];
    seen.add(destination);
    // Keep the response associated with its requested URL; an onward redirect needs a later collection.
    return [{ url: `https://github.com/${destination}`, check: check.state === "moved" ? { state: "alive" as const } : check }];
  });
  if (oldRepository.state === "moved" && !seen.has(oldRepository.to)) {
    candidates.unshift({ url: `https://github.com/${oldRepository.to}`, check: { state: "alive" } });
  }
  return repoMoveCandidateSchema.parse({ kind: "repo_move", snapshot, oldRepository,
    page: page ? repoMoveSource("product_page", "page", page.finalUrl ?? snapshot.url,
      `${page.title}\n${page.text}`, observedAt, pageConclusive(page, null) && page.status >= 200 && page.status < 400 ? "complete"
        : [401, 403, 429, 999].includes(page.status) ? "blocked" : "missing", page.status) : null,
    candidates, uncheckedRepositoryUrls: unchecked.map(key => `https://github.com/${key}`) });
}

/** README/page fetches run in the consumer, outside the existing 50 second producer budget. */
export function buildRepoMoveInput(value: RepoMoveCandidate, collected: readonly AssistSource[] = []): RepoMoveInput {
  const candidate = repoMoveCandidateSchema.parse(value);
  const { snapshot } = candidate;
  const oldKey = repositoryKey(snapshot.repoUrl)!;
  const redirect = candidate.oldRepository.state === "moved" ? `GitHub redirected https://github.com/${oldKey} to https://github.com/${candidate.oldRepository.to}.`
    : `GitHub repository https://github.com/${oldKey}: ${candidate.oldRepository.state}.`;
  const sources = [repoMoveSource("old_repository", "metadata", snapshot.repoUrl, redirect,
    snapshot.repoCheckedAt ?? snapshot.updatedAt, candidate.oldRepository.state === "unknown" ? "missing" : "complete", null),
  ...(candidate.page ? [candidate.page] : []), ...collected];
  return assistInputSchema.parse({ schemaVersion: ASSIST_SCHEMA_VERSION, task: "repo",
    subject: { type: "product", id: snapshot.id, revision: assistHash(snapshot) }, policyVersion: ASSIST_POLICY_VERSION,
    promptVersion: ASSIST_PROMPT_VERSION, sources, context: { oldRepositoryUrl: snapshot.repoUrl, productName: snapshot.name,
      productDescription: snapshot.description, candidateRepositoryUrls: candidate.candidates.map(item => item.url) } }) as RepoMoveInput;
}

export type RepoMoveDecision =
  | { kind: "update_repo_candidate"; url: string; officialEvidenceHash: string }
  | { kind: "unrelated_candidate" }
  | { kind: "human"; reason: string }
  | { kind: "collect_evidence"; reason: string };

/** The model cannot introduce an official link, choose an unbound URL, or turn a failed fetch into unrelated. */
export function decideRepositoryMove(candidateValue: RepoMoveCandidate, input: RepoMoveInput, value: unknown): RepoMoveDecision {
  const candidate = repoMoveCandidateSchema.parse(candidateValue);
  const valid = validateAssistOutcome(input, value);
  if (!valid.ok || valid.outcome.task !== "repo") return { kind: "human", reason: valid.ok ? "task_mismatch" : valid.error };
  const outcome = valid.outcome;
  if (input.subject.id !== candidate.snapshot.id || input.subject.revision !== assistHash(candidate.snapshot)
    || input.policyVersion !== ASSIST_POLICY_VERSION || input.promptVersion !== ASSIST_PROMPT_VERSION
    || input.context.oldRepositoryUrl !== candidate.snapshot.repoUrl
    || assistHash(input.context.candidateRepositoryUrls) !== assistHash(candidate.candidates.map(item => item.url))) {
    return { kind: "human", reason: "source_binding_mismatch" };
  }
  const boundSources = buildRepoMoveInput(candidate).sources;
  if (boundSources.some(expected => !input.sources.some(source => source.sourceId === expected.sourceId && assistHash(source) === assistHash(expected)))) {
    return { kind: "human", reason: "source_binding_mismatch" };
  }
  if (candidate.uncheckedRepositoryUrls.length || candidate.candidates.length !== 1) return { kind: "human", reason: "multiple_or_unchecked_repositories" };
  const [destination] = candidate.candidates;
  const supports = (pointer: string, eligible: (source: AssistSource) => boolean) => outcome.evidence.some(item =>
    item.supports.includes(`/state/${pointer}`) && input.sources.some(source => source.sourceId === item.source_id
      && source.completeness === "complete" && source.text.trim() && eligible(source)));
  const destinationSource = (source: AssistSource) => (source.kind === "readme" || source.kind === "repository")
    && source.httpStatus !== null && source.httpStatus >= 200 && source.httpStatus < 300
    && source.url !== null && (repositoryKey(source.url) === repositoryKey(destination.url)
      || source.url.startsWith(`https://raw.githubusercontent.com/${repositoryKey(destination.url)}/`));
  if (outcome.evidence_quality.status !== "sufficient" || candidate.oldRepository.state === "unknown"
    || destination.check.state !== "alive" || !supports("project_identity", destinationSource)) {
    return { kind: "collect_evidence", reason: "missing_positive_repository_evidence" };
  }
  if (outcome.state.relationship === "unrelated") {
    // fork/copy is lineage evidence, never positive evidence that this is a different product.
    if (outcome.state.code_lineage === "fork_or_copy" || outcome.state.project_identity !== "different"
      || candidate.oldRepository.state !== "gone") return { kind: "human", reason: "unverified_unrelated_repository" };
    if (!candidate.page || candidate.page.completeness !== "complete" || !candidate.page.httpStatus
      || candidate.page.httpStatus < 200 || candidate.page.httpStatus >= 400) return { kind: "collect_evidence", reason: "product_page_unavailable" };
    return outcome.action.proposal === "delist_candidate" ? { kind: "unrelated_candidate" } : { kind: "human", reason: "model_requires_review" };
  }
  if (outcome.state.relationship !== "same_project" || outcome.action.proposal !== "update_repo_candidate") {
    return { kind: outcome.action.proposal === "collect_evidence" ? "collect_evidence" : "human", reason: "unverified_repository_move" };
  }
  // Server-observed GitHub redirects are the initial verifiable official transfer proof. Author continuity
  // remains separate; matching owner names, fork lineage and a website link cannot mint official authority.
  if (candidate.oldRepository.state !== "moved" || candidate.oldRepository.to !== repositoryKey(destination.url)
    || outcome.state.official_continuity !== "explicit_move" || !supports("official_continuity", source => source.sourceId === "old_repository")
    || outcome.state.code_lineage === "independent" || !supports("code_lineage", destinationSource)) {
    return { kind: "human", reason: "official_move_not_verified" };
  }
  return { kind: "update_repo_candidate", url: destination.url,
    officialEvidenceHash: assistHash({ old: candidate.oldRepository, destination: destination.url, sources: input.sources.map(source =>
      ({ id: source.sourceId, revision: source.revision })), evidence: outcome.evidence }) };
}

export function repoMoveSnapshotMatches(expected: RepoMoveSnapshot, current: RepoMoveSnapshot): boolean {
  return assistHash(repoMoveSnapshotSchema.parse(expected)) === assistHash(repoMoveSnapshotSchema.parse(current));
}

export function repoMoveProtected(snapshot: RepoMoveSnapshot): boolean {
  return snapshot.source !== "crawler" || snapshot.claimedAt !== null || snapshot.activeMaker
    || !["seeded", "verified"].includes(snapshot.status) || snapshot.review?.operatorDecision === "keep";
}
