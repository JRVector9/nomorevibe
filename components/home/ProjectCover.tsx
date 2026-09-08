const ARTS = ["paper", "day", "invoice", "form", "hue", "note"] as const;
export type CoverArt = (typeof ARTS)[number];

export function coverArtFor(slug: string): CoverArt {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash + slug.charCodeAt(index) * (index + 1)) % ARTS.length;
  }
  return ARTS[hash];
}

function WindowChrome() {
  return (
    <div className="window-top" aria-hidden="true">
      <i /><i /><i />
    </div>
  );
}

function CoverArt({ art }: { art: CoverArt }) {
  switch (art) {
    case "paper":
      return (
        <>
          <div className="mock-window">
            <WindowChrome />
            <div className="paper-inner">
              <div className="paper-rail"><span /><span /><span /></div>
              <div className="paper-doc">
                <b>A little less friction.</b>
                A simpler way to read your documents.
                <div className="fake-line purple" />
                <div className="fake-line" /><div className="fake-line" /><div className="fake-line short" />
                <div className="fake-line" /><div className="fake-line" /><div className="fake-line short" />
              </div>
            </div>
          </div>
          <div className="mini-toolbar">100% &nbsp; − &nbsp; + &nbsp; ↗</div>
        </>
      );
    case "day":
      return (
        <div className="mock-window">
          <WindowChrome />
          <div className="day-inner">
            <div className="day-top"><b>A good day, by design.</b><small>SEPTEMBER</small></div>
            <div className="cal-week">{[7, 8, 9, 10, 11, 12, 13].map((day, index) => (
              <span key={day} className={index === 2 ? "sel" : undefined}>{day}</span>
            ))}</div>
            <div className="cal-task"><i className="yes" />A small step forward</div>
            <div className="cal-task"><i />Make room for what matters</div>
            <div className="cal-task"><i />Take a moment for yourself</div>
          </div>
        </div>
      );
    case "invoice":
      return (
        <>
          <div className="invoice-doc">
            <b>INVOICE</b>
            <small>A SMALL BUSINESS. A BIG IDEA.</small>
            <br />
            <div className="invoice-row"><span>Design consultation</span><span>$240.00</span></div>
            <div className="invoice-row"><span>Project delivery</span><span>$160.00</span></div>
            <div className="invoice-total"><span>TOTAL</span><span>$400.00</span></div>
          </div>
          <div className="paid-stamp">PAID ✓</div>
        </>
      );
    case "form":
      return (
        <>
          <div className="form-window">
            <b>Let’s make something.</b>
            <p>A little introduction goes a long way.</p>
            <div className="form-field">Your name</div>
            <div className="form-field">Email address</div>
            <div className="form-field">Tell us about your idea</div>
            <div className="form-submit">Let’s go →</div>
          </div>
          <div className="form-plus">＋</div>
        </>
      );
    case "hue":
      return (
        <>
          <div className="hue-board">
            <div className="hue-head"><b>Soft landscapes.</b><span>COLLECTION 001</span></div>
            <div className="palette"><i /><i /><i /><i /><i /></div>
            <div className="palette-caption"><span>EARTH</span><span>GENTLE</span><span>ORGANIC</span></div>
          </div>
          <div className="hue-caption" />
        </>
      );
    case "note":
      return (
        <>
          <div className="note-window">
            <div className="note-top">Less listening. More doing.</div>
            <div className="wave">
              {[5, 9, 15, 20, 11, 25, 18, 8, 15, 25, 31, 18, 10, 19, 13, 8, 23, 17, 10, 5].map((height, index) => (
                <i key={index} style={{ height }} />
              ))}
            </div>
            <div className="note-summary">
              MEETING SUMMARY
              <br />✓ A clearer plan for your next big idea.
              <br />✓ Three next steps. Nothing left behind.
            </div>
          </div>
          <div className="note-pill">✦ Summary ready</div>
        </>
      );
  }
}

export function ProjectCover({
  name,
  ogImage,
  art,
}: {
  name: string;
  ogImage: string | null;
  art: CoverArt;
}) {
  const safeImage = ogImage?.startsWith("/") ? ogImage : null;
  if (safeImage) {
    return (
      <span className="project-cover cover-photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- 목록 커버는 크기를 미리 알 수 없는 동적 이미지 */}
        <img src={safeImage} alt="" />
        <span className="cover-brand">{name.toLowerCase()}</span>
      </span>
    );
  }

  return (
    <span className={`project-cover cover-${art}`}>
      <span className="cover-brand">{name.toLowerCase()}</span>
      <CoverArt art={art} />
    </span>
  );
}
