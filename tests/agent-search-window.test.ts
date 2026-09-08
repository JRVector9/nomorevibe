import { expect, it } from "vitest";
import { splitSearchWindow } from "@/lib/crawl/search-window";

it("splits a capped result into adjacent bounded windows", () => {
  const pieces = splitSearchWindow({from:"2026-09-01T00:00:00Z",to:"2026-09-02T00:00:00Z"});
  expect(pieces).toHaveLength(2);
  expect(new Date(pieces![1].from).getTime() - new Date(pieces![0].to).getTime()).toBe(1000);
});
it("retains incomplete coverage when the smallest range is saturated", () => {
  expect(splitSearchWindow({from:"2026-09-01T00:00:00Z",to:"2026-09-01T00:00:00Z"})).toBeNull();
});
