import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, secondReviews, type SecondReviewProvider, type SecondReviewStatus, type SecondReviewTrigger } from "@/lib/db/schema";
import { pageFactsFromDocument } from "./rules";
import type { CrawlSettings } from "./settings-schema";

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
/** 표 하나를 1차와 견준 결과 — 행에 남는 상태다. 후보 전체의 결론은 combineVotes 가 낸다 */
export function combineVerdicts(first: Verdict, second: Vote, agreeAt: number, published: boolean): Exclude<SecondReviewStatus, "pending" | "failed" | "resolved"> {
  if (published) return second.decision === "approve" ? "agreed" : "needs_human";
  const agreed = first.decision === second.decision && first.decision !== "needs_review" && counts(second, agreeAt)
    && (first.confidence ?? 0) >= agreeAt;
  return agreed ? "agreed" : "needs_human";
}

export type Vote = Verdict & { provider: SecondReviewProvider | null };

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
 * 표가 많을수록 안전하므로 몇 표가 모였는지를 함께 돌려준다 — 사람은 표 수를 보고 확정 범위를
 * 고른다(2026-09-12 평가: 성향이 반대인 두 모델이 일치하면 사람 판정과 거의 어긋나지 않았다).
 *
 * 공개된 제품: 2차가 하나라도 제품이 아니라고 하면 사람에게. 자동으로 내리지 않는다.
 */
export function combineVotes(first: Verdict, second: Vote[], options: { agreeAt: number; published: boolean; pending: number }): CandidateVerdict {
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
    if (!second.length || second.some((vote) => vote.decision !== "approve")) {
      return { status: "needs_human", decision: second.length ? "reject" : null, votes: second.length };
    }
    return { status: "agreed", decision: "approve", votes: second.length };
  }
  const all = [...(counts(first, options.agreeAt) ? [first.decision] : []), ...second.filter((vote) => counts(vote, options.agreeAt)).map((vote) => vote.decision)];
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
    decision: sql<string>`${crawlReviewAttempts.outcome}->>'decision'`.as("decision"),
    confidence: sql<number | null>`(${crawlReviewAttempts.outcome}->>'confidence')::float`.as("confidence"),
  }).from(crawlReviewAttempts).innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.decidedBy, "auto"),
      eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"), eq(crawlReviewAttempts.provider, "claude-cli"),
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
  const decided = await db.select().from(latest)
    .where(sql`(select count(*) from ${secondReviews} s
      where s.candidate_id = ${latest.candidateId} and s.input_hash = ${latest.inputHash})
      < ${settings.secondReview.voters.length}`)
    .limit(ENQUEUE_LIMIT * 4);
  /**
   * 세워 둔 모델마다 한 행. 누가 볼지를 올릴 때 적는다 — 유일 색인이 (후보, 입력, 모델)이라
   * 모델을 비워 두면 Postgres 가 NULL 을 서로 다른 값으로 보아 같은 후보가 매 틱 다시 올라온다.
   */
  const voters = settings.secondReview.voters;
  /**
   * 한 후보가 모델 수만큼 행을 쓰므로, 후보 수로 상한을 잡는다 — 행 수로 자르면 모델을 셋
   * 세웠을 때 한 후보의 표가 반만 올라가 영영 짝이 맞지 않는다.
   */
  const rows: (typeof secondReviews.$inferInsert)[] = decided
    .filter((row) => row.decision === "approve" || row.decision === "reject" || (held && row.decision === "needs_review"))
    .slice(0, ENQUEUE_LIMIT)
    .flatMap((row) => voters.map((voter) => ({ ...voter, candidateId: row.candidateId, repo: row.repo,
      trigger: (row.decision === "needs_review" ? "ai_held" : "ai_decided") as SecondReviewTrigger,
      firstDecision: row.decision, firstConfidence: row.confidence, inputHash: row.inputHash })));

  const published = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, slug: crawlCandidates.publishedSlug,
    productUrl: crawlCandidates.productUrl, pageMeta: crawlDocuments.pageMeta, pageStatus: crawlDocuments.pageStatus, documentUrl: crawlDocuments.productUrl })
    .from(crawlCandidates).innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(eq(crawlCandidates.state, "published"), eq(crawlCandidates.decidedBy, "auto"), isNotNull(crawlCandidates.publishedSlug),
      gte(crawlCandidates.decidedAt, new Date(now.getTime() - PUBLISHED_LOOKBACK_MS))))
    .limit(2_000);
  const publishedRows: (typeof secondReviews.$inferInsert)[] = [];
  let publishedCount = 0;
  for (const row of published) {
    const meta = (row.pageMeta ?? {}) as { title?: unknown; readmeSample?: unknown };
    const facts = pageFactsFromDocument({ productUrl: row.documentUrl, pageStatus: row.pageStatus, pageMeta: row.pageMeta });
    const signals = riskSignals({ name: typeof meta.title === "string" ? meta.title : row.repo, productUrl: row.productUrl,
      textSample: facts.textSample ?? null, readme: typeof meta.readmeSample === "string" ? meta.readmeSample : null });
    const sampled = inSample(row.repo, settings.secondReview.sampleRate);
    if (!signals.length && !sampled) continue;
    publishedRows.push(...voters.map((voter) => ({ ...voter, candidateId: row.id, repo: row.repo, publishedSlug: row.slug,
      trigger: (signals.length ? "risk" : "sample") as SecondReviewTrigger, signals,
      firstDecision: "approve", firstConfidence: null, inputHash: publishedInputHash(row.slug!) })));
    if (++publishedCount >= PUBLISHED_LIMIT) break;
  }
  rows.push(...publishedRows);
  if (!rows.length) return 0;
  const inserted = await db.insert(secondReviews).values(rows).onConflictDoNothing()
    .returning({ id: secondReviews.id, candidateId: secondReviews.candidateId, trigger: secondReviews.trigger, inputHash: secondReviews.inputHash });
  const renewed = inserted.filter((row) => row.trigger === "ai_decided" || row.trigger === "ai_held");
  if (renewed.length) {
    /**
     * 앞선 것을 닫는 기준은 "입력이 바뀌었다"이지 "새 행이 들어왔다"가 아니다.
     *
     * 모델을 하나 더 세우면 같은 입력에 새 행이 생기는데, 그때 후보 id 로만 닫으면 먼저 세운
     * 모델의 표(아직 안 본 것까지)가 함께 닫힌다. 같은 입력은 이미 낸 유일 색인 때문에 다시
     * 올릴 수도 없어 그 표는 영영 사라진다. 입력 해시가 다른 것만 닫는다.
     */
    await db.update(secondReviews).set({ status: "resolved", resolution: "superseded", resolvedAt: now })
      .where(and(inArray(secondReviews.trigger, ["ai_decided", "ai_held"]), inArray(secondReviews.candidateId, renewed.map((row) => row.candidateId)),
        notInArray(secondReviews.inputHash, [...new Set(renewed.map((row) => row.inputHash))]),
        inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"])));
  }
  return inserted.length;
}

/**
 * 더 볼 필요가 없어진 것을 닫는다 — 사람이 이미 결정했거나(보류가 아님) 공개분이 내려갔다.
 * 지우지 않는다. 몇 건을 누가 어떻게 끝냈는지가 2차 심사의 정확도다.
 */
export async function closeSettledSecondReviews(now = new Date()): Promise<number> {
  // 확신 없는 옛 1차로 올린 것 — 일치할 수 없으니 닫는다. 2차 의견은 남아 심사 상세에 그대로 보인다
  const legacy = await db.update(secondReviews).set({ status: "resolved", resolution: "no_first_confidence", resolvedAt: now })
    .where(and(eq(secondReviews.trigger, "ai_decided"), isNull(secondReviews.firstConfidence),
      inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"])))
    .returning({ id: secondReviews.id });
  return legacy.length + await closeDecidedSecondReviews(now);
}

async function closeDecidedSecondReviews(now: Date): Promise<number> {
  // 공개분의 일치는 끝난 기록이다(그대로 둔다) — 훑는 대상에 넣으면 날마다 쌓여 한도를 잡아먹는다
  const open = await db.select({ id: secondReviews.id, candidateId: secondReviews.candidateId, published: secondReviews.publishedSlug })
    .from(secondReviews).where(or(inArray(secondReviews.status, ["pending", "needs_human"]),
      and(eq(secondReviews.status, "agreed"), isNull(secondReviews.publishedSlug))))
    .orderBy(secondReviews.id).limit(1_000);
  if (!open.length) return 0;
  const candidates = await db.select({ id: crawlCandidates.id, state: crawlCandidates.state }).from(crawlCandidates)
    .where(inArray(crawlCandidates.id, [...new Set(open.map((row) => row.candidateId))]));
  const state = new Map(candidates.map((row) => [row.id, row.state]));
  const settled = open.filter((row) => row.published ? state.get(row.candidateId) !== "published" : state.get(row.candidateId) !== "needs_review");
  if (!settled.length) return 0;
  await db.update(secondReviews).set({ status: "resolved", resolution: "decided_elsewhere", resolvedAt: now })
    .where(inArray(secondReviews.id, settled.map((row) => row.id)));
  return settled.length;
}

export async function pendingSecondReviews(limit: number) {
  return db.select().from(secondReviews).where(eq(secondReviews.status, "pending")).orderBy(secondReviews.id).limit(limit);
}

export async function recordSecondReview(id: number, result:
  | { ok: true; decision: string; confidence: number | null; reason: string; model: string; provider: SecondReviewProvider; status: "agreed" | "needs_human" }
  | { ok: false; error: string; model: string; provider: SecondReviewProvider }, now = new Date()): Promise<void> {
  await db.update(secondReviews).set(result.ok
    ? { status: result.status, model: result.model, provider: result.provider, secondDecision: result.decision, secondConfidence: result.confidence,
        secondReason: result.reason.slice(0, 2000), errorCode: null, reviewedAt: now }
    : { status: "failed", model: result.model, provider: result.provider, errorCode: result.error.slice(0, 60), reviewedAt: now })
    .where(eq(secondReviews.id, id));
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
    .where(and(isNotNull(secondReviews.errorCode), gte(secondReviews.reviewedAt, new Date(now.getTime() - 24 * 3600_000))))
    .groupBy(secondReviews.provider, secondReviews.model, secondReviews.errorCode)
    .orderBy(desc(sql`count(*)`));
  return rows.map((row) => ({ ...row, errorCode: row.errorCode ?? "unknown", count: Number(row.count) }));
}

/** 잠깐 막힌 것과 그렇지 않은 것 — 다시 보는 때가 다르다 */
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
    .where(and(eq(secondReviews.status, "failed"),
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
    confidence: secondReviews.secondConfidence, provider: secondReviews.provider, published: secondReviews.publishedSlug,
    firstDecision: secondReviews.firstDecision, firstConfidence: secondReviews.firstConfidence }).from(secondReviews)
    // 실패한 표도 읽는다 — 한 시간 뒤 다시 보므로 아직 끝나지 않은 표이고, 모두 실패한 후보가
    // 집계에서 통째로 사라지면 멈춘 줄 모른다
    .where(inArray(secondReviews.status, ["pending", "agreed", "needs_human", "failed"]));

  const byCandidate = new Map<number, typeof rows>();
  for (const row of rows) byCandidate.set(row.candidateId, [...(byCandidate.get(row.candidateId) ?? []), row]);

  const ids: Record<SecondChipKey, number[]> = { unanimous_reject: [], unanimous_approve: [], agreed_reject: [], agreed_approve: [], needs_human: [] };
  let published = 0, pending = 0;
  for (const [candidateId, group] of byCandidate) {
    const first = { decision: group[0].firstDecision, confidence: group[0].firstConfidence };
    const outstanding = group.filter((row) => row.status === "pending" || row.status === "failed").length;
    const votes = group.filter((row) => row.status === "agreed" || row.status === "needs_human")
      .map((row) => ({ decision: row.decision ?? "", confidence: row.confidence, provider: row.provider }));
    const verdict = combineVotes(first, votes, { agreeAt, published: Boolean(group[0].published), pending: outstanding });
    if (verdict.status === "pending") { pending += 1; continue; }
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
      // 새 입력이 대신한 표만 뺀다. 사람이 먼저 결정해 닫힌 표나 확신 없는 1차로 닫힌 표는
      // 그 입력에 대한 지금 의견이라 그대로 보여 준다
      or(isNull(secondReviews.resolution), notInArray(secondReviews.resolution, ["superseded"]))!))
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
