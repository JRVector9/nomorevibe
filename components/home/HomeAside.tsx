import Link from "next/link";
import { Icon } from "@/components/home/icons";
import { HOME_NEWS } from "@/components/home/news";

export function HomeAside() {
  return (
    <aside className="aside">
      <section id="briefing" className="aside-card" aria-labelledby="briefing-title">
        <div className="aside-title">
          <h2 id="briefing-title">빌더를 위한 AI 소식</h2>
          <span className="source-pill">공식 출처</span>
        </div>
        <p className="aside-sub">만드는 사람에게 필요한 변화만 모았습니다.</p>
        <div>
          {HOME_NEWS.map((item) => (
            <a
              key={item.url}
              className="news-item"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <div className="news-type">
                <span className={`mini-source ${item.tone}`}>{item.letter}</span>
                {item.source}
                <span>·</span>
                {item.type}
              </div>
              <h3>{item.title}</h3>
              <div className="news-meta">
                <span>{item.date} 게시</span>
                <span>원문 <Icon name="arrow-up-right" size={10} /></span>
              </div>
            </a>
          ))}
        </div>
        <div className="brief-bottom">
          선정 기사 예시 · 실시간 피드 아님
          <br />
          기사 게시일을 표시하며, 제목을 누르면 원문으로 이동합니다.
        </div>
      </section>

      <section className="build-panel">
        <div className="eyebrow">LESS FRICTION. MORE SHIPPING.</div>
        <h2>만들었다면,<br />이제 보여줄 차례.</h2>
        <p>긴 등록 폼 대신, 프로젝트 맥락으로.<br />소개를 생성하고 확인한 뒤 공개하세요.</p>
        <Link className="build-command" href="/launch">
          <code>/nomorevibe launch</code>
          <Icon name="arrow-up-right" size={15} />
        </Link>
        <Link className="build-link" href="/launch">
          등록 흐름 보기 <Icon name="arrow-right" size={12} />
        </Link>
      </section>

      <section className="community-preview">
        <h3>메이커의 다음 한 걸음</h3>
        <p>완성된 프로젝트뿐 아니라, 공개 후의 변화도 남겨보세요. 업데이트는 출시 건수와 별도로 집계합니다.</p>
      </section>
    </aside>
  );
}
