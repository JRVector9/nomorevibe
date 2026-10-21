import "@/components/me/opinions.css";
import { MeLoginRequired } from "@/components/me/MeLoginRequired";
import { OpinionList } from "@/components/me/OpinionList";
import { opinionDetailMessages } from "@/components/me/opinion-messages";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import { meMetadata } from "@/lib/me/metadata";
import { listMyOpinions } from "@/lib/me/opinions";
import { getMeSession } from "@/lib/me/session";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("opinions");

/** 의견 탭(시안 3.3) — 로그인하고 쓴 긴 글의 공개·검토 중·숨김 상태, 메이커 답장, GitHub 이슈 전달. 종류·전달 문구는 상세(detail)와 같다 */
export default async function MeOpinionsPage() {
  const [locale, session] = await Promise.all([getRequestLocale(), getMeSession()]);
  if (!session) return <MeLoginRequired tab="opinions" />;
  const [detail, opinions] = await Promise.all([getDictionary(locale, "detail"), listMyOpinions(session.user.id)]);
  // 상세 사전은 탭이 쓰는 몫만 싣고, '지금'은 이 탭을 그린 때(틀은 탭을 옮겨도 다시 그리지 않는다)
  return <I18nProvider locale={locale} dictionaries={{ detail: opinionDetailMessages(detail) }} now={new Date().toISOString()}><OpinionList opinions={opinions} /></I18nProvider>;
}
