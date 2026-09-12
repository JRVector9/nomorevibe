import { describe, expect, it } from "vitest";
import { combineVotes, combineVerdicts, inSample, riskSignals } from "@/lib/crawl/second-review";

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
  const sure = (decision: string) => ({ decision, confidence: 0.9, provider: "claude-cli" as const });

  it("대기 후보: 결론이 같고 둘 다 확신이 기준 이상이면 일치", () => {
    expect(combineVerdicts(sure("reject"), sure("reject"), 0.85, false)).toBe("agreed");
    expect(combineVerdicts(sure("approve"), sure("approve"), 0.85, false)).toBe("agreed");
  });

  it("결론이 다르거나 한쪽 확신이 모자라면 사람에게", () => {
    expect(combineVerdicts(sure("reject"), sure("approve"), 0.85, false)).toBe("needs_human");
    expect(combineVerdicts(sure("reject"), { decision: "reject", confidence: 0.7, provider: "claude-cli" as const }, 0.85, false)).toBe("needs_human");
    // 확신을 적지 않은 판단은 모자란 것으로 본다
    expect(combineVerdicts({ decision: "reject", confidence: null }, sure("reject"), 0.85, false)).toBe("needs_human");
  });

  it("둘 다 모르겠다는 일치가 아니다", () => {
    expect(combineVerdicts(sure("needs_review"), sure("needs_review"), 0.85, false)).toBe("needs_human");
  });

  it("공개된 제품: 2차도 제품이라 하면 그대로, 아니면 사람에게 — 자동으로 내리지 않는다", () => {
    expect(combineVerdicts({ decision: "approve", confidence: null }, { decision: "approve", confidence: 0.4, provider: "claude-cli" as const }, 0.85, true)).toBe("agreed");
    expect(combineVerdicts({ decision: "approve", confidence: null }, sure("reject"), 0.85, true)).toBe("needs_human");
    expect(combineVerdicts({ decision: "approve", confidence: null }, sure("needs_review"), 0.85, true)).toBe("needs_human");
  });
});

describe("combineVotes — 표 여럿을 합친다", () => {
  const vote = (decision: string, confidence: number | null, provider: "claude-cli" | "abcllm" = "abcllm") => ({ decision, confidence, provider });
  const first = { decision: "reject", confidence: 0.9 };

  it("엇갈림 없이 둘 이상이 같으면 일치 — 표 수를 함께 돌려준다", () => {
    expect(combineVotes(first, [vote("reject", 0.8)], { agreeAt: 0.85, published: false, pending: 0 }))
      .toEqual({ status: "agreed", decision: "reject", votes: 2 });
    expect(combineVotes(first, [vote("reject", 0.8), vote("reject", 1)], { agreeAt: 0.85, published: false, pending: 0 }))
      .toEqual({ status: "agreed", decision: "reject", votes: 3 });
  });

  it("한 표라도 엇갈리면 사람에게 — 다수결로 밀지 않는다", () => {
    expect(combineVotes(first, [vote("reject", 1), vote("approve", 1)], { agreeAt: 0.85, published: false, pending: 0 }))
      .toMatchObject({ status: "needs_human" });
  });

  it("사내 모델은 확신으로 거르지 않고, Claude 계열은 거른다", () => {
    // 게이트웨이 표는 확신이 낮아도 셈에 든다 — 확신이 신호가 아니었다
    expect(combineVotes(first, [vote("reject", 0.3)], { agreeAt: 0.85, published: false, pending: 0 }))
      .toMatchObject({ status: "agreed", votes: 2 });
    // CLI 표는 기준에 못 미치면 기권이다
    expect(combineVotes(first, [vote("reject", 0.3, "claude-cli")], { agreeAt: 0.85, published: false, pending: 0 }))
      .toMatchObject({ status: "needs_human", votes: 1 });
    // 1차의 확신이 모자라면 1차도 기권 — 사내 표 둘이 모여야 일치가 된다
    const weakFirst = { decision: "reject", confidence: 0.4 };
    expect(combineVotes(weakFirst, [vote("reject", 1)], { agreeAt: 0.85, published: false, pending: 0 })).toMatchObject({ status: "needs_human", votes: 1 });
    expect(combineVotes(weakFirst, [vote("reject", 1), vote("reject", 1)], { agreeAt: 0.85, published: false, pending: 0 })).toMatchObject({ status: "agreed", votes: 2 });
  });

  it("아직 볼 표가 남았으면 기다린다 — 모자란 채로 사람에게 넘기지 않는다", () => {
    expect(combineVotes(first, [], { agreeAt: 0.85, published: false, pending: 2 })).toMatchObject({ status: "pending" });
    expect(combineVotes(first, [], { agreeAt: 0.85, published: false, pending: 0 })).toMatchObject({ status: "needs_human" });
  });

  it("공개분은 한 표라도 제품이 아니거나 모르겠다고 하면 사람에게", () => {
    const published = { agreeAt: 0.85, published: true, pending: 0 };
    const first = { decision: "approve", confidence: null };
    expect(combineVotes(first, [vote("approve", 0.4), vote("approve", 1)], published)).toMatchObject({ status: "agreed" });
    expect(combineVotes(first, [vote("approve", 1), vote("reject", 1)], published)).toMatchObject({ status: "needs_human" });
    // 모르겠다는 표를 걸러내고 나머지만 보면 "그대로 두기"가 되어 버린다
    expect(combineVotes(first, [vote("approve", 1), vote("needs_review", 1)], published)).toMatchObject({ status: "needs_human" });
    expect(combineVotes(first, [], published)).toMatchObject({ status: "needs_human" });
  });
});
