import { describe, it, expect } from "vitest";
import {
  initialState,
  reduceDemo,
  balance,
  reserved,
  type Feedback,
} from "../../components/design/store";
const feedback: Feedback = {
  id: "f-test",
  product: "notegen",
  author: "나",
  source: "User",
  task: "PDF 내보내기",
  outcome: "막힘",
  body: "버튼을 눌렀지만 다운로드가 시작되지 않았습니다.",
  improve: "오류 안내",
  review: "pending",
  progress: "접수",
  reward: true,
  mine: true,
  reply: "",
};
describe("design-only state transitions", () => {
  it("requires a test session and prevents repeated product submissions", () => {
    expect(reduceDemo(initialState, { type: "submit", feedback })).toBe(
      initialState,
    );
    const s = reduceDemo(initialState, { type: "start", slug: "notegen" });
    expect(
      reduceDemo(s, {
        type: "submit",
        feedback: { ...feedback, source: "Agent" },
      }),
    ).toBe(s);
    const submitted = reduceDemo(s, { type: "submit", feedback });
    expect(submitted.feedback[0].review).toBe("pending");
    expect(balance(submitted)).toBe(45);
    expect(
      reduceDemo(submitted, {
        type: "submit",
        feedback: { ...feedback, id: "f-repeat" },
      }),
    ).toBe(submitted);
  });
  it("awards a qualified blocked experience once, never on revision request", () => {
    let s = reduceDemo(initialState, { type: "start", slug: "notegen" });
    s = reduceDemo(s, { type: "submit", feedback });
    s = reduceDemo(s, {
      type: "review",
      id: feedback.id,
      decision: "revision",
    });
    expect(balance(s)).toBe(45);
    s = reduceDemo(s, {
      type: "review",
      id: feedback.id,
      decision: "qualified",
    });
    expect(balance(s)).toBe(55);
    expect(
      reduceDemo(s, { type: "review", id: feedback.id, decision: "qualified" }),
    ).toBe(s);
  });
  it("cannot reward owner or Agent feedback", () => {
    for (const f of [
      { ...feedback, product: "frameit" },
      { ...feedback, source: "Agent" as const },
    ]) {
      const s = { ...initialState, feedback: [f] };
      expect(
        balance(
          reduceDemo(s, { type: "review", id: f.id, decision: "qualified" }),
        ),
      ).toBe(45);
    }
  });
  it("reserves within balance, rejects duplicate/invalid requests, releases once", () => {
    const campaign = {
      id: "c1",
      product: "frameit",
      count: 3,
      cost: 45,
      task: "사용성",
      audience: "디자이너",
      days: 7,
      status: "open" as const,
    };
    const s = reduceDemo(initialState, { type: "reserve", campaign });
    expect(balance(s)).toBe(0);
    expect(reserved(s)).toBe(45);
    expect(reduceDemo(s, { type: "reserve", campaign })).toBe(s);
    expect(
      reduceDemo(s, { type: "reserve", campaign: { ...campaign, id: "c2" } }),
    ).toBe(s);
    for (const invalid of [
      { count: -1, cost: -15 },
      { count: 1, cost: 0 },
      { count: 1.5, cost: 22.5 },
      { count: 11, cost: 165 },
    ])
      expect(
        reduceDemo(initialState, {
          type: "reserve",
          campaign: { ...campaign, ...invalid },
        }),
      ).toBe(initialState);
    const released = reduceDemo(s, { type: "cancel", id: "c1" });
    expect(balance(released)).toBe(45);
    expect(reserved(released)).toBe(0);
    expect(reduceDemo(released, { type: "cancel", id: "c1" })).toBe(released);
  });
  it("a shipped update never implies reconfirmed", () => {
    const s = reduceDemo(initialState, {
      type: "update",
      update: {
        id: "u1",
        version: "v1.2",
        body: "버튼 개선",
        feedbackId: "f1",
        retest: true,
      },
    });
    expect(s.feedback.find((f) => f.id === "f1")?.progress).toBe("수정 배포");
    expect(s.updates[0].retest).toBe(true);
  });
});
