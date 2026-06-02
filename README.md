# Discord Roblox Lua Bot

Discord上でRoblox Luaスクリプトを検索し、AIによる自動応答を提供するBotです。

## 機能

### スクリプト検索
```
!search_{スクリプト名}
```
ScriptBlox APIを使ってRoblox Luaスクリプトを検索します。
- タイトル・ゲーム名・閲覧数・認証済みフラグを埋め込み表示
- スクリプトが長い場合は .lua ファイル添付
- Keyシステムがある場合はKeyリンクを表示
- ゲーム画像サムネイル付き

### AIモード (Groq llama-3.3-70b + Gemini 1.5-flash フォールバック)
```
!set     — このチャンネルでAI自動応答を開始
!unset   — AI自動応答を停止
```
- Roblox Luaスクリプトの質問・解説
- 難読化 (obfuscation)
- リバースエンジニアリング (解読)
- 会話履歴維持 (ユーザーごと最大10往復)

## 対応サーバー・チャンネル

| 項目 | ID |
|------|-----|
| サーバー | 1490495338296115364 |
| チャンネル | 1510354846111371377 |

## 必要な環境変数

```env
DISCORD_BOT_TOKEN=
GROQ_API_KEY=
GEMINI_API_KEY=
GITHUB_TOKEN=
```

## セットアップ

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
```

## 注意

Discord Developer Portalでボットに Message Content Intent を有効にしてください。
