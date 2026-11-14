"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { SaveButtonMarkup } from "./markup";

/**
 * 서버가 그린 카드의 저장(북마크) 단추 — 카드에서 브라우저로 넘어가는 값은 slug·이름(단추 이름)뿐이다.
 * 저장소는 홈 목록과 같은 localStorage(useSavedSlugs)라 다른 탭에서 바꿔도 따라온다.
 */
export function SaveToggle({ slug, name }: { slug: string; name: string }) {
  const t = useTranslations("labels");
  const [saved, toggle] = useSavedSlugs();
  return <SaveButtonMarkup slug={slug} name={name} saved={saved.has(slug)} onClick={() => toggle(slug)} t={t} />;
}
