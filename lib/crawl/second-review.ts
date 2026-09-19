import { createHash } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews, type SecondReviewProvider, type SecondReviewStatus, type SecondReviewTrigger } from "@/lib/db/schema";
import { pageFactsFromDocument } from "./rules";
import type { CrawlSettings } from "./settings-schema";
import { mergeWithDefaults } from "./settings";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "./agent-review-contract";
import { loadReviewInput } from "./agent-review-repository";
import { loadSecondReviewInput, secondReviewGeneration } from "./second-review-input";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { canonicalReviewModel, sameReviewModel } from "./review-model-identity";

/**
 * 2차 심사 — 무엇을 다시 보고, 두 판단을 어떻게 합치나.
 *
 * 1차와 다른 모델이 같은 입력으로 따로 본다. 판단을 합치는 규칙과 위험 신호는 순수 함수로 두어
 * 잡·화면·테스트가 같은 답을 낸다.
 */

/** 제품일 수도, 아닐 수도 있어 규칙으로 막지 않은 주소 — 2차에서 한 번 더 본다 */
export const RISK_HOSTS = ["testflight.apple.com", "t.me", "apps.apple.com", "play.google.com"];
const SEO_NAME = /(下载|GitHub 与|指南|教程|官方|免费|破解)/;

/** 규칙은 통과했지만 한 번 더 볼 이유 */
export function riskSignals(input: { name: string; productUrl: string | null; textSample: string | null; readme: string | null }): string[] {
  const signals: string[] = [];
  let host = "";
  try { host = input.productUrl ? new URL(input.productUrl).hostname.toLowerCase() : ""; } catch { /* 주소가 아니면 호스트 신호는 없다 */ }
  if (RISK_HOSTS.some((risk) => host === risk || host.endsWith(`.${risk}`))) signals.push("store_or_messenger");
  // 페이지 문장을 이름으로 가져온 것 — "ile başlıyordu: ne doctype, ne <head>…" (2026-09-11 실측 243개가 45자 넘음)
  if (input.name.length > 45 || input.name.trim().split(/\s+/).length >= 8) signals.push("sentence_name");
  if (SEO_NAME.test(input.name)) signals.push("seo_name");
  if (!input.textSample?.trim() && !input.readme?.trim()) signals.push("no_text");
  return signals;
}

/** 무작위 표본 — 레포 이름으로 정해 같은 것이 매번 뽑히지도, 빠지지도 않는다 */
export function inSample(repo: string, rate: number): boolean {
  if (rate <= 0) return false;
  const value = createHash("sha256").update(repo.toLowerCase()).digest().readUInt32BE(0);
  return value / 0x1_0000_0000 < rate;
}

type Verdict = { decision: string; confidence: number | null };

/**
 * 두 판단을 합친다.
 *
 * 대기 후보: 결론이 같고 둘 다 확신이 기준 이상이면 일치 — 사람은 한 번에 확정만 한다. 아니면 사람에게.
 * 공개된 제품: 2차도 제품이라 하면 일치(그대로 둔다), 아니라거나 모르겠다면 사람에게 — 자동으로 내리지 않는다.
 */
/**
 * 표 하나를 1차와 견준 결과 — 행에 남는 상태다. 후보 전체의 결론은 combineVotes 가 낸다.
 * 1차와 같은 모델이면 같은 답을 되풀이한 것이라 "일치"로 적지 않는다.
 */
export function combineVerdicts(first: Verdict & { model?: string | null }, second: Vote, agreeAt: number, published: boolean):
  Exclude<SecondReviewStatus, "pending" | "failed" | "resolved"> {
  const echo = sameReviewModel(first.model, second.model);
  if (published) return !echo && second.decision === "approve" ? "agreed" : "needs_human";
  const agreed = !echo && first.decision === second.decision && first.decision !== "needs_review" && counts(second, agreeAt)
    && (first.confidence ?? 0) >= agreeAt;
  return agreed ? "agreed" : "needs_human";
}

export type Vote = Verdict & { provider: SecondReviewProvider | null; model?: string | null };

/**
 * 표 하나가 셈에 드는가.
 *
 * 확신 기준은 Claude 계열에만 건다. 사내 게이트웨이 모델은 틀릴 때도 0.9~1.0 을 달아
 * 확신이 신호가 아니었다(2026-09-12, 사람이 판정한 130건). 거기서는 확신이 아니라
 * 서로 다른 성향의 모델이 같은 결론을 냈는지로 거른다.
 */
function counts(vote: Vote | Verdict, agreeAt: number): boolean {
  if (vote.decision !== "approve" && vote.decision !== "reject") return false;
  const gateway = "provider" in vote && vote.provider === "abcllm";
  return gateway || (vote.confidence ?? 0) >= agreeAt;
}

export type CandidateVerdict = {
  /** pending: 아직 볼 표가 남았다 · agreed: 엇갈림 없이 둘 이상이 같다 · needs_human: 갈렸거나 표가 모자라다 */
  status: "pending" | "agreed" | "needs_human";
  decision: "approve" | "reject" | null;
  /** 셈에 든 표의 수 — 화면은 "3표 일치"처럼 그대로 보여 준다 */
  votes: number;
};

/**
 * 한 후보에 모인 표를 합친다.
 *
 * 대기 후보: 1차와 2차들의 표 중 셈에 드는 것이 둘 이상이고 하나도 엇갈리지 않으면 일치다.
 * 낮은 확신의 반대 의견이나 명시적 보류도 사람 확인으로 보낸다. 표 수는 독립 모델 수이며
 * 정확도 보장이 아니다.
 *
 * 공개된 제품: 2차가 하나라도 제품이 아니라고 하면 사람에게. 자동으로 내리지 않는다.
 */
export function combineVotes(first: Verdict, second: Vote[], options: {
  agreeAt: number; published: boolean; pending: number;
  /** 1차를 본 모델. 2차에 같은 모델이 서면 그 표는 같은 답을 되풀이할 뿐이라 셈에서 뺀다 */
  firstModel?: string | null;
}): CandidateVerdict {
  // Known model aliases and repeated model results are not independent votes.
  const votes: Vote[] = [];
  const known = new Map<string, Vote>();
  for (const vote of second) {
    if (sameReviewModel(options.firstModel, vote.model)) continue;
    if (!vote.model) { votes.push(vote); continue; }
    const key = canonicalReviewModel(vote.model);
    const prior = known.get(key);
    if (prior) {
      // Conflicting duplicate results cannot silently become an agreeing vote.
      if (prior.decision !== vote.decision) prior.decision = "needs_review";
      prior.confidence = Math.min(prior.confidence ?? 0, vote.confidence ?? 0);
    } else {
      const copy = { ...vote };
      known.set(key, copy); votes.push(copy);
    }
  }
  /*
   * 표가 다 모이기 전에는 칩에 올리지 않는다.
   *
   * 1차가 이미 한 표라 두 번째 표 하나만 와도 "둘이 같다"가 된다. 그 상태로 확정 칩에 올리면
   * 남은 표가 엇갈릴 때 칩이 뒤바뀌고, 그 사이에 사람이 한 번에 확정해 버릴 수 있다.
   * 몇 분이면 나머지가 오므로 기다린다.
   */
  if (options.pending > 0) return { status: "pending", decision: null, votes: 0 };
  if (options.published) {
    // 제품이 아니라는 표든 모르겠다는 표든 사람이 본다 — 자동으로 내리지 않지만 넘기지도 않는다
    if (!votes.length || votes.some((vote) => vote.decision !== "approve")) {
      return { status: "needs_human", decision: votes.length ? "reject" : null, votes: votes.length };
    }
    return { status: "agreed", decision: "approve", votes: votes.length };
  }
  const all = [...(counts(first, options.agreeAt) ? [first.decision] : []), ...votes.filter((vote) => counts(vote, options.agreeAt)).map((vote) => vote.decision)];
  // Confidence controls whether support counts, never whether dissent disappears.
  const expressed = [first, ...votes].map(vote => vote.decision);
  if (expressed.some(decision => decision !== "approve" && decision !== "reject") || new Set(expressed).size > 1) {
    return { status: "needs_human", decision: null, votes: all.length };
  }
  const decision = all[0] === "approve" || all[0] === "reject" ? all[0] : null;
  if (new Set(all).size > 1) return { status: "needs_human", decision: null, votes: all.length };
  if (all.length >= 2) return { status: "agreed", decision, votes: all.length };
  // 다 봤는데도 셈에 든 표가 하나뿐이다 — 사람이 본다
  return { status: "needs_human", decision, votes: all.length };
}

const PUBLISHED_LOOKBACK_MS = 48 * 3600_000;

/** 공개분은 slug 당 한 번 — slug 가 80자까지라 그대로는 input_hash(64)에 안 들어간다 */
export function publishedInputHash(slug: string): string {
  return createHash("sha256").update(`published:${slug}`).digest("hex");
}
const ENQUEUE_LIMIT = 50;
/** 공개분 표본은 대기 후보와 몫을 나눈다 — 모델을 여럿 세우면 행 수로는 앞쪽이 다 먹는다 */
const PUBLISHED_LIMIT = 25;

/**
 * 2차에 올린다. 같은 후보·같은 입력은 한 번만(유일 색인).
 *  - ai_decided: 규칙이 못 가른 보류 후보를 AI 1차가 승인·거부로 가른 것 — 확신을 낸 1차만.
 *    확신이 없던 옛 1차(프롬프트 2026-09-11.2 이전)는 일치 기준에 닿을 수 없어 전부 "사람 확인"이 된다.
 *    배포 직후 프로드에서 그렇게 쌓였다 — 새 프롬프트가 다시 보면 그 판단으로 올린다.
 *  - risk / sample: 규칙만 통과해 최근 공개된 것 중 위험 신호가 있거나 표본에 든 것
 * 같은 후보에 새 1차 판단이 오면 앞의 것은 superseded 로 닫는다 — 한 후보가 두 칩에 겹쳐 세어지지 않게.
 */
export async function enqueueSecondReviews(settings: CrawlSettings, now = new Date()): Promise<number> {
  const held = settings.secondReview.includeAiHeld;
  const voters = [...new Map(settings.secondReview.voters.map(voter => [canonicalReviewModel(voter.model), voter])).values()];

  /**
   * 후보마다 마지막 1차 판단 하나 — 그것이 지금 물어야 할 입력이다.
   *
   * 고르는 것(distinct on)을 먼저 하고 거르는 것을 나중에 한다. 거꾸로 하면 "표를 다 받았다"에
   * 걸린 마지막 판단이 빠지고 그 앞의 판단이 골라져, 이미 지나간 입력으로 다시 묻는다 —
   * 그렇게 올린 행은 다음 틱에 superseded 로 닫히고 표는 버려진다(2026-09-12 프로드에서 20분
   * 사이 후보 53개에 해시 150개가 올라갔고, 닫힌 324행 중 160행은 이미 판단을 받은 것이었다).
   */
  const latest = db.selectDistinctOn([crawlReviewAttempts.candidateId], {
    candidateId: crawlReviewAttempts.candidateId, repo: crawlCandidates.repo, inputHash: crawlReviewAttempts.inputHash,
    promptVersion: crawlReviewAttempts.promptVersion, rulesVersion: crawlReviewAttempts.rulesVersion, validUntil: crawlReviewAttempts.validUntil,
    firstModel: crawlReviewAttempts.model, firstAttemptId: crawlReviewAttempts.id, sourceRevisionHash: crawlReviewAttempts.sourceRevisionHash,
    decision: sql<string>`${crawlReviewAttempts.outcome}->>'decision'`.as("decision"),
    confidence: sql<number | null>`(${crawlReviewAttempts.outcome}->>'confidence')::float`.as("confidence"),
  }).from(crawlReviewAttempts).innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.decidedBy, "auto"),
      // 관문에서 2차가 반대해 보류된 것은 이미 두 모델의 표가 있다 — 다시 올리면 같은 표를 또 부르고 관문 행을 덮는다
      ne(crawlCandidates.reason, "second_review_split"),
      eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"), inArray(crawlReviewAttempts.provider, ["claude-cli", "abcllm"]),
      // 가른 판단은 확신을 낸 것만 — 1차가 보류한 것은 애초에 확신을 재지 않는다
      or(sql`${crawlReviewAttempts.outcome}->>'confidence' is not null`,
        held ? sql`${crawlReviewAttempts.outcome}->>'decision' = 'needs_review'` : undefined)!))
    .orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id))
    .as("latest");

  /**
   * 그중 세워 둔 표를 아직 다 못 받은 것만. 행 수로 재는 이유는 모델을 하나 더 세우면 이미
   * 올라간 후보에도 그 모델의 표를 더해야 하기 때문이다. 이 조건이 없으면 후보 id 가 작은
   * 것들만 매 틱 다시 집혀 뒤가 영영 올라가지 않는다(대상 738건 중 654건이 그렇게 밀렸다).
   */
  const required = sql`(select count(*) from jsonb_array_elements_text(${JSON.stringify(voters.map(voter => canonicalReviewModel(voter.model)))}::jsonb) as v(model)
    where v.model <> regexp_replace(lower(trim(coalesce(${latest.firstModel}, ''))), '^\\[mlx\\][[:space:]]*', '', 'i'))`;
  const decided = await db.select().from(latest)
    .where(and(eq(latest.promptVersion, REVIEW_PROMPT_VERSION), eq(latest.rulesVersion, REVIEW_RULES_VERSION), gt(latest.validUntil, now), sql`${required} > 0`, sql`(select count(*) from ${secondReviews} s
      where s.candidate_id = ${latest.candidateId} and s.input_hash = ${latest.inputHash}
        and s.first_attempt_id = ${latest.firstAttemptId}
        and exists(select 1 from jsonb_array_elements(${JSON.stringify(voters)}::jsonb) v
          where v->>'provider'=s.provider and regexp_replace(lower(trim(v->>'model')), '^\\[mlx\\][[:space:]]*', '', 'i')
            = regexp_replace(lower(trim(s.model)), '^\\[mlx\\][[:space:]]*', '', 'i'))) < ${required}`))
    .limit(ENQUEUE_LIMIT * 4);
  /**
   * 세워 둔 모델마다 한 행. 누가 볼지를 올릴 때 적는다 — 유일 색인이 (후보, 입력, 모델)이라
   * 모델을 비워 두면 Postgres 가 NULL 을 서로 다른 값으로 보아 같은 후보가 매 틱 다시 올라온다.
   */
  /**
   * 한 후보가 모델 수만큼 행을 쓰므로, 후보 수로 상한을 잡는다 — 행 수로 자르면 모델을 셋
   * 세웠을 때 한 후보의 표가 반만 올라가 영영 짝이 맞지 않는다.
   */
  const rows: (typeof secondReviews.$inferInsert)[] = decided
    .filter((row) => row.decision === "approve" || row.decision === "reject" || (held && row.decision === "needs_review"))
    .slice(0, ENQUEUE_LIMIT)
    .flatMap((row) => voters.filter(voter => !sameReviewModel(row.firstModel, voter.model)).map((voter) => ({ ...voter, candidateId: row.candidateId, repo: row.repo,
      trigger: (row.decision === "needs_review" ? "ai_held" : "ai_decided") as SecondReviewTrigger,
      firstDecision: row.decision, firstConfidence: row.confidence, firstModel: row.firstModel, firstAttemptId: row.firstAttemptId, generationKey: secondReviewGeneration(row.firstAttemptId, row), inputHash: row.inputHash })));

  /**
   * 두 모델 승인 관문(2026-09-19, 사용자 결정). enforce 에서 1차 AI 가 승인한 후보는 2차 모델도 승인해야
   * 발행된다 — reviewApprovalPredicate·assertReviewApproval 이 이 행들을 본다. 1차와 같은 모델의 표는 되풀이라
   * 올리지 않는다. 실측(블라인드 159건): 1차 혼자 승인하면 124건 중 오답 9, 둘 다 승인하면 116건 중 5.
   */
  if (settings.reviewMode === "enforce") {
    const approved = db.selectDistinctOn([crawlReviewAttempts.candidateId], {
      candidateId: crawlReviewAttempts.candidateId, repo: crawlCandidates.repo, inputHash: crawlReviewAttempts.inputHash,
      promptVersion: crawlReviewAttempts.promptVersion, rulesVersion: crawlReviewAttempts.rulesVersion, validUntil: crawlReviewAttempts.validUntil,
      firstModel: crawlReviewAttempts.model, firstAttemptId: crawlReviewAttempts.id, sourceRevisionHash: crawlReviewAttempts.sourceRevisionHash,
      decision: sql<string>`${crawlReviewAttempts.outcome}->>'decision'`.as("decision"),
      confidence: sql<number | null>`(${crawlReviewAttempts.outcome}->>'confidence')::float`.as("confidence"),
    }).from(crawlReviewAttempts).innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
      .where(and(eq(crawlCandidates.state, "approved"), eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug),
        eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"), inArray(crawlReviewAttempts.provider, ["claude-cli", "abcllm"])))
      .orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id))
      .as("approved_latest");
    const gateRequired = sql`(select count(*) from jsonb_array_elements_text(${JSON.stringify(voters.map(voter => canonicalReviewModel(voter.model)))}::jsonb) as v(model)
      where v.model <> regexp_replace(lower(trim(coalesce(${approved.firstModel}, ''))), '^\\[mlx\\][[:space:]]*', '', 'i'))`;
    const gate = await db.select().from(approved)
      .where(and(sql`${approved.decision} = 'approve'`, eq(approved.promptVersion, REVIEW_PROMPT_VERSION), eq(approved.rulesVersion, REVIEW_RULES_VERSION),
        // 지금 세운 모델의 행만 센다 — 모델을 바꾸면 옛 모델의 행이 수를 채워 새 모델의 표가 영영 안 올라간다
        gt(approved.validUntil, now), sql`${gateRequired} > 0`, sql`(select count(*) from ${secondReviews} s
          where s.candidate_id = ${approved.candidateId} and s.first_attempt_id = ${approved.firstAttemptId} and s.trigger = 'ai_approved'
            and exists(select 1 from jsonb_array_elements(${JSON.stringify(voters)}::jsonb) v
              where v->>'provider'=s.provider and regexp_replace(lower(trim(v->>'model')), '^\\[mlx\\][[:space:]]*', '', 'i')
                = regexp_replace(lower(trim(s.model)), '^\\[mlx\\][[:space:]]*', '', 'i'))) < ${gateRequired}`))
      .limit(ENQUEUE_LIMIT);
    rows.push(...gate.flatMap((row) => voters.filter(voter => !sameReviewModel(row.firstModel, voter.model)).map((voter) => ({ ...voter,
      candidateId: row.candidateId, repo: row.repo, trigger: "ai_approved" as SecondReviewTrigger,
      firstDecision: "approve", firstConfidence: row.confidence, firstModel: row.firstModel, firstAttemptId: row.firstAttemptId,
      generationKey: secondReviewGeneration(row.firstAttemptId, row, "ai_approved"), inputHash: row.inputHash }))));
  }

  const published = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, slug: crawlCandidates.publishedSlug,
    productUrl: crawlCandidates.productUrl, pageMeta: crawlDocuments.pageMeta, pageStatus: crawlDocuments.pageStatus, documentUrl: crawlDocuments.productUrl })
    .from(crawlCandidates).innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(eq(crawlCandidates.state, "published"), eq(crawlCandidates.decidedBy, "auto"), isNotNull(crawlCandidates.publishedSlug),
      gte(crawlCandidates.decidedAt, new Date(now.getTime() - PUBLISHED_LOOKBACK_MS))))
    .limit(2_000);
  const previousPublished = published.length ? await db.select({ candidateId: secondReviews.candidateId, generationKey: secondReviews.generationKey, model: secondReviews.model })
    .from(secondReviews).where(inArray(secondReviews.candidateId, published.map(row => row.id))) : [];
  const publishedModels = new Set(previousPublished.map(row => `${row.candidateId}:${row.generationKey}:${canonicalReviewModel(row.model ?? "")}`));
  const publishedRows: (typeof secondReviews.$inferInsert)[] = [];
  let publishedCount = 0;
  for (const row of published) {
    const meta = (row.pageMeta ?? {}) as { title?: unknown; readmeSample?: unknown };
    const facts = pageFactsFromDocument({ productUrl: row.documentUrl, pageStatus: row.pageStatus, pageMeta: row.pageMeta });
    const signals = riskSignals({ name: typeof meta.title === "string" ? meta.title : row.repo, productUrl: row.productUrl,
      textSample: facts.textSample ?? null, readme: typeof meta.readmeSample === "string" ? meta.readmeSample : null });
    const sampled = inSample(row.repo, settings.secondReview.sampleRate);
    if (!signals.length && !sampled) continue;
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.id));
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, row.repo)).limit(1);
    if (!candidate || !document) continue;
    const input = await loadReviewInput(candidate, document, settings);
    const generationKey = secondReviewGeneration(null, input);
    const missingVoters = voters.filter(voter => !publishedModels.has(`${row.id}:${generationKey}:${canonicalReviewModel(voter.model)}`));
    if (!missingVoters.length) continue;
    publishedRows.push(...missingVoters.map((voter) => ({ ...voter, candidateId: row.id, repo: row.repo, publishedSlug: row.slug,
      trigger: (signals.length ? "risk" : "sample") as SecondReviewTrigger, signals,
      firstDecision: "approve", firstConfidence: null, firstAttemptId: null, generationKey, inputHash: publishedInputHash(row.slug!) })));
    if (++publishedCount >= PUBLISHED_LIMIT) break;
  }
  rows.push(...publishedRows);
  if (!rows.length) return 0;
  return db.transaction(async tx => {
    const candidateIds = [...new Set(rows.map(row => row.candidateId))].sort((a, b) => a - b);
    const locked = await tx.select().from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds))
      .orderBy(crawlCandidates.id).for("update");
    const currentFirst = await tx.selectDistinctOn([crawlReviewAttempts.candidateId], {
      candidateId: crawlReviewAttempts.candidateId, id: crawlReviewAttempts.id,
    }).from(crawlReviewAttempts).where(and(inArray(crawlReviewAttempts.candidateId, candidateIds),
      eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"),
      inArray(crawlReviewAttempts.provider, ["claude-cli", "abcllm"])))
      .orderBy(crawlReviewAttempts.candidateId, desc(crawlReviewAttempts.id));
    const latestIds = new Map(currentFirst.map(row => [row.candidateId, row.id]));
    const candidates = new Map(locked.map(row => [row.id, row]));
    const valid = rows.filter(row => {
      const candidate = candidates.get(row.candidateId);
      // 관문 행은 승인 상태의 후보에, 나머지는 보류 후보에 붙는다 — 그 사이에 상태가 바뀌었으면 올리지 않는다
      const expected = row.trigger === "ai_approved" ? "approved" : "needs_review";
      return row.publishedSlug ? candidate?.state === "published" && candidate.publishedSlug === row.publishedSlug
        : candidate?.state === expected && candidate.decidedBy === "auto" && latestIds.get(row.candidateId) === row.firstAttemptId;
    });
    if (!valid.length) return 0;
    const inserted = await tx.insert(secondReviews).values(valid).onConflictDoNothing()
      .returning({ id: secondReviews.id, candidateId: secondReviews.candidateId, generationKey: secondReviews.generationKey });
    const renewed = [...new Map(inserted.map(row => [row.candidateId, row])).values()];
    if (renewed.length) {
      await tx.update(secondReviews).set({ status: "resolved", resolution: "superseded", resolvedAt: now })
        .where(and(or(...renewed.map(row => and(eq(secondReviews.candidateId, row.candidateId),
          sql`${secondReviews.generationKey} <> ${row.generationKey}`))),
          inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"])));
    }
    return inserted.length;
  });
}

/**
 * 더 볼 필요가 없어진 것을 닫는다 — 사람이 이미 결정했거나(보류가 아님) 공개분이 내려갔다.
 * 지우지 않는다. 몇 건을 누가 어떻게 끝냈는지가 2차 심사의 정확도다.
 */
export async function closeSettledSecondReviews(now = new Date()): Promise<number> {
  // Removed voters must not keep consuming retries or influence current consensus.
  const [saved] = await db.select().from(crawlSettings).limit(1);
  const {voters, fallbacks = []} = mergeWithDefaults(saved?.values).secondReview;
  const removed = await db.update(secondReviews).set({ status: "resolved", resolution: "model_removed", resolvedAt: now })
    .where(and(inArray(secondReviews.status, ["pending", "failed", "agreed", "needs_human"]),
      sql`not exists(select 1 from jsonb_array_elements(case when ${secondReviews.fallbackForId} is null then ${JSON.stringify(voters)}::jsonb else ${JSON.stringify(fallbacks)}::jsonb end) v
        where v->>'provider'=coalesce(${secondReviews.provider}, 'claude-cli')
          and regexp_replace(lower(trim(v->>'model')), '^\\[mlx\\][[:space:]]*', '', 'i')
            = regexp_replace(lower(trim(${secondReviews.model})), '^\\[mlx\\][[:space:]]*', '', 'i')
          and (${secondReviews.fallbackForId} is null or exists(select 1 from second_reviews root
            where root.id=${secondReviews.fallbackForId} and root.fallback_for_id is null
              and root.candidate_id=${secondReviews.candidateId} and root.generation_key=${secondReviews.generationKey}
              and root.input_hash=${secondReviews.inputHash} and root.status='resolved' and root.resolution='fallback'
              and exists(select 1 from jsonb_array_elements(${JSON.stringify(voters)}::jsonb) primary_v
                where primary_v->>'provider'=root.provider
                  and regexp_replace(lower(trim(primary_v->>'model')), '^\\[mlx\\][[:space:]]*', '', 'i')
                    = regexp_replace(lower(trim(root.model)), '^\\[mlx\\][[:space:]]*', '', 'i')))))`))
    .returning({ id: secondReviews.id });
  const orphaned = await db.update(secondReviews).set({status: "needs_human", resolution: null, resolvedAt: null,
    secondDecision: null, secondConfidence: null,
    secondReason: "대체 모델 설정이 변경되어 해당 의견을 제외했습니다. 직접 확인해주세요.",
    failureCount: sql`greatest(${secondReviews.failureCount}, coalesce((select max(child.failure_count) from second_reviews child where child.fallback_for_id=${secondReviews.id}), 0))`})
    .where(and(eq(secondReviews.status, "resolved"), eq(secondReviews.resolution, "fallback"), isNull(secondReviews.fallbackForId),
      sql`exists(select 1 from second_reviews child where child.fallback_for_id=${secondReviews.id} and child.resolution='model_removed')`,
      sql`not exists(select 1 from second_reviews child where child.fallback_for_id=${secondReviews.id} and child.status in ('pending','failed','agreed','needs_human'))`,
      sql`exists(select 1 from jsonb_array_elements(${JSON.stringify(voters)}::jsonb) v
        where v->>'provider'=${secondReviews.provider}
          and regexp_replace(lower(trim(v->>'model')), '^\\[mlx\\][[:space:]]*', '', 'i')
            = regexp_replace(lower(trim(${secondReviews.model})), '^\\[mlx\\][[:space:]]*', '', 'i'))`))
    .returning({id: secondReviews.id});
  // A prompt upgrade invalidates these inputs before any model call. Retain completed historical opinions.
  const obsolete = await db.update(secondReviews).set({status: "resolved", resolution: "superseded", resolvedAt: now})
    .where(and(inArray(secondReviews.status, ["pending", "failed"]), or(eq(secondReviews.generationKey, "legacy"),
      sql`exists(select 1 from ${crawlReviewAttempts} a where a.id=${secondReviews.firstAttemptId}
        and (a.prompt_version<>${REVIEW_PROMPT_VERSION} or a.rules_version<>${REVIEW_RULES_VERSION} or a.valid_until<=${now.toISOString()}::timestamp))`)))
    .returning({id: secondReviews.id});
  // 확신 없는 옛 1차로 올린 것 — 일치할 수 없으니 닫는다. 2차 의견은 남아 심사 상세에 그대로 보인다
  const legacy = await db.update(secondReviews).set({ status: "resolved", resolution: "no_first_confidence", resolvedAt: now })
    .where(and(eq(secondReviews.trigger, "ai_decided"), isNull(secondReviews.firstConfidence),
      inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"])))
    .returning({ id: secondReviews.id });
  return removed.length + orphaned.length + obsolete.length + legacy.length + await closeDecidedSecondReviews(now);
}

async function closeDecidedSecondReviews(now: Date): Promise<number> {
  // 공개분의 일치는 끝난 기록이다(그대로 둔다) — 훑는 대상에 넣으면 날마다 쌓여 한도를 잡아먹는다
  const open = await db.select({ id: secondReviews.id, candidateId: secondReviews.candidateId, published: secondReviews.publishedSlug, trigger: secondReviews.trigger })
    .from(secondReviews).where(or(inArray(secondReviews.status, ["pending", "failed", "needs_human"]),
      and(eq(secondReviews.status, "agreed"), isNull(secondReviews.publishedSlug))))
    .orderBy(secondReviews.id).limit(1_000);
  if (!open.length) return 0;
  const candidates = await db.select({ id: crawlCandidates.id, state: crawlCandidates.state }).from(crawlCandidates)
    .where(inArray(crawlCandidates.id, [...new Set(open.map((row) => row.candidateId))]));
  const state = new Map(candidates.map((row) => [row.id, row.state]));
  /*
   * 관문 행은 후보가 발행을 기다리는 동안(승인)과, 2차가 반대해 사람에게 넘어간 동안(보류) 열려 있다 —
   * 발행 조건이 일치한 행을 보고, 사람은 심사 화면에서 두 모델의 의견을 나란히 본다.
   */
  const settled = open.filter((row) => row.published ? state.get(row.candidateId) !== "published"
    : row.trigger === "ai_approved" ? !["approved", "needs_review"].includes(state.get(row.candidateId) ?? "")
      : state.get(row.candidateId) !== "needs_review");
  if (!settled.length) return 0;
  await db.update(secondReviews).set({ status: "resolved", resolution: "decided_elsewhere", resolvedAt: now })
    .where(inArray(secondReviews.id, settled.map((row) => row.id)));
  return settled.length;
}

export async function pendingSecondReviews(limit: number) {
  return db.select().from(secondReviews).where(eq(secondReviews.status, "pending")).orderBy(desc(sql`${secondReviews.fallbackForId} is not null`), secondReviews.id).limit(limit);
}

export async function recordSecondReview(id: number, result:
  | { ok: true; decision: string; confidence: number | null; reason: string; model: string; provider: SecondReviewProvider; status: "agreed" | "needs_human" }
  | { ok: false; error: string; detail?: string; model: string; provider: SecondReviewProvider }, now = new Date(), lease?: JobLease): Promise<void> {
  if (!result.ok && result.error === "cancelled") return;
  await db.transaction(async tx => {
    const [original] = await tx.select().from(secondReviews).where(eq(secondReviews.id, id));
    if (!original || original.status !== "pending") return;
    const input = await loadSecondReviewInput(original, tx);
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, id)).for("update");
    if (!row || row.status !== "pending" || row.generationKey !== original.generationKey) return;
    if (lease) await assertJobLease(tx, lease);
    if (!input || row.model !== result.model || row.provider !== result.provider) {
      await tx.update(secondReviews).set({status: "resolved", resolution: "superseded", resolvedAt: now})
        .where(eq(secondReviews.id, id));
      return;
    }
    const [saved] = await tx.select().from(crawlSettings).limit(1);
    const settings = mergeWithDefaults(saved?.values);
    const agreeAt = settings.secondReview.agreeAt;
    if (!result.ok && result.error !== "input_too_large" && row.failureCount + 1 < MAX_SECOND_REVIEW_FAILURES) {
      // The candidate lock from loadSecondReviewInput serializes allocation across primary slots.
      const attempted = await tx.select({model: secondReviews.model}).from(secondReviews).where(and(
        eq(secondReviews.candidateId, row.candidateId), eq(secondReviews.generationKey, row.generationKey)));
      const excluded = [...settings.secondReview.voters.map(v => v.model), ...attempted.map(v => v.model)];
      const eligible = (settings.secondReview.fallbacks ?? []).filter(v => !excluded.some(model => sameReviewModel(model, v.model)));
      // Prefer an independent model. A same-first fallback is reference-only and must end in human review.
      const backup = eligible.find(v => !sameReviewModel(row.firstModel, v.model)) ?? eligible[0];
      if (backup) {
        await tx.insert(secondReviews).values({ ...backup, candidateId: row.candidateId, repo: row.repo,
          publishedSlug: row.publishedSlug, trigger: row.trigger, signals: row.signals,
          firstDecision: row.firstDecision, firstConfidence: row.firstConfidence, firstModel: row.firstModel,
          firstAttemptId: row.firstAttemptId, inputHash: row.inputHash, generationKey: row.generationKey,
          fallbackForId: row.fallbackForId ?? row.id, failureCount: row.failureCount + 1 });
        await tx.update(secondReviews).set({ status: "resolved", resolution: "fallback", resolvedAt: now,
          reviewedAt: now, failureCount: row.failureCount + 1, errorCode: result.error.slice(0, 60),
          errorDetail: result.detail?.slice(0, 80) ?? null }).where(eq(secondReviews.id, id));
        return;
      }
    }
    const status = result.ok
      ? combineVerdicts({decision: row.firstDecision, confidence: row.firstConfidence, model: row.firstModel},
          {decision: result.decision, confidence: result.confidence, provider: result.provider, model: result.model},
          // Consensus summary independently applies the current configured threshold.
          agreeAt,
          Boolean(row.publishedSlug))
      : row.failureCount + 1 >= MAX_SECOND_REVIEW_FAILURES ? "needs_human" : "failed";
    await tx.update(secondReviews).set(result.ok
      ? { status, secondDecision: result.decision, secondConfidence: result.confidence,
          secondReason: result.reason.slice(0, 2000), errorCode: null, errorDetail: null, reviewedAt: now }
      : { status,
          failureCount: row.failureCount + 1, errorCode: result.error.slice(0, 60),
          errorDetail: result.detail?.slice(0, 80) ?? null, reviewedAt: now,
          secondDecision: null, secondConfidence: null,
          secondReason: row.failureCount + 1 >= MAX_SECOND_REVIEW_FAILURES
            ? "모델 심사가 3회 실패했습니다. 자동 재시도를 종료했으므로 직접 확인해주세요." : null })
      .where(eq(secondReviews.id, id));
    /*
     * 두 모델 승인 관문에서 2차가 승인하지 않았다 — 발행을 멈추고 사람에게 넘긴다(2026-09-19).
     * 후보는 loadSecondReviewInput 이 이 트랜잭션에서 잠갔다. 사유는 AI 심사가 다시 집지 않는 것으로 둔다 —
     * 다시 집으면 1차가 같은 승인을 되풀이해 "승인됐지만 발행은 막힌" 상태에 갇힌다.
     */
    if (row.trigger === "ai_approved" && status === "needs_human") {
      const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.candidateId));
      if (candidate?.state === "approved" && candidate.decidedBy === "auto") {
        const detail = result.ok ? `${result.model} ${result.decision}: ${result.reason}` : `${result.model} 심사 3회 실패 (${result.error})`;
        await tx.update(crawlCandidates).set({ state: "needs_review", reason: "second_review_split", updatedAt: now,
          signals: { ...(candidate.signals ?? {}), stoppedAt: { rule: "2차 심사", detail: detail.slice(0, 300) } } })
          .where(eq(crawlCandidates.id, candidate.id));
      }
    }
  });
}

export type SecondReviewFailure = { provider: string | null; model: string | null; errorCode: string; count: number };

/**
 * 최근 하루 동안 2차가 실패한 까닭 — 모델별로.
 *
 * 게이트웨이는 모델 목록이 바뀌면 404 를 낸다. 그때 화면이 "대기 N건"만 보여 주면 심사가 멈춘 것을
 * 아무도 모른다. 실패를 숫자로 드러내 무엇을 갈아 끼워야 하는지 바로 보이게 한다.
 */
export async function recentSecondReviewFailures(now = new Date()): Promise<SecondReviewFailure[]> {
  const rows = await db.select({ provider: secondReviews.provider, model: secondReviews.model, errorCode: secondReviews.errorCode,
    count: sql<number>`count(*)::int` }).from(secondReviews)
    .where(and(inArray(secondReviews.status, ["pending", "failed", "needs_human"]), isNotNull(secondReviews.errorCode), gte(secondReviews.reviewedAt, new Date(now.getTime() - 24 * 3600_000))))
    .groupBy(secondReviews.provider, secondReviews.model, secondReviews.errorCode)
    .orderBy(desc(sql`count(*)`));
  return rows.map((row) => ({ ...row, errorCode: row.errorCode ?? "unknown", count: Number(row.count) }));
}

/** 잠깐 막힌 것과 그렇지 않은 것 — 다시 보는 때가 다르다 */
export const MAX_SECOND_REVIEW_FAILURES = 3;
const TRANSIENT = ["timeout", "gateway_error", "rate_limited", "budget"];
export const TRANSIENT_RETRY_MS = 5 * 60_000;
const RETRY_MS = 60 * 60_000;

/**
 * 실패한 것을 다시 대기로.
 *
 * 잠깐 막힌 것(시간 초과·게이트웨이 오류·한도)은 5분 뒤, 나머지는 한 시간 뒤. 게이트웨이가
 * 붐비는 동안 난 시간 초과를 한 시간씩 묵히면 그만큼 사람이 기다린다 — 2026-09-12 실측에서
 * gemma 두 모델의 24~30%가 시간 초과였고, 다시 부르면 대개 통과했다.
 *
 * 비교는 lt() 로 한다. sql`` 안에 Date 를 그대로 넣으면 "Fri Sep 11 2026 …" 문자열로 넘어가
 * 프로드에서 매 틱 실패했다(2026-09-11) — 컬럼 타입을 거쳐야 시각으로 바뀐다.
 */
export async function retryFailedSecondReviews(now = new Date()): Promise<void> {
  await db.update(secondReviews).set({ status: "pending" })
    .where(and(eq(secondReviews.status, "failed"), lt(secondReviews.failureCount, MAX_SECOND_REVIEW_FAILURES),
      or(
        and(inArray(secondReviews.errorCode, TRANSIENT), lt(secondReviews.reviewedAt, new Date(now.getTime() - TRANSIENT_RETRY_MS))),
        lt(secondReviews.reviewedAt, new Date(now.getTime() - RETRY_MS)),
      )));
}

export type SecondReviewCounts = { unanimousReject: number; unanimousApprove: number; agreedReject: number; agreedApprove: number; needsHuman: number; published: number; pending: number };
export type SecondChipKey = "unanimous_reject" | "unanimous_approve" | "agreed_reject" | "agreed_approve" | "needs_human";

/**
 * 심사 화면의 거르기 칩과 운영센터가 쓰는 수.
 *
 * 표는 모델마다 한 행이라 후보로 묶어 센다. 셋 이상이 같으면 만장일치, 둘이면 2표 일치다 —
 * 사람은 안전한 쪽부터 한 번에 확정한다. 아직 볼 표가 남은 후보는 어느 칩에도 넣지 않는다.
 */
export async function secondReviewSummary(agreeAt: number): Promise<{ counts: SecondReviewCounts; ids: Record<SecondChipKey, number[]> }> {
  const rows = await db.select({ candidateId: secondReviews.candidateId, status: secondReviews.status, decision: secondReviews.secondDecision,
    confidence: secondReviews.secondConfidence, provider: secondReviews.provider, model: secondReviews.model,
    fallbackForId: secondReviews.fallbackForId, generationKey: secondReviews.generationKey, inputHash: secondReviews.inputHash, published: secondReviews.publishedSlug, firstDecision: secondReviews.firstDecision,
    firstConfidence: secondReviews.firstConfidence, firstModel: secondReviews.firstModel }).from(secondReviews)
    // 실패한 표도 읽는다 — 한 시간 뒤 다시 보므로 아직 끝나지 않은 표이고, 모두 실패한 후보가
    // 집계에서 통째로 사라지면 멈춘 줄 모른다
    .where(inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"]));

  const byCandidate = new Map<number, typeof rows>();
  for (const row of rows) byCandidate.set(row.candidateId, [...(byCandidate.get(row.candidateId) ?? []), row]);

  const ids: Record<SecondChipKey, number[]> = { unanimous_reject: [], unanimous_approve: [], agreed_reject: [], agreed_approve: [], needs_human: [] };
  let published = 0, pending = 0;
  for (const [candidateId, group] of byCandidate) {
    if (new Set(group.map(row => `${row.inputHash}:${row.generationKey}`)).size > 1 || group.some(row => row.generationKey === "legacy")) {
      if (group.some(row => row.published)) published += 1;
      else ids.needs_human.push(candidateId);
      continue;
    }
    const first = { decision: group[0].firstDecision, confidence: group[0].firstConfidence };
    const outstanding = group.filter((row) => (row.fallbackForId || !sameReviewModel(row.firstModel, row.model)) && (row.status === "pending" || row.status === "failed")).length;
    const votes = group.filter((row) => row.status === "agreed" || row.status === "needs_human")
      .map((row) => ({ decision: row.decision ?? "", confidence: row.confidence, provider: row.provider, model: row.model }));
    const verdict = combineVotes(first, votes, { agreeAt, published: Boolean(group[0].published),
      pending: outstanding, firstModel: group[0].firstModel });
    if (verdict.status === "pending") { pending += 1; continue; }
    const referenceOnly = group.some(row => row.fallbackForId && sameReviewModel(row.firstModel, row.model));
    if (referenceOnly) {
      if (group[0].published) published += 1;
      else ids.needs_human.push(candidateId);
      continue;
    }
    if (group[0].published) { if (verdict.status === "needs_human") published += 1; continue; }
    if (verdict.status === "needs_human" || !verdict.decision) { ids.needs_human.push(candidateId); continue; }
    const key = `${verdict.votes >= 3 ? "unanimous" : "agreed"}_${verdict.decision}` as SecondChipKey;
    ids[key].push(candidateId);
  }
  return {
    counts: { unanimousReject: ids.unanimous_reject.length, unanimousApprove: ids.unanimous_approve.length,
      agreedReject: ids.agreed_reject.length, agreedApprove: ids.agreed_approve.length, needsHuman: ids.needs_human.length, published, pending },
    ids,
  };
}

/**
 * 후보별 지금 표 — 심사 상세에 1차와 나란히, 모델마다 한 줄로 보인다.
 *
 * 새 입력이 대신한 표(superseded)는 뺀다. 입력이 바뀌어 다시 본 뒤에도 옛 표가 남아 있으면
 * 같은 모델이 두 줄로 보이고, 어느 쪽이 지금 의견인지 화면으로는 가릴 수 없다.
 * 아직 보지 않은 표는 그대로 보여 준다 — 무엇을 기다리는지가 보여야 사람이 기다릴지 정한다.
 */
export async function secondReviewsFor(candidateIds: number[]) {
  if (!candidateIds.length) return [];
  return db.select().from(secondReviews)
    .where(and(inArray(secondReviews.candidateId, candidateIds),
      // 새 입력이나 제거된 모델의 표는 뺀다. 사람이 먼저 결정해 닫힌 표나 확신 없는 1차로 닫힌 표는
      // 그 입력에 대한 지금 의견이라 그대로 보여 준다
      or(isNull(secondReviews.resolution), notInArray(secondReviews.resolution, ["superseded", "model_removed", "fallback"]))!))
    .orderBy(secondReviews.candidateId, secondReviews.id);
}

/** 공개된 제품 중 2차가 제품이 아니라고 본 것 — 사람이 내릴지 정한다 */
export async function publishedSecondReviews(limit = 100) {
  return db.select().from(secondReviews).where(and(eq(secondReviews.status, "needs_human"), isNotNull(secondReviews.publishedSlug)))
    .orderBy(desc(secondReviews.reviewedAt)).limit(limit);
}

export async function resolveSecondReviews(ids: number[], resolution: "kept" | "banned", actor: string, now = new Date()): Promise<number> {
  if (!ids.length) return 0;
  const updated = await db.update(secondReviews).set({ status: "resolved", resolution, resolvedBy: actor, resolvedAt: now })
    .where(and(inArray(secondReviews.id, ids), eq(secondReviews.status, "needs_human"))).returning({ id: secondReviews.id });
  return updated.length;
}
