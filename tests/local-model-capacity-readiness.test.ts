import { expect, it } from "vitest";
import { localModelCapacityReadiness } from "@/lib/llm/local-model-capacity-readiness";

it("누락된 legacy와 실제 물리 alias inventory를 전역 준비로 승격하지 않는다", () => {
  const report = localModelCapacityReadiness(null, {});
  expect(report).toMatchObject({ globalReady: false, localRoutes: [] });
  expect(report.blockers).toContain("gateway_physical_alias_inventory_unverified");
  expect(report.blockers).toContain("legacy_gateway_and_cli_contract_readback_unverified");
});
