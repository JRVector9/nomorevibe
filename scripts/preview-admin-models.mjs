/** Generate credential-free static HTML from the real React components and fixed ledger fixture. */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = process.argv[2];
if (!directory) throw new Error("usage: node scripts/preview-admin-models.mjs OUTPUT_DIRECTORY");
const root = process.cwd();
const result = await build({ stdin: { contents: `import {createElement} from 'react'; import {renderToString} from 'react-dom/server'; import Preview, {previewData} from './tests/fixtures/admin-models-preview'; module.exports = {markup:renderToString(createElement(Preview)), data:previewData};`, resolveDir: root, loader: "tsx" },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false, plugins: [{ name: "offline-preview", setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "offline" }));
    builder.onResolve({ filter: /^\.\/(?:operation-actions|ops-runner-actions|stage-model-actions|actions)$/ }, args => args.importer.includes("/admin/models/") ? ({ path: "actions", namespace: "offline" }) : undefined);
    builder.onLoad({ filter: /.*/, namespace: "offline" }, args => ({ contents: args.path === "navigation" ? `export const useRouter = () => ({refresh(){}});` : `export const probeAdminModel=async()=>({}); export const submitAdminModelOperation=async()=>({}); export const readAdminModelOperation=async()=>({}); export const saveReviewModels=async()=>null; export const saveAdminStageModels=async()=>null;` }));
  } }] });
const rendered = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(resolve(root, "package.json")), rendered, rendered.exports);
const browser = await build({ stdin: { contents: `import {createElement} from 'react'; import {hydrateRoot} from 'react-dom/client'; import Preview from './tests/fixtures/admin-models-preview-ui'; hydrateRoot(document.getElementById('preview-root'), createElement(Preview, {data:JSON.parse(document.getElementById('fixture-data').textContent)}));`, resolveDir: root, loader: "tsx" },
  bundle: true, platform: "browser", format: "iife", write: false, minify: true, define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "offline-browser", setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "offline" }));
    builder.onResolve({ filter: /^\.\/(?:operation-actions|ops-runner-actions|stage-model-actions|actions)$/ }, args => args.importer.includes("/admin/models/") ? ({ path: "actions", namespace: "offline" }) : undefined);
    builder.onLoad({ filter: /.*/, namespace: "offline" }, args => ({ resolveDir: root, contents: args.path === "navigation" ? `const router={refresh(){window.dispatchEvent(new Event('preview-refresh'))}}; export const useRouter = () => router;` : `export {previewProbe as probeAdminModel, previewOpsSubmit as submitAdminModelOperation, previewOpsRead as readAdminModelOperation, previewSave as saveReviewModels, previewStageSave as saveAdminStageModels} from './tests/fixtures/admin-models-preview-actions';` }));
  } }] });
const css = await postcss([tailwind({ base: root })]).process(await readFile("app/globals.css", "utf8"), { from: resolve(root, "app/globals.css") });
const styles = css.css + await readFile("app/(operator)/admin/admin.css", "utf8") + await readFile("app/(operator)/admin/status/operations.css", "utf8") + await readFile("app/(operator)/admin/models/models.css", "utf8");
await mkdir(directory, { recursive: true });
for (const width of [1440, 390]) {
  const html = `<!doctype html><html lang="ko" data-admin-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><title>단계별 모델 · ${width}px 정적 검토</title><style>${styles.replaceAll("</style", "<\\/style")}</style></head><body style="margin:0"><p style="padding:8px;font-size:13px">${width}px 검토용 고정 데이터 · 모든 버튼은 합성 응답만 사용</p><div id="preview-root">${rendered.exports.markup}</div><script type="application/json" id="fixture-data">${JSON.stringify(rendered.exports.data).replaceAll("<", "\\u003c")}</script><script>${browser.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`;
  await writeFile(resolve(directory, `admin-models-${width}.html`), html);
}
console.log("Wrote static previews at 1440px and 390px. Offline actions use synthetic responses only; no production IO.");
