import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UptimeConfirmControls } from "@/app/(operator)/admin/status/dashboard/UptimeConfirmControls";

describe("업타임 LLM 확인 스위치", () => {
  it("확인 소비와 적용의 켜짐을 따로 보여 준다", () => {
    const html = renderToStaticMarkup(createElement(UptimeConfirmControls, {
      controls: [{ task: "uptime", mode: "confirm", confirmationRequired: true, dispatchEnabled: false, applyEnabled: false }],
      queue: [
        { task: "uptime", state: "queued", count: 4720, mode: "confirm", confirmationRequired: true, dispatchEnabled: false, applyEnabled: false },
        { task: "uptime", state: "waiting_evidence", count: 5, mode: "confirm", confirmationRequired: true, dispatchEnabled: false, applyEnabled: false },
      ],
    }));
    expect(html).toContain("확인 소비");
    expect(html).toContain("적용");
    expect(html).toContain("꺼짐");
    expect(html).toContain("4,720");
    expect(html).toContain("페이지 근거 대기 5");
    expect(html).not.toContain('data-on="true"');
    expect(html.match(/data-on="false"/g)?.length).toBe(2);
  });

  it("설정을 못 읽으면 꺼짐으로 단정하지 않는다", () => {
    const html = renderToStaticMarkup(createElement(UptimeConfirmControls, { controls: null, queue: null }));
    expect(html).toContain("읽지 못했습니다");
    expect(html).not.toContain("꺼짐");
  });
});
