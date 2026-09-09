import { describe, expect, it } from "vitest";
import { healthIdentity } from "@/lib/operations/health";

describe("web health identity", () => {
  it("reports the replica and release without exposing configuration", () => {
    expect(healthIdentity({
      SERVICE_INSTANCE_ID: "mini-web",
      RELEASE_TAG: "release-123",
    })).toEqual({ instanceId: "mini-web", release: "release-123" });
  });

  it("uses the deployment ID and legacy instance when optional runtime values are absent", () => {
    expect(healthIdentity({ NEXT_DEPLOYMENT_ID: "release-456" })).toEqual({
      instanceId: "legacy",
      release: "release-456",
    });
  });
});
