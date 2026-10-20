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
