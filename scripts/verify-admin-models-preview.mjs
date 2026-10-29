/** Browser validation against offline fixture HTML. No operational endpoints or credentials. */
import { chromium } from "playwright";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
const directory = process.argv[2];
if (!directory) throw new Error("usage: node scripts/verify-admin-models-preview.mjs ARTIFACT_DIRECTORY");
const browser = await chromium.launch({ executablePath: process.env.ADMIN_MODELS_CHROMIUM_PATH || undefined, headless: true });
const results = [], errors = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 1000 : 844 }, deviceScaleFactor: 1, isMobile: width === 390 });
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.install();
    await page.goto(`file://${resolve(directory, `admin-models-${width}.html`)}`);
    await page.getByRole("heading", { name: "지금 상태", exact: true }).waitFor();
    await page.evaluate(() => { window.previewRefreshCount = 0; window.addEventListener('preview-refresh', () => { window.previewRefreshCount += 1; }); });
    await page.getByRole("button", { name: "수동 새로고침", exact: true }).click();
    await page.clock.fastForward(30000);
    if (await page.evaluate(() => window.previewRefreshCount) < 2) throw new Error("manual_or_auto_refresh_failed");
    const save = page.getByRole("button", { name: "모델 설정 저장", exact: true });
    if (!await save.isDisabled()) throw new Error("unchanged_save_enabled");
    const card = page.getByRole("article", { name: "supa Qwen3.8-27B-NVFP4", exact: true });
    if (!await card.getByRole("button", { name: "종료(정식 해제)", exact: true }).isDisabled()) throw new Error("supa_release_not_disabled");
    const m1 = page.getByRole("article", { name: "m1 Gemma 4 26B", exact: true });
    if (!await m1.getByRole("button", { name: "모델 재시작", exact: true }).isDisabled()) throw new Error("m1_restart_not_disabled");
    const requestVisible = await page.getByText("requestId", { exact: false }).first().isVisible();
    if (requestVisible) throw new Error("internal_id_open_by_default");
    await page.screenshot({ path: resolve(directory, `admin-models-${width}.png`), fullPage: true });
    await page.screenshot({ path: resolve(directory, `admin-models-${width}-first-screen.png`) });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      cardColumns: getComputedStyle(document.querySelector('[aria-label="supa Qwen3.8-27B-NVFP4"]').parentElement).gridTemplateColumns.split(' ').length }));
    if (dimensions.document > width) throw new Error(`horizontal_overflow_${width}_${dimensions.document}`);
    await card.evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(directory, `admin-models-${width}-model.png`) });
    await card.getByRole("button", { name: "연결 확인", exact: true }).click();
    await card.getByText("모델 목록에 있음", { exact: false }).waitFor();
    await page.getByRole("button", { name: "추가 1차 모델 · 후보를 나눠 처리 1번째 모델 빼기", exact: true }).click();
    if (!await save.isEnabled()) throw new Error("changed_save_disabled");
    await page.screenshot({ path: resolve(directory, `admin-models-${width}-settings.png`) });
    await save.click();
    await page.getByText("모델 설정을 저장했습니다.", { exact: true }).waitFor();
    if (!await save.isDisabled()) throw new Error("saved_form_still_dirty");
    await page.getByLabel("심사 사유 번역 모델 추가", { exact: true }).selectOption(JSON.stringify(["abcllm", "mlx:text"]));
    if (!await save.isEnabled()) throw new Error("stage_add_did_not_enable_save");
    await page.getByRole("button", { name: "심사 사유 번역 1번째 모델 빼기", exact: true }).click();
    if (!await save.isDisabled()) throw new Error("stage_revert_still_dirty");
    await card.getByRole("button", { name: "접수 일시중지", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.waitFor();
    await dialog.getByRole("textbox", { name: "변경 사유" }).fill("로컬 합성 자료 검증");
    await page.screenshot({ path: resolve(directory, `admin-models-${width}-confirm.png`) });
    await dialog.getByRole("button", { name: "확인 · 접수 일시중지", exact: true }).click();
    await page.clock.fastForward(2100);
    await page.getByRole("article", { name: "접수 일시중지 진행 상황", exact: true }).getByText("진행 중", { exact: true }).first().waitFor();
    await page.clock.fastForward(2100);
    const progress = page.getByRole("article", { name: "접수 일시중지 진행 상황", exact: true });
    await progress.getByText("멈춘 단계:", { exact: false }).waitFor({ timeout: 15000 });
    await progress.evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(directory, `admin-models-${width}-progress.png`) });
    results.push({ width, ...dimensions, checks: ["manual and 30s auto refresh", "initial save disabled", "Supa/M1 recovery disabled with reason", "IDs collapsed", "probe synthetic result", "chip remove enables save", "save clears draft", "stage chip add/remove and revert", "Korean confirmation", "synthetic progress failure step"] });
    await page.close();
  }
  if (errors.length) throw new Error(`browser_errors: ${errors.join("; ")}`);
  await writeFile(resolve(directory, "admin-models-browser-validation.json"), JSON.stringify({ results, pageErrors: errors, source: "offline synthetic fixtures; no production IO" }, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
