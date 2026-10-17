import { describe, expect, it } from "vitest";
import { formatEvidenceMarkerError, parseEvidenceMarkerArgs } from "@/lib/operations/pipeline-evidence-marker";

describe("0097 recorder marker CLI arguments (F1)", () => {
  it("defaults to a dry-run and requires a revision and an operator", () => {
    expect(parseEvidenceMarkerArgs(["--revision=abcdef1", "--operator=f1-root"])).toEqual({ revision: "abcdef1", operator: "f1-root", execute: false, json: false });
    expect(parseEvidenceMarkerArgs(["--operator=운영자 A", "--revision=" + "a".repeat(40), "--execute", "--json"]))
      .toEqual({ revision: "a".repeat(40), operator: "운영자 A", execute: true, json: true });
  });
  it.each([
    [["--operator=f1-root"], "pipeline_evidence_marker_revision_required"],
    [["--revision=ABCDEF1", "--operator=f1-root"], "pipeline_evidence_marker_revision_required"],
    [["--revision=abcdef", "--operator=f1-root"], "pipeline_evidence_marker_revision_required"],
    [["--revision=abcdef1"], "pipeline_evidence_marker_operator_required"],
    [["--revision=abcdef1", "--operator="], "pipeline_evidence_marker_operator_required"],
    [["--revision=abcdef1", "--operator= f1"], "pipeline_evidence_marker_operator_required"],
    [["--revision=abcdef1", `--operator=${"x".repeat(121)}`], "pipeline_evidence_marker_operator_required"],
    [["--revision=abcdef1", "--operator=a\tb"], "pipeline_evidence_marker_operator_required"],
    [["--revision=abcdef1", "--operator=f1", "--execute=yes"], "pipeline_evidence_marker_unknown_option"],
    [["--revision=abcdef1", "--operator=f1", "--execute", "--execute"], "pipeline_evidence_marker_unknown_option"],
    [["--revision=abcdef1", "--revision=abcdef2", "--operator=f1"], "pipeline_evidence_marker_unknown_option"],
    [["--revision=abcdef1", "--operator=f1", "--force"], "pipeline_evidence_marker_unknown_option"],
    [["--revision=abcdef1", "--operator=f1", "postgres://u:p@db/x"], "pipeline_evidence_marker_url_argument_rejected"],
  ])("refuses %j", (args, code) => {
    expect(() => parseEvidenceMarkerArgs(args)).toThrow(code);
  });
  it("prints only fixed error codes", () => {
    expect(formatEvidenceMarkerError(new Error("dr_writer_site_fenced"))).toBe("dr_writer_site_fenced");
    expect(formatEvidenceMarkerError(new Error("Failed query: insert into pipeline_evidence_events ... postgres://u:p@db"))).toBe("pipeline_evidence_marker_failed");
    expect(formatEvidenceMarkerError("x")).toBe("pipeline_evidence_marker_failed");
  });
});
