import "@/components/me/me.css";
import { MeTabs } from "@/components/me/MeTabs";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";

/** 마이페이지 틀 — 탭 줄 아래에 각 탭 화면(children). 탭마다 주소가 따로 있다(/me, /me/tried …) */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRequestLocale();
  const me = await getDictionary(locale, "me");
  return (
    <I18nProvider locale={locale} dictionaries={{ me }}>
      <main className="me-page">
        <h1 className="me-title">{me["page.title"]}</h1>
        <MeTabs />
        {children}
      </main>
    </I18nProvider>
  );
}
