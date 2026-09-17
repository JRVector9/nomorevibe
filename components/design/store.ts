"use client";
import { useSyncExternalStore } from "react";
import { z } from "zod";
const feedbackSchema = z.object({
  id: z.string(),
  product: z.string(),
  author: z.string(),
  source: z.enum(["User", "Agent"]),
  task: z.string(),
  outcome: z.string(),
  body: z.string(),
  improve: z.string(),
  review: z.enum(["pending", "qualified", "revision"]),
  progress: z.string(),
  reward: z.boolean(),
  mine: z.boolean(),
  reply: z.string().default(""),
  reviewReason: z.string().optional(),
  evidenceName: z.string().optional(),
  evidenceVisibility: z.string().optional(),
  aiWriting: z.boolean().optional(),
});
const campaignSchema = z.object({
  id: z.string(),
  product: z.string(),
  count: z.number().int().min(1).max(10),
  cost: z.number().int().nonnegative(),
  task: z.string(),
  audience: z.string(),
  days: z.number(),
  status: z.enum(["open", "cancelled"]),
});
const schema = z.object({
  version: z.literal(1),
  saved: z.array(z.string()),
  sessions: z.array(z.string()),
  feedback: z.array(feedbackSchema),
  campaigns: z.array(campaignSchema),
  ledger: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      amount: z.number().int(),
      kind: z.enum(["grant", "reserve", "release", "reward"]),
    }),
  ),
  updates: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      body: z.string(),
      feedbackId: z.string(),
      retest: z.boolean(),
      releaseUrl: z.string().optional(),
    }),
  ),
  draft: z.record(z.string(), z.string()),
  claims: z.array(z.string()),
  readNotifications: z.boolean(),
});
export type Feedback = z.infer<typeof feedbackSchema>;
export type DemoState = z.infer<typeof schema>;
export const initialState: DemoState = {
  version: 1,
  saved: [],
  sessions: [],
  campaigns: [],
  ledger: [
    { id: "pilot", label: "미리보기용 파일럿 예산", amount: 45, kind: "grant" },
  ],
  updates: [],
  draft: {},
  claims: [],
  readNotifications: false,
  feedback: [
    {
      id: "f1",
      product: "frameit",
      author: "서연",
      source: "User",
      task: "모바일에서 이미지 저장하기",
      outcome: "일부 완료",
      body: "배경을 바꾸는 과정은 쉬웠어요. 다만 모바일에서 내보내기 버튼을 찾는 데 시간이 걸렸습니다.",
      improve: "이미지 아래에 내보내기 버튼이 보이면 좋겠어요.",
      review: "qualified",
      progress: "검토 중",
      reward: false,
      mine: false,
      reply: "",
    },
    {
      id: "f2",
      product: "frameit",
      author: "도윤",
      source: "User",
      task: "스크린샷 두 장으로 이미지 만들기",
      outcome: "완료",
      body: "여백을 조절하면서 결과를 바로 볼 수 있어 좋았어요. 가로 이미지를 위한 프리셋도 필요했습니다.",
      improve: "가로 비율 프리셋을 추가해주세요.",
      review: "qualified",
      progress: "수정 배포",
      reward: false,
      mine: false,
      reply: "가로형 프리셋을 추가했습니다. 업데이트에서 확인해주세요.",
    },
    {
      id: "f3",
      product: "frameit",
      author: "UI Check Agent",
      source: "Agent",
      task: "키보드로 내보내기 메뉴 탐색",
      outcome: "막힘",
      body: "Tab 키로 이동했을 때 내보내기 옵션에서 초점 표시가 보이지 않았습니다. 샘플 브라우저 실행 기록에 연결된 관찰입니다.",
      improve: "버튼의 focus-visible 상태를 추가해주세요.",
      review: "qualified",
      progress: "접수",
      reward: false,
      mine: false,
      reply: "",
    },
  ],
};
export type DemoAction =
  | { type: "save"; slug: string }
  | { type: "start"; slug: string }
  | { type: "submit"; feedback: Feedback }
  | {
      type: "review";
      id: string;
      decision: "qualified" | "revision";
      reason?: string;
    }
  | { type: "progress"; id: string; progress: string; reply?: string }
  | { type: "reserve"; campaign: DemoState["campaigns"][number] }
  | { type: "cancel"; id: string }
  | { type: "draft"; values: Record<string, string> }
  | { type: "claim"; slug: string }
  | { type: "update"; update: DemoState["updates"][number] }
  | { type: "read" };
export function balance(state: DemoState) {
  return state.ledger.reduce((n, e) => n + e.amount, 0);
}
export function reserved(state: DemoState) {
  return state.campaigns
    .filter((c) => c.status === "open")
    .reduce((n, c) => n + c.cost, 0);
}
export function reduceDemo(s: DemoState, a: DemoAction): DemoState {
  switch (a.type) {
    case "save":
      return {
        ...s,
        saved: s.saved.includes(a.slug)
          ? s.saved.filter((x) => x !== a.slug)
          : [...s.saved, a.slug],
      };
    case "start":
      return s.sessions.includes(a.slug)
        ? s
        : { ...s, sessions: [...s.sessions, a.slug] };
    case "draft":
      return { ...s, draft: { ...s.draft, ...a.values } };
    case "claim":
      return s.claims.includes(a.slug)
        ? s
        : { ...s, claims: [...s.claims, a.slug] };
    case "submit":
      return a.feedback.source !== "User" ||
        !s.sessions.includes(a.feedback.product) ||
        s.feedback.some((f) => f.mine && f.product === a.feedback.product)
        ? s
        : {
            ...s,
            feedback: [
              {
                ...a.feedback,
                source: "User",
                mine: true,
                review: "pending",
                reward: a.feedback.product !== "frameit" && a.feedback.reward,
              },
              ...s.feedback,
            ],
          };
    case "review": {
      const f = s.feedback.find((x) => x.id === a.id);
      if (!f || f.review === "qualified") return s;
      const eligible =
        a.decision === "qualified" &&
        f.mine &&
        f.reward &&
        f.source === "User" &&
        f.product !== "frameit" &&
        !s.ledger.some((e) => e.id === `reward-${f.id}`);
      return {
        ...s,
        feedback: s.feedback.map((x) =>
          x.id === a.id
            ? { ...x, review: a.decision, reviewReason: a.reason ?? "" }
            : x,
        ),
        ledger: eligible
          ? [
              ...s.ledger,
              {
                id: `reward-${f.id}`,
                label: `${f.product} 적격 미션 (미리보기)`,
                amount: 10,
                kind: "reward",
              },
            ]
          : s.ledger,
      };
    }
    case "progress":
      return {
        ...s,
        feedback: s.feedback.map((f) =>
          f.id === a.id
            ? { ...f, progress: a.progress, reply: a.reply ?? f.reply }
            : f,
        ),
      };
    case "reserve":
      return a.campaign.product !== "frameit" ||
        a.campaign.count < 1 ||
        a.campaign.count > 10 ||
        !Number.isInteger(a.campaign.count) ||
        a.campaign.cost !== a.campaign.count * 15 ||
        balance(s) < a.campaign.cost ||
        s.campaigns.some((c) => c.id === a.campaign.id)
        ? s
        : {
            ...s,
            campaigns: [a.campaign, ...s.campaigns],
            ledger: [
              ...s.ledger,
              {
                id: `reserve-${a.campaign.id}`,
                label: "FrameIt 피드백 요청 예약",
                amount: -a.campaign.cost,
                kind: "reserve",
              },
            ],
          };
    case "cancel": {
      const c = s.campaigns.find((x) => x.id === a.id);
      return !c || c.status !== "open"
        ? s
        : {
            ...s,
            campaigns: s.campaigns.map((x) =>
              x.id === a.id ? { ...x, status: "cancelled" } : x,
            ),
            ledger: [
              ...s.ledger,
              {
                id: `release-${c.id}`,
                label: "미매칭 요청 예약 해제",
                amount: c.cost,
                kind: "release",
              },
            ],
          };
    }
    case "update":
      return s.updates.some((u) => u.id === a.update.id)
        ? s
        : {
            ...s,
            updates: [a.update, ...s.updates],
            feedback: s.feedback.map((f) =>
              f.id === a.update.feedbackId
                ? { ...f, progress: "수정 배포" }
                : f,
            ),
            readNotifications: false,
          };
    case "read":
      return { ...s, readNotifications: true };
  }
}
const KEY = "nomorevibe-design-v1";
let cacheRaw: string | null = null;
let cache = initialState;
let memory: string | null = null;
let storageError = false;
function snapshot() {
  let raw: string | null;
  try {
    raw = storageError ? memory : (localStorage.getItem(KEY) ?? memory);
  } catch {
    raw = memory;
    storageError = true;
  }
  if (raw === cacheRaw) return cache;
  cacheRaw = raw;
  try {
    cache = raw ? schema.parse(JSON.parse(raw)) : initialState;
  } catch {
    cache = initialState;
  }
  return cache;
}
const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("storage", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}
export function dispatchDemo(action: DemoAction) {
  const next = reduceDemo(snapshot(), action);
  memory = JSON.stringify(next);
  try {
    localStorage.setItem(KEY, memory);
  } catch {
    storageError = true;
  }
  cacheRaw = memory;
  cache = next;
  listeners.forEach((fn) => fn());
}
export function resetDemo() {
  memory = null;
  cacheRaw = null;
  cache = initialState;
  try {
    localStorage.removeItem(KEY);
    storageError = false;
  } catch {
    storageError = true;
  }
  listeners.forEach((fn) => fn());
}
export function useDemo() {
  const state = useSyncExternalStore(subscribe, snapshot, () => initialState);
  return { state, dispatch: dispatchDemo, storageError };
}
