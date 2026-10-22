import { expect, it } from "vitest";
import { xCollectorConfig } from "@/scripts/x-collector";

it("defaults to dry-run and requires an explicit live selection", () => {
  expect(xCollectorConfig([], {}, "laptop")).toMatchObject({ live: false, useCaseApproved: false });
  expect(xCollectorConfig(["--dry-run"], { X_COLLECTION_LIVE: "1" }, "laptop").live).toBe(false);
});
it("permits live only on the exact selected host and keeps the approval gate separate", () => {
  expect(() => xCollectorConfig(["--live"], {}, "onetwoday")).toThrow("invalid_configuration");
  expect(xCollectorConfig([], { X_COLLECTION_LIVE: "1", X_USE_CASE_APPROVED: "0" }, "osaka-smoke"))
    .toMatchObject({ live: true, useCaseApproved: false });
  expect(xCollectorConfig(["--live"], { X_USE_CASE_APPROVED: "1" }, "osaka-smoke").useCaseApproved).toBe(true);
});
it.each([["--live", "--dry-run"], ["--live", "--live"], ["--token", "private-token"], ["--help"]])(
  "rejects unsupported and conflicting arguments without echoing secrets: %s", (...args) => {
    expect(() => xCollectorConfig(args, {}, "osaka-smoke")).toThrow(/^invalid_configuration$/);
  });
it("requires an absolute persistent state path", () => {
  expect(() => xCollectorConfig([], { X_STATE_DIR: "relative" }, "osaka-smoke")).toThrow("invalid_configuration");
});
it("sends web reports only with a 32-byte secret and https report addresses", () => {
  const secret = "x-status-current-secret-0123456789abcdef";
  expect(xCollectorConfig([], {}, "osaka-smoke")).not.toHaveProperty("report");
  expect(xCollectorConfig([], { X_STATUS_REPORT_SECRET: secret, X_STATUS_REPORT_URL: "https://nomorevibe.com/api/ops/x-status" }, "osaka-smoke").report)
    .toEqual({ secret, statusUrl: "https://nomorevibe.com/api/ops/x-status", postsUrl: null });
  expect(xCollectorConfig([], { X_STATUS_REPORT_SECRET: secret, X_POSTS_REPORT_URL: "https://nomorevibe.com/api/ops/x-posts" }, "osaka-smoke").report)
    .toMatchObject({ statusUrl: null, postsUrl: "https://nomorevibe.com/api/ops/x-posts" });
});
it.each(["https://nomorevibe.com/api/ops/x-query", "http://nomorevibe.com/api/ops/x-query", "not a url"])(
  "a leftover X_QUERY_URL (removed 2026-10-22) is ignored, never validated or used: %s", leftover => {
    const secret = "x-status-current-secret-0123456789abcdef";
    const environment = { X_STATUS_REPORT_SECRET: secret, X_STATUS_REPORT_URL: "https://nomorevibe.com/api/ops/x-status",
      X_POSTS_REPORT_URL: "https://nomorevibe.com/api/ops/x-posts", X_QUERY_URL: leftover };
    expect(xCollectorConfig([], environment, "osaka-smoke").report)
      .toEqual({ secret, statusUrl: "https://nomorevibe.com/api/ops/x-status", postsUrl: "https://nomorevibe.com/api/ops/x-posts" });
    expect(xCollectorConfig([], { X_QUERY_URL: leftover }, "osaka-smoke")).not.toHaveProperty("report");
    // It is not a report address: a secret with only the leftover line still has nowhere to report.
    expect(() => xCollectorConfig([], { X_STATUS_REPORT_SECRET: secret, X_QUERY_URL: leftover }, "osaka-smoke")).toThrow(/^invalid_configuration$/);
  });
it.each([
  { X_STATUS_REPORT_SECRET: "short", X_STATUS_REPORT_URL: "https://nomorevibe.com/api/ops/x-status" },
  { X_STATUS_REPORT_SECRET: "x-status-current-secret-0123456789 abcdef", X_STATUS_REPORT_URL: "https://nomorevibe.com/api/ops/x-status" },
  { X_STATUS_REPORT_SECRET: "x-status-current-secret-0123456789abcdef" },
  { X_STATUS_REPORT_SECRET: "x-status-current-secret-0123456789abcdef", X_STATUS_REPORT_URL: "http://nomorevibe.com/api/ops/x-status" },
  { X_STATUS_REPORT_SECRET: "x-status-current-secret-0123456789abcdef", X_POSTS_REPORT_URL: "https://user:pass@nomorevibe.com/api/ops/x-posts" },
  { X_STATUS_REPORT_SECRET: "x-status-current-secret-0123456789abcdef", X_POSTS_REPORT_URL: "not a url" },
])("rejects unsafe report settings without echoing them: %#", environment => {
  expect(() => xCollectorConfig([], environment, "osaka-smoke")).toThrow(/^invalid_configuration$/);
});
