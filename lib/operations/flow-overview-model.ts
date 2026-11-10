import type { Conveyor } from "./conveyor-model";
import type { OperatorDesk } from "./operator-desk-model";
import type { SocialSource } from "@/lib/db/social-schema";

export type PublicationPoint = { hour: string; count: number };
export type ProjectFlowOverview = {
  measuredAt: string;
  registered: number;
  listed: number;
  unverified: number;
  banned: number;
  published1h: number;
  published24h: number;
  previous24h: number;
  hours: PublicationPoint[];
};

/** A zero comparison has no meaningful percentage; retain the actual difference. */
export function publicationChange(current: number, previous: number): { delta: number; percent: number | null } {
  return { delta: current - previous, percent: previous > 0 ? (current - previous) / previous * 100 : null };
}

export function flowOverviewRequests(desk: Pick<OperatorDesk, "decisions"> | null, reactions: number | null): number | null {
  if (!desk?.decisions || reactions === null) return null;
  const keys = ["takedown", "introRequest", "feedback", "makerReply", "contact"];
  const counts = keys.map(key => desk.decisions!.sections.find(section => section.key === key)?.count
    ?? (desk.decisions!.clear.some(section => section.key === key) ? 0 : null));
  return counts.some(count => count === null) ? null : counts.reduce<number>((sum, count) => sum + count!, reactions);
}

export type FlowOverviewContext = {
  data: Conveyor;
  desk: OperatorDesk | null;
  reactionRequests: number | null;
};

export type SocialCollector = {
  source: SocialSource;
  label: string;
  status: string;
  tone: "green" | "amber" | "red" | "gray";
  lastSuccessAt: string | null;
  lastSeenAt: string | null;
  stored: number;
  new24h: number;
  note: string;
  href: string;
  /** 수집기 상태를 자세히 보는 곳(작업 상세·X 보고). 자동 잡이 없으면 null */
  statusHref: string | null;
};
/** 콘텐츠 운영 SNS 탭의 수집기 줄 — 운영 홈 SNS 칸과 같은 판정 */
export type SocialCollectorStatus = { measuredAt: string; collectors: SocialCollector[] };
export type SocialFlowOverview = {
  measuredAt: string;
  stored: number;
  new24h: number;
  linked: number;
  qualifiedProjects: number;
  talkProjects: number;
  homeWaiting: number;
  homeProjects: number;
  publicEnabled: boolean;
  collectors: SocialCollector[];
};
