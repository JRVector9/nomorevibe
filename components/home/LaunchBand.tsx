import Link from "next/link";

/** 등록 안내 — 한 줄 가로형. 명령 한 줄과 버튼 하나 */
export function LaunchBand() {
  return (
    <section className="launch-band" aria-labelledby="launch-title">
      <div>
        <h2 id="launch-title" className="launch-title">만들었다면, 이제 <em>보여줄</em> 차례.</h2>
        <p className="launch-note">긴 등록 폼 대신 프로젝트 폴더에서 한 줄. AI 기능이 없어도, AI로 만들었다면 괜찮습니다.</p>
      </div>
      <div className="launch-actions">
        <code className="launch-command">/nomorevibe launch</code>
        <Link className="primary" href="/launch">등록 흐름 보기</Link>
      </div>
    </section>
  );
}
