import Link from "next/link";
import { formatDate, formatDateTime, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import type { ProductTalk } from "@/lib/social/talk";
import { TalkSparkline } from "./TalkSparkline";
import { discussionUrl, SOURCE_NAME, sourceChip, sourceClass } from "./talk-format";
import "./talk.css";

/**
 * 상세 머리 바로 아래의 넓은 화제 띠(SNS 화제 C안) — 왜 지금 이야기되는지를 들어오자마자 보인다.
 * 자격 글(HN 30점 또는 댓글 15)이 있을 때만 그린다. 이슈·PR 글은 그 토론이라고 밝혀 함께 둔다.
 */
export function TalkBand({ talk, t, locale, now, preview }: {
  talk: ProductTalk;
  t: Translator<"detail">;
  locale: Locale;
  now: Date;
  preview: boolean;
}) {
  if (!talk.qualifies || !talk.posts.length) return null;
  const count = (n: number) => formatNumber(n, locale);
  const best = talk.posts[0];
  const firstPosted = new Date(Math.min(...talk.posts.map(post => post.postedAt.getTime())));
  const discussion = (target: string) => target === "issue" ? t("talk.issue") : target === "pull" ? t("talk.pull") : t("talk.discussion");
  return (
    <section className="talk-band" aria-labelledby="talk-band-title">
      <div style={{ minWidth: 0 }}>
        <p className="talk-band-kicker">
          {talk.rank ? t("talk.kickerRank", { rank: count(talk.rank) }) : t("talk.kicker")} · {t("talk.sources", { count: count(talk.sources.length) })}
          {preview && <> · {t("talk.preview")}</>}
        </p>
        <h2 id="talk-band-title">{best.source === "x"
          ? t("talk.xHeadline", { points: count(best.points), comments: count(best.comments) })
          : t("talk.headline", { source: SOURCE_NAME[best.source], points: count(best.points), comments: count(best.comments) })}</h2>
        <div className="talk-lines">
          {talk.posts.slice(0, 4).map(post => {
            // X 게시물은 본문·작성자를 옮기지 않는다 — 반응 수와 링크만
            const x = post.source === "x";
            return (
              <div key={post.id} className="talk-line">
                <span className={sourceClass(post.source)}><b>{sourceChip(post)}</b> {t(x ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}</span>
                {x ? <span className="talk-line-title">{t("talk.xPost")}</span> : <span className="talk-line-title" lang="en">{post.title}</span>}
                <span>{formatDate(post.postedAt, now, locale)}{x ? "" : ` · ${t(post.kind === "show" ? "talk.byMaker" : "talk.byOthers")}`}</span>
                <a className="talk-link" href={discussionUrl(post)} target="_blank" rel="noopener">{x ? t("talk.viewOnX") : discussion(post.linkTarget)} ↗</a>
              </div>
            );
          })}
        </div>
      </div>
      {talk.starGrowth ? (
        <div className="talk-band-chart">
          <span>{t(talk.starGrowth.basis === "mention" ? "talk.starsMention" : "talk.starsObservation")}</span>
          <b>{talk.starGrowth.delta >= 0 ? "+" : ""}{count(talk.starGrowth.delta)}</b>
          <TalkSparkline growth={talk.starGrowth} postedAt={firstPosted} label={`${count(talk.starGrowth.from)} → ${count(talk.starGrowth.to)}`} />
          <small>{formatDate(talk.starGrowth.fromAt, now, locale)} {count(talk.starGrowth.from)} → {formatDate(talk.starGrowth.toAt, now, locale)} {count(talk.starGrowth.to)}</small>
        </div>
      ) : <div />}
      <div className="talk-band-actions">
        <Link prefetch={false} href={localePath(locale, "/talk")}>{t("talk.viewAll")}</Link>
      </div>
      <p className="talk-band-note">
        {talk.checkedAt && <>{t("talk.checked", { time: formatDateTime(talk.checkedAt, now, locale) })} · </>}{t("talk.note")}
      </p>
    </section>
  );
}
