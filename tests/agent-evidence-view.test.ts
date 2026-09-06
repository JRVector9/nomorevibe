import { expect, it } from "vitest";
import { presentObservedAgentFacts } from "@/lib/domain/evidence/agents/view";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
const observation: AgentObservation = {kind:"instruction_file",client:null,compatibleClients:["claude-code"],modelDeveloper:null,declaredModelId:null,gateway:null,routing:"unknown",role:null,scope:"",keyPath:null,ruleId:"claude.instructions.v1",sourcePath:"CLAUDE.md",commitSha:"a".repeat(40),blobSha:"b".repeat(40),sourceUrl:`https://github.com/acme/app/blob/${"a".repeat(40)}/CLAUDE.md`};
it("keeps compatible instructions and unknown models separate from execution", () => {
 const [view] = presentObservedAgentFacts({ observations:[observation], scanState:"complete", observedAt:new Date("2026-09-06"), relationship:"unknown" });
 expect(view.label).toBe("Claude 호환 지침 파일 확인");
 expect(view.modelLabel).toBe("미확인");
 expect(view.executionVerified).toBe(false);
 expect(view.relationshipLabel).toBe("제품과 저장소 관계 미확인");
});
it("preserves configured model, client, gateway, partial coverage and immutable citations", () => {
 const [view] = presentObservedAgentFacts({ observations:[{...observation,kind:"model_config",client:"claude-code",declaredModelId:"glm-4.7",gateway:"z-ai",routing:"fixed"}], scanState:"partial", observedAt:new Date("2026-09-06"), relationship:"same_product" });
 expect(view).toMatchObject({ clientLabel:"Claude Code",modelLabel:"glm-4.7",gatewayLabel:"Z.AI",coverageLabel:"일부 미확인",sourceUrl:observation.sourceUrl });
});
it("does not resolve automatic router settings to an execution model", () => {
 const [view] = presentObservedAgentFacts({ observations:[{...observation,kind:"model_config",client:"opencode",declaredModelId:"openrouter/auto",gateway:"openrouter",routing:"auto"}], scanState:"complete", observedAt:new Date("2026-09-06"), relationship:"same_product" });
 expect(view.label).toBe("자동 모델 선택 설정");
 expect(view.executionVerified).toBe(false);
});

it.each([
 ["kimi", "moonshot-direct", "Kimi Code", "Moonshot"],
 ["grok-build", "x-ai-direct", "Grok Build", "xAI"],
 ["roo-code", "anthropic-direct", "Roo Code", "Anthropic"],
 ["factory-droid", "openai-direct", "Factory Droid", "OpenAI"],
 ["github-copilot", "kimi-direct", "GitHub Copilot", "Kimi"],
])("uses public names for detector identifiers %s / %s", (client, gateway, clientLabel, gatewayLabel) => {
 const [view] = presentObservedAgentFacts({ observations:[{...observation,client,gateway}], scanState:"complete", observedAt:new Date("2026-09-06"), relationship:"same_product" });
 expect(view).toMatchObject({clientLabel,gatewayLabel});
});
it("marks an old complete scan independently of repository metadata freshness", () => {
 const [view] = presentObservedAgentFacts({ observations:[observation], scanState:"complete", observedAt:new Date("2026-09-01"), now:new Date("2026-09-06"), relationship:"same_product" });
 expect(view.coverageLabel).toBe("에이전트 정보 재확인 필요");
});
it("preserves a completed scan but labels a later failed attempt", () => {
 const [view] = presentObservedAgentFacts({ observations:[observation], scanState:"complete", observedAt:new Date("2026-09-06"), now:new Date("2026-09-06"), scanLastError:"timeout", relationship:"same_product" });
 expect(view.coverageLabel).toBe("최근 수집 실패 · 이전 확인 정보");
 expect(view.sourceUrl).toBe(observation.sourceUrl);
});
