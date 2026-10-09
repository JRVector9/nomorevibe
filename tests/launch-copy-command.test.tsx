import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyCommand, copyOrSelect } from "@/app/launch/CopyCommand";

/** /launch 명령 복사 단추(UX-20) — 클립보드에 넣고, 못 넣으면 명령 글자를 선택해 둔다 */
afterEach(() => vi.unstubAllGlobals());

const COMMAND = "curl -fsSL https://registry.example/install.sh | sh";

describe("명령 한 줄", () => {
  it("명령과 복사 단추를 한 칸에 그리고, '$' 는 복사·선택 밖에 둔다", () => {
    const html = renderToStaticMarkup(<CopyCommand command={COMMAND} label="설치 명령" prompt="$" />);
    expect(html).toContain('aria-label="설치 명령 복사"');
    expect(html).toContain(">복사</button>");
    // 명령 글자만 따로 감싼다 — 선택 대체 경로가 이 노드를 고른다
    expect(html).toContain(`<span>${COMMAND}</span>`);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*select-none[^>]*>\$<\/span>/);
    // 좁은 화면에서도 꺾지 않는다
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain('role="status"');
  });

  it("'$' 가 없으면 그리지 않는다 — 슬래시 명령은 AI 툴 안에서 친다", () => {
    const html = renderToStaticMarkup(<CopyCommand command="/nomorevibe verify" label="확인 명령" />);
    expect(html).not.toContain("aria-hidden");
    expect(html).toContain("<span>/nomorevibe verify</span>");
  });
});

describe("복사", () => {
  it("클립보드에 명령 그대로 넣는다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await copyOrSelect(COMMAND, null)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(COMMAND);
  });

  it("클립보드가 거절하면 명령 글자를 선택해 둔다", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const selectAllChildren = vi.fn();
    vi.stubGlobal("window", { getSelection: () => ({ selectAllChildren }) });
    const target = {} as Node;

    expect(await copyOrSelect(COMMAND, target)).toBe("selected");
    expect(selectAllChildren).toHaveBeenCalledWith(target);
  });

  it("클립보드가 아예 없는 브라우저도 선택으로 넘어간다", async () => {
    vi.stubGlobal("navigator", {});
    const selectAllChildren = vi.fn();
    vi.stubGlobal("window", { getSelection: () => ({ selectAllChildren }) });

    expect(await copyOrSelect(COMMAND, {} as Node)).toBe("selected");
    expect(selectAllChildren).toHaveBeenCalledOnce();
  });

  it("고를 글자도 없으면 실패를 알린다", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { getSelection: () => null });

    expect(await copyOrSelect(COMMAND, null)).toBe("failed");
  });
});
