"use client";

import { useEffect, useState } from "react";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { reviveTalk, type ProductTalkResponse } from "@/lib/social/talk-wire";
import { TalkBand } from "./TalkBand";

/**
 * 상세 화제 띠 자리(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에는 싣지 않고 브라우저가 /api/products/[slug]/talk 로 받아 그린다.
 * 화제 글이 있는 제품은 드물어, 받는 동안 자리를 잡아 두면 대부분의 상세에서 빈 자리가 접힌다 — 받기 전과 못 받았을 때는 그리지 않는다.
 * 사전은 상세의 detail 사전(DetailMessages), 시각은 서버가 그린 시각(useServerNow)을 쓴다.
 */
const loads = new Map<string, Promise<ProductTalkResponse | null>>();
/** 받아 둔 응답 — 같은 상세를 다시 열면(앱 안 이동) 바로 그린다 */
const loaded = new Map<string, ProductTalkResponse>();

export function loadProductTalk(slug: string): Promise<ProductTalkResponse | null> {
  let load = loads.get(slug);
  if (!load) {
    load = fetch(`/api/products/${encodeURIComponent(slug)}/talk`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? JSON.parse(await response.text(), reviveTalk) as ProductTalkResponse : null)
      .catch(() => null)
      .then((data) => {
        if (data) loaded.set(slug, data); else loads.delete(slug);
        return data;
      });
    loads.set(slug, load);
  }
  return load;
}

export function TalkBandSlot({ slug }: { slug: string }) {
  const locale = useLocale();
  const now = useServerNow();
  const t = useTranslations("detail");
  const [state, setState] = useState<{ slug: string; data: ProductTalkResponse | null }>(() => ({ slug, data: loaded.get(slug) ?? null }));
  useEffect(() => {
    let alive = true;
    loadProductTalk(slug).then((data) => { if (alive) setState({ slug, data }); });
    return () => { alive = false; };
  }, [slug]);
  const data = state.slug === slug ? state.data : loaded.get(slug) ?? null;
  if (!data?.talk) return null;
  return <TalkBand talk={data.talk} t={t} locale={locale} now={now} preview={data.preview} />;
}
