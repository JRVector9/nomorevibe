// Gate-split tiebreak measurement — branch functions (nmv-qwen): reviewWithQwenDirect (20s = tiebreak CALL_TIMEOUT_MS) and reviewWithDeepSeek. No DB access.
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { reviewWithQwenDirect, QwenDirectError, QWEN_V2_ADDENDUM, QWEN_V2_ADDENDUM_SHA256, QWEN_V2_PROMPT_VERSION } from "./lib/crawl/qwen-direct-review";
import { reviewWithDeepSeek } from "./lib/crawl/deepseek-review";
import { DEEPSEEK_MIN_CONFIDENCE } from "./lib/crawl/deepseek-review-policy";
import { parseGatewayContent } from "./lib/crawl/agent-review-gateway";
import { REVIEW_SYSTEM_PROMPT } from "./lib/crawl/agent-review";
import { REVIEW_PROMPT_VERSION, validateReviewOutcome } from "./lib/crawl/agent-review-contract";
import { secondRejectHolds } from "./lib/crawl/second-opinion-rules";

const [MODE, SAMPLE, INPUTS, OUT] = process.argv.slice(2);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sample = JSON.parse(readFileSync(SAMPLE, "utf8")).items as any[];
const inputs = new Map<number, any>(readFileSync(INPUTS, "utf8").split("\n").filter(Boolean).map(l => { const x = JSON.parse(l); return [x.candidateId, x.input]; }));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l).candidateId) : []);
async function vllmWaiting(): Promise<number | null> {
  try { const t = await (await fetch("http://127.0.0.1:8090/metrics", { signal: AbortSignal.timeout(3000) })).text();
    const m = t.match(/^vllm:num_requests_waiting\{[^}]*\} ([0-9.]+)/m); return m ? Number(m[1]) : null; } catch { return null; }
}
let consecutive = 0;
for (const s of sample) {
  if (done.has(s.candidateId)) continue;
  const raw = inputs.get(s.candidateId); if (!raw) continue;
  const input = { ...raw, validUntil: new Date(raw.validUntil) };
  let waiting = MODE === "qwen" ? await vllmWaiting() : null;
  for (let w = 0; MODE === "qwen" && (waiting ?? 0) > 0 && w < 6; w++) { console.log("vllm queue waiting", waiting); await sleep(10_000); waiting = await vllmWaiting(); }
  const cap: any = {};
  const request = (async (url: any, init: any) => { cap.url = String(url); cap.body = init?.body; const res = await fetch(url, init); cap.status = res.status;
    try { cap.text = await res.clone().text(); } catch { /* read by caller */ } return res; }) as typeof fetch;
  const t0 = Date.now();
  let decision: string | null = null, confidence: number | null = null, reason: string | null = null, error: string | null = null, errorDetail: string | null = null, rawDecision: string | null = null, rawConfidence: number | null = null;
  if (MODE === "qwen") {
    try { const r = await reviewWithQwenDirect(input, { timeoutMs: 20_000, request }); decision = r.outcome.decision; confidence = r.outcome.confidence ?? null; reason = r.outcome.reason; }
    catch (e) { if (!(e instanceof QwenDirectError)) throw e; error = e.code; errorDetail = e.detail; }
  } else {
    const r = await reviewWithDeepSeek(input, { request });
    if (r.ok) { decision = r.outcome.decision; confidence = r.outcome.confidence ?? null; reason = r.outcome.reason; } else error = r.error;
    try { const env = JSON.parse(cap.text); const v = validateReviewOutcome(input, parseGatewayContent(env.choices?.[0]?.message?.content ?? ""));
      rawDecision = v.decision; rawConfidence = v.confidence ?? null; if (!reason) reason = v.reason; } catch { /* no raw */ }
  }
  const durationMs = Date.now() - t0;
  let system = "", user = "", wireModel = null;
  try { const b = JSON.parse(cap.body); system = b.messages[0].content; user = b.messages[1].content; wireModel = b.model; } catch { /* no request */ }
  const at = system.indexOf(REVIEW_SYSTEM_PROMPT);
  const suffix = at >= 0 ? system.slice(at + REVIEW_SYSTEM_PROMPT.length) : null;
  const model = MODE === "qwen" ? "qwen3.8-flash-next" : "deepseek-v4.1-flash-1017";
  // splitRejectVerdict: every sampled gate is 1 approve (first) : 1 independent reject (27B) — so a Qwen-v2 reject applies unless the catalog exception holds it
  const tiebreakApplied = MODE === "qwen" && decision === "reject"
    ? ([reason, s.rejectReason27B].every(x => secondRejectHolds(model, x)) ? "rejected" : "held_catalog") : MODE === "qwen" ? (decision ? "kept_human" : "failed") : null;
  const rec = { provider: MODE, candidateId: s.candidateId, repo: s.repo, model, wireModel, endpoint: cap.url ?? null, httpStatus: cap.status ?? null,
    policyVersion: REVIEW_PROMPT_VERSION, policySha256: sha(REVIEW_SYSTEM_PROMPT), policyBytesIdentical: at >= 0, systemTextSha256: system ? sha(system) : null,
    suffixSha256: suffix !== null ? sha(suffix) : null, suffixIsQwenV2Addendum: suffix === QWEN_V2_ADDENDUM && sha(QWEN_V2_ADDENDUM) === QWEN_V2_ADDENDUM_SHA256,
    qwenPromptVersion: MODE === "qwen" ? QWEN_V2_PROMPT_VERSION : null, userContentSha256: user ? sha(user) : null, inputHash: input.inputHash, gateInputHash: s.inputHash,
    decision, confidence, reason, rawDecision, rawConfidence, floorDowngraded: MODE === "deepseek" && rawDecision && rawDecision !== "needs_review" && decision === "needs_review" ? `conf<${DEEPSEEK_MIN_CONFIDENCE}` : null,
    tiebreakApplied, error, errorDetail, durationMs, vllmWaitingBefore: waiting, rejectReason27B: s.rejectReason27B, finishedAt: new Date().toISOString() };
  appendFileSync(OUT, JSON.stringify(rec) + "\n");
  console.log([s.candidateId, s.repo.slice(0, 34), "→", decision ?? `ERR ${error}`, confidence ?? "", MODE === "deepseek" ? `raw:${rawDecision} ${rawConfidence ?? ""}` : tiebreakApplied, `${durationMs}ms`].join("\t"));
  if (error && /429|503|rate_limited|unreachable|http_4|http_5|capacity/.test(error)) { console.log("STOP:", error); break; }
  consecutive = error ? consecutive + 1 : 0; if (consecutive >= 3) { console.log("STOP: 3 consecutive errors"); break; }
  await sleep(500);
}
