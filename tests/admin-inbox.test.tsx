import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACTION_LINKS } from "@/app/admin/status/action-links";
import { assembleInbox, AUDIT_TAB_HREF, INBOX_KEYS, INBOX_SECTIONS } from "@/app/admin/inbox/inbox-model";
import { InboxCard } from "@/app/admin/inbox/InboxCard";
import type { InboxKey, InboxSectionData, InboxSectionResult } from "@/lib/operations/inbox";

/** 오늘 할 일(2026-10-08 UX 감사 ADM-07) — 칸의 차례·합계와 칸 하나의 그림 */
const section = (count: number, over: Partial<InboxSectionData> = {}): InboxSectionResult =>
  ({ ok: true, data: { count, items: [], ...over } });
const results = (over: Partial<Record<InboxKey, InboxSectionResult>> = {}) =>
  Object.fromEntries(INBOX_KEYS.map((key) => [key, over[key] ?? section(0)])) as Record<InboxKey, InboxSectionResult>;

describe("assembleInbox", () => {
  it("급한 차례 — 요청, 직접 판단, 확정만, 감사, 응답 없음, 소개, 저장소, 스팸", () => {
    expect(INBOX_KEYS).toEqual(["takedown", "human", "agreed", "audit", "down", "intro", "repoGone", "spam"]);
    expect(Object.keys(INBOX_SECTIONS).sort()).toEqual([...INBOX_KEYS].sort());
    const inbox = assembleInbox(results(Object.fromEntries(INBOX_KEYS.map((key, index) => [key, section(index + 1)]))), [3, 1]);
    expect(inbox.sections.map((item) => item.key)).toEqual([...INBOX_KEYS]);
    expect(inbox.remaining).toBe(36);
    expect(inbox.done).toBe(4);
    expect(inbox.clear).toEqual([]);
  });

  it("빈 칸은 아래로 모으고, 못 읽은 칸은 제자리에 둔다", () => {
    const inbox = assembleInbox(results({ spam: section(2), agreed: { ok: false }, down: section(615) }), [0, null]);
    expect(inbox.sections.map((item) => [item.key, item.state])).toEqual([["agreed", "failed"], ["down", "work"], ["spam", "work"]]);
    expect(inbox.clear.map((item) => item.key)).toEqual(["takedown", "human", "audit", "intro", "repoGone"]);
    expect(inbox.remaining).toBe(617);
    expect(inbox.failed).toBe(1);
    // 못 읽은 조각은 빼고 더한다
    expect(inbox.done).toBe(0);
  });

  it("모두 비면 할 일이 없고, 처리 수를 하나도 못 읽으면 null", () => {
    const inbox = assembleInbox(results(), [null, null]);
    expect(inbox.sections).toEqual([]);
    expect(inbox.clear).toHaveLength(INBOX_KEYS.length);
    expect(inbox).toMatchObject({ remaining: 0, failed: 0, done: null });
  });

  it("내려달라는 요청이 24시간을 넘기면 빨강, 아니면 주황", () => {
    expect(assembleInbox(results({ takedown: section(2, { overdue: 1 }) }), []).sections[0].tone).toBe("critical");
    expect(assembleInbox(results({ takedown: section(2, { overdue: 0 }) }), []).sections[0].tone).toBe("warn");
    expect(assembleInbox(results({ human: section(9, { overdue: 3 }) }), []).sections[0].tone).toBe("warn");
  });

  it("칸마다 처리 화면으로 보낸다 — 운영센터와 같은 주소, 감사는 감사 탭", () => {
    const links = Object.values(ACTION_LINKS) as string[];
    for (const key of INBOX_KEYS) {
      if (key === "audit") continue;
      expect(links, key).toContain(INBOX_SECTIONS[key].href);
    }
    expect(INBOX_SECTIONS.audit.href).toBe(AUDIT_TAB_HREF);
    // /admin/audit 이 ?tab=audit 을 읽는다
    const audit = readFileSync(path.resolve(__dirname, "../app/admin/audit/page.tsx"), "utf8");
    expect(audit).toMatch(/const TABS = \{[^}]*\baudit:/);
    expect(INBOX_SECTIONS.takedown.href).toBe(ACTION_LINKS.takedowns);
    expect(INBOX_SECTIONS.human.href).toBe("/admin/review?stage=human&sort=wait#review-list");
  });
});

describe("InboxCard", () => {
  const now = "2026-10-09T03:00:00.000Z";
  const build = (key: InboxKey, result: InboxSectionResult) => assembleInbox(results({ [key]: result }), []).sections[0];

  it("수·가장 오래된 것·줄·링크를 그리고, 직접 판단의 사유 코드는 사람 말로 바꾼다", () => {
    const html = renderToStaticMarkup(<InboxCard now={now} section={build("human", section(12, {
      note: "2주 넘음 1건",
      items: [{ id: "1", name: "owner/repo", why: "second_review_split", since: "2026-10-06T03:00:00.000Z" }],
    }))} />);
    expect(html).toContain("직접 판단");
    expect(html).toContain("12건");
    expect(html).toContain("가장 오래된 것 3일 전");
    expect(html).toContain("2차 심사 갈림 — 사람 확인");
    expect(html).toContain("12건 모두 보기");
    expect(html).toContain('href="/admin/review?stage=human&amp;sort=wait#review-list"');
  });

  it("못 읽은 칸은 불러오지 못함과 링크만 그린다", () => {
    const html = renderToStaticMarkup(<InboxCard now={now} section={build("intro", { ok: false })} />);
    expect(html).toContain("불러오지 못함");
    expect(html).toContain('data-tone="failed"');
    expect(html).not.toContain("<ul");
    expect(html).toContain(`href="${ACTION_LINKS.productsIntro.replace(/&/g, "&amp;")}"`);
  });
});
