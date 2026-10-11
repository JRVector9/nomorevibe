import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";

const dependencies = vi.hoisted(() => ({ claim: vi.fn(), expire: vi.fn(), deliver: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/domain/feedback/github/outbox", () => ({ claimFeedbackOutbox: dependencies.claim, expireFeedbackDispatches: dependencies.expire }));
vi.mock("@/lib/domain/feedback/github/deliver", () => ({ deliverFeedbackIssue: dependencies.deliver }));
vi.mock("@/lib/domain/github-integration/flags", () => ({ githubFeedbackDeliveryEnabled: dependencies.enabled }));
import { deliverGithubFeedback } from "@/lib/jobs/github/feedback-delivery";

const context = (): JobContext<null> => ({ cursor: null, save: vi.fn(), hasBudget: () => true, log: vi.fn(),
  lease: { name: "github-feedback-delivery", token: "job-token", requestedVersion: 1 } });
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.enabled.mockReturnValue(true);
  dependencies.expire.mockResolvedValue(0);
  dependencies.claim.mockResolvedValue({ id: "row" });
  dependencies.deliver.mockResolvedValue("delivered");
});
afterEach(() => vi.useRealTimers());

describe("bounded feedback publisher tick", () => {
  it("dispatches at most five rows sequentially under the caller job lease", async () => {
    const ctx = context();
    let active = 0, maximum = 0;
    dependencies.deliver.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active -= 1;
      return "delivered";
    });
    expect(await deliverGithubFeedback(ctx)).toEqual({ done: true, cursor: null });
    expect(dependencies.claim).toHaveBeenCalledTimes(5);
    expect(dependencies.deliver).toHaveBeenCalledTimes(5);
    expect(maximum).toBe(1);
    const deadlineAt = dependencies.deliver.mock.calls[0][1].deadlineAt;
    expect(dependencies.claim).toHaveBeenCalledWith(ctx.lease, deadlineAt);
    expect(dependencies.expire).toHaveBeenCalledWith(ctx.lease, deadlineAt);
    expect(dependencies.deliver).toHaveBeenCalledWith({ id: "row" }, expect.objectContaining({ lease: ctx.lease }));
  });

  it("stops claiming after its twenty-second budget even if the outer runner still has time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    dependencies.deliver.mockImplementation(async () => { vi.setSystemTime(120_001); return "uncertain"; });
    await deliverGithubFeedback(context());
    expect(dependencies.claim).toHaveBeenCalledTimes(1);
    expect(dependencies.deliver.mock.calls[0][1].deadlineAt).toBe(120_000);
  });

  it("still expires in-flight leases while disabled and starts no new writes", async () => {
    dependencies.enabled.mockReturnValue(false);
    const ctx = context();
    await deliverGithubFeedback(ctx);
    expect(dependencies.expire).toHaveBeenCalledWith(ctx.lease, expect.any(Number));
    expect(dependencies.claim).not.toHaveBeenCalled();
    expect(dependencies.deliver).not.toHaveBeenCalled();
  });

  it("respects shutdown and outer budget before claiming", async () => {
    const controller = new AbortController();
    controller.abort();
    await deliverGithubFeedback({ ...context(), signal: controller.signal });
    await deliverGithubFeedback({ ...context(), hasBudget: () => false });
    expect(dependencies.claim).not.toHaveBeenCalled();
  });
});
