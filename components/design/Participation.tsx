"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { href, productBySlug, type DemoProduct } from "./data";
import { useDemo } from "./store";
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
} from "./ui";
export function LaunchForm() {
  const { state, dispatch } = useDemo();
  const d = state.draft;
  const step = Number(d.step ?? 0);
  const [saved, setSaved] = useState(false);
  const value = (k: string, v: string) =>
    dispatch({ type: "draft", values: { [k]: v } });
  const steps = ["제품 연결", "기본 정보", "이용·피드백 조건", "검토 및 저장"];
  function submit(e: FormEvent) {
    e.preventDefault();
    if (step < 3) {
      value("step", String(step + 1));
      return;
    }
    value("submitted", "yes");
    setSaved(true);
  }
  return (
    <>
      <PageHeading
        title="Launch your product"
        description="제품을 소개하고, 첫 사용자의 경험을 만나보세요. 기본 등록은 무료입니다."
      />
      <div className="d-wizard">
        <aside className="d-wizard-steps">
          {steps.map((s, i) => (
            <div
              key={s}
              className={i === step ? "active" : i < step ? "done" : ""}
            >
              <span>{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
              <div>
                <strong>{s}</strong>
                <small>
                  {
                    [
                      "URL에서 시작해요",
                      "누구를 위한 제품인가요?",
                      "테스트 전 준비물을 알려주세요",
                      "공개 전 내용을 확인해요",
                    ][i]
                  }
                </small>
              </div>
            </div>
          ))}
        </aside>
        <form className="d-panel d-form" onSubmit={submit}>
          <div className="d-between">
            <h2>{steps[step]}</h2>
            <Badge>등록 0C</Badge>
          </div>
          <p className="d-muted">
            입력한 내용은 이 브라우저에 초안으로 저장됩니다.
          </p>
          {step === 0 && (
            <>
              <Field label="제품 URL *">
                <input
                  type="url"
                  required
                  placeholder="https://yourproduct.com"
                  value={d.url ?? ""}
                  onChange={(e) => value("url", e.target.value)}
                />
              </Field>
              <Field
                label="GitHub 저장소 URL"
                hint="저장소가 없는 제품도 등록할 수 있습니다."
              >
                <input
                  type="url"
                  placeholder="https://github.com/your/project"
                  value={d.repo ?? ""}
                  onChange={(e) => value("repo", e.target.value)}
                />
              </Field>
              <Notice>
                제품·도메인 관리 권한은 별도 확인합니다. URL 입력만으로
                인증되지는 않습니다.
              </Notice>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="제품명 *">
                <input
                  required
                  maxLength={80}
                  value={d.name ?? ""}
                  placeholder="예: FrameIt"
                  onChange={(e) => value("name", e.target.value)}
                />
              </Field>
              <Field label="한 줄 소개 *">
                <input
                  required
                  maxLength={160}
                  value={d.tagline ?? ""}
                  placeholder="어떤 문제를 해결하나요?"
                  onChange={(e) => value("tagline", e.target.value)}
                />
              </Field>
              <Field label="카테고리 *">
                <select
                  required
                  value={d.category ?? ""}
                  onChange={(e) => value("category", e.target.value)}
                >
                  <option value="">선택해주세요</option>
                  {[
                    "생산성",
                    "디자인",
                    "개발 도구",
                    "콘텐츠",
                    "교육",
                    "라이프스타일",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="대상 사용자 *">
                <input
                  required
                  maxLength={200}
                  value={d.audience ?? ""}
                  placeholder="예: 작업물을 자주 공유하는 디자이너"
                  onChange={(e) => value("audience", e.target.value)}
                />
              </Field>
              <Field label="제품 소개 (선택)">
                <textarea
                  maxLength={2000}
                  value={d.description ?? ""}
                  onChange={(e) => value("description", e.target.value)}
                />
              </Field>
            </>
          )}
          {step === 2 && (
            <>
              <Field label="이용 조건 *">
                <select
                  value={d.condition ?? "가입 없이 사용"}
                  onChange={(e) => value("condition", e.target.value)}
                >
                  {[
                    "가입 없이 사용",
                    "회원가입 필요",
                    "설치 필요",
                    "API 키 필요",
                    "유료 사용 필요",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="써봤으면 하는 과제 *">
                <textarea
                  required
                  maxLength={500}
                  value={d.task ?? ""}
                  onChange={(e) => value("task", e.target.value)}
                  placeholder="사용자가 시도할 과제를 구체적으로 알려주세요."
                />
              </Field>
              <label className="d-check-field">
                <input type="checkbox" required /> User Feedback을 받고
                답변하겠습니다.
              </label>
              <label className="d-check-field">
                <input
                  type="checkbox"
                  checked={d.agent === "yes"}
                  onChange={(e) =>
                    value("agent", e.target.checked ? "yes" : "no")
                  }
                />{" "}
                Agent 테스트 허용 범위를 나중에 설정하겠습니다.
              </label>
              <small>이 선택으로 에이전트가 실행되지는 않습니다.</small>
            </>
          )}
          {step === 3 && (
            <>
              <Notice tone="amber">
                현재 관리 권한 확인 전입니다. 공개되지 않는 초안으로 저장합니다.
              </Notice>
              <dl className="d-definition">
                <dt>제품명</dt>
                <dd>{d.name}</dd>
                <dt>주소</dt>
                <dd>{d.url}</dd>
                <dt>대상</dt>
                <dd>{d.audience}</dd>
                <dt>과제</dt>
                <dd>{d.task}</dd>
                <dt>등록 비용</dt>
                <dd>무료 · 0C</dd>
              </dl>
              <label className="d-check-field">
                <input required type="checkbox" /> 이 제품의 정보를 게시할
                권한이 있습니다.
              </label>
            </>
          )}
          {saved ? (
            <div role="status">
              <Notice tone="green">
                초안을 저장했습니다. 관리 권한 확인 후 공개할 수 있습니다.
              </Notice>
              <ButtonLink to="dashboard" secondary>
                대시보드로 이동
              </ButtonLink>
            </div>
          ) : (
            <div className="d-form-actions">
              {step > 0 && (
                <button
                  type="button"
                  className="d-button secondary"
                  onClick={() => value("step", String(step - 1))}
                >
                  이전
                </button>
              )}
              <button className="d-button" type="submit">
                {step === 3 ? "초안 저장" : "다음 단계"}
                <Icon size={16} />
              </button>
            </div>
          )}
        </form>
        <aside className="d-sidebar d-launch-preview">
          <Panel title="카드 미리보기">
            <Logo
              product={{
                ...productBySlug("frameit")!,
                name: d.name || "내 제품",
              }}
              large
            />
            <h2>{d.name || "Your product name"}</h2>
            <p>{d.tagline || "제품의 한 줄 소개가 여기에 표시됩니다."}</p>
            <Badge>{d.category || "카테고리"}</Badge>
            <hr />
            <span className="d-muted">관리 권한 확인 대기</span>
          </Panel>
          <Panel title="등록하고 시작하세요" icon="rocket">
            <ul className="d-check-list">
              <li>내 제품의 소개 페이지</li>
              <li>사용자의 구체적인 피드백</li>
              <li>수정과 업데이트 기록</li>
              <li>기여 크레딧으로 테스트 요청</li>
            </ul>
          </Panel>
        </aside>
      </div>
    </>
  );
}
export function Claim({ product: p }: { product: DemoProduct }) {
  const [method, setMethod] = useState("GitHub 저장소");
  const [result, setResult] = useState("");
  const { state, dispatch } = useDemo();
  const pending = state.claims.includes(p.slug);
  return (
    <>
      <PageHeading
        title="이 제품의 메이커이신가요?"
        description="관리 권한을 확인하고, 기존 제품의 발견 기록을 이어가세요."
      />
      <div className="d-claim-summary">
        <Logo product={p} large />
        <div>
          <Badge tone="blue">Radar에서 발견</Badge>
          <h2>{p.name}</h2>
          <p>{p.tagline}</p>
          <small>{p.repo ?? "메이커 직접 등록"}</small>
        </div>
      </div>
      <div className="d-two-main">
        <Panel title="관리 권한 확인" icon="shield">
          {p.type === "launch" ? (
            <>
              <Notice tone="amber">
                이미 메이커가 연결된 제품입니다. 새로운 신청자에게 관리 권한을
                자동 이전하지 않습니다.
              </Notice>
              <ButtonLink to="appeals/demo" secondary>
                팀 초대·권한 분쟁 요청
              </ButtonLink>
            </>
          ) : (
            <>
              <p>확인할 수 있는 방법을 선택해주세요.</p>
              <div className="d-choice-grid">
                {[
                  ["GitHub 저장소", "code", "대상 저장소의 관리 권한"],
                  ["도메인 DNS", "grid", "일회성 TXT 레코드"],
                  ["검증 파일", "shield", "고정 경로의 일회성 파일"],
                ].map(([m, i, t]) => (
                  <button
                    key={m}
                    className={`d-choice ${method === m ? "selected" : ""}`}
                    aria-pressed={method === m}
                    onClick={() => setMethod(m)}
                  >
                    <Icon name={i} />
                    <strong>{m}</strong>
                    <small>{t}</small>
                  </button>
                ))}
              </div>
              <div className="d-challenge">
                <h3>{method}로 확인하기</h3>
                <p>
                  {method === "GitHub 저장소"
                    ? "로그인한 계정이 연결된 특정 저장소를 관리할 수 있는지 확인합니다."
                    : "제품과 신청 계정에 연결된 일회성 인증 값을 발급받아 게시합니다."}
                </p>
                <code>
                  {method === "GitHub 저장소"
                    ? p.repo
                    : "미리보기에서는 실제 인증 토큰을 발급하지 않습니다."}
                </code>
              </div>
              <Notice>
                관리 권한 확인은 법적 소유권이나 저작권을 보증하지 않습니다.
                이메일 수신만으로는 승인되지 않습니다.
              </Notice>
              {pending ? (
                <div role="status">
                  <Badge tone="blue">검토 중 · 미리보기 신청</Badge>
                  <p>
                    권한이 부여된 상태가 아닙니다. 실제 서비스에서는 서버 검증과
                    충돌 검토가 필요합니다.
                  </p>
                </div>
              ) : (
                <button
                  className="d-button"
                  onClick={() => {
                    dispatch({ type: "claim", slug: p.slug });
                    setResult("검토 요청을 미리보기에 저장했습니다.");
                  }}
                >
                  검토 요청 미리보기 <Icon size={16} />
                </button>
              )}
              {result && <p role="status">{result}</p>}
              <details className="d-disclosure">
                <summary>인증이 진행되지 않을 때</summary>
                <p>
                  권한 부족: 저장소의 관리 권한을 확인하세요. 토큰 만료: 새
                  challenge가 필요합니다. 기존 관리자와 충돌: 수동 검토하며
                  권한을 자동 이전하지 않습니다.
                </p>
                <Link href={href("appeals/demo")}>
                  이의제기·보완 자료 제출 →
                </Link>
              </details>
            </>
          )}
        </Panel>
        <aside className="d-sidebar">
          <Panel title="제품의 다음 단계를 함께" icon="rocket">
            <ul className="d-check-list">
              <li>기존 URL과 저장 기록 유지</li>
              <li>제품 소개와 이용 조건 편집</li>
              <li>피드백 요청과 답변</li>
              <li>업데이트와 재테스트 연결</li>
            </ul>
          </Panel>
          <Notice tone="neutral">
            인증 후에도 내용을 검토한 뒤 Launch로 공개합니다.
          </Notice>
        </aside>
      </div>
    </>
  );
}
export function StartTest({ product: p }: { product: DemoProduct }) {
  const { state, dispatch } = useDemo();
  const [agree, setAgree] = useState(false);
  const [opened, setOpened] = useState(false);
  const has = state.sessions.includes(p.slug);
  const reward = p.needsFeedback && p.slug !== "frameit";
  return (
    <>
      <PageHeading
        eyebrow="TRY SOMETHING NEW"
        title="시작하기 전에, 잠깐."
        description="무엇을 해볼지, 무엇이 필요한지 먼저 확인하세요."
      />
      <div className="d-two-main">
        <Panel>
          <div className="d-product-inline">
            <Logo product={p} />
            <div>
              <h2>{p.name}</h2>
              <p>{p.tagline}</p>
            </div>
          </div>
          <hr />
          <h2>{p.task}</h2>
          <ol className="d-numbered">
            <li>첫 화면에서 시작 방법을 찾아보세요.</li>
            <li>샘플 데이터로 핵심 기능을 시도해보세요.</li>
            <li>결과를 확인하고 좋았던 점과 막힌 점을 기록하세요.</li>
          </ol>
          <div className="d-preconditions">
            <div>
              <Icon name="clock" />
              <strong>메이커 안내 · 약 5분</strong>
              <p>실제 소요 시간은 다를 수 있어요.</p>
            </div>
            <div>
              <Icon name="shield" />
              <strong>{p.condition}</strong>
              <p>개인 정보 대신 샘플을 사용하세요.</p>
            </div>
          </div>
          <Notice tone="green">
            끝까지 성공하지 않아도 괜찮아요. 막힘과 접근 실패도 구체적인
            피드백이 됩니다.
          </Notice>
          {has ? (
            <div className="d-form-actions">
              <ButtonLink to={"tests/" + p.slug + "/feedback"}>
                결과 작성하기 <Icon size={16} />
              </ButtonLink>
              <button
                className="d-button secondary"
                onClick={() => setOpened(!opened)}
              >
                {opened ? "사용 안내 닫기" : "제품 사용 안내"}
              </button>
            </div>
          ) : (
            <>
              <label className="d-check-field">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(e) => setAgree(e.target.checked)}
                />{" "}
                과제와 이용 조건을 확인했습니다.
              </label>
              <button
                className="d-button"
                disabled={!agree}
                onClick={() => {
                  dispatch({ type: "start", slug: p.slug });
                  setOpened(true);
                }}
              >
                {reward ? "미션 참여 시작" : "테스트 시작"} <Icon size={16} />
              </button>
            </>
          )}
          {opened && (
            <Notice>
              이 제품은 디자인용 예시입니다. 외부 사이트로 이동하지 않습니다.
              사용 후 돌아온 흐름은 ‘결과 작성하기’에서 확인할 수 있습니다.
            </Notice>
          )}
        </Panel>
        <aside className="d-sidebar">
          <Panel title="참여 안내">
            <Badge tone={reward ? "green" : "neutral"}>
              {reward ? "+10C · 적격 심사 후" : "자발적 피드백 · 보상 없음"}
            </Badge>
            <p>
              {reward
                ? "미리보기의 플랫폼 후원 미션입니다. 제출 시 적립 대기, 검토 후 적격일 때만 적립됩니다."
                : "자기 제품이나 일반 피드백에는 기여 크레딧이 지급되지 않습니다."}
            </p>
            <hr />
            <h3>사용 경험 확인</h3>
            <p>
              과제·결과·개선점을 작성해주세요. 링크 클릭이나 머문 시간만으로
              사용을 확인하지 않습니다.
            </p>
            <Link href={href("credits/how-it-works")}>
              보상·예약 기준 보기 →
            </Link>
          </Panel>
          <small>
            실서비스의 예약은 30분 예시 정책이며, 제출 후 심사 중인 슬롯은
            만료시키지 않습니다.
          </small>
        </aside>
      </div>
    </>
  );
}
export function FeedbackForm({ product: p }: { product: DemoProduct }) {
  const { state, dispatch } = useDemo();
  const router = useRouter();
  const [outcome, setOutcome] = useState("완료");
  const [error, setError] = useState("");
  const [attachment, setAttachment] = useState("");
  const [author, setAuthor] = useState("human");
  const already = state.feedback.find((f) => f.mine && f.product === p.slug);
  const reward = p.needsFeedback && p.slug !== "frameit";
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (author !== "human") return;
    const f = new FormData(e.currentTarget);
    const task = String(f.get("task") ?? "").trim(),
      body = String(f.get("body") ?? "").trim(),
      improve = String(f.get("improve") ?? "").trim();
    if (!task || !body || !improve) {
      setError("세 질문에 공백이 아닌 내용을 작성해주세요.");
      return;
    }
    const id = "f" + crypto.randomUUID();
    dispatch({
      type: "submit",
      feedback: {
        id,
        product: p.slug,
        author: "나",
        source: "User",
        task,
        outcome,
        body,
        improve,
        review: "pending",
        progress: "접수",
        reward,
        mine: true,
        reply: "",
        evidenceName: attachment,
        evidenceVisibility: String(f.get("visibility")),
        aiWriting: f.get("ai-writing") === "on",
      },
    });
    router.push(href("feedback/" + id));
  }
  return (
    <>
      <PageHeading
        title="Leave feedback"
        description="어떤 경험을 했나요? 구체적인 관찰이 다음 개선으로 이어집니다."
      />
      {already ? (
        <Empty
          title="이미 피드백을 제출했어요"
          body="같은 미션은 중복 제출하지 않습니다. 검토 상태와 메이커 답변을 확인하세요."
          action={
            <ButtonLink to={"feedback/" + already.id}>제출한 피드백</ButtonLink>
          }
        />
      ) : !state.sessions.includes(p.slug) ? (
        <Empty
          title="먼저 테스트 과제를 확인해주세요"
          body="참여 조건을 읽고 시작한 뒤 경험을 남길 수 있어요."
          action={
            <ButtonLink to={"p/" + p.slug + "/test"}>
              테스트 시작하기
            </ButtonLink>
          }
        />
      ) : (
        <div className="d-two-main">
          <form className="d-panel d-form" onSubmit={submit}>
            <Badge tone="green">
              <Icon name="user" size={14} /> User Feedback · 사용 경험 자기진술
            </Badge>
            <Field label="실제 테스트는 누가 수행했나요?">
              <select
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              >
                <option value="human">제가 직접 사용했습니다</option>
                <option value="agent">에이전트가 수행했습니다</option>
              </select>
            </Field>
            {author === "agent" ? (
              <Notice tone="purple">
                에이전트 실행 결과는 Agent Feedback으로 제출해야 합니다. 사람
                피드백 미션 보상 대상이 아닙니다.{" "}
                <Link href={href("dashboard/agent-runs")}>
                  Agent Runs 보기 →
                </Link>
              </Notice>
            ) : (
              <>
                <fieldset>
                  <legend>실제 결과 *</legend>
                  <div className="d-outcomes">
                    {["완료", "일부 완료", "막힘", "접근 불가"].map((x) => (
                      <label
                        key={x}
                        className={outcome === x ? "selected" : ""}
                      >
                        <input
                          type="radio"
                          name="outcome"
                          checked={outcome === x}
                          onChange={() => setOutcome(x)}
                        />
                        {x}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label="무엇을 하려고 했나요? *">
                  <textarea
                    name="task"
                    required
                    maxLength={500}
                    defaultValue={p.task}
                    placeholder="시도한 과제를 알려주세요."
                  />
                </Field>
                <Field
                  label="실제로 어떤 결과가 나왔고, 어디에서 막혔나요? *"
                  hint={
                    ["막힘", "접근 불가"].includes(outcome)
                      ? "시도한 순서, 오류 문구와 멈춘 화면을 적어주세요."
                      : "행동과 결과를 구체적으로 적어주세요."
                  }
                >
                  <textarea
                    name="body"
                    required
                    maxLength={2000}
                    placeholder="예: 내보내기를 눌렀지만 파일이 저장되지 않았어요."
                  />
                </Field>
                <Field label="한 가지만 바꾼다면 무엇을 바꾸겠나요? *">
                  <textarea
                    name="improve"
                    required
                    maxLength={1000}
                    placeholder="가장 먼저 개선했으면 하는 점을 알려주세요."
                  />
                </Field>
                <Field
                  label="스크린샷 (선택)"
                  hint="PNG/JPG, 최대 5MB. 민감한 정보는 가려주세요. 미리보기에서는 서버로 전송하지 않습니다."
                >
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      setError("");
                      setAttachment("");
                      if (file) {
                        if (
                          !["image/png", "image/jpeg"].includes(file.type) ||
                          file.size > 5 * 1024 * 1024
                        ) {
                          setError(
                            "5MB 이하 PNG 또는 JPG 파일을 선택해주세요.",
                          );
                          e.target.value = "";
                          return;
                        }
                        setAttachment(file.name);
                      }
                    }}
                  />
                </Field>
                {attachment && <p className="d-green">선택됨: {attachment}</p>}
                <Field label="증거 공개 범위">
                  <select name="visibility">
                    <option>메이커·운영 검토자에게만</option>
                    <option>개인정보를 가린 후 공개</option>
                  </select>
                </Field>
                <label className="d-check-field">
                  <input type="checkbox" name="ai-writing" /> 문장 정리에 AI의
                  도움을 받았습니다 (선택)
                </label>
                <label className="d-check-field">
                  <input type="checkbox" required /> 직접 시도한 경험이며 공개
                  범위와 심사 기준을 확인했습니다.
                </label>
                {error && (
                  <p role="alert" className="d-error">
                    {error}
                  </p>
                )}
                <div className="d-form-actions">
                  <small>
                    {reward
                      ? "제출 후 적립 대기 +10C · 아직 확정되지 않습니다."
                      : "자발적 피드백 · 자동 보상 없음"}
                  </small>
                  <button type="submit" className="d-button">
                    피드백 제출 <Icon size={16} />
                  </button>
                </div>
              </>
            )}
          </form>
          <aside className="d-sidebar">
            <Panel title="참여한 제품">
              <Logo product={p} />
              <h2>{p.name}</h2>
              <p>{p.tagline}</p>
              <hr />
              <h3>메이커가 궁금한 것</h3>
              <p>{p.task}</p>
              <ul className="d-check-list">
                <li>첫 사용 흐름이 명확했나요?</li>
                <li>예상과 다른 결과가 있었나요?</li>
                <li>무엇부터 개선하면 좋을까요?</li>
              </ul>
            </Panel>
            <Notice tone="green">
              호평이나 높은 별점을 요구하지 않습니다. 솔직한 막힘 보고도 동일한
              기준으로 검토합니다.
            </Notice>
          </aside>
        </div>
      )}
    </>
  );
}
