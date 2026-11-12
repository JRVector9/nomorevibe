import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/flow", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));

import { admissionHeadline, admissionStatusFrom } from "@/lib/operations/admission-headline";
import { AdmissionPill } from "@/app/(operator)/admin/AdminShell";

const NOW = Date.parse("2026-11-11T23:26:00.000Z"); // 08:26 KST
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** 머리줄의 접수(운영 콘솔 조각 4b, 시안 흐름 6) — 열림/중단 · 언제부터 · 누가 */
describe("admission in the header", () => {
  it("takes who and since from the last admission log row only when its mode is the current one", () => {
    expect(admissionStatusFrom({ mode: "draining", updated_at: new Date(ago(10)), actor: "JR", at: new Date(ago(18)), last_mode: "draining" }))
      .toEqual({ mode: "draining", since: ago(18), actor: "JR" });
    // 마지막 줄이 다른 모드(기록 없이 바뀜) — 행이 바뀐 때만, 사람은 모름
    expect(admissionStatusFrom({ mode: "open", updated_at: ago(5), actor: "JR", at: ago(18), last_mode: "draining" }))
      .toEqual({ mode: "open", since: ago(5), actor: null });
    expect(admissionStatusFrom({ mode: "paused", updated_at: ago(5) })).toBeNull();
    expect(admissionStatusFrom(null)).toBeNull();
  });

  it("says open/paused, since when, who and for how long — paused turns red past thirty minutes", () => {
    expect(admissionHeadline({ mode: "draining", since: ago(18), actor: "JR" }, NOW))
      .toMatchObject({ mode: "draining", tone: "warn", label: "접수 중단", detail: "08:08부터 · JR · 18분", href: "/admin/models/dashboard#admission" });
    expect(admissionHeadline({ mode: "draining", since: ago(45), actor: "jr-claude" }, NOW)).toMatchObject({ tone: "bad", detail: "07:41부터 · jr-claude · 45분" });
    expect(admissionHeadline({ mode: "open", since: ago(60), actor: "JR" }, NOW)).toMatchObject({ tone: "ok", label: "접수 열림", detail: "07:26부터 · JR" });
    expect(admissionHeadline({ mode: "open", since: ago(26 * 60), actor: null }, NOW)).toMatchObject({ detail: "11-11 06:26부터" });
    expect(admissionHeadline({ mode: "disabled", since: null, actor: null }, NOW)).toMatchObject({ tone: "off", label: "접수 꺼짐", detail: null });
    expect(admissionHeadline(null, NOW)).toMatchObject({ mode: null, tone: "off", label: "접수 셀 수 없음", href: "/admin/models/dashboard#admission" });
  });

  it("draws a dot and short words that lead to the existing admission control, and only a placeholder before the first read", () => {
    const html = renderToStaticMarkup(<AdmissionPill admission={admissionHeadline({ mode: "draining", since: ago(18), actor: "JR" }, NOW)} />);
    expect(html).toMatch(/^<a [^>]*class="top-admission" data-tone="warn" data-mode="draining"/);
    expect(html).toContain('href="/admin/models/dashboard#admission"');
    expect(html).toContain("<b>접수 중단</b><span class=\"top-admission-detail\">08:08부터 · JR · 18분</span>");
    const waiting = renderToStaticMarkup(<AdmissionPill admission={null} />);
    expect(waiting).toBe('<span class="top-admission" data-tone="off" aria-busy="true"><i aria-hidden="true"></i><b>접수</b></span>');
  });
});
