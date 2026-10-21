import "./projects.css";
import Link from "next/link";
import { ShareKit } from "@/components/me/ShareKit";
import { productReactionsEnabled } from "@/lib/domain/reactions/flags";
import { getTranslator } from "@/lib/i18n/dictionary";
import { formatDate, formatNumber, formatRelativeTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { ME_TAB_PATHS } from "@/lib/me/contract";
import { siteOrigin } from "@/lib/site";
import { findMyRepos, INBOX_PAGE, makerInbox, makerProjects, type InboxItem, type MakerProject } from "@/lib/me/maker";
import { FoundReposBox } from "./FoundReposBox";
import { IntroEditor } from "./IntroEditor";
import { ReplyBox } from "./ReplyBox";

type Translator = Awaited<ReturnType<typeof getTranslator<"me">>>;

/**
 * 내 프로젝트 탭 — 위에서부터 «더 확인할 저장소 → 내 프로젝트 → 받은 의견»(시안 3.6). view=inbox 면 받은 의견 전체를 50개씩 쪽으로(page).
 * 써봤어요를 끄면(PRODUCT_REACTIONS_ENABLED) 써본 사람 숫자·한 줄·«써본 사람 수» 배지를 그리지 않는다
 */
export async function ProjectsView({ userId, csrfToken, view, page = 1 }: { userId: number; csrfToken: string; view: "default" | "inbox"; page?: number }) {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "me");
  const now = new Date();
  const projectsHref = localePath(locale, ME_TAB_PATHS.projects);
  const reactions = productReactionsEnabled();

  if (view === "inbox") {
    const current = Number.isSafeInteger(page) && page > 1 ? Math.min(page, 2_000) : 1;
    const inbox = await makerInbox(userId, { limit: INBOX_PAGE, offset: (current - 1) * INBOX_PAGE });
    const pageHref = (target: number) => `${projectsHref}?view=inbox${target > 1 ? `&page=${target}` : ""}`;
    return (
      <section className="me-proj">
        <div className="me-proj-head">
          <h2 className="me-proj-h2">{t("projects.inbox.allTitle", { count: formatNumber(inbox.total, locale) })}</h2>
          <Link prefetch={false} className="me-proj-btn is-ghost" href={projectsHref}>{t("projects.inbox.back")}</Link>
        </div>
        <InboxList items={inbox.items} csrfToken={csrfToken} t={t} locale={locale} now={now} />
        {(current > 1 || current * INBOX_PAGE < inbox.total) && (
          <nav className="me-proj-acts" aria-label={t("projects.inbox.pages")}>
            {current > 1 && <Link prefetch={false} className="me-proj-btn is-ghost" href={pageHref(current - 1)}>{t("projects.inbox.newer")}</Link>}
            {current * INBOX_PAGE < inbox.total && <Link prefetch={false} className="me-proj-btn" href={pageHref(current + 1)}>{t("projects.inbox.older")}</Link>}
          </nav>
        )}
      </section>
    );
  }

  const [found, projects, inbox] = await Promise.all([findMyRepos(userId), makerProjects(userId), makerInbox(userId, { limit: 5, waitingFirst: true })]);
  const tried = projects.reduce((sum, project) => sum + project.tried, 0);
  return (
    <section className="me-proj">
      {projects.length > 0 && (
        <p className="me-proj-kpis">
          <span><b>{formatNumber(projects.length, locale)}</b>{t("projects.kpi.projects")}</span>
          <span><b>{formatNumber(inbox.waiting, locale)}</b>{t("projects.kpi.waiting")}</span>
          {reactions && <span><b>{formatNumber(tried, locale)}</b>{t("projects.kpi.tried")}</span>}
        </p>
      )}
      <FoundReposBox csrfToken={csrfToken} linked={found.linked} login={found.login} repos={found.repos} />
      {projects.length === 0 ? (
        <div className="me-proj-empty">
          <h2 className="me-proj-h2">{t("projects.empty.title")}</h2>
          <p>{t("projects.empty.body")}</p>
        </div>
      ) : (
        <>
          <h2 className="me-proj-h2">{t("projects.list.title")}</h2>
          <ul className="me-proj-list">
            {projects.map((project) => <ProjectCard key={project.productId} project={project} csrfToken={csrfToken} t={t} locale={locale} now={now} reactions={reactions} />)}
          </ul>
          <div className="me-proj-head">
            <h2 className="me-proj-h2">{t("projects.inbox.title", { count: formatNumber(inbox.waiting, locale) })}</h2>
            {inbox.total > inbox.items.length && (
              <Link prefetch={false} className="me-proj-btn is-ghost" href={`${projectsHref}?view=inbox`}>{t("projects.inbox.all", { count: formatNumber(inbox.total, locale) })}</Link>
            )}
          </div>
          <InboxList items={inbox.items} csrfToken={csrfToken} t={t} locale={locale} now={now} />
        </>
      )}
    </section>
  );
}

function ProjectCard({ project, csrfToken, t, locale, now, reactions }: { project: MakerProject; csrfToken: string; t: Translator; locale: Locale; now: Date; reactions: boolean }) {
  const metrics = [
    { label: t("projects.metric.stars"), value: project.stars },
    { label: t("projects.metric.visits"), value: project.visits7d },
    ...(reactions ? [{ label: t("projects.metric.tried"), value: project.tried }] : []),
    { label: t("projects.metric.feedback"), value: project.feedback },
  ];
  return (
    <li className="me-proj-card">
      <div className="me-proj-card-h">
        <span className="me-proj-icon" aria-hidden>{Array.from(project.name.trim())[0]?.toUpperCase() ?? "?"}</span>
        <div className="me-proj-box-x">
          <div className="me-proj-name-row">
            <Link prefetch={false} className="me-proj-name" href={localePath(locale, `/p/${encodeURIComponent(project.slug)}`)}>{project.name}</Link>
            <span className={`me-proj-chip is-${project.status}`}>{t(`projects.status.${project.status}`)}</span>
          </div>
          <span className="me-proj-sub">
            {t(`projects.role.${project.role}`)} · {t(`projects.method.${project.method}`)} · {t("projects.recheck", { date: formatDate(project.nextRecheckAt, now, locale) })}
          </span>
        </div>
      </div>
      <p className="me-proj-tagline">{project.tagline}</p>
      <dl className="me-proj-metrics">
        {metrics.map((metric) => (
          <div key={metric.label}><dt>{metric.label}</dt><dd>{formatNumber(metric.value, locale)}</dd></div>
        ))}
      </dl>
      <p className="me-proj-kpi-line">
        {reactions && <span>{t("projects.kpiLine", { good: formatNumber(project.good, locale), meh: formatNumber(project.meh, locale), bad: formatNumber(project.bad, locale) })}</span>}
        <span>{t("projects.saves", { count: formatNumber(project.saves, locale) })}</span>
        {project.waiting > 0 && <span className="is-hot">{t("projects.waiting", { count: formatNumber(project.waiting, locale) })}</span>}
      </p>
      <IntroEditor csrfToken={csrfToken} productId={project.productId} tagline={project.tagline} description={project.description}>
        <Link prefetch={false} className="me-proj-btn" href={localePath(locale, `/p/${encodeURIComponent(project.slug)}`)}>{t("projects.open")}</Link>
      </IntroEditor>
      {/* 배지·공유 카드는 공개 목록에 오른 제품만 내준다(lib/me/share.ts) — 검토 중·숨김·주인 없는 개인 프로필이면 404 라 그리지 않는다 */}
      {project.shareable && <ShareKit slug={project.slug} name={project.name} origin={siteOrigin()} version={String(Date.parse(project.updatedAt))} tried={reactions} />}
    </li>
  );
}

function InboxList({ items, csrfToken, t, locale, now }: { items: InboxItem[]; csrfToken: string; t: Translator; locale: Locale; now: Date }) {
  if (items.length === 0) return <p className="me-proj-hint">{t("projects.inbox.empty")}</p>;
  return (
    <ul className="me-proj-inbox">
      {items.map((item) => (
        <li key={`${item.targetType}:${item.targetId}`} className="me-proj-item">
          <p className="me-proj-item-h">
            <span className="me-proj-chip is-kind">{item.kind ? t(`projects.inbox.kind.${item.kind}`) : t("projects.inbox.kind.reaction")}</span>
            <span>{item.productName}</span>
            <span>· {item.authorName ?? (item.authorDeleted ? t("account.deletedName") : t("projects.inbox.visitor"))}</span>
            {item.triedVerified && <span>· {t("projects.inbox.tried")}</span>}
            {item.verdict && <span className={`me-proj-verdict is-${item.verdict}`}>{t(`projects.inbox.verdict.${item.verdict}`)}</span>}
            <time dateTime={item.createdAt}>· {formatRelativeTime(item.createdAt, now, locale)}</time>
          </p>
          {item.title && <p className="me-proj-item-title">{item.title}</p>}
          <p className="me-proj-quote">{item.body}</p>
          <ReplyBox csrfToken={csrfToken} targetType={item.targetType} targetId={item.targetId} reply={item.reply} notifiable={item.notifiable} />
        </li>
      ))}
    </ul>
  );
}
