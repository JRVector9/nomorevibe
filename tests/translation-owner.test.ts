import { describe, expect, it } from "vitest";
import { batchOwnerForJob } from "@/lib/jobs/batches";
import { translationOwnerText } from "@/app/(operator)/admin/translations/owner";

/**
 * 공개 번역 화면의 "모델 호출은 기존 text 워커만 수행합니다"는 고정 글이었다(ops-v8 PR8).
 * 작업 배치 방식이 바뀌면 product-translate 를 맡는 역할이 바뀐다 — 기존 방식(legacy)은 text, 분리(versioned)는 translation.
 */
describe("공개 번역 모델 호출 담당", () => {
  it("작업 배치 방식마다 product-translate 를 맡는 역할을 정한다", () => {
    expect(batchOwnerForJob("product-translate", "legacy")).toBe("text");
    expect(batchOwnerForJob("product-translate", "versioned")).toBe("translation");
    // 비우는 중에는 아무 역할도 맡지 않는다(batchJobsForRole 이 빈 목록)
    expect(batchOwnerForJob("product-translate", "draining")).toBeNull();
  });

  it("기존 방식이면 지금 글 그대로다", () => {
    expect(translationOwnerText("legacy")).toEqual({ page: "모델 호출은 기존 text 워커만 수행합니다.",
      accepted: "접수했습니다. 기존 text 워커가 처리합니다." });
  });

  it("분리 방식이면 분리 번역 역할을 코드 이름과 함께 적는다", () => {
    const text = translationOwnerText("versioned");
    expect(text.page).toBe("모델 호출은 분리 번역 역할(translation)만 수행합니다.");
    expect(text.accepted).toBe("접수했습니다. 분리 번역 역할(translation)이 처리합니다.");
    expect(text.page).not.toContain("text 워커");
  });

  it("비우는 중이면 맡은 역할이 없다고 적는다", () => {
    expect(translationOwnerText("draining").page).toBe("작업 배치를 비우는 중(draining)이라 지금은 모델 호출을 맡은 역할이 없습니다.");
  });

  it("작업 배치를 읽지 못했으면 보류다 — 기존 글로 짐작하지 않는다", () => {
    const text = translationOwnerText(null);
    expect(text.page).toContain("보류");
    expect(text.page).not.toContain("text 워커");
    expect(text.accepted).not.toContain("text 워커");
  });
});
