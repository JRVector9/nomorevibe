import { createHash } from "node:crypto";
import { z } from "zod";
import { parseLayaEvaluationInput, type LayaSample } from "./laya-evaluation";
import { LAYA_QUESTION_VERSION } from "./laya-preview";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const responseSchema = z.object({
  version: z.literal(1), mode: z.literal("live"), complete: z.literal(true),
  questionVersion: z.literal(LAYA_QUESTION_VERSION),
  rows: z.array(z.object({ id: z.string(), subjectHash: digest, hint: z.object({
    kind: z.literal("hint"), authority: z.literal("none"), questionVersion: z.literal(LAYA_QUESTION_VERSION),
    softwareProbability: z.number().finite().min(0).max(1), durationMs: z.number().finite().nonnegative(),
    requestHash: digest, truncated: z.boolean(), routingModel: z.enum(["english", "multilingual"]).nullable(),
  }) })).min(2).max(100),
});
type AuditCard = { reviewId: string; repo: string; name: string; description: string; readme: string; pageText: string };
type Member = { sampleId: string; reviewId: string; softwareProbability: number };
export type QualityAudit = {
  version: 1; auditId: string; questionVersion: string; seed: string; take: number;
  population: number; overlap: number; productionEffect: "none"; humanOutcome: "pending";
  selected: Member[]; control: Member[]; cards: AuditCard[];
  apiP50Ms: number; apiP95Ms: number; excerptTruncated: number;
};

/** Offline attention ranking only. No DB, publication decisions, queue writes or live calls. */
export function createQualityAudit(input: LayaSample[], rawResponses: unknown, options: { seed: string; take: number }): QualityAudit {
  const samples = parseLayaEvaluationInput({ version: 1, samples: input });
  const { seed, take } = z.object({ seed: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/), take: z.number().int().min(1).max(20) }).parse(options);
  if (take * 2 > samples.length || samples.some(s => s.snapshot.product.accessMode !== "installable" || (s.snapshot.repoFacts.stars ?? 0) < 500)) {
    throw new Error("invalid_audit_scope");
  }
  const repos = samples.map(s => s.snapshot.product.repo.toLowerCase());
  if (new Set(repos).size !== samples.length) throw new Error("duplicate_repository");
  const responses = responseSchema.parse(rawResponses);
  const byId = new Map(responses.rows.map(row => [row.id, row]));
  if (byId.size !== samples.length || responses.rows.length !== samples.length) throw new Error("response_mismatch");
  const candidates = samples.map(sample => {
    const response = byId.get(sample.id);
    const subject = { ...sample.snapshot.product, stars: sample.snapshot.repoFacts.stars ?? 0 };
    if (!response || response.subjectHash !== hash(JSON.stringify(subject))) throw new Error("source_mismatch");
    return { sample, response, repo: sample.snapshot.product.repo.toLowerCase() };
  });
  const key = (namespace: string, repo: string) => hash(`${namespace}:${seed}:${repo}`);
  const ranked = candidates.toSorted((a, b) => a.response.hint.softwareProbability - b.response.hint.softwareProbability
    || key("tie", a.repo).localeCompare(key("tie", b.repo))).slice(0, take);
  // Draw from the entire pool, independently of scores. Do not exclude the selected group:
  // doing so would turn "random" into a biased easy remainder. Shared cards are reviewed once.
  const control = candidates.toSorted((a, b) => key("control", a.repo).localeCompare(key("control", b.repo))).slice(0, take);
  const union = [...new Map([...ranked, ...control].map(row => [row.sample.id, row])).values()]
    .toSorted((a, b) => key("blind", a.repo).localeCompare(key("blind", b.repo)));
  const reviewIds = new Map(union.map((row, i) => [row.sample.id, `Q-${String(i + 1).padStart(2, "0")}`]));
  const member = (row: typeof candidates[number]): Member => ({ sampleId: row.sample.id,
    reviewId: reviewIds.get(row.sample.id)!, softwareProbability: row.response.hint.softwareProbability });
  const identity = candidates.map(row => [row.sample.id, row.response.subjectHash, row.response.hint.requestHash,
    row.response.hint.softwareProbability]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const latencies = candidates.map(row => row.response.hint.durationMs).toSorted((a, b) => a - b);
  return { version: 1, auditId: hash(JSON.stringify({ seed, take, identity, version: LAYA_QUESTION_VERSION })).slice(0, 24),
    questionVersion: LAYA_QUESTION_VERSION, seed, take, population: samples.length,
    overlap: take * 2 - union.length, productionEffect: "none", humanOutcome: "pending",
    selected: ranked.map(member), control: control.map(member),
    cards: union.map(row => ({ reviewId: reviewIds.get(row.sample.id)!, repo: row.sample.snapshot.product.repo,
      name: row.sample.snapshot.product.name, description: row.sample.snapshot.product.description,
      readme: row.sample.snapshot.product.readme, pageText: row.sample.snapshot.product.pageText })),
    apiP50Ms: latencies[Math.ceil(latencies.length * .5) - 1], apiP95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
    excerptTruncated: candidates.filter(row => row.response.hint.truncated).length,
  };
}

const answerSchema = z.object({
  reviewId: z.string(), verdict: z.enum(["product", "non_product", "uncertain"]),
  notes: z.string().trim().max(2000), durationMs: z.number().finite().min(1000).max(3_600_000).nullable(),
}).refine(row => row.verdict !== "non_product" || row.notes.length >= 10, "source_notes_required");
const annotationSchema = z.object({ version: z.literal(1), auditId: z.string(), reviewer: z.string().trim().min(1).max(100),
  confirmedSourceReview: z.literal(true), answers: z.array(answerSchema).max(40) });

/** Reviewer-supplied judgments, never inferred from either model's earlier approval. */
export function summarizeQualityAudit(plan: QualityAudit, annotations: unknown) {
  const annotation = annotations === null ? null : annotationSchema.parse(annotations);
  if (annotation && annotation.auditId !== plan.auditId) throw new Error("wrong_audit");
  const answers = annotation?.answers ?? [];
  const allowed = new Set(plan.cards.map(card => card.reviewId));
  if (new Set(answers.map(a => a.reviewId)).size !== answers.length || answers.some(a => !allowed.has(a.reviewId))) throw new Error("invalid_review_ids");
  const byId = new Map(answers.map(answer => [answer.reviewId, answer]));
  const complete = allowed.size === answers.length;
  const group = (members: Member[]) => {
    const rows = members.flatMap(member => byId.has(member.reviewId) ? [byId.get(member.reviewId)!] : []);
    const findings = rows.filter(answer => answer.verdict === "non_product").length;
    const timingComplete = rows.length === members.length && rows.every(answer => answer.durationMs !== null);
    const seconds = timingComplete ? rows.reduce((total, answer) => total + answer.durationMs!, 0) / 1000 : null;
    return { size: members.length, reviewed: rows.length, findings, uncertain: rows.filter(answer => answer.verdict === "uncertain").length,
      yield: rows.length === members.length ? findings / members.length : null,
      selfReportedSeconds: seconds, secondsPerFinding: seconds !== null && findings > 0 ? seconds / findings : null };
  };
  const selected = group(plan.selected), control = group(plan.control);
  return { version: 1, auditId: plan.auditId, status: complete ? "reviewed" : "awaiting_review",
    productionEffect: "none", labelSource: "reviewer_supplied_not_verified_by_code", statisticalSignificance: "not_tested",
    uniqueReviewed: answers.length, uniqueRequired: allowed.size, overlap: plan.overlap, selected, control,
    yieldDifference: complete ? selected.yield! - control.yield! : null,
    secondsPerFindingDifference: complete && selected.secondsPerFinding !== null && control.secondsPerFinding !== null
      ? selected.secondsPerFinding - control.secondsPerFinding : null,
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function renderQualityAudit(plan: QualityAudit): string {
  // The board receives only source cards. Group allocation, model predictions, old decisions
  // and private credentials are absent, including from embedded JSON and DOM attributes.
  const payload = JSON.stringify({ auditId: plan.auditId, reviewIds: plan.cards.map(card => card.reviewId) })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const script = `"use strict";
const config=JSON.parse(document.getElementById("config").textContent);
const key="nmv-quality-audit:"+config.auditId;
const status=document.getElementById("status");
const rows=[...document.querySelectorAll("article")];
const field=(row,name)=>row.querySelector('[data-field="'+name+'"]');
function values(){return {reviewer:document.getElementById("reviewer").value,confirmedSourceReview:document.getElementById("confirmed").checked,
 answers:rows.map(row=>({reviewId:row.id,verdict:field(row,"verdict").value,notes:field(row,"notes").value,
 durationMs:field(row,"seconds").value===""?null:Number(field(row,"seconds").value)*1000})).filter(row=>row.verdict)};}
function save(){const v=values();try{localStorage.setItem(key,JSON.stringify(v));status.textContent=v.answers.length+" / "+rows.length+"개 기록 · 이 브라우저에 저장됨";}catch{status.textContent="브라우저 저장 불가 · 결과 파일을 내려받아 보관하세요";}}
try{const saved=JSON.parse(localStorage.getItem(key)||"null");if(saved){
 if(typeof saved.reviewer==="string")document.getElementById("reviewer").value=saved.reviewer;
 document.getElementById("confirmed").checked=saved.confirmedSourceReview===true;
 if(Array.isArray(saved.answers))for(const answer of saved.answers){const row=rows.find(r=>r.id===answer.reviewId);if(!row)continue;
 if(["product","non_product","uncertain"].includes(answer.verdict))field(row,"verdict").value=answer.verdict;
 if(typeof answer.notes==="string")field(row,"notes").value=answer.notes.slice(0,2000);
 if(Number.isFinite(answer.durationMs)&&answer.durationMs>=1000&&answer.durationMs<=3600000)field(row,"seconds").value=String(answer.durationMs/1000);}}}catch{}
document.addEventListener("input",save);save();
document.getElementById("download").addEventListener("click",()=>{
 const v=values();if(!v.reviewer.trim()||!v.confirmedSourceReview||!v.answers.length){status.textContent="검토자 이름, 원문 확인 체크와 최소 1개 판단을 입력하세요";return;}
 for(const answer of v.answers){if(answer.verdict==="non_product"&&answer.notes.trim().length<10){status.textContent=answer.reviewId+": 제품이 아닌 것으로 본 원문 근거를 10자 이상 적어주세요";return;}
 if(answer.durationMs!==null&&(!Number.isFinite(answer.durationMs)||answer.durationMs<1000||answer.durationMs>3600000)){status.textContent=answer.reviewId+": 시간은 1~3600초 또는 빈칸으로 입력하세요";return;}}
 const report={version:1,auditId:config.auditId,...v,reviewer:v.reviewer.trim()};
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));
 const a=document.createElement("a");a.href=url;a.download="quality-audit-"+config.auditId+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 status.textContent="파일을 내려받았습니다. 제품 상태는 변경되지 않습니다.";
});`;
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const cards = plan.cards.map(card => `<article id="${escapeHtml(card.reviewId)}">
<div class="eyebrow">${escapeHtml(card.reviewId)}</div><h2>${escapeHtml(card.name || card.repo)}</h2>
<a href="https://github.com/${escapeHtml(card.repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(card.repo)} ↗</a>
<p class="description">${escapeHtml(card.description || "저장된 설명 없음")}</p>
<details><summary>저장된 README 원문</summary><pre>${escapeHtml(card.readme || "저장된 README 없음 — 저장소에서 확인하세요")}</pre></details>
<details><summary>저장된 페이지 원문</summary><pre>${escapeHtml(card.pageText || "저장된 페이지 본문 없음")}</pre></details>
<div class="fields"><label>검토 결과<select data-field="verdict"><option value="">선택하세요</option><option value="product">제품으로 유지</option><option value="non_product">제품이 아닌 것으로 보임</option><option value="uncertain">추가 확인 필요</option></select></label>
<label>검토 시간 · 초 (선택)<input type="number" data-field="seconds" min="1" max="3600" step="any" placeholder="미기록"></label></div>
<label>원문 근거 · 메모<textarea data-field="notes" maxlength="2000" rows="3" placeholder="판단 근거가 된 문구와 파일 위치를 적어주세요"></textarea></label></article>`).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>NoMoreVibe · 품질 점검 실험</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#202538;font:15px/1.65 system-ui,-apple-system,sans-serif}main{max-width:960px;margin:auto;padding:40px 22px 100px}header{margin-bottom:30px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.08em;color:#6c54c8}h1{font-size:30px;line-height:1.25;margin:12px 0}h2{font-size:20px;margin:5px 0;overflow-wrap:anywhere}p{margin:10px 0}a{color:#5840b0;overflow-wrap:anywhere}.intro{color:#505b72;max-width:760px}.notice{padding:14px 18px;background:#ece8fb;border-radius:10px;margin:18px 0}article{background:white;padding:25px;border:1px solid #dee2ec;border-radius:14px;margin:18px 0;break-inside:avoid}.description{color:#4e596b;white-space:pre-wrap;overflow-wrap:anywhere}details{border-top:1px solid #eceef3;padding:12px 0}summary{cursor:pointer;font-weight:600;min-height:32px}pre{font:13px/1.65 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:380px;overflow:auto;background:#f7f8fa;padding:12px}label{display:block;font-size:13px;font-weight:650;margin-top:12px}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;border:1px solid #c6ccd9;border-radius:8px;padding:10px;color:#202538;background:white;min-height:44px}textarea{resize:vertical}.fields{display:grid;grid-template-columns:2fr 1fr;gap:18px}.toolbar{background:#fff;padding:22px;border:1px solid #dee2ec;border-radius:14px}.check{display:flex;align-items:center;gap:10px}.check input{width:20px;height:20px;min-height:20px}button{background:#6247c9;color:#fff;border:0;border-radius:8px;min-height:44px;padding:11px 18px;font-weight:650;cursor:pointer;margin-top:15px}#status{color:#505b72;font-size:13px;min-height:24px}small{color:#596479}a:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid #8f7add;outline-offset:3px}@media(max-width:560px){main{padding:24px 14px 60px}h1{font-size:25px}article{padding:18px}.fields{grid-template-columns:1fr;gap:0}}
</style></head><body><main><header><div class="eyebrow">NOMOREVIBE / QUALITY PILOT</div><h1>원문으로 확인하는 제품 점검</h1>
<p class="intro">발행된 설치형 제품의 품질 점검 실험입니다. 모델 점수와 표본 그룹을 가린 상태에서 ${plan.cards.length}개 제품을 동일한 기준으로 확인합니다.</p>
<div class="notice">설치 가능한 앱·CLI·라이브러리·SDK·플러그인·스킬은 제품에 포함합니다. 문서·강좌·설문·자료 목록만 제공하는 경우는 따로 표시하고, 불명확하면 추가 확인으로 남겨주세요.</div>
<p class="intro">저장된 원문과 현재 저장소가 다르면 메모에 남겨주세요. 별 수만으로 판단하지 않습니다. 시간은 외부 원문 확인을 포함해 직접 입력하며, 모르면 빈칸으로 둡니다.</p>
<small>입력은 이 브라우저에 저장됩니다. 검토 결과를 파일로 내려받을 수 있으며, 제품 상태는 변경되지 않습니다.</small></header>
${cards}<section class="toolbar"><label for="reviewer">검토자 이름<input id="reviewer" maxlength="100" autocomplete="off"></label>
<label class="check"><input id="confirmed" type="checkbox">제가 원문을 확인하고 판단을 기록했습니다.</label>
<button id="download" type="button">검토 결과 내려받기</button><p id="status" role="status" aria-live="polite"></p>
<small>미완료 항목이 있어도 중간 저장할 수 있습니다. 전체 검토 전에는 그룹 간 효과를 확정하지 않습니다.</small></section>
</main><script id="config" type="application/json">${payload}</script><script>${script}</script></body></html>`;
}
