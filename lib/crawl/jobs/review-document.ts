import type { CrawlDocument } from "@/lib/db/schema";
import { getDocument, recordReadmeFetchFailure, setReadmeSample } from "@/lib/crawl/repository";
import { fetchReadmeSample, README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import type { JobLease } from "@/lib/jobs/control";
import { storedReviewEvidenceRequired } from "../review-replay-context";

/**
 * README 를 받지 못한 원본을 몇 번까지 기다리는가. 기다림은 15분·30분(readmeFetchRetryAfter) — 세 번째 실패 뒤에는
 * 까닭(readmeFetchError)을 원본에 남긴 채 README 없이 심사한다. 끝없이 기다리면 GitHub raw 장애 하나가 1차 심사를 통째로 멈춘다.
 */
export const README_FETCH_WAIT_ATTEMPTS = 3;

export type ReviewReadmeState =
  | { kind: "ready" }
  /** 받지 못했고 아직 기다린다 — 이 틱은 이 후보를 빈 README 로 보내지 않는다 */
  | { kind: "waiting"; error: string; attempts: number; retryAfter: number }
  /** 기다릴 횟수를 다 썼다 — README 없이 심사하되 까닭을 남긴다 */
  | { kind: "unavailable"; error: string; attempts: number };

const currentSample = (document: CrawlDocument) => typeof document.pageMeta?.readmeSample === "string"
  && document.pageMeta.readmeSampleVersion === README_SAMPLE_VERSION;

/** 원본에 남은 README 상태. 옛 판의 README(다시 수집이 옮겨 온 것)는 받기 실패가 없으면 그대로 심사에 쓴다 */
export function reviewReadmeState(document: CrawlDocument): ReviewReadmeState {
  const meta = document.pageMeta ?? {};
  if (currentSample(document) || typeof meta.readmeFetchError !== "string") return { kind: "ready" };
  if (typeof meta.readmeSample === "string") return { kind: "ready" };
  const attempts = typeof meta.readmeFetchAttempts === "number" ? meta.readmeFetchAttempts : 1;
  const retryAfter = typeof meta.readmeFetchRetryAfter === "number" ? meta.readmeFetchRetryAfter : 0;
  return attempts < README_FETCH_WAIT_ATTEMPTS
    ? { kind: "waiting", error: meta.readmeFetchError, attempts, retryAfter }
    : { kind: "unavailable", error: meta.readmeFetchError, attempts };
}

/**
 * 심사에 넘길 원본. README 는 처음 심사할 때 한 번 받아 원본 옆에 둔다("" = 없음). 1차·2차 심사가 같이 쓴다.
 * 받지 못하면(한도·5xx·시간 초과) 까닭과 다음 시도 시각을 원본에 남기고, 그 시각 전에는 다시 받지 않는다 — 1차 심사는
 * reviewReadmeState 로 기다리거나 까닭을 남긴 채 README 없이 간다.
 */
export async function loadReviewDocument(repo: string, lease?: JobLease, now = Date.now()): Promise<CrawlDocument | undefined> {
  const document = await getDocument(repo);
  if (!document || currentSample(document)) return document;
  if (storedReviewEvidenceRequired()) throw new Error("replay_readme_evidence_missing");
  const retryAfter = document.pageMeta?.readmeFetchRetryAfter;
  if (typeof retryAfter === "number" && retryAfter > now) return document;
  // 까닭을 알리지 않은 실패(시험의 모의 전송 등)는 temporary 로 적는다
  let error = "temporary";
  const sample = await fetchReadmeSample(repo, undefined, reason => { error = reason; });
  const saved = typeof sample === "string" ? await setReadmeSample(repo, sample, document, lease)
    : await recordReadmeFetchFailure(document, { error, retryAfter: null }, lease, now);
  // 받는 사이 원본이 다시 수집됐다 — 새 원본에는 옛 README 를 붙이지 않는다(다음 심사에서 다시 받는다)
  return saved ?? await getDocument(repo);
}
