import { defineCatalog } from "@/lib/i18n/messages";
import type { launch as Schema } from "@/messages/ko/launch";
import { launch as english } from "@/messages/en/launch";

/** Product content is Japanese; untranslated support/account/policy copy explicitly falls back to English. */
export const launch = defineCatalog<typeof Schema>()({
  ...english,
  "metadata.title": "プロジェクトを掲載",
  "metadata.description": "AIコーディングツールからコマンド1回で公開サービスを登録できます。",
  "hero.heading": "AIで作ったら、コマンド1回で紹介しよう。",
  "hero.description": "登録フォームもSDKも不要です。Claude CodeやCodexなど、制作に使ったAIツールでスラッシュコマンドを実行します。",
  "install.title": "スキルをインストール",
  "install.step": "ターミナルで1回インストール",
  "command.install": "インストールコマンド",
  "command.launch": "登録コマンド",
  "command.verify": "確認コマンド",
  "output.title": "出力例",
  "output.claude": "Claude Codeスキルをインストールしました {path}",
  "output.codex": "Codexプロンプトをインストールしました {path}",
  "install.launchStep": "プロジェクトフォルダを開き、Claude CodeかCodexで実行",
  "script.summary": "スクリプトを見る（/install.sh）",
  "script.description": "インストールコマンドが取得して実行する内容です。",
  "script.original": "原文を開く",
  "verify.heading": "所有者であることを確認",
  "copy.aria": "{label} をコピー",
  "copy.button": "コピー",
  "copy.copiedButton": "コピー済み ✓",
  "copy.copied": "コピーしました。",
  "copy.selected": "自動コピーが使えません。選択されたコマンドを ⌘C または Ctrl+C でコピーしてください。",
  "copy.failed": "自動コピーが使えません。コマンドを選択して手動でコピーしてください。",
});
