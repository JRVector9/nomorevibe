"use client";

import { useTranslations } from "@/lib/i18n/context";
import { TileView } from "@/components/cards/views";

/**
 * 카드 커버(components/cards/views.tsx TileView) — 브라우저 부품용. 서버 부품은 TileView 를 바로 쓴다.
 * 커버 규칙(토큰 바탕·README 그림)은 cards.css 에 있고 이 커버를 쓰는 카드가 가져온다.
 */
export function ProjectTile(props: {
  slug: string;
  name: string;
  ogImage: string | null;
  size: 64 | 44;
  installable?: boolean;
  ai?: boolean;
  category?: string;
  priority?: boolean;
}) {
  return <TileView {...props} t={useTranslations("labels")} />;
}
