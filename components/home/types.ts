import type { StarObservation } from '@/lib/domain/products/star-change';
import type { TaglineSource } from "@/lib/db/schema";
import type { ProductActivity } from "@/lib/domain/products/activity";
import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
export type HomePulseView = {
  asOf: string;
  asOfLabel: string;
  methodVersion: string;
  born: { current: number; previous: number; change: number | null };
  updates: { projects: number; releases: number };
  /** 이번 주 가장 활발한 프로젝트 수 — 목록(제품 값)은 서버가 그린 구획(ActiveList)에만 있다 */
  activeCount: number;
  categories: { key: string; total: number; born: number }[];
  tools: { scanned: number; withTool: number; rows: { label: string; count: number }[] } | null;
};

export type HomeCardProduct = StarObservation & {
  id?: number;
  translationName?: string;
  translation?: ProductTranslationSelection;
  starGrowth?: StarGrowthItem["starGrowth"];
  slug: string;
  name: string;
  tagline: string;
  /** 한국어 한 줄 소개(UX-13) — ProductTagline 이 먼저 보인다 */
  taglineKo?: string | null;
  taglineSource?: TaglineSource;
  activity?: ProductActivity;
  category: string;
  accessMode?: "website" | "installable";
  /** AI 제작 근거 단계 — 있으면 커버에 'AI' 배지(ProjectTile) */
  aiLevel?: number | null;
  builder: string | null;
  builderClaim: "reported" | "guessed";
  ogImage: string | null;
  makerName: string | null;
  repoUrl: string | null;
  /** GitHub 이 돌려준 지금 owner/name — 운영 주체 표기(listedRepositoryOwner) */
  repoRenamedTo?: string | null;
  unclaimed: boolean;
  health?: { down: boolean };
  metrics?: { clicks: number };
  validClicks?: number;
};
