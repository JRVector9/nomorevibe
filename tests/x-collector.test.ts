import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runXCollector } from "@/lib/social/x-collector";

let stateDir: string;
const instant = Date.parse("2026-10-15T04:00:00Z");
const post = (id = "123", repos = ["owner/skill-repo"]) => ({ id, created_at: "2026-10-15T01:00:00Z",
  text: "private-raw-text", author_id: "private-author", entities: { urls: repos.map(repo => ({ expanded_url: `https://github.com/${repo}` })) },
  public_metrics: { like_count: 10, reply_count: 2, retweet_count: 3, quote_count: 4 } });
const data = (posts: unknown[] = [post()]) => new Response(JSON.stringify({ data: posts }));
const options = () => ({ stateDir, live: true, useCaseApproved: true, token: "private-token", now: () => instant });
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "x-collector-")); });
afterEach(() => vi.restoreAllMocks());

it.each([{ live: false }, { useCaseApproved: false }, { token: "" }, { token: "bad\nheader" }])(
  "never calls or reserves when an execution gate is missing: %s", async override => {
    const request = vi.fn();
    const result = await runXCollector({ ...options(), ...override }, { request });
    expect(result.reservedPosts).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect((await readdir(stateDir)).filter(file => file.startsWith("budget-"))).toEqual([]);
  });

it("durably reserves ten before HTTP and does not read the search results again", async () => {
  const request = vi.fn(async () => {
    const receipt = JSON.parse(await readFile(join(stateDir, "budget-2026-10-15.json"), "utf8"));
    expect(receipt).toMatchObject({ reservedPosts: 10, day: "2026-10-15" });
    expect((await stat(join(stateDir, "budget-2026-10-15.json"))).mode & 0o777).toBe(0o600);
    return data();
  });
  const result = await runXCollector(options(), { request });
  expect(result).toMatchObject({ status: "completed", reservedPosts: 10, requests: 1, candidates: 1 });
  expect(request).toHaveBeenCalledOnce();
  const stored = await readFile(join(stateDir, "observations.json"), "utf8");
  expect(stored).not.toMatch(/private-raw-text|private-author|private-token/);
  expect(JSON.parse(stored)).toMatchObject({ expiresAt: "2026-10-16T04:00:00.000Z",
    candidates: [{ repository: "owner/skill-repo", reactions: 19, postCount: 1, skillVerified: false }] });
  expect((await stat(join(stateDir, "observations.json"))).mode & 0o777).toBe(0o600);
});

it("blocks a same-day restart even after an upstream failure", async () => {
  const request = vi.fn().mockRejectedValue(new Error("private-token"));
  expect(await runXCollector(options(), { request })).toMatchObject({ status: "stopped", reservedPosts: 10 });
  expect(await runXCollector(options(), { request })).toMatchObject({ status: "blocked", reason: "daily_limit", requests: 0 });
  expect(request).toHaveBeenCalledOnce();
  expect(await readFile(join(stateDir, "status.json"), "utf8")).not.toContain("private-token");
});

it("allows only one concurrent caller to reserve the UTC day", async () => {
  const request = vi.fn(async () => data());
  const results = await Promise.all([runXCollector(options(), { request }), runXCollector(options(), { request })]);
  expect(results.map(row => row.status).sort()).toEqual(["blocked", "completed"]);
  expect(request).toHaveBeenCalledOnce();
});

it("never resets a malformed existing receipt", async () => {
  await writeFile(join(stateDir, "budget-2026-10-15.json"), "incomplete");
  const request = vi.fn();
  expect(await runXCollector(options(), { request })).toMatchObject({ status: "blocked", reason: "daily_limit" });
  expect(request).not.toHaveBeenCalled();
  expect(await readFile(join(stateDir, "budget-2026-10-15.json"), "utf8")).toBe("incomplete");
});

it("a new UTC day permits one new reservation while preserving the old day", async () => {
  const request = vi.fn(async () => data());
  await runXCollector(options(), { request });
  await runXCollector({ ...options(), now: () => instant + 86400000 }, { request });
  expect(request).toHaveBeenCalledTimes(2);
  expect((await readdir(stateDir)).filter(file => file.startsWith("budget-")).sort())
    .toEqual(["budget-2026-10-15.json", "budget-2026-10-16.json"]);
});

it("deduplicates repositories and excludes ambiguous and unavailable contributions", async () => {
  const denied = { ...post("126"), withheld: { country_codes: ["US"] } };
  const request = vi.fn(async () => data([post(), post("124"), post("125", ["owner/a", "owner/b"]), denied]));
  expect(await runXCollector(options(), { request })).toMatchObject({ candidates: 1 });
  expect(JSON.parse(await readFile(join(stateDir, "observations.json"), "utf8")).candidates)
    .toEqual([expect.objectContaining({ repository: "owner/skill-repo", reactions: 38, postCount: 2 })]);
});

it("missing reaction metrics remain unknown rather than zero", async () => {
  const request = vi.fn(async () => data([{ ...post(), public_metrics: { like_count: 2 } }]));
  await runXCollector(options(), { request });
  expect(JSON.parse(await readFile(join(stateDir, "observations.json"), "utf8")).candidates[0].reactions).toBeNull();
});

it("a failed response invalidates the current candidate file rather than publishing partial results", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ data: [post()], errors: "bad" })));
  expect(await runXCollector(options(), { request })).toMatchObject({ status: "stopped", candidates: 0 });
  expect(JSON.parse(await readFile(join(stateDir, "observations.json"), "utf8")).candidates).toEqual([]);
});
