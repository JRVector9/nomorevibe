import { defineCatalog } from "@/lib/i18n/messages";
import type { auth as Schema } from "@/messages/ko/auth";
import { auth as english } from "@/messages/en/auth";

/** Product content is Japanese; untranslated support/account/policy copy explicitly falls back to English. */
export const auth = defineCatalog<typeof Schema>()({
  ...english,
  "login.title": "ログイン",
  "login.metadataTitle": "ログイン — NoMoreVibe",
  "login.connectTitle": "GitHubと連携",
  "login.description": "ログインしてスターやフィードバックを投稿できます。",
  "login.emailSection": "メールでログイン",
  "login.emailHeading": "メールでログイン",
  "login.emailDescription": "メールを確認すれば、GitHubアカウントなしでフィードバックできます。公開投稿にはメールアドレスではなくニックネームが表示されます。",
  "login.unavailable": "ログイン機能を準備中です。",
  "email.label": "メールアドレス",
  "email.codeLabel": "確認コード",
  "email.deliveryUnknown": "メールの送信状況を確認中です。コードが届いていれば入力してください。",
  "email.codeSent": "メールで届いた8桁のコードを10分以内に入力してください。",
  "email.busy": "処理中…",
  "email.submit": "ログイン",
  "email.sendCode": "確認コードを受け取る",
  "email.restart": "別のメールを使う・コードを再取得",
  "github.signIn": "GitHubでログイン",
  "github.connect": "GitHubと連携",
  "github.disconnect": "GitHub連携を解除",
  "github.reconnect": "GitHubと再連携",
  "github.loading": "連携状況を確認中…",
  "github.connected": "@{login} と連携済み",
  "feedback.metadataTitle": "プロジェクトのフィードバック — NoMoreVibe",
  "feedback.backToProduct": "{name} に戻る",
  "feedback.heading": "プロジェクトのフィードバック原文",
});
