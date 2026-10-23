import { expect, it, vi } from "vitest";
import { JOB_CATALOG, JOB_ROLES, jobsForRole, lanesForRole } from "@/lib/jobs/catalog";
import { dbPoolConfig } from "@/lib/db/pool";
import { SERVICE_ROLES, serviceObservationKey } from "@/lib/operations/instance";
import { ROLE_LABELS } from "@/lib/operations/contracts";
import { parseWorkerArgs, jobRunOptions, runWorker } from "@/scripts/worker";
import { supervisorLimits } from "@/scripts/worker-supervisor";
import { workerIsHealthy } from "@/scripts/worker-healthcheck";

it("owns text jobs once, with an executable role, bounded pool and health identity", () => {
  expect(JOB_ROLES).toContain("text");
  expect(jobsForRole("publisher")).toEqual(["crawl-publish", "cdn-purge", "github-feedback-delivery"]);
  expect(jobsForRole("text")).toEqual(["reason-translate", "crawl-tagline", "product-search-profile", "product-search-verify", "product-embedding", "product-repo-review", "product-tagline-ko", "product-translate"]);
  expect(JOB_CATALOG.filter(job => ["reason-translate", "crawl-tagline", "product-search-profile", "product-search-verify", "product-embedding", "product-repo-review", "product-tagline-ko", "product-translate"].includes(job.name))).toHaveLength(8);
  expect(parseWorkerArgs(["--role=text"])).toMatchObject({ role: "text" });
  expect(dbPoolConfig({ WORKER_ROLE: "text" }).max).toBe(3);
  expect(supervisorLimits("text", {}).jobMs).toBe(180_000);
  expect(SERVICE_ROLES).toContain("text");
  expect(serviceObservationKey("text", { SERVICE_INSTANCE_ID: "local-text" })).toBe("service:text:local-text");
  expect(ROLE_LABELS.text).toBe("소개·사유 번역");
  expect(workerIsHealthy({ role: "text", status: "running", updatedAt: 1000, lastHeartbeatAt: 1000 }, 2000, "text")).toBe(true);
  expect(jobRunOptions("reason-translate", { requestedOnly: true }).budgetMs).toBe(55_000);
  expect(jobRunOptions("product-search-profile", { requestedOnly: true }).budgetMs).toBe(55_000);
  expect(jobRunOptions("product-embedding", { requestedOnly: true }).budgetMs).toBe(50_000);
  expect(jobRunOptions("product-repo-review", { requestedOnly: true }).budgetMs).toBe(55_000);
  expect(jobRunOptions("product-tagline-ko", { requestedOnly: true }).budgetMs).toBe(55_000);
  expect(jobRunOptions("crawl-tagline", { requestedOnly: true }).budgetMs).toBeUndefined();
});
it("publication starts while text is blocked, and text jobs remain serial", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const run = vi.fn(async (name: string) => {
    order.push(name);
    if (name === "reason-translate") await blocked;
    return { status: "completed" };
  });
  const dependencies = { pending: async () => ["reason-translate", "crawl-tagline", "crawl-publish"], seen: async () => {}, run };
  const text = runWorker({ role: "text", once: true }, { ...dependencies, names: jobsForRole("text") });
  await vi.waitFor(() => expect(order).toContain("reason-translate"));
  await runWorker({ role: "publisher", once: true }, { ...dependencies, names: jobsForRole("publisher") });
  expect(order).toEqual(["reason-translate", "crawl-publish"]);
  release(); await text;
  expect(order).toEqual(["reason-translate", "crawl-publish", "crawl-tagline"]);
});

it("Korean translation starts once while both the main and multilingual text lanes are blocked", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ran: string[] = [];
  const names = jobsForRole("text"), lanes = lanesForRole("text");
  const worker = runWorker({ role: "text", once: true }, {
    names, lanes, seen: async () => {}, pending: async () => ["reason-translate", "product-tagline-ko", "product-translate"],
    run: async name => { ran.push(name); if (name !== "product-tagline-ko") await blocked; return { status: "completed" }; },
  });
  try {
    await vi.waitFor(() => expect(ran).toContain("product-tagline-ko"));
    expect(ran).toContain("reason-translate"); expect(ran).toContain("product-translate");
    expect(ran.filter(name => name === "product-tagline-ko")).toHaveLength(1);
    expect(lanes.flat().filter(name => name === "product-tagline-ko")).toHaveLength(1);
  } finally { release(); await worker; }
});

it("product translation runs while the main text lane is blocked, and releases neither lane's other work", async () => {
  let releaseProfile!: () => void, releaseTranslation!: () => void;
  const profile = new Promise<void>(resolve => { releaseProfile = resolve; });
  const translation = new Promise<void>(resolve => { releaseTranslation = resolve; });
  const ran: string[] = [];
  const worker = runWorker({ role: "text", once: true }, {
    names: jobsForRole("text"), lanes: lanesForRole("text"), seen: async () => {},
    pending: async () => ["product-search-profile", "product-search-verify", "product-translate"],
    run: async name => {
      ran.push(name);
      if (name === "product-search-profile") await profile;
      if (name === "product-translate") await translation;
      return { status: "completed" };
    },
  });
  try {
    await vi.waitFor(() => expect(ran).toContain("product-translate"));
    expect(ran).toContain("product-search-profile");
    expect(ran).not.toContain("product-search-verify");
    releaseProfile();
    await vi.waitFor(() => expect(ran).toContain("product-search-verify"));
    expect(ran.filter(name => name === "product-translate")).toHaveLength(1);
  } finally {
    releaseProfile(); releaseTranslation(); await worker;
  }
});
