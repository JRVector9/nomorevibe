import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseLayaEvaluationInput } from "../lib/crawl/laya-evaluation";
import { LAYA_QUESTION_VERSION } from "../lib/crawl/laya-preview";
import { createQualityAudit, renderQualityAudit, summarizeQualityAudit } from "../lib/crawl/laya-quality-audit";

function fixture() {
  const samples = parseLayaEvaluationInput({ version: 1, samples: Array.from({ length: 12 }, (_, i) => ({
    id: String(i + 1), snapshot: { product: { repo: `owner/repo-${i}`, accessMode: "installable", name: `Product ${i}`,
      description: "Public description", readme: "Original README", pageText: "Original page" }, repoFacts: { stars: 600 } },
    first: { decision: "approve" },
  })) });
  const responses = { version: 1, mode: "live", complete: true, questionVersion: LAYA_QUESTION_VERSION,
    rows: samples.map((sample, i) => ({ id: sample.id,
      subjectHash: createHash("sha256").update(JSON.stringify({ ...sample.snapshot.product, stars: sample.snapshot.repoFacts.stars })).digest("hex"),
      hint: { kind: "hint", authority: "none", questionVersion: LAYA_QUESTION_VERSION, softwareProbability: i / 12,
        durationMs: 20, requestHash: "a".repeat(64), truncated: true, routingModel: "english" },
    })),
  };
  return { samples, responses };
}
function setup(seed = "fixed-seed") {
  const { samples, responses } = fixture();
  return createQualityAudit(samples, responses, { seed, take: 3 });
}

describe("published-product quality pilot", () => {
  it("selects lowest software scores for attention, with a seeded control and no product decisions", () => {
    const plan = setup();
    expect(plan.selected.map(row => row.sampleId).sort()).toEqual(["1", "2", "3"]);
    expect(plan.control).toHaveLength(3);
    expect(plan.productionEffect).toBe("none");
    expect(plan.humanOutcome).toBe("pending");
    expect(plan).toEqual(setup());
    expect(new Set(plan.cards.map(row => row.reviewId)).size).toBe(plan.cards.length);
  });

  it("selects controls independently of LAYA scores and keeps overlapping members in both arms", () => {
    const { samples, responses } = fixture();
    const baseline = createQualityAudit(samples, responses, { seed: "fixed-seed", take: 3 });
    for (const row of responses.rows) row.hint.softwareProbability = baseline.control.some(x => x.sampleId === row.id) ? 0 : 1;
    const next = createQualityAudit(samples, responses, { seed: "fixed-seed", take: 3 });
    expect(next.control.map(x => x.sampleId)).toEqual(baseline.control.map(x => x.sampleId));
    expect(next.overlap).toBe(3);
    expect(next.cards).toHaveLength(3);
  });

  it("binds input revisions to the response and rejects stale or tampered rows", () => {
    const { samples, responses } = fixture();
    samples[0].snapshot.product.readme = "new revision";
    expect(() => createQualityAudit(samples, responses, { seed: "x", take: 3 })).toThrow();
  });

  it.each(["incomplete", "unavailable", "duplicate", "wrong-version", "wrong-authority", "dry-run"])("refuses %s results instead of dropping failed rows", mode => {
    const { samples, responses } = fixture();
    const invalid = JSON.parse(JSON.stringify(responses));
    if (mode === "incomplete") invalid.complete = false;
    if (mode === "unavailable") invalid.rows[0].hint = { kind: "unavailable", reason: "auth" };
    if (mode === "duplicate") invalid.rows[0] = invalid.rows[1];
    if (mode === "wrong-version") invalid.questionVersion = "different-question";
    if (mode === "wrong-authority") invalid.rows[0].hint.authority = "approve";
    if (mode === "dry-run") invalid.mode = "dry_run";
    expect(() => createQualityAudit(samples, invalid, { seed: "x", take: 3 })).toThrow();
  });

  it("refuses out-of-scope input and excessive group size", () => {
    const { samples, responses } = fixture();
    expect(() => createQualityAudit(samples, responses, { seed: "x", take: 7 })).toThrow();
    samples[0].snapshot.repoFacts.stars = 499;
    expect(() => createQualityAudit(samples, responses, { seed: "x", take: 3 })).toThrow();
  });

  it("escapes untrusted source text and excludes model scores and groups from the blind view", () => {
    const { samples, responses } = fixture();
    samples[0].snapshot.product.readme = '</script><img src=x onerror="alert(1)">';
    responses.rows[0].subjectHash = createHash("sha256").update(JSON.stringify({ ...samples[0].snapshot.product, stars: 600 })).digest("hex");
    const html = renderQualityAudit(createQualityAudit(samples, responses, { seed: "x", take: 3 }));
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('softwareProbability');
    expect(html).not.toContain('"control"');
    expect(html).not.toContain('"selected"');
    expect(html).not.toContain('firstDecision');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('github.com');
  });

  it("reports pending human review without inventing accuracy or review time", () => {
    const summary = summarizeQualityAudit(setup(), null);
    expect(summary.status).toBe("awaiting_review");
    expect(summary.yieldDifference).toBeNull();
    expect(summary.secondsPerFindingDifference).toBeNull();
  });

  it("counts uncertain reviews in the denominator, reports overlap, and preserves missing timing", () => {
    const plan = setup();
    const notes = { version: 1, auditId: plan.auditId, reviewer: "test fixture", confirmedSourceReview: true,
      answers: plan.cards.map((card, index) => ({ reviewId: card.reviewId, verdict: index === 0 ? "non_product" : "uncertain",
        notes: "Fixture source evidence only", durationMs: null })),
    };
    const result = summarizeQualityAudit(plan, notes);
    expect(result.status).toBe("reviewed");
    expect(result.selected.reviewed).toBe(3);
    expect(result.control.reviewed).toBe(3);
    expect(result.selected.yield).toBe(result.selected.findings / 3);
    expect(result.secondsPerFindingDifference).toBeNull();
    expect(result.overlap).toBe(plan.overlap);
    expect(result.statisticalSignificance).toBe("not_tested");
  });

  it("requires source notes for alleged non-products and binds reviewer answers to this audit", () => {
    const plan = setup();
    const base = { version: 1, auditId: plan.auditId, reviewer: "test fixture", confirmedSourceReview: true,
      answers: [{ reviewId: plan.cards[0].reviewId, verdict: "non_product", notes: "", durationMs: 10_000 }] };
    expect(() => summarizeQualityAudit(plan, base)).toThrow();
    expect(() => summarizeQualityAudit(plan, { ...base, auditId: "different" })).toThrow();
    expect(() => summarizeQualityAudit(plan, { ...base, answers: [{ ...base.answers[0], notes: "Source evidence", reviewId: "unknown" }] })).toThrow();
  });
});
