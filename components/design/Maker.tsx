"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { href, productBySlug } from "./data";
import { useDemo, balance, reserved } from "./store";
import {
  Badge,
  ButtonLink,
  Empty,
  Field,
  Icon,
  Logo,
  Notice,
  PageHeading,
  Panel,
  Tabs,
} from "./ui";
export function Dashboard() {
  const { state, dispatch } = useDemo();
  const [filter, setFilter] = useState("답변 필요");
  const [selected, setSelected] = useState("f1");
  const [reply, setReply] = useState("");
  const [notice, setNotice] = useState("");
  const productFeedback = state.feedback.filter((f) => f.product === "frameit");
  const rows = productFeedback.filter((f) =>
    filter === "User Feedback"
      ? f.source === "User"
      : filter === "Agent Feedback"
        ? f.source === "Agent"
        : filter === "재확인 대기"
          ? f.progress === "수정 배포"
          : filter === "답변 필요"
            ? !f.reply
            : true,
  );
  const f = rows.find((f) => f.id === selected) ?? rows[0];
  return (
    <>
      <PageHeading
        title="Builder Dashboard"
        description="작은 피드백을 읽고, 다음 개선을 시작하세요."
        action={
          <ButtonLink to="dashboard/products/frameit/updates/new">
            <Icon name="plus" size={16} /> 업데이트 작성
          </ButtonLink>
        }
      />
      <nav className="d-workspace-nav" aria-label="빌더 메뉴">
        <Link className="active" href={href("dashboard")}>
          피드백 작업함
        </Link>
        <Link href={href("sprints/demo")}>미션·캠페인</Link>
        <Link href={href("dashboard/agent-runs")}>Agent Runs</Link>
        <Link href={href("credits")}>크레딧</Link>
        <Link href={href("settings/billing")}>청구</Link>
      </nav>
      {state.draft.submitted === "yes" && (
        <Notice>
          초안 ‘{state.draft.name}’이 저장되어 있습니다. 관리 권한 확인 전이며
          공개되지 않았습니다. <Link href={href("launch")}>편집하기 →</Link>
        </Notice>
      )}
      <div className="d-dashboard-summary">
        <div>
          <Logo product={productBySlug("frameit")!} />
          <div>
            <strong>FrameIt</strong>
            <p>내 제품 · 관리 권한 확인</p>
          </div>
        </div>
        <div className="d-inline-stats">
          <span>
            <strong>
              {productFeedback.filter((f) => f.source === "User").length}
            </strong>{" "}
            User Feedback
          </span>
          <span>
            <strong>
              {productFeedback.filter((f) => f.source === "Agent").length}
            </strong>{" "}
            Agent Feedback
          </span>
          <Link href={href("sprints/new")}>
            피드백 요청 <Icon size={15} />
          </Link>
        </div>
      </div>
      <Tabs
        items={[
          "답변 필요",
          "전체",
          "User Feedback",
          "Agent Feedback",
          "재확인 대기",
        ]}
        value={filter}
        onChange={(value) => {
          setFilter(value);
          setReply("");
          setNotice("");
        }}
      />
      <div className="d-inbox">
        <section aria-label="피드백 작업 목록">
          <div className="d-inbox-label">
            피드백 <span>{rows.length}건</span>
          </div>
          {rows.map((x) => (
            <button
              key={x.id}
              className={`d-inbox-item ${f?.id === x.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(x.id);
                setReply("");
                setNotice("");
              }}
            >
              <div className="d-between">
                <Badge tone={x.source === "User" ? "green" : "purple"}>
                  {x.source}
                </Badge>
                <span>{x.progress}</span>
              </div>
              <h3>{x.improve}</h3>
              <p>
                {productBySlug(x.product)?.name} · {x.author}
              </p>
            </button>
          ))}
          {!rows.length && <Empty title="이 조건의 피드백이 없어요" />}
        </section>
        <section className="d-inbox-detail" aria-label="선택한 피드백">
          {f ? (
            <>
              <div className="d-between">
                <Badge tone={f.source === "User" ? "green" : "purple"}>
                  {f.source} Feedback
                </Badge>
                <Link href={href("feedback/" + f.id)}>원문 보기 ↗</Link>
              </div>
              <h2>{f.task}</h2>
              <p className="d-muted">
                {f.author} · {f.outcome}
              </p>
              <blockquote>{f.body}</blockquote>
              <h3>가장 먼저 바꾸고 싶은 것</h3>
              <p>{f.improve}</p>
              <Field label="개선 상태">
                <select
                  value={f.progress}
                  onChange={(e) =>
                    dispatch({
                      type: "progress",
                      id: f.id,
                      progress: e.target.value,
                    })
                  }
                >
                  {[
                    "접수",
                    "검토 중",
                    "계획됨",
                    "작업 중",
                    "수정 배포",
                    "보류",
                    "채택하지 않음",
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <small>
                ‘재확인 완료’는 사용자 재확인 또는 Agent 재실행으로 연결합니다.
              </small>
              <Field label="메이커 답변">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={
                    f.reply || "어떻게 검토했는지, 무엇을 바꿀지 알려주세요."
                  }
                  maxLength={2000}
                />
              </Field>
              <div className="d-form-actions">
                <ButtonLink
                  to="dashboard/products/frameit/updates/new"
                  secondary
                >
                  업데이트 연결
                </ButtonLink>
                <button
                  className="d-button"
                  disabled={!reply.trim()}
                  onClick={() => {
                    dispatch({
                      type: "progress",
                      id: f.id,
                      progress: f.progress,
                      reply: reply.trim(),
                    });
                    setReply("");
                    setNotice("답변을 미리보기에 저장했습니다.");
                  }}
                >
                  답변 저장
                </button>
              </div>
              {notice && (
                <p role="status" className="d-green">
                  {notice}
                </p>
              )}
              <Notice tone="neutral">
                적격 심사는 플랫폼이 담당합니다. 메이커 답변이나 채택 여부는
                보상을 결정하지 않습니다.
              </Notice>
            </>
          ) : (
            <Empty />
          )}
        </section>
      </div>
    </>
  );
}
export function UpdateForm() {
  const { state, dispatch } = useDemo();
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageHeading
        title="개선한 내용을 알려주세요."
        description="어떤 피드백이 어떤 변경으로 이어졌는지 기록합니다."
      />
      <div className="d-two-main">
        <form
          className="d-panel d-form"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            dispatch({
              type: "update",
              update: {
                id: crypto.randomUUID(),
                version: String(d.get("version")).trim(),
                body: String(d.get("body")).trim(),
                feedbackId: String(d.get("feedback")),
                retest: d.get("retest") === "on",
                releaseUrl: String(d.get("release") ?? "").trim(),
              },
            });
            setSaved(true);
          }}
        >
          <Field label="배포 버전 *">
            <input
              required
              name="version"
              maxLength={40}
              placeholder="예: v1.2.0"
            />
          </Field>
          <Field label="무엇이 바뀌었나요? *">
            <textarea
              required
              name="body"
              minLength={10}
              maxLength={3000}
              placeholder="사용자가 겪었던 문제와 변경된 경험을 알려주세요."
            />
          </Field>
          <Field label="연결할 피드백">
            <select name="feedback">
              {state.feedback
                .filter((f) => f.product === "frameit")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.improve}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="릴리스 또는 배포 링크 (선택)">
            <input name="release" type="url" placeholder="https://…" />
          </Field>
          <label className="d-check-field">
            <input type="checkbox" required /> 이 변경이 실제 사용자 환경에
            배포되었음을 확인했습니다.
          </label>
          <label className="d-check-field">
            <input type="checkbox" name="retest" defaultChecked /> 기여자에게
            수정 재확인을 요청합니다.
          </label>
          {saved ? (
            <div role="status">
              <Notice tone="green">
                업데이트를 미리보기에 저장했습니다. 수정 배포와 재확인 완료는
                별도 상태입니다.
              </Notice>
              <ButtonLink to="p/frameit" secondary>
                제품 페이지 보기
              </ButtonLink>
            </div>
          ) : (
            <button className="d-button">
              업데이트 저장 <Icon size={16} />
            </button>
          )}
        </form>
        <aside>
          <Panel title="개선의 흐름" icon="rocket">
            <ol className="d-numbered">
              <li>피드백을 읽고 검토합니다.</li>
              <li>실제로 배포한 변경을 연결합니다.</li>
              <li>기여자가 다시 확인합니다.</li>
            </ol>
            <Notice>
              이슈가 닫혔거나 커밋이 생긴 것만으로 수정 배포·해결을 확정하지
              않습니다.
            </Notice>
          </Panel>
        </aside>
      </div>
    </>
  );
}
export function SprintForm() {
  const { state, dispatch } = useDemo();
  const router = useRouter();
  const [kind, setKind] = useState("커뮤니티 요청");
  const [count, setCount] = useState(3);
  const [days, setDays] = useState(7);
  const [goals, setGoals] = useState(["첫 사용 경험"]);
  const [quoted, setQuoted] = useState(false);
  const [error, setError] = useState("");
  const cost = count * 15;
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (kind !== "커뮤니티 요청") {
      setQuoted(true);
      return;
    }
    if (balance(state) < cost) {
      setError(
        "사용 가능한 크레딧이 부족합니다. 모집 수를 줄이거나 미션에 참여해주세요.",
      );
      return;
    }
    const d = new FormData(e.currentTarget);
    dispatch({
      type: "reserve",
      campaign: {
        id: crypto.randomUUID(),
        product: "frameit",
        count,
        cost,
        task: String(d.get("task")),
        audience: String(d.get("audience")),
        days,
        status: "open",
      },
    });
    router.push(href("sprints/demo"));
  }
  return (
    <>
      <PageHeading
        center
        title="Start a Feedback Sprint"
        description="어떤 사용자의 어떤 경험이 필요한가요? 명확한 과제에서 시작해요."
      />
      <div className="d-two-main">
        <form className="d-panel d-form" onSubmit={submit}>
          <h2>1. 요청 방식을 선택하세요</h2>
          <div className="d-choice-grid two">
            {["커뮤니티 요청", "유료 Assisted Sprint"].map((x) => (
              <button
                key={x}
                type="button"
                className={`d-choice ${kind === x ? "selected" : ""}`}
                onClick={() => setKind(x)}
                aria-pressed={kind === x}
              >
                <Icon name={x === "커뮤니티 요청" ? "coin" : "user"} />
                <strong>{x}</strong>
                <small>
                  {x === "커뮤니티 요청"
                    ? "적격 피드백 1건당 15C"
                    : "대상·운영 범위에 따른 견적"}
                </small>
              </button>
            ))}
          </div>
          <h2>2. 어떤 피드백이 필요한가요?</h2>
          <div className="d-goals">
            {[
              "첫 사용 경험",
              "사용성",
              "가격 안내",
              "버그 찾기",
              "가치 전달",
            ].map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={goals.includes(x)}
                className={goals.includes(x) ? "active" : ""}
                onClick={() =>
                  setGoals(
                    goals.includes(x)
                      ? goals.filter((g) => g !== x)
                      : [...goals, x],
                  )
                }
              >
                {x}
              </button>
            ))}
          </div>
          <Field label="대상 사용자 *">
            <input
              required
              name="audience"
              placeholder="예: 작업물을 공유하는 디자이너"
              maxLength={300}
            />
          </Field>
          <Field label="시도할 과제 *">
            <textarea
              required
              name="task"
              placeholder="예: 스크린샷 하나를 꾸미고 이미지로 내보내주세요."
              maxLength={1000}
            />
          </Field>
          <div className="d-form-grid">
            <Field label="모집 인원">
              <div className="d-stepper">
                <button
                  type="button"
                  aria-label="모집 인원 줄이기"
                  disabled={count <= 1}
                  onClick={() => setCount(count - 1)}
                >
                  −
                </button>
                <output>{count}명</output>
                <button
                  type="button"
                  aria-label="모집 인원 늘리기"
                  disabled={count >= 10}
                  onClick={() => setCount(count + 1)}
                >
                  +
                </button>
              </div>
            </Field>
            <Field label="모집 기간">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[3, 7, 14].map((n) => (
                  <option key={n} value={n}>
                    {n}일
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="준비물·샘플 계정 안내">
            <input
              placeholder="민감한 비밀번호 대신 테스트 계정 제공 방법을 알려주세요."
              maxLength={500}
            />
          </Field>
          <Field label="피드백 공개 범위">
            <select>
              <option>경험 공개 · 증거는 메이커/운영자만</option>
              <option>비공개 과제 (유료 파일럿 검토)</option>
            </select>
          </Field>
          {error && (
            <p role="alert" className="d-error">
              {error}
            </p>
          )}
          {quoted ? (
            <Notice>
              견적 요청 초안을 확인했습니다. 이 미리보기에서는 전송·결제되지
              않습니다. 실제 판매 가격과 모집 약속은 별도 협의가 필요합니다.
            </Notice>
          ) : (
            <button className="d-button" type="submit">
              {kind === "커뮤니티 요청"
                ? `${cost}C 예약하고 요청 만들기`
                : "견적 요청 미리보기"}
              <Icon size={16} />
            </button>
          )}
        </form>
        <aside className="d-sidebar">
          <Panel title="요청 요약">
            <div className="d-product-inline">
              <Logo product={productBySlug("frameit")!} />
              <div>
                <h3>FrameIt</h3>
                <p>내 제품</p>
              </div>
            </div>
            <hr />
            <dl className="d-definition">
              <dt>방식</dt>
              <dd>{kind}</dd>
              <dt>피드백 목표</dt>
              <dd>{goals.join(", ") || "아직 선택하지 않음"}</dd>
              <dt>사용자</dt>
              <dd>{count}명</dd>
              <dt>기간</dt>
              <dd>{days}일</dd>
              <dt>Agent 실행</dt>
              <dd>포함하지 않음</dd>
            </dl>
            <hr />
            {kind === "커뮤니티 요청" ? (
              <>
                <p>
                  사용 가능 <strong>{balance(state)}C</strong>
                </p>
                <div className="d-cost">
                  <span>{count}명 × 15C</span>
                  <strong>{cost}C</strong>
                </div>
                <small>
                  요청 시 예약하고 적격 완료 시 차감합니다. 미매칭 슬롯은 예약을
                  해제합니다.
                </small>
              </>
            ) : (
              <Notice>
                금액 미확정 · 기여 크레딧과 현금 상품은 환산하지 않습니다.
              </Notice>
            )}
          </Panel>
          <Notice tone="neutral">
            긍정적인 평가나 모집 완료를 보장하지 않습니다. 구체적인 막힘·실패
            경험도 적격 결과입니다.
          </Notice>
        </aside>
      </div>
    </>
  );
}
export function SprintResult() {
  const { state, dispatch } = useDemo();
  const [tab, setTab] = useState("User 결과");
  const c = state.campaigns[0];
  return (
    <>
      <PageHeading
        title="피드백 요청의 진행 상황"
        description="참여와 제출, 적격 결과를 구분해 확인하세요."
        action={
          <ButtonLink to="sprints/new">
            새 요청 만들기 <Icon name="plus" size={16} />
          </ButtonLink>
        }
      />
      {!c ? (
        <Empty
          title="아직 만든 요청이 없어요"
          body="대상과 과제를 정하고 커뮤니티 피드백 요청을 열어보세요."
          action={<ButtonLink to="sprints/new">피드백 요청하기</ButtonLink>}
        />
      ) : (
        <>
          <Panel>
            <div className="d-between">
              <div>
                <Badge tone={c.status === "open" ? "blue" : "neutral"}>
                  {c.status === "open" ? "모집 중" : "취소됨"}
                </Badge>
                <h2>{c.task}</h2>
                <p>
                  FrameIt · {c.audience} · {c.days}일
                </p>
              </div>
              {c.status === "open" && (
                <button
                  className="d-button secondary"
                  onClick={() => dispatch({ type: "cancel", id: c.id })}
                >
                  미매칭 예약 해제
                </button>
              )}
            </div>
            <div className="d-stat-row">
              <div>
                <strong>{c.count}</strong>
                <span>모집 슬롯</span>
              </div>
              <div>
                <strong>0</strong>
                <span>제출된 결과</span>
              </div>
              <div>
                <strong>0</strong>
                <span>적격 완료</span>
              </div>
              <div>
                <strong>{c.status === "open" ? c.cost : 0}C</strong>
                <span>예약 중</span>
              </div>
            </div>
          </Panel>
          <Tabs
            value={tab}
            onChange={setTab}
            items={["User 결과", "Agent 결과"]}
          />
          <Panel>
            {tab === "User 결과" ? (
              <>
                <h2>미션 슬롯</h2>
                {Array.from({ length: c.count }, (_, i) => (
                  <div key={i} className="d-table-row">
                    <span>참여 슬롯 {i + 1}</span>
                    <Badge>
                      {c.status === "open" ? "매칭 대기" : "예약 해제"}
                    </Badge>
                    <span>{c.status === "open" ? "15C 예약" : "15C 반환"}</span>
                  </div>
                ))}
              </>
            ) : (
              <Empty
                title="포함된 Agent 실행이 없어요"
                body="사람 피드백 요청과 자동 실행 예산은 별도로 관리합니다."
              />
            )}
          </Panel>
          <Notice>
            현재 미리보기에서는 실제 참가자를 모집하지 않습니다. 취소 시 예약
            크레딧 해제 흐름을 확인할 수 있습니다.
          </Notice>
        </>
      )}
    </>
  );
}
export function AgentRuns() {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageHeading
        title="Agent Runs"
        description="권한이 명확한 범위에서, 재현 가능한 관찰을 남깁니다."
      />
      <Notice tone="purple">
        자동 실행은 후속 개발 단계입니다. 이 화면에서는 허용 범위를 검토하며
        실제 에이전트는 실행하지 않습니다.
      </Notice>
      <div className="d-two-main">
        <form
          className="d-panel d-form"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(true);
          }}
        >
          <h2>실행 범위 설정</h2>
          <Field label="허용 도메인 *">
            <input
              required
              type="url"
              placeholder="https://staging.example.com"
            />
          </Field>
          <Field label="허용할 과제 *">
            <textarea
              required
              placeholder="예: 샘플 데이터로 이미지 편집과 내보내기 확인"
            />
          </Field>
          <div className="d-form-grid">
            <Field label="시간 한도 (분)">
              <input type="number" min={1} max={30} defaultValue={5} />
            </Field>
            <Field label="실행 횟수">
              <input type="number" min={1} max={10} defaultValue={1} />
            </Field>
          </div>
          <Field label="환경">
            <select>
              <option>격리된 브라우저 · 테스트 데이터</option>
            </select>
          </Field>
          <label className="d-check-field">
            <input type="checkbox" required /> 지정한 테스트 환경을 관리할
            권한이 있습니다.
          </label>
          <button className="d-button">범위 검토 미리보기</button>
          {saved && (
            <p role="status" className="d-green">
              설정 내용을 확인했습니다. 실제 실행·과금은 발생하지 않았습니다.
            </p>
          )}
        </form>
        <aside className="d-sidebar">
          <Panel title="기본적으로 차단하는 행동" icon="shield">
            <ul className="d-check-list">
              <li>결제와 계정 삭제</li>
              <li>실제 고객 데이터 변경</li>
              <li>허용하지 않은 도메인 이동</li>
              <li>외부 메시지 발송</li>
            </ul>
          </Panel>
          <Panel title="사람 피드백과 구분">
            <p>
              Agent 결과는 실제 사용자 수·구매 의향을 뜻하지 않습니다. 사람용
              크레딧을 자동 지급하지 않습니다.
            </p>
            <Badge tone="purple">Agent Feedback · 별도 집계</Badge>
          </Panel>
        </aside>
      </div>
      <Panel title="실행 기록 예시">
        <div className="d-table-row">
          <strong>키보드 접근성 점검</strong>
          <Badge tone="purple">Platform-run</Badge>
          <Badge>완료 · 샘플</Badge>
          <Link href={href("feedback/f3")}>관찰 보기 →</Link>
        </div>
        <div className="d-table-row">
          <strong>외부 결제 페이지 이동</strong>
          <Badge tone="purple">Maker-run</Badge>
          <Badge tone="amber">범위 밖 이동 차단 · 샘플</Badge>
        </div>
      </Panel>
    </>
  );
}
export function Credits() {
  const { state } = useDemo();
  const [filter, setFilter] = useState("전체");
  const pending =
    state.feedback.filter((f) => f.mine && f.reward && f.review === "pending")
      .length * 10;
  const rows = state.ledger.filter(
    (e) =>
      filter === "전체" ||
      (filter === "적립" && ["grant", "reward"].includes(e.kind)) ||
      (filter === "예약·해제" && ["reserve", "release"].includes(e.kind)),
  );
  return (
    <>
      <PageHeading
        title="Credits"
        description="기여하면, 내 제품에도 피드백을 받을 수 있습니다."
        action={
          <ButtonLink to="credits/how-it-works" secondary>
            크레딧 정책 <Icon size={15} />
          </ButtonLink>
        }
      />
      <div className="d-wallet">
        <div>
          <span>사용 가능</span>
          <strong>
            {balance(state)}
            <small>C</small>
          </strong>
        </div>
        <div>
          <span>예약 중</span>
          <strong>
            {reserved(state)}
            <small>C</small>
          </strong>
        </div>
        <div>
          <span>적립 대기</span>
          <strong>
            {pending}
            <small>C</small>
          </strong>
        </div>
      </div>
      <div className="d-hero-actions">
        <ButtonLink to="missions">
          미션 참여하기 <Icon size={16} />
        </ButtonLink>
        <ButtonLink to="sprints/new" secondary>
          내 제품 피드백 요청
        </ButtonLink>
      </div>
      <Notice tone="neutral">
        표시 잔액은 디자인용 예시입니다. 현금 구매·출금·다른 계정으로의 양도는
        제공하지 않습니다.
      </Notice>
      <div className="d-section-heading">
        <h2>크레딧 내역</h2>
        <Tabs
          items={["전체", "적립", "예약·해제"]}
          value={filter}
          onChange={setFilter}
        />
      </div>
      <Panel>
        <div className="d-table-row d-table-head">
          <span>활동</span>
          <span>상태</span>
          <span>증감</span>
        </div>
        {[...rows].reverse().map((e) => (
          <div className="d-table-row" key={e.id}>
            <span>{e.label}</span>
            <Badge>
              {
                {
                  grant: "예시 예산",
                  reward: "적립 완료",
                  reserve: "예약",
                  release: "예약 해제",
                }[e.kind]
              }
            </Badge>
            <strong className={e.amount > 0 ? "d-green" : ""}>
              {e.amount > 0 ? "+" : ""}
              {e.amount}C
            </strong>
          </div>
        ))}
        {!rows.length && <Empty />}
      </Panel>
      <div className="d-between d-muted">
        <span>파일럿 정책 v1.0 · 디자인 검토용</span>
        <Link href={href("appeals/demo")}>적립 심사 이의제기 →</Link>
      </div>
    </>
  );
}
