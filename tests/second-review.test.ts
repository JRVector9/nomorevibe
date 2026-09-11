import { describe, expect, it } from "vitest";
import { combineVerdicts, inSample, riskSignals } from "@/lib/crawl/second-review";

const base = { name: "Taskly", productUrl: "https://taskly.app", textSample: "Plan your week", readme: null };

describe("riskSignals — 규칙은 통과했지만 한 번 더 볼 이유", () => {
  it("평범한 제품에는 신호가 없다", () => {
    expect(riskSignals(base)).toEqual([]);
  });

  it("스토어·메신저 주소는 제품일 수도 아닐 수도 있어 다시 본다", () => {
    expect(riskSignals({ ...base, productUrl: "https://testflight.apple.com/join/abc" })).toEqual(["store_or_messenger"]);
    expect(riskSignals({ ...base, productUrl: "https://t.me/some_bot" })).toEqual(["store_or_messenger"]);
    // 뒤쪽이 같을 뿐인 다른 호스트는 아니다
    expect(riskSignals({ ...base, productUrl: "https://nott.me" })).toEqual([]);
  });

  it("페이지 문장을 이름으로 가져온 것을 잡는다", () => {
    // 프로드 실측 — 본문 첫 문장이 이름이 됐다
    expect(riskSignals({ ...base, name: "ile başlıyordu: ne doctype, ne <head>, ne de bir stil dosyası vardı" })).toContain("sentence_name");
    expect(riskSignals({ ...base, name: "the quick way to plan all of your week" })).toContain("sentence_name");
  });

  it("검색 유입용 이름을 잡는다", () => {
    expect(riskSignals({ ...base, name: "Cursor 免费下载 指南" })).toContain("seo_name");
  });

  it("본문도 README 도 없으면 볼 것이 없다는 신호다", () => {
    expect(riskSignals({ ...base, textSample: " ", readme: null })).toEqual(["no_text"]);
    expect(riskSignals({ ...base, textSample: null, readme: "# Taskly" })).toEqual([]);
  });

  it("주소가 아니면 호스트 신호만 건너뛴다", () => {
    expect(riskSignals({ ...base, productUrl: "not a url" })).toEqual([]);
  });
});

describe("inSample — 레포 이름으로 정하는 표본", () => {
  it("같은 레포는 늘 같은 답이다 — 대소문자도 가리지 않는다", () => {
    const repos = Array.from({ length: 50 }, (_, i) => `acme/repo-${i}`);
    expect(repos.map((repo) => inSample(repo, 0.3))).toEqual(repos.map((repo) => inSample(repo.toUpperCase(), 0.3)));
  });

  it("비율 0은 아무것도, 1은 전부 뽑는다", () => {
    expect(inSample("acme/a", 0)).toBe(false);
    expect(inSample("acme/a", 1)).toBe(true);
  });

  it("비율만큼 뽑힌다", () => {
    const picked = Array.from({ length: 2_000 }, (_, i) => inSample(`owner/r${i}`, 0.05)).filter(Boolean).length;
    expect(picked).toBeGreaterThan(60);
    expect(picked).toBeLessThan(140);
  });
});

describe("combineVerdicts — 두 판단을 합친다", () => {
  const sure = (decision: string) => ({ decision, confidence: 0.9 });

  it("대기 후보: 결론이 같고 둘 다 확신이 기준 이상이면 일치", () => {
    expect(combineVerdicts(sure("reject"), sure("reject"), 0.85, false)).toBe("agreed");
    expect(combineVerdicts(sure("approve"), sure("approve"), 0.85, false)).toBe("agreed");
  });

  it("결론이 다르거나 한쪽 확신이 모자라면 사람에게", () => {
    expect(combineVerdicts(sure("reject"), sure("approve"), 0.85, false)).toBe("needs_human");
    expect(combineVerdicts(sure("reject"), { decision: "reject", confidence: 0.7 }, 0.85, false)).toBe("needs_human");
    // 확신을 적지 않은 판단은 모자란 것으로 본다
    expect(combineVerdicts({ decision: "reject", confidence: null }, sure("reject"), 0.85, false)).toBe("needs_human");
  });

  it("둘 다 모르겠다는 일치가 아니다", () => {
    expect(combineVerdicts(sure("needs_review"), sure("needs_review"), 0.85, false)).toBe("needs_human");
  });

  it("공개된 제품: 2차도 제품이라 하면 그대로, 아니면 사람에게 — 자동으로 내리지 않는다", () => {
    expect(combineVerdicts({ decision: "approve", confidence: null }, { decision: "approve", confidence: 0.4 }, 0.85, true)).toBe("agreed");
    expect(combineVerdicts({ decision: "approve", confidence: null }, sure("reject"), 0.85, true)).toBe("needs_human");
    expect(combineVerdicts({ decision: "approve", confidence: null }, sure("needs_review"), 0.85, true)).toBe("needs_human");
  });
});
