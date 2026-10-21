import { I18nProvider } from "@/lib/i18n/context";
import { getRequestLocale } from "@/lib/i18n/server";

/**
 * 탭 화면의 '지금'(useServerNow) — 틀(layout)과 그 위는 탭을 옮겨도 다시 그리지 않아, 거기 적힌 시각은 처음 연 때에 머문다.
 * 탭 화면(page)을 이것으로 감싸면 "5분 전"·오늘/어제 묶음·다음 변경일이 그 탭을 그린 때를 기준으로 한다(상세 p/[slug] 와 같다)
 */
export async function MeNow({ children }: { children: React.ReactNode }) {
  return <I18nProvider locale={await getRequestLocale()} dictionaries={{}} now={new Date().toISOString()}>{children}</I18nProvider>;
}
