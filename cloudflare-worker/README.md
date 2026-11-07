# Step 5-4 — Cloudflare Worker 只讀 Google Sheets

本目錄包含 **準備部署但尚未部署** 的 Cloudflare Worker 程式，以之前人工建立的 stock-line-bot Webhook 程式為基礎，保留 /webhook、LINE HMAC 驗證、私人群組白名單、/測試、設定期 /群組ID，新增 /資料測試。

/資料測試：只在指定 LINE 私人群組讀取 Watchlist、Signals、Performance、Reports 的限定範圍；使用 Google OAuth 2.0 的 spreadsheets.readonly scope。無公開查詢 API、沒有寫入、沒有 LINE 個股或選股指令（留至 Step 5-5），也不修改 GitHub Actions 排程。

## 目前限制

已部署的 Worker 程式碼**沒有保存在 GitHub Repository**，Windows 電腦也未登入 Wrangler，因此無法獨立取得 Cloudflare 正在運作的原始碼。**不得在比對並備份現行 Worker 之前，直接以本檔案覆蓋正式 Worker。** 這份檔案的既有 LINE 部分是根據先前已成功驗證的程式；若正式 Worker 已另外增加功能，必須保留那些功能。

## Cloudflare Secrets（不可公開、提交 Git 或貼入聊天室）

現有設定保留：
- LINE_CHANNEL_SECRET：Secret
- LINE_CHANNEL_ACCESS_TOKEN：Secret
- LINE_ALLOWED_GROUP_ID：Secret，只有指定群組可以查資料

新增：
- GOOGLE_SHEET_ID：Stock-Strategies-TW 的 Spreadsheet ID，建議設定為 Secret
- GOOGLE_CREDS_JSON：Google 服務帳戶 JSON 完整原文，必須設定為 Secret

Cloudflare Dashboard → Workers & Pages → stock-line-bot → Settings → Variables and Secrets → Add。GitHub Secret 無法直接讀回，使用當初下載的 JSON 原檔取得內容。**不要把私鑰寫進 Wrangler 設定檔或 Repository。**

## 手動部署驗收（尚未執行）

1. 先從 Cloudflare Dashboard 備份現行 Worker 原始碼，核對與 index.mjs 的差異。
2. 確認現有 LINE 簽章驗證、群組授權及 Reply API 沒有額外功能需要保留。
3. 在 Cloudflare Dashboard 新增 GOOGLE_SHEET_ID 和 GOOGLE_CREDS_JSON，類型選 Secret。
4. 將通過測試的程式整合到現行 Worker，更新並部署。
5. 私人 LINE 群組輸入 /測試，應仍回「✅ LINE 機器人連線成功！」。
6. 私人 LINE 群組輸入 /資料測試，應回 Google Sheets 唯讀連線成功、觀察清單約 4 檔、Signals 約 4 筆、Performance 0 筆，最近日報 2026-11-06／stale（以目前試算表為準）。
7. 非白名單群組不得讀到 Google Sheets；GET / 仍回 LINE Webhook Ready。
8. 確認日誌沒有 Google 私鑰、LINE Token 或私人群組 ID。

## 測試

在 Node.js 22+ 直接執行以下指令；不需要安裝任何 npm 依賴：

    node --test cloudflare-worker/index.test.mjs

測試涵蓋 LINE 簽章、白名單、Google OAuth JWT RS256 簽章、spreadsheets.readonly scope、Google Sheets API GET、錯誤回覆不洩漏機密。

**所有 Google/LINE 呼叫都由單元測試模擬，通過不等於已完成 Cloudflare 實際部署驗收。**

## 設計取捨

- 不公開 Sheets，Worker 以服務帳戶呼叫 Google API。
- Google WebCrypto RS256 簽章，避免新增 npm 依賴。
- 四張表使用單次 spreadsheets.values.batchGet；限定讀取列數，超過讀取範圍不顯示為完整筆數。
- OAuth 權杖僅在 Worker 記憶體暫存，不建立資料庫或其他持久服務。
